import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'
import { piiRedactor } from './pii-redactor.js'

const logger = createLogger()

/**
 * S3 Client for file uploads
 */
class S3Uploader {
  static get textContentType() {
    return 'text/plain'
  }

  static get htmlContentType() {
    return 'text/html'
  }

  constructor() {
    this.mockMode = config.get('mockMode.s3Upload')

    if (this.mockMode) {
      logger.info(
        'S3Uploader running in MOCK mode - files will not actually be uploaded'
      )
      this.s3Client = null
    } else {
      const s3Config = {
        region: config.get('aws.region')
      }

      // Add endpoint for LocalStack if configured
      const awsEndpoint = config.get('aws.endpoint')
      if (awsEndpoint) {
        s3Config.endpoint = awsEndpoint
        s3Config.forcePathStyle = true // Required for LocalStack
      }

      this.s3Client = new S3Client(s3Config)
    }

    this.bucket = config.get('s3.bucket')
    this.pathPrefix = 'content-uploads' // previously config.get('upload.s3Path')
  }

  /**
   * Create mock upload response
   * @private
   */
  _createMockUploadResponse(
    uploadId,
    filename,
    contentToUpload,
    key,
    redactionResult,
    contentType
  ) {
    logger.warn(
      {
        uploadId,
        filename,
        contentLength: contentToUpload.length,
        hasPII: redactionResult.hasPII
      },
      '[MOCK MODE] Simulating S3 text upload - not actually uploading'
    )

    return {
      success: true,
      bucket: this.bucket,
      key,
      location: `s3://${this.bucket}/${key}`,
      size: contentToUpload.length,
      contentType,
      piiRedacted: redactionResult.hasPII,
      piiRedactionCount: redactionResult.redactionCount
    }
  }

  /**
   * Create S3 put object command
   * @private
   */
  _createPutCommand(
    key,
    contentToUpload,
    filename,
    uploadId,
    redactionResult,
    contentType
  ) {
    return new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: Buffer.from(contentToUpload, 'utf-8'),
      ContentType: contentType,
      Metadata: {
        originalName: filename,
        uploadId,
        uploadedAt: new Date().toISOString(),
        contentLength: contentToUpload.length.toString(),
        piiRedacted: redactionResult.hasPII ? 'true' : 'false',
        piiRedactionCount: redactionResult.redactionCount.toString()
      }
    })
  }

  /**
   * Create successful upload response
   * @private
   */
  _createUploadResponse(
    uploadId,
    filename,
    contentToUpload,
    key,
    redactionResult,
    contentType
  ) {
    return {
      success: true,
      bucket: this.bucket,
      key,
      location: `s3://${this.bucket}/${key}`,
      fileId: uploadId,
      filename,
      size: contentToUpload.length,
      contentType,
      piiRedacted: redactionResult.hasPII,
      piiRedactionCount: redactionResult.redactionCount
    }
  }

  /**
   * Log upload start information
   * @private
   */
  _logUploadStart(
    uploadId,
    filename,
    textContent,
    contentToUpload,
    redactionResult,
    key
  ) {
    logger.info(
      {
        uploadId,
        filename,
        originalLength: textContent.length,
        redactedLength: contentToUpload.length,
        hasPII: redactionResult.hasPII,
        piiRedactionCount: redactionResult.redactionCount,
        bucket: this.bucket,
        key
      },
      redactionResult.hasPII
        ? `S3 text upload started - PII REDACTED (${redactionResult.redactionCount} instances)`
        : 'S3 text content upload started'
    )
  }

  /**
   * Log successful upload
   * @private
   */
  _logUploadSuccess(
    uploadId,
    filename,
    contentToUpload,
    key,
    duration,
    redactionResult
  ) {
    logger.info({
      uploadId,
      filename,
      contentLength: contentToUpload.length,
      bucket: this.bucket,
      key,
      s3Location: `s3://${this.bucket}/${key}`,
      durationMs: duration,
      piiRedacted: redactionResult.hasPII,
      piiRedactionCount: redactionResult.redactionCount
    })
  }

  /**
   * Log upload error
   * @private
   */
  _logUploadError(uploadId, filename, key, error, duration) {
    logger.error(
      {
        uploadId,
        filename,
        bucket: this.bucket,
        key,
        error: error.message,
        errorName: error.name,
        errorCode: error.Code,
        durationMs: duration
      },
      `S3 text upload failed after ${duration}ms: ${error.message}`
    )
  }

  /**
   * Upload text content to S3
   * @param {string} textContent - Text content to upload
   * @param {string} uploadId - Unique upload ID
   * @param {string} title - Optional title for the content
   * @returns {Promise<Object>} Upload result
   */
  async uploadTextContent(textContent, uploadId, title = 'Text Content') {
    // Preserve .html extension for URL-sourced content; use .txt for everything else
    const isHtml = title.toLowerCase().endsWith('.html')
    const safeBase = title
      .replace(/\.html$/i, '')
      .replaceAll(/[^a-zA-Z0-9-_]/g, '_')
    const filename = isHtml ? `${safeBase}.html` : `${safeBase}.txt`
    const contentType = isHtml
      ? S3Uploader.htmlContentType
      : S3Uploader.textContentType
    const key = `${this.pathPrefix}/${uploadId}/${filename}`

    // Redact PII from content before uploading to S3
    const redactionResult = piiRedactor.redactUserContent(textContent)
    const contentToUpload = redactionResult.redactedText

    this._logUploadStart(
      uploadId,
      filename,
      textContent,
      contentToUpload,
      redactionResult,
      key
    )

    const startTime = performance.now()

    // Mock mode - simulate successful upload without actually uploading
    if (this.mockMode) {
      return this._createMockUploadResponse(
        uploadId,
        filename,
        contentToUpload,
        key,
        redactionResult,
        contentType
      )
    }

    const command = this._createPutCommand(
      key,
      contentToUpload,
      filename,
      uploadId,
      redactionResult,
      contentType
    )

    try {
      await this.s3Client.send(command)

      const duration = Math.round(performance.now() - startTime)
      this._logUploadSuccess(
        uploadId,
        filename,
        contentToUpload,
        key,
        duration,
        redactionResult
      )

      return this._createUploadResponse(
        uploadId,
        filename,
        contentToUpload,
        key,
        redactionResult,
        contentType
      )
    } catch (error) {
      const duration = Math.round(performance.now() - startTime)
      this._logUploadError(uploadId, filename, key, error, duration)
      throw new Error(`S3 text upload failed: ${error.message}`)
    }
  }
}

export const s3Uploader = new S3Uploader()
