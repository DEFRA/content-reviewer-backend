import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * Document Extractor Service
 * Extracts text content from PDF and Word documents
 */
class DocumentExtractor {
  constructor() {
    const s3Config = {
      region: config.get('s3.region')
    }

    // Add endpoint for LocalStack if configured
    const awsEndpoint =
      process.env.AWS_ENDPOINT || process.env.LOCALSTACK_ENDPOINT
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true
    }

    this.s3Client = new S3Client(s3Config)
  }

  /**
   * Download file from S3
   * @param {string} bucket - S3 bucket name
   * @param {string} key - S3 object key
   * @returns {Promise<Buffer>} File buffer
   */
  async downloadFromS3(bucket, key) {
    try {
      logger.info({ bucket, key }, 'Downloading file from S3')

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key
      })

      const response = await this.s3Client.send(command)
      const chunks = []

      for await (const chunk of response.Body) {
        chunks.push(chunk)
      }

      const buffer = Buffer.concat(chunks)

      logger.info(
        {
          bucket,
          key,
          size: buffer.length,
          contentType: response.ContentType
        },
        'File downloaded from S3'
      )

      return buffer
    } catch (error) {
      logger.error(
        {
          error: error.message,
          bucket,
          key
        },
        'Failed to download file from S3'
      )
      throw error
    }
  }

  /**
   * Extract text from document
   * @param {string} bucket - S3 bucket name
   * @param {string} key - S3 object key
   * @param {string} contentType - File content type
   * @returns {Promise<Object>} Extracted content and metadata
   */
  async extractText(bucket, key, contentType) {
    try {
      logger.info(
        {
          bucket,
          key,
          contentType
        },
        'Extracting text from document'
      )

      // Download file
      const fileBuffer = await this.downloadFromS3(bucket, key)

      let extractedText = ''
      let extractionMethod = 'unknown'
      const metadata = {
        originalSize: fileBuffer.length,
        contentType
      }

      // Determine extraction method based on content type
      if (contentType?.includes('pdf') || key.toLowerCase().endsWith('.pdf')) {
        // PDF extraction
        const result = await this.extractFromPDF(fileBuffer)
        extractedText = result.text
        extractionMethod = 'pdf'
        metadata.pages = result.pages
      } else if (
        contentType?.includes('word') ||
        contentType?.includes('document') ||
        key.toLowerCase().endsWith('.docx') ||
        key.toLowerCase().endsWith('.doc')
      ) {
        // Word document extraction
        const result = await this.extractFromWord(fileBuffer)
        extractedText = result.text
        extractionMethod = 'word'
      } else if (
        contentType?.includes('text') ||
        key.toLowerCase().endsWith('.txt')
      ) {
        // Plain text
        extractedText = fileBuffer.toString('utf8')
        extractionMethod = 'text'
      } else {
        // Fallback: try to read as text
        logger.warn(
          { contentType, key },
          'Unknown content type, attempting text extraction'
        )
        extractedText = fileBuffer.toString('utf8')
        extractionMethod = 'fallback'
      }

      // Clean and validate extracted text
      extractedText = this.cleanText(extractedText)

      if (!extractedText || extractedText.trim().length === 0) {
        throw new Error('No text content extracted from document')
      }

      logger.info(
        {
          bucket,
          key,
          extractionMethod,
          extractedLength: extractedText.length,
          wordCount: extractedText.split(/\s+/).length
        },
        'Text extraction completed'
      )

      return {
        text: extractedText,
        extractionMethod,
        metadata: {
          ...metadata,
          extractedLength: extractedText.length,
          wordCount: extractedText.split(/\s+/).length,
          extractedAt: new Date().toISOString()
        }
      }
    } catch (error) {
      logger.error(
        {
          error: error.message,
          stack: error.stack,
          bucket,
          key
        },
        'Text extraction failed'
      )
      throw error
    }
  }

  /**
   * Extract text from PDF
   * @param {Buffer} buffer - PDF file buffer
   * @returns {Promise<Object>} Extracted text and page count
   */
  async extractFromPDF(buffer) {
    try {
      // NOTE: This requires pdf-parse library
      // npm install pdf-parse

      // Lazy load pdf-parse to avoid errors if not installed
      let pdfParse
      try {
        pdfParse = (await import('pdf-parse')).default
      } catch (error) {
        logger.error('pdf-parse library not installed')
        throw new Error(
          'PDF extraction requires pdf-parse library. Install with: npm install pdf-parse'
        )
      }

      const data = await pdfParse(buffer)

      return {
        text: data.text,
        pages: data.numpages,
        info: data.info
      }
    } catch (error) {
      logger.error({ error: error.message }, 'PDF extraction failed')
      throw new Error(`PDF extraction failed: ${error.message}`)
    }
  }

  /**
   * Extract text from Word document
   * @param {Buffer} buffer - Word file buffer
   * @returns {Promise<Object>} Extracted text
   */
  async extractFromWord(buffer) {
    try {
      // NOTE: This requires mammoth library for .docx
      // npm install mammoth

      // Lazy load mammoth to avoid errors if not installed
      let mammoth
      try {
        mammoth = await import('mammoth')
      } catch (error) {
        logger.error('mammoth library not installed')
        throw new Error(
          'Word extraction requires mammoth library. Install with: npm install mammoth'
        )
      }

      const result = await mammoth.extractRawText({ buffer })

      return {
        text: result.value,
        messages: result.messages
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Word extraction failed')
      throw new Error(`Word extraction failed: ${error.message}`)
    }
  }

  /**
   * Clean extracted text
   * @param {string} text - Raw extracted text
   * @returns {string} Cleaned text
   */
  cleanText(text) {
    if (!text) return ''

    return (
      text
        // Remove multiple consecutive spaces
        .replace(/ {2,}/g, ' ')
        // Remove multiple consecutive newlines (keep max 2)
        .replace(/\n{3,}/g, '\n\n')
        // Remove leading/trailing whitespace
        .trim()
    )
  }

  /**
   * Get service health status
   * @returns {Object} Health status
   */
  getHealth() {
    const health = {
      status: 'ok',
      service: 'document-extractor',
      supportedFormats: ['pdf', 'docx', 'txt']
    }

    // Check if libraries are available
    try {
      require.resolve('pdf-parse')
      health.pdfSupport = true
    } catch {
      health.pdfSupport = false
      health.warnings = health.warnings || []
      health.warnings.push(
        'pdf-parse not installed - PDF extraction unavailable'
      )
    }

    try {
      require.resolve('mammoth')
      health.wordSupport = true
    } catch {
      health.wordSupport = false
      health.warnings = health.warnings || []
      health.warnings.push(
        'mammoth not installed - Word extraction unavailable'
      )
    }

    if (health.warnings?.length > 0) {
      health.status = 'degraded'
    }

    return health
  }
}

// Create singleton instance
export const documentExtractor = new DocumentExtractor()

// Export class for testing
export { DocumentExtractor }
