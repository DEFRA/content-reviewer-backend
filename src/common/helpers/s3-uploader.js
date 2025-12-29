import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { config } from '../../config.js'

/**
 * S3 Client for file uploads
 */
class S3Uploader {
  constructor() {
    this.s3Client = new S3Client({
      region: config.get('upload.region')
    })
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
