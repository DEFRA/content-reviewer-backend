import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf'
import fs from 'fs'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * Parse PDF file to JSON (page by page)
 * @param {string} filePath - Path to the PDF file
 * @returns {Promise<Array>} - Array of pages with content
 */
export async function parsePdfToJson(filePath) {
  try {
    const loader = new PDFLoader(filePath, { splitPages: true })
    const docs = await loader.load()

    const jsonPages = docs.map((doc, index) => ({
      pageNumber: index + 1,
      content: doc.pageContent
    }))

    logger.info('PDF parsed successfully', {
      pageCount: jsonPages.length,
      filePath
    })

    return jsonPages
  } catch (error) {
    logger.error('Error parsing PDF file', {
      error: error.message,
      filePath
    })
    throw new Error(`Failed to parse PDF: ${error.message}`)
  }
}

/**
 * Parse PDF file to text as a single string
 * @param {string} filePath - Path to the PDF file
 * @returns {Promise<string>} - PDF content as a string
 */
export async function parsePdfToText(filePath) {
  try {
    const pages = await parsePdfToJson(filePath)
    const text = pages.map((page) => page.content).join('\n\n')

    logger.info('PDF converted to text', {
      pageCount: pages.length,
      textLength: text.length
    })

    return text
  } catch (error) {
    logger.error('Error parsing PDF to text', {
      error: error.message,
      filePath
    })
    throw new Error(`Failed to parse PDF to text: ${error.message}`)
  }
}

/**
 * Parse PDF buffer directly
 * @param {Buffer} buffer - PDF file buffer
 * @param {string} filename - Original filename (for logging)
 * @returns {Promise<string>} - PDF content as a string
 */
export async function parsePdfBuffer(buffer, filename = 'unknown') {
  let tempFilePath = null

  try {
    logger.info('Parsing PDF buffer', { filename, size: buffer.length })

    // Save buffer to temporary file
    tempFilePath = await saveTempFile(buffer)

    // Parse the temporary file
    const text = await parsePdfToText(tempFilePath)

    logger.info('PDF buffer parsed successfully', {
      filename,
      textLength: text.length
    })

    return text
  } catch (error) {
    logger.error('Error parsing PDF buffer', {
      error: error.message,
      filename
    })
    throw new Error(`Failed to parse PDF buffer: ${error.message}`)
  } finally {
    // Always clean up temp file
    if (tempFilePath) {
      await deleteTempFile(tempFilePath)
    }
  }
}

/**
 * Save buffer to temporary file
 * @param {Buffer} buffer - PDF file buffer
 * @returns {Promise<string>} - Path to the temporary file
 */
async function saveTempFile(buffer) {
  const tempDir = './temp'

  // Create temp directory if it doesn't exist
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
    logger.info('Created temp directory', { tempDir })
  }

  const tempFilePath = `${tempDir}/${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`
  await fs.promises.writeFile(tempFilePath, buffer)

  logger.info('Saved temporary PDF file', { tempFilePath })

  return tempFilePath
}

/**
 * Delete temporary file
 * @param {string} filePath - Path to the temporary file
 */
async function deleteTempFile(filePath) {
  try {
    await fs.promises.unlink(filePath)
    logger.info('Deleted temporary file', { filePath })
  } catch (error) {
    logger.warn('Error deleting temporary file', {
      error: error.message,
      filePath
    })
  }
}

/**
 * Check if file is a PDF based on extension
 * @param {string} filename - Filename to check
 * @returns {boolean}
 */
export function isPdfFile(filename) {
  return filename.toLowerCase().endsWith('.pdf')
}

/**
 * Extract text from Word document (placeholder for future implementation)
 * @param {Buffer} buffer - Word document buffer
 * @param {string} filename - Original filename
 * @returns {Promise<string>}
 */
export async function parseWordDocument(buffer, filename) {
  // TODO: Implement Word document parsing
  // Could use mammoth.js or similar
  logger.warn('Word document parsing not yet implemented', { filename })
  throw new Error(
    'Word document parsing not yet implemented. Please use PDF format.'
  )
}

// Export service object for easier importing
export const pdfService = {
  extractText: parsePdfBuffer,
  parseToJson: parsePdfToJson,
  parseToText: parsePdfToText,
  parseBuffer: parsePdfBuffer,
  isPdfFile
}
