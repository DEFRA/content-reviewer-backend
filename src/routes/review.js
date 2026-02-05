import { randomUUID } from 'crypto'
import { config } from '../config.js'
import { reviewRepository } from '../common/helpers/review-repository.js'
import { sqsClient } from '../common/helpers/sqs-client.js'
import { s3Uploader } from '../common/helpers/s3-uploader.js'

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
       * COMMENTED OUT - File upload functionality disabled for demo
       */
      /* server.route({
        method: 'POST',
        path: '/api/review/file',
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
            const reviewId = `review_${randomUUID()}`

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
            if (buffer.length > 10485760) {
              request.logger.warn(
                {
                  reviewId,
                  filename: file.hapi.filename,
                  fileSize: buffer.length,
                  maxFileSize: 10485760
                },
                'File size exceeds limit'
              )

              return h
                .response({
                  success: false,
                  error: `File too large. Maximum size: ${10485760 / 1024 / 1024}MB`
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
      }) */

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
                hasTitle: !!title,
                title: title || 'untitled',
                titleLength: title?.length
              },
              `Text review request received with title: "${title || 'NO TITLE PROVIDED'}"`
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

            const reviewId = `review_${randomUUID()}`

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
                s3Key: s3Result.key,
                fileName: title || 'Text Content',
                title,
                filename: title || 'Text Content'
              },
              `Review record created in database with fileName: ${title}`
            )

            // Queue review job in SQS (send only reference, not content)
            try {
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

              request.logger.info(
                { reviewId, sqsQueue: 'content_review_queue' },
                'SQS message sent successfully'
              )
            } catch (sqsError) {
              request.logger.error(
                {
                  reviewId,
                  error: sqsError.message,
                  errorName: sqsError.name,
                  stack: sqsError.stack
                },
                'Failed to send SQS message - marking review as failed'
              )

              // Mark review as failed if SQS send fails
              await reviewRepository.updateReviewStatus(reviewId, 'failed', {
                error: {
                  message: `Failed to queue review: ${sqsError.message}`,
                  code: 'SQS_SEND_FAILED',
                  timestamp: new Date().toISOString()
                }
              })

              throw sqsError
            }

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
              `Text review queued successfully in ${requestDuration}ms from ${s3Result.key}`
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
          request.logger.info(
            { query: request.query },
            '/api/reviews request received'
          )

          try {
            const limit = parseInt(request.query.limit) || 50
            const skip = parseInt(request.query.skip) || 0

            request.logger.info(
              { limit, skip },
              'Fetching reviews from S3 repository'
            )

            const reviews = await reviewRepository.getAllReviews(limit, skip)
            request.logger.info(
              {
                count: reviews.length,
                reviewIds: reviews.map((r) => r.id),
                statuses: reviews.map((r) => r.status)
              },
              `Retrieved ${reviews.length} reviews from S3`
            )

            const totalCount = await reviewRepository.getReviewCount()
            request.logger.info(
              { totalCount },
              'Retrieved total review count from S3'
            )

            // Format reviews for response
            const formattedReviews = reviews.map((review) => {
              const derivedId = review.id || review._id || review.jobId

              if (!derivedId) {
                request.logger.warn(
                  { s3Key: review.s3Key },
                  'Review missing id/reviewId; could not derive from s3Key'
                )
              }

              if (!review.fileName || review.fileName === 'Text Content') {
                request.logger.warn(
                  {
                    reviewId: derivedId,
                    fileName: review.fileName,
                    status: review.status,
                    sourceType: review.sourceType
                  },
                  'Review has default or missing fileName'
                )
              }

              if (!review.createdAt) {
                request.logger.warn(
                  {
                    reviewId: derivedId,
                    createdAt: review.createdAt,
                    updatedAt: review.updatedAt,
                    status: review.status
                  },
                  'Review missing createdAt timestamp'
                )
              }

              return {
                id: derivedId,
                reviewId: derivedId,
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
                errorMessage: review.error?.message || review.error || null, // Extract error message from error object
                processingTime:
                  review.processingCompletedAt && review.processingStartedAt
                    ? Math.round(
                        (new Date(review.processingCompletedAt).getTime() -
                          new Date(review.processingStartedAt).getTime()) /
                          1000
                      )
                    : null
              }
            })

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

      /**
       * DELETE /api/reviews/:reviewId
       * Delete a review and its associated S3 content
       */
      server.route({
        method: 'DELETE',
        path: '/api/reviews/{reviewId}',
        options: {
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          }
        },
        handler: async (request, h) => {
          const { reviewId } = request.params

          request.logger.info(
            { reviewId },
            'DELETE /api/reviews/{reviewId} request received'
          )

          try {
            // Delete the review and associated content
            const result = await reviewRepository.deleteReview(reviewId)

            request.logger.info(
              {
                reviewId,
                deletedKeys: result.deletedKeys,
                deletedCount: result.deletedCount
              },
              'Review deleted successfully'
            )

            return h
              .response({
                success: true,
                message: `Review "${result.fileName || reviewId}" deleted successfully`,
                reviewId: result.reviewId,
                deletedCount: result.deletedCount,
                deletedKeys: result.deletedKeys
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              {
                reviewId,
                error: error.message,
                stack: error.stack
              },
              'Failed to delete review'
            )

            // Return appropriate error code
            const statusCode = error.message.includes('not found') ? 404 : 500

            return h
              .response({
                success: false,
                error: error.message,
                reviewId
              })
              .code(statusCode)
          }
        }
      })
    }
  }
}
