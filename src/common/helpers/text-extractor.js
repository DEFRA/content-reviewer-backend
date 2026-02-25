import { createRequire } from 'node:module'
import mammoth from 'mammoth'
import { createLogger } from './logging/logger.js'

const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse')

const logger = createLogger()

/**
 * Extract text from various file formats
 */
class TextExtractor {
  /**
   * Extract text from a buffer based on MIME type
   * @param {Buffer} buffer - File buffer
   * @param {string} mimeType - MIME type of the file
   * @param {string} fileName - Original file name
   * @returns {Promise<string>} Extracted text
   */
  async extractText(buffer, mimeType, fileName = 'unknown') {
    logger.info(
      { mimeType, fileName, bufferSize: buffer.length },
      'Extracting text from file'
    )

    try {
      let text = ''

      switch (mimeType) {
        case 'application/pdf':
          text = await this.extractFromPDF(buffer)
          break

        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          text = await this.extractFromDocx(buffer)
          break

        case 'application/msword':
          throw new Error(
            'Legacy .doc format is not supported. Please use .docx format.'
          )

        case 'text/plain':
          text = buffer.toString('utf-8')
          break

        default:
          throw new Error(`Unsupported file type: ${mimeType}`)
      }

      // Clean up extracted text
      text = this.cleanText(text)

      logger.info(
        { extractedLength: text.length, fileName },
        'Text extraction completed'
      )

      if (!text || text.trim().length === 0) {
        throw new Error('No text content could be extracted from the file')
      }

      return text
    } catch (error) {
      logger.error(
        { error: error.message, mimeType, fileName },
        'Text extraction failed'
      )
      throw new Error(`Failed to extract text: ${error.message}`)
    }
  }

  /**
   * Extract text from PDF buffer
   * @param {Buffer} buffer - PDF file buffer
   * @returns {Promise<string>} Extracted text
   */
  async extractFromPDF(buffer) {
    try {
      const data = await pdfParse(buffer)
      return data.text
    } catch (error) {
      logger.error({ error: error.message }, 'PDF extraction failed')
      throw new Error(`Failed to extract text from PDF: ${error.message}`)
    }
  }

  /**
   * Extract text from DOCX buffer
   * @param {Buffer} buffer - DOCX file buffer
   * @returns {Promise<string>} Extracted text
   */
  async extractFromDocx(buffer) {
    try {
      const result = await mammoth.extractRawText({ buffer })

      if (result.messages && result.messages.length > 0) {
        logger.warn(
          { messages: result.messages },
          'DOCX extraction had warnings'
        )
      }

      return result.value
    } catch (error) {
      logger.error({ error: error.message }, 'DOCX extraction failed')
      throw new Error(`Failed to extract text from DOCX: ${error.message}`)
    }
  }

  /**
   * Clean extracted text
   * @param {string} text - Raw extracted text
   * @returns {string} Cleaned text
   */
  cleanText(text) {
    if (!text) {
      return ''
    }

    // Remove excessive whitespace
    text = text.replaceAll('\r\n', '\n') // Normalize line endings
    text = text.replaceAll(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
    text = text.replaceAll(/[ \t]+/g, ' ') // Normalize spaces
    text = text.trim()

    return text
  }

  /**
   * Get text preview (first N characters)
   * @param {string} text - Full text
   * @param {number} maxLength - Maximum length for preview
   * @returns {string} Preview text
   */
  getPreview(text, maxLength = 500) {
    if (!text || text.length <= maxLength) {
      return text
    }

    return text.substring(0, maxLength) + '...'
  }

  /**
   * Count words in text
   * @param {string} text - Text to count
   * @returns {number} Word count
   */
  countWords(text) {
    if (!text) {
      return 0
    }

    // Split by whitespace and filter empty strings
    const words = text.trim().split(/\s+/).filter(Boolean)
    return words.length
  }

  /**
   * Get text statistics
   * @param {string} text - Text to analyze
   * @returns {Object} Text statistics
   */
  getStatistics(text) {
    if (!text) {
      return {
        characters: 0,
        words: 0,
        lines: 0,
        paragraphs: 0
      }
    }

    const lines = text.split('\n').length
    const paragraphs = text.split(/\n\n+/).filter(Boolean).length
    const words = this.countWords(text)
    const characters = text.length

    return {
      characters,
      words,
      lines,
      paragraphs
    }
  }
}

// Export singleton instance
export const textExtractor = new TextExtractor()
