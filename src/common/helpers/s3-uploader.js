import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * S3 Client for file uploads
 */
class S3Uploader {
  constructor() {
    // Check if we should use mock mode (when LocalStack/AWS is not available)
    // Default to mock mode in development if no AWS endpoint is configured
    const awsEndpoint =
      process.env.AWS_ENDPOINT || process.env.LOCALSTACK_ENDPOINT
    this.mockMode =
      process.env.MOCK_S3_UPLOAD === 'true' ||
      (!awsEndpoint && process.env.NODE_ENV === 'development')

    if (this.mockMode) {
      console.log(
        '[S3Uploader] Running in MOCK mode - files will not actually be uploaded'
      )
      this.s3Client = null
    } else {
      const s3Config = {
        region: config.get('aws.region')
      }

      // Add endpoint for LocalStack if configured
      const awsEndpoint = process.env.AWS_ENDPOINT
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
   * Upload file to S3
   * @param {Object} file - File object from multer
   * @param {string} uploadId - Unique upload ID
   * @returns {Promise<Object>} Upload result
   */
  async uploadFile(file, uploadId) {
    const key = `${this.pathPrefix}/${uploadId}/${file.originalname}`

    logger.info(
      {
        uploadId,
        filename: file.originalname,
        size: file.size,
        contentType: file.mimetype,
        bucket: this.bucket,
        key
      },
      'S3 file upload started'
    )

    const startTime = performance.now()

    // Mock mode - simulate successful upload without actually uploading
    if (this.mockMode) {
      logger.warn(
        {
          uploadId,
          filename: file.originalname,
          size: file.size
        },
        '[MOCK MODE] Simulating S3 file upload - not actually uploading'
      )

      return {
        success: true,
        bucket: this.bucket,
        key,
        location: `s3://${this.bucket}/${key}`,
        fileId: uploadId,
        filename: file.originalname,
        size: file.size,
        contentType: file.mimetype
      }
    }

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      Metadata: {
        originalName: file.originalname,
        uploadId,
        uploadedAt: new Date().toISOString()
      }
    })

    try {
      await this.s3Client.send(command)

      const endTime = performance.now()
      const duration = Math.round(endTime - startTime)

      logger.info(
        {
          uploadId,
          filename: file.originalname,
          size: file.size,
          bucket: this.bucket,
          key,
          s3Location: `s3://${this.bucket}/${key}`,
          durationMs: duration
        },
        `S3 file upload completed in ${duration}ms`
      )

      return {
        success: true,
        bucket: this.bucket,
        key,
        location: `s3://${this.bucket}/${key}`,
        fileId: uploadId,
        filename: file.originalname,
        size: file.size,
        contentType: file.mimetype
      }
    } catch (error) {
      const endTime = performance.now()
      const duration = Math.round(endTime - startTime)

      logger.error(
        {
          uploadId,
          filename: file.originalname,
          bucket: this.bucket,
          key,
          error: error.message,
          errorName: error.name,
          errorCode: error.Code,
          durationMs: duration
        },
        `S3 file upload failed after ${duration}ms: ${error.message}`
      )

      throw new Error(`S3 upload failed: ${error.message}`)
    }
  }

  /**
   * Upload text content to S3
   * @param {string} textContent - Text content to upload
   * @param {string} uploadId - Unique upload ID
   * @param {string} title - Optional title for the content
   * @returns {Promise<Object>} Upload result
   */
  async uploadTextContent(textContent, uploadId, title = 'Text Content') {
    const filename = `${title.replace(/[^a-zA-Z0-9-_]/g, '_')}.txt`
    const key = `${this.pathPrefix}/${uploadId}/${filename}`

    logger.info(
      {
        uploadId,
        filename,
        contentLength: textContent.length,
        bucket: this.bucket,
        key
      },
      'S3 text content upload started'
    )

    const startTime = performance.now()

    // Mock mode - simulate successful upload without actually uploading
    if (this.mockMode) {
      logger.warn(
        {
          uploadId,
          filename,
          contentLength: textContent.length
        },
        '[MOCK MODE] Simulating S3 text upload - not actually uploading'
      )

      return {
        success: true,
        bucket: this.bucket,
        key,
        location: `s3://${this.bucket}/${key}`,
        fileId: uploadId,
        filename,
        size: textContent.length,
        contentType: 'text/plain'
      }
    }

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: Buffer.from(textContent, 'utf-8'),
      ContentType: 'text/plain',
      Metadata: {
        originalName: filename,
        uploadId,
        uploadedAt: new Date().toISOString(),
        contentLength: textContent.length.toString()
      }
    })

    try {
      await this.s3Client.send(command)

      const endTime = performance.now()
      const duration = Math.round(endTime - startTime)

      logger.info(
        {
          uploadId,
          filename,
          contentLength: textContent.length,
          bucket: this.bucket,
          key,
          s3Location: `s3://${this.bucket}/${key}`,
          durationMs: duration
        },
        `S3 text upload completed in ${duration}ms`
      )

      return {
        success: true,
        bucket: this.bucket,
        key,
        location: `s3://${this.bucket}/${key}`,
        fileId: uploadId,
        filename,
        size: textContent.length,
        contentType: 'text/plain'
      }
    } catch (error) {
      const endTime = performance.now()
      const duration = Math.round(endTime - startTime)

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

      throw new Error(`S3 text upload failed: ${error.message}`)
    }
  }
}

export const s3Uploader = new S3Uploader()
