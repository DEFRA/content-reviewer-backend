import { randomUUID } from 'crypto'
import { config } from '../config.js'
import { reviewRepository } from '../common/helpers/review-repository.js'
import { sqsClient } from '../common/helpers/sqs-client.js'
import { s3Uploader } from '../common/helpers/s3-uploader.js'
import mime from 'mime-types'

/**
 * Review routes - Async review processing
 * Supports both file uploads and direct text input
 */
export const reviewRoutes = {
  plugin: {
    name: 'review-routes',
    register: async (server) => {
      /**
       * POST /api/review/file
       * Submit a file for review (async)
       */
      server.route({
        method: 'POST',
        path: '/api/review/file',
        options: {
          payload: {
            maxBytes: config.get('upload.maxFileSize'),
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
          const requestStartTime = performance.now()

          try {
            const data = request.payload

            request.logger.info(
              {
                endpoint: '/api/review/file',
                hasFile: !!data?.file,
                payloadKeys: data ? Object.keys(data) : []
              },
              'File review request received'
            )

            if (!data || !data.file) {
              request.logger.warn(
                {
                  endpoint: '/api/review/file',
                  error: 'No file provided'
                },
                'File review request rejected - no file'
              )

              return h
                .response({
                  success: false,
                  error: 'No file provided'
                })
                .code(400)
            }

            const file = data.file
            const reviewId = `review_${Date.now()}_${randomUUID()}`

            request.logger.info(
              {
                reviewId,
                filename: file.hapi.filename,
                contentType: file.hapi.headers['content-type']
              },
              'Processing file review request'
            )

            // Validate file type
            const allowedMimeTypes = config.get('upload.allowedMimeTypes')
            const detectedMimeType =
              mime.lookup(file.hapi.filename) || 'application/octet-stream'

            if (!allowedMimeTypes.includes(detectedMimeType)) {
              request.logger.warn(
                {
                  reviewId,
                  filename: file.hapi.filename,
                  detectedMimeType,
                  allowedMimeTypes
                },
                'File type not allowed'
              )

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

            request.logger.info(
              {
                reviewId,
                filename: file.hapi.filename,
                fileSize: buffer.length
              },
              'File buffer read successfully'
            )

            // Validate file size
            if (buffer.length > config.get('upload.maxFileSize')) {
              request.logger.warn(
                {
                  reviewId,
                  filename: file.hapi.filename,
                  fileSize: buffer.length,
                  maxFileSize: config.get('upload.maxFileSize')
                },
                'File size exceeds limit'
              )

              return h
                .response({
                  success: false,
                  error: `File too large. Maximum size: ${config.get('upload.maxFileSize') / 1024 / 1024}MB`
                })
                .code(400)
            }

            // Upload to S3
            const fileObject = {
              originalname: file.hapi.filename,
              mimetype: detectedMimeType,
              size: buffer.length,
              buffer
            }

            const s3Result = await s3Uploader.uploadFile(fileObject, reviewId)

            // Create review record in MongoDB
            await reviewRepository.createReview({
              id: reviewId,
              sourceType: 'file',
              fileName: file.hapi.filename,
              fileSize: buffer.length,
              mimeType: detectedMimeType,
              s3Key: s3Result.key
            })

            request.logger.info(
              {
                reviewId,
                filename: file.hapi.filename,
                s3Key: s3Result.key
              },
              'Review record created in database'
            )

            // Queue review job in SQS
            await sqsClient.sendMessage({
              uploadId: reviewId,
              reviewId,
              filename: file.hapi.filename,
              s3Bucket: s3Result.bucket,
              s3Key: s3Result.key,
              s3Location: s3Result.location,
              contentType: detectedMimeType,
              fileSize: buffer.length,
              messageType: 'file_review',
              userId: request.headers['x-user-id'] || 'anonymous',
              sessionId: request.headers['x-session-id'] || null
            })

            const requestEndTime = performance.now()
            const requestDuration = Math.round(
              requestEndTime - requestStartTime
            )

            request.logger.info(
              {
                reviewId,
                filename: file.hapi.filename,
                fileSize: buffer.length,
                s3Key: s3Result.key,
                durationMs: requestDuration
              },
              `File review queued successfully in ${requestDuration}ms`
            )

            return h
              .response({
                success: true,
                reviewId,
                status: 'pending',
                message: 'Review queued for processing'
              })
              .code(202)
          } catch (error) {
            const requestEndTime = performance.now()
            const requestDuration = Math.round(
              requestEndTime - requestStartTime
            )

            request.logger.error(
              {
                error: error.message,
                errorName: error.name,
                stack: error.stack,
                durationMs: requestDuration
              },
              `Failed to queue file review after ${requestDuration}ms`
            )

            return h
              .response({
                success: false,
                error: error.message || 'Failed to queue review'
              })
              .code(500)
          }
        }
      })

      /**
       * POST /api/review/text
       * Submit text content for review (async)
       */
      server.route({
        method: 'POST',
        path: '/api/review/text',
        options: {
          payload: {
            maxBytes: 1024 * 1024, // 1MB max for text
            parse: true
          },
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          }
        },
        handler: async (request, h) => {
          const requestStartTime = performance.now()

          try {
            const { content, title } = request.payload

            request.logger.info(
              {
                endpoint: '/api/review/text',
                hasContent: !!content,
                contentLength: content?.length,
                title: title || 'untitled'
              },
              'Text review request received'
            )

            if (!content || typeof content !== 'string') {
              request.logger.warn(
                {
                  endpoint: '/api/review/text',
                  error: 'Content is required and must be a string'
                },
                'Text review request rejected - invalid content'
              )

              return h
                .response({
                  success: false,
                  error: 'Content is required and must be a string'
                })
                .code(400)
            }

            if (content.length < 10) {
              request.logger.warn(
                {
                  endpoint: '/api/review/text',
                  contentLength: content.length
                },
                'Text review request rejected - content too short'
              )

              return h
                .response({
                  success: false,
                  error: 'Content must be at least 10 characters'
                })
                .code(400)
            }

            if (content.length > 100000) {
              request.logger.warn(
                {
                  endpoint: '/api/review/text',
                  contentLength: content.length
                },
                'Text review request rejected - content too long'
              )

              return h
                .response({
                  success: false,
                  error: 'Content must not exceed 100,000 characters'
                })
                .code(400)
            }

            const reviewId = `review_${Date.now()}_${randomUUID()}`

            request.logger.info(
              {
                reviewId,
                contentLength: content.length,
                title: title || 'Text Content'
              },
              'Processing text review request'
            )

            // Upload text content to S3 (following reference architecture)
            const s3Result = await s3Uploader.uploadTextContent(
              content,
              reviewId,
              title || 'Text Content'
            )

            request.logger.info(
              {
                reviewId,
                s3Key: s3Result.key,
                contentLength: content.length
              },
              'Text content uploaded to S3'
            )

            // Create review record in MongoDB (store S3 reference, not full content)
            await reviewRepository.createReview({
              id: reviewId,
              sourceType: 'text',
              fileName: title || 'Text Content',
              fileSize: content.length,
              mimeType: 'text/plain',
              s3Key: s3Result.key
            })

            request.logger.info(
              {
                reviewId,
                s3Key: s3Result.key
              },
              'Review record created in database'
            )

            // Queue review job in SQS (send only reference, not content)
            await sqsClient.sendMessage({
              uploadId: reviewId,
              reviewId,
              filename: title || 'Text Content',
              messageType: 'text_review',
              s3Bucket: s3Result.bucket,
              s3Key: s3Result.key,
              s3Location: s3Result.location,
              contentType: 'text/plain',
              fileSize: content.length,
              userId: request.headers['x-user-id'] || 'anonymous',
              sessionId: request.headers['x-session-id'] || null
            })

            const requestEndTime = performance.now()
            const requestDuration = Math.round(
              requestEndTime - requestStartTime
            )

            request.logger.info(
              {
                reviewId,
                contentLength: content.length,
                s3Key: s3Result.key,
                durationMs: requestDuration
              },
              `Text review queued successfully in ${requestDuration}ms`
            )

            return h
              .response({
                success: true,
                reviewId,
                status: 'pending',
                message: 'Review queued for processing'
              })
              .code(202)
          } catch (error) {
            const requestEndTime = performance.now()
            const requestDuration = Math.round(
              requestEndTime - requestStartTime
            )

            request.logger.error(
              {
                error: error.message,
                errorName: error.name,
                stack: error.stack,
                durationMs: requestDuration
              },
              `Failed to queue text review after ${requestDuration}ms`
            )

            return h
              .response({
                success: false,
                error: error.message || 'Failed to queue text review'
              })
              .code(500)
          }
        }
      })

      /**
       * GET /api/review/:id
       * Get review status and result
       */
      server.route({
        method: 'GET',
        path: '/api/review/{id}',
        options: {
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          }
        },
        handler: async (request, h) => {
          const requestStartTime = performance.now()

          try {
            const { id } = request.params

            request.logger.info(
              {
                reviewId: id,
                endpoint: '/api/review/{id}'
              },
              'Review status request received'
            )

            const review = await reviewRepository.getReview(id)

            if (!review) {
              request.logger.warn(
                {
                  reviewId: id
                },
                'Review not found'
              )

              return h
                .response({
                  success: false,
                  error: 'Review not found'
                })
                .code(404)
            }

            const requestEndTime = performance.now()
            const requestDuration = Math.round(
              requestEndTime - requestStartTime
            )

            request.logger.info(
              {
                reviewId: id,
                status: review.status,
                sourceType: review.sourceType,
                hasResult: !!review.result,
                hasError: !!review.error,
                durationMs: requestDuration
              },
              `Review status retrieved in ${requestDuration}ms`
            )

            // Return review without internal fields
            return h
              .response({
                success: true,
                data: {
                  id: review.id || review._id, // S3 uses 'id', MongoDB used '_id'
                  status: review.status,
                  sourceType: review.sourceType,
                  fileName: review.fileName,
                  fileSize: review.fileSize,
                  createdAt: review.createdAt,
                  updatedAt: review.updatedAt,
                  result: review.result,
                  error: review.error,
                  processingTime:
                    review.processingCompletedAt && review.processingStartedAt
                      ? new Date(review.processingCompletedAt).getTime() -
                        new Date(review.processingStartedAt).getTime()
                      : null
                }
              })
              .code(200)
          } catch (error) {
            const requestEndTime = performance.now()
            const requestDuration = Math.round(
              requestEndTime - requestStartTime
            )

            request.logger.error(
              {
                error: error.message,
                errorName: error.name,
                reviewId: request.params.id,
                durationMs: requestDuration
              },
              `Failed to retrieve review after ${requestDuration}ms`
            )

            return h
              .response({
                success: false,
                error: 'Failed to retrieve review'
              })
              .code(500)
          }
        }
      })

      /**
       * GET /api/reviews
       * Get all reviews (history)
       */
      server.route({
        method: 'GET',
        path: '/api/reviews',
        options: {
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          }
        },
        handler: async (request, h) => {
          try {
            const limit = parseInt(request.query.limit) || 50
            const skip = parseInt(request.query.skip) || 0

            const reviews = await reviewRepository.getAllReviews(limit, skip)
            const totalCount = await reviewRepository.getReviewCount()

            // Format reviews for response
            const formattedReviews = reviews.map((review) => ({
              id: review.id || review._id, // S3 uses 'id', MongoDB used '_id'
              reviewId: review.id || review._id, // For frontend compatibility
              status: review.status,
              sourceType: review.sourceType,
              fileName: review.fileName,
              filename: review.fileName, // For frontend compatibility (lowercase)
              fileSize: review.fileSize,
              createdAt: review.createdAt,
              uploadedAt: review.createdAt, // For frontend compatibility
              updatedAt: review.updatedAt,
              hasResult: !!review.result,
              hasError: !!review.error,
              processingTime:
                review.processingCompletedAt && review.processingStartedAt
                  ? Math.round(
                      (new Date(review.processingCompletedAt).getTime() -
                        new Date(review.processingStartedAt).getTime()) /
                        1000
                    )
                  : null
            }))

            return h
              .response({
                success: true,
                reviews: formattedReviews,
                pagination: {
                  total: totalCount,
                  limit,
                  skip,
                  returned: formattedReviews.length
                }
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              {
                error: error.message
              },
              'Failed to get reviews'
            )

            return h
              .response({
                success: false,
                error: 'Failed to retrieve reviews'
              })
              .code(500)
          }
        }
      })
    }
  }
}
