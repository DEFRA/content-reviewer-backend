import multer from 'multer'
import { randomUUID } from 'crypto'
import mime from 'mime-types'
import { config } from '../config.js'
import { s3Uploader } from '../common/helpers/s3-uploader.js'
import { sqsClient } from '../common/helpers/sqs-client.js'
import { reviewRepository } from '../common/helpers/review-repository.js'

// Configure multer for memory storage (used for validation reference)
const storage = multer.memoryStorage()

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = config.get('upload.allowedMimeTypes')

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true)
  } else {
    cb(
      new Error(`File type not allowed. Accepted types: PDF, Word documents`),
      false
    )
  }
}

// Multer configuration (for reference - Hapi handles multipart natively)
multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10485760 // 10MB
  }
})

/**
 * Upload route plugin
 */
export const uploadRoutes = {
  plugin: {
    name: 'upload-routes',
    register: async (server) => {
      /**
       * POST /api/upload
       * Upload a file
       */
      server.route({
        method: 'POST',
        path: '/api/upload',
        options: {
          payload: {
            maxBytes: 10485760, // 10MB
            output: 'stream',
            parse: true,
            multipart: true,
            allow: 'multipart/form-data'
          },
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          }
        },
        handler: async (request, h) => {
          try {
            const data = request.payload

            // Log payload for debugging
            request.logger.info(
              {
                payloadKeys: data ? Object.keys(data) : 'null',
                hasFile: data ? !!data.file : false
              },
              'Upload request received'
            )

            if (!data || !data.file) {
              return h
                .response({
                  success: false,
                  error:
                    'No file provided. Received fields: ' +
                    (data ? Object.keys(data).join(', ') : 'none')
                })
                .code(400)
            }

            const file = data.file
            const uploadId = randomUUID()

            // Validate file type
            const allowedMimeTypes = config.get('upload.allowedMimeTypes')
            const detectedMimeType =
              mime.lookup(file.hapi.filename) || 'application/octet-stream'

            if (!allowedMimeTypes.includes(detectedMimeType)) {
              return h
                .response({
                  success: false,
                  error: `File type not allowed. Accepted types: PDF, Word documents. Detected: ${detectedMimeType}`
                })
                .code(400)
            }

            // Read file buffer
            const chunks = []
            for await (const chunk of file) {
              chunks.push(chunk)
            }
            const buffer = Buffer.concat(chunks)

            // Validate file size
            if (buffer.length > 10485760) {
              return h
                .response({
                  success: false,
                  error: `File too large. Maximum size: ${10485760 / 1024 / 1024}MB`
                })
                .code(400)
            }

            // Prepare file object for S3 upload
            const fileObject = {
              originalname: file.hapi.filename,
              mimetype: detectedMimeType,
              size: buffer.length,
              buffer
            }

            // Upload to S3
            const result = await s3Uploader.uploadFile(fileObject, uploadId)

            request.logger.info(
              {
                uploadId,
                filename: file.hapi.filename,
                size: buffer.length,
                s3Location: result.location
              },
              'File uploaded to S3 successfully'
            )

            // Create review record with pending status
            const reviewId = `review_${randomUUID()}`

            await reviewRepository.createReview({
              id: reviewId,
              sourceType: 'file',
              fileName: result.filename,
              s3Bucket: result.bucket,
              s3Key: result.key,
              s3Location: result.location,
              contentType: result.contentType,
              fileSize: result.size,
              uploadId: result.fileId
            })

            request.logger.info(
              {
                reviewId,
                uploadId,
                filename: result.filename
              },
              'Review record created'
            )

            // Send message to SQS queue for processing
            try {
              const sqsResult = await sqsClient.sendMessage({
                reviewId, // Include reviewId in SQS message
                uploadId: result.fileId,
                filename: result.filename,
                s3Bucket: result.bucket,
                s3Key: result.key,
                s3Location: result.location,
                contentType: result.contentType,
                fileSize: result.size,
                messageType: 'file_upload',
                userId: request.headers['x-user-id'] || 'anonymous',
                sessionId: request.headers['x-session-id'] || null
              })

              request.logger.info(
                {
                  reviewId,
                  uploadId,
                  messageId: sqsResult.messageId,
                  queueUrl: sqsResult.queueUrl
                },
                'Message sent to SQS queue for AI review'
              )
            } catch (sqsError) {
              // Log but don't fail the upload if SQS fails
              request.logger.error(
                {
                  reviewId,
                  uploadId,
                  error: sqsError.message
                },
                'Failed to send message to SQS queue, but file upload succeeded'
              )
            }

            return h
              .response({
                success: true,
                reviewId, // Return reviewId for frontend redirect
                uploadId: result.fileId,
                filename: result.filename,
                size: result.size,
                contentType: result.contentType,
                s3Bucket: result.bucket,
                s3Key: result.key,
                s3Location: result.location
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              {
                error,
                errorMessage: error.message,
                errorStack: error.stack,
                errorName: error.name
              },
              'File upload failed'
            )

            return h
              .response({
                success: false,
                error: error.message || 'Upload failed'
              })
              .code(500)
          }
        }
      })

      /**
       * GET /api/upload/health
       * Health check for upload service
       */
      server.route({
        method: 'GET',
        path: '/api/upload/health',
        options: {
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          }
        },
        handler: async (request, h) => {
          return h
            .response({
              status: 'ok',
              service: 'upload',
              bucket: config.get('upload.s3Bucket'),
              maxFileSize: config.get('upload.maxFileSize'),
              allowedTypes: config.get('upload.allowedMimeTypes')
            })
            .code(200)
        }
      })
    }
  }
}
