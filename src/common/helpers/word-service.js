import mammoth from 'mammoth'
import { createLogger } from './logging/logger.js'
import fs from 'fs/promises'
import path from 'path'
import { tmpdir } from 'os'
import { v4 as uuidv4 } from 'uuid'

const logger = createLogger()

/**
 * Word Document Text Extraction Service
 * Extracts text content from Word documents (.doc, .docx)
 */
export class WordService {
  /**
   * Extract text from a Word document buffer
   * @param {Buffer} buffer - Word document buffer
   * @param {string} filename - Original filename for logging
   * @returns {Promise<string>} Extracted text content
   */
  async extractText(buffer, filename = 'unknown') {
    const startTime = Date.now()
    let tempFilePath = null

    try {
      logger.info(
        { filename, bufferSize: buffer.length },
        'Starting Word text extraction'
      )

      // Create a temporary file
      const tempDir = tmpdir()
      const tempFileName = `word-${uuidv4()}.docx`
      tempFilePath = path.join(tempDir, tempFileName)

      // Write buffer to temp file
      await fs.writeFile(tempFilePath, buffer)

      // Extract text using mammoth
      const result = await mammoth.extractRawText({ path: tempFilePath })

      const extractedText = result.value.trim()
      const wordCount = extractedText.split(/\s+/).length
      const duration = Date.now() - startTime

      logger.info(
        {
          filename,
          textLength: extractedText.length,
          wordCount,
          duration
        },
        'Word text extraction completed'
      )

      if (result.messages && result.messages.length > 0) {
        logger.warn(
          {
            filename,
            messages: result.messages
          },
          'Word extraction warnings'
        )
      }

      if (!extractedText || extractedText.length === 0) {
        throw new Error('No text content extracted from Word document')
      }

      return extractedText
    } catch (error) {
      logger.error(
        {
          filename,
          error: error.message,
          stack: error.stack
        },
        'Word text extraction failed'
      )
      throw new Error(
        `Failed to extract text from Word document: ${error.message}`
      )
    } finally {
      // Clean up temp file
      if (tempFilePath) {
        try {
          await fs.unlink(tempFilePath)
          logger.debug({ tempFile: tempFilePath }, 'Cleaned up temp file')
        } catch (error) {
          logger.warn(
            { tempFile: tempFilePath, error: error.message },
            'Failed to clean up temp file'
          )
        }
      }
    }
  }

  /**
   * Check if a file is a Word document based on MIME type
   * @param {string} mimeType - File MIME type
   * @returns {boolean} True if Word document
   */
  static isWordDocument(mimeType) {
    const wordMimeTypes = [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
    return wordMimeTypes.includes(mimeType)
  }
}

// Export singleton instance
export const wordService = new WordService()
