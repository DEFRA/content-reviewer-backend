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
          try {
            const data = request.payload

            if (!data || !data.file) {
              return h
                .response({
                  success: false,
                  error: 'No file provided'
                })
                .code(400)
            }

            const file = data.file
            const reviewId = `review_${Date.now()}_${randomUUID()}`

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
            if (buffer.length > config.get('upload.maxFileSize')) {
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

            // Queue review job in SQS
            await sqsClient.sendMessage({
              uploadId: reviewId,
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

            request.logger.info(
              {
                reviewId,
                filename: file.hapi.filename,
                size: buffer.length
              },
              'Review queued successfully'
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
            request.logger.error(
              {
                error: error.message,
                stack: error.stack
              },
              'Failed to queue review'
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

      // Shared handler for text review (supports both /api/review/text and /api/review-text)
      const textReviewHandler = async (request, h) => {
        try {
          // Support both 'content' and 'textContent' field names
          const { content, textContent, title } = request.payload
          const reviewContent = content || textContent

          if (!reviewContent || typeof reviewContent !== 'string') {
            return h
              .response({
                success: false,
                error:
                  'Content is required and must be a string (use "content" or "textContent" field)'
              })
              .code(400)
          }

          if (reviewContent.length < 10) {
            return h
              .response({
                success: false,
                error: 'Content must be at least 10 characters'
              })
              .code(400)
          }

          if (reviewContent.length > 100000) {
            return h
              .response({
                success: false,
                error: 'Content must not exceed 100,000 characters'
              })
              .code(400)
          }

          const reviewId = `review_${Date.now()}_${randomUUID()}`

          // Generate descriptive filename from content if no title provided
          const filename =
            title ||
            `Pasted Content (${reviewContent.substring(0, 50).replace(/\s+/g, ' ').trim()}${reviewContent.length > 50 ? '...' : ''})`

          // Create review record in MongoDB
          await reviewRepository.createReview({
            id: reviewId,
            sourceType: 'text',
            fileName: filename,
            textContent: reviewContent
          })

          // Queue review job in SQS
          await sqsClient.sendMessage({
            uploadId: reviewId,
            filename,
            messageType: 'text_review',
            textContent: reviewContent,
            contentType: 'text/plain',
            fileSize: reviewContent.length,
            userId: request.headers['x-user-id'] || 'anonymous',
            sessionId: request.headers['x-session-id'] || null
          })

          request.logger.info(
            {
              reviewId,
              contentLength: reviewContent.length,
              filename
            },
            'Text review queued successfully'
          )

          return h
            .response({
              success: true,
              reviewId,
              filename,
              status: 'pending',
              message: 'Review queued for processing'
            })
            .code(202)
        } catch (error) {
          request.logger.error(
            {
              error: error.message,
              stack: error.stack
            },
            'Failed to queue text review'
          )

          return h
            .response({
              success: false,
              error: error.message || 'Failed to queue text review'
            })
            .code(500)
        }
      }

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
        handler: textReviewHandler
      })

      /**
       * POST /api/review-text (alias for backward compatibility)
       * Submit text content for review (async)
       */
      server.route({
        method: 'POST',
        path: '/api/review-text',
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
        handler: textReviewHandler
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
          try {
            const { id } = request.params

            const review = await reviewRepository.getReview(id)

            if (!review) {
              return h
                .response({
                  success: false,
                  error: 'Review not found'
                })
                .code(404)
            }

            // Return review without internal fields
            return h
              .response({
                success: true,
                review: {
                  id: review._id,
                  status: review.status,
                  sourceType: review.sourceType,
                  fileName: review.fileName,
                  fileSize: review.fileSize,
                  createdAt: review.createdAt,
                  updatedAt: review.updatedAt,
                  result: review.result,
                  error: review.error,
                  processingTime: review.processingCompletedAt
                    ? review.processingCompletedAt - review.processingStartedAt
                    : null
                }
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              {
                error: error.message,
                reviewId: request.params.id
              },
              'Failed to get review'
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
                total: totalCount, // Add total at root level for compatibility
                pagination: {
                  total: totalCount,
                  limit,
                  skip,
                  returned: formattedReviews.length
                }
              })
              .type('application/json')
              .header('Content-Encoding', 'identity')
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
