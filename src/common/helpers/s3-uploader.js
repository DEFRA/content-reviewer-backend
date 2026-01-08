import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { config } from '../../config.js'

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
        region: config.get('upload.region')
      }

      // Add endpoint for LocalStack if configured
      const awsEndpoint = process.env.AWS_ENDPOINT
      if (awsEndpoint) {
        s3Config.endpoint = awsEndpoint
        s3Config.forcePathStyle = true // Required for LocalStack
      }

      this.s3Client = new S3Client(s3Config)
    }

    this.bucket = config.get('upload.s3Bucket')
    this.pathPrefix = config.get('upload.s3Path')
  }

  /**
   * Upload file to S3
   * @param {Object} file - File object from multer
   * @param {string} uploadId - Unique upload ID
   * @returns {Promise<Object>} Upload result
   */
  async uploadFile(file, uploadId) {
    const key = `${this.pathPrefix}/${uploadId}/${file.originalname}`

    // Mock mode - simulate successful upload without actually uploading
    if (this.mockMode) {
      console.log(
        `[S3Uploader MOCK] Simulating upload of ${file.originalname} (${file.size} bytes)`
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
      throw new Error(`S3 upload failed: ${error.message}`)
    }
  }
}

export const s3Uploader = new S3Uploader()
