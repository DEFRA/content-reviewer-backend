import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { reviewRepository } from '../common/helpers/review-repository.js'
import { sqsClient } from '../common/helpers/sqs-client.js'
import { s3Uploader } from '../common/helpers/s3-uploader.js'

// HTTP Status Codes
const HTTP_STATUS = {
  OK: 200,
  ACCEPTED: 202,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500
}

// Constants
const ENDPOINTS = {
  REVIEW_TEXT: '/api/review/text',
  REVIEW_BY_ID: '/api/review/{id}',
  REVIEWS_LIST: '/api/reviews',
  REVIEWS_DELETE: '/api/reviews/{reviewId}'
}

const CORS_CONFIG_KEYS = {
  ORIGIN: 'cors.origin',
  CREDENTIALS: 'cors.credentials'
}

const CONTENT_DEFAULTS = {
  TITLE: 'Text Content',
  MIN_LENGTH: 10
}

const PAGINATION_DEFAULTS = {
  LIMIT: 50,
  SKIP: 0
}

const CONTENT_TYPES = {
  TEXT_PLAIN: 'text/plain'
}

const MESSAGE_TYPES = {
  TEXT_REVIEW: 'text_review'
}

const SOURCE_TYPES = {
  TEXT: 'text'
}

const REVIEW_STATUSES = {
  PENDING: 'pending',
  FAILED: 'failed'
}

const ERROR_CODES = {
  SQS_SEND_FAILED: 'SQS_SEND_FAILED'
}

/**
 * Review routes - Async review processing
 * Supports both file uploads and direct text input
 */

// ============ VALIDATION HELPERS ============

/**
 * Validates text content from request payload
 * @param {Object} payload - Request payload
 * @param {Object} logger - Request logger
 * @returns {Object} Validation result with error info if invalid
 */
function validateTextContent(payload, logger) {
  const { content, title } = payload

  if (!content || typeof content !== 'string') {
    logger.warn(
      {
        endpoint: ENDPOINTS.REVIEW_TEXT,
        error: 'Content is required and must be a string'
      },
      'Text review request rejected - invalid content'
    )
    return {
      valid: false,
      error: 'Content is required and must be a string',
      statusCode: HTTP_STATUS.BAD_REQUEST
    }
  }

  if (content.length < CONTENT_DEFAULTS.MIN_LENGTH) {
    logger.warn(
      {
        endpoint: ENDPOINTS.REVIEW_TEXT,
        contentLength: content.length
      },
      'Text review request rejected - content too short'
    )
    return {
      valid: false,
      error: `Content must be at least ${CONTENT_DEFAULTS.MIN_LENGTH} characters`,
      statusCode: HTTP_STATUS.BAD_REQUEST
    }
  }

  const maxCharLength = config.get('contentReview.maxCharLength')
  if (content.length > maxCharLength) {
    logger.warn(
      {
        endpoint: ENDPOINTS.REVIEW_TEXT,
        contentLength: content.length,
        maxCharLength
      },
      'Text review request rejected - content too long'
    )
    return {
      valid: false,
      error: `Content must not exceed ${maxCharLength.toLocaleString()} characters`,
      statusCode: HTTP_STATUS.BAD_REQUEST
    }
  }

  return { valid: true, content, title }
}

// ============ S3 UPLOAD HELPERS ============

/**
 * Uploads text content to S3
 * @param {string} content - Text content to upload
 * @param {string} reviewId - Review ID
 * @param {string} title - Content title
 * @param {Object} logger - Request logger
 * @returns {Object} S3 upload result with duration
 */
async function uploadTextToS3(content, reviewId, title, logger) {
  const s3UploadStart = performance.now()
  const s3Result = await s3Uploader.uploadTextContent(
    content,
    reviewId,
    title || CONTENT_DEFAULTS.TITLE
  )
  const s3UploadDuration = Math.round(performance.now() - s3UploadStart)

  logger.info(
    {
      reviewId,
      s3Key: s3Result.key,
      contentLength: content.length,
      durationMs: s3UploadDuration
    },
    `⏱️ [STEP 2/6] Text content uploaded to S3 - COMPLETED in ${s3UploadDuration}ms`
  )

  return { s3Result, s3UploadDuration }
}

// ============ DATABASE HELPERS ============

/**
 * Creates review record in database
 * @param {string} reviewId - Review ID
 * @param {Object} s3Result - S3 upload result
 * @param {string} title - Content title
 * @param {number} contentLength - Content length in bytes
 * @param {Object} logger - Request logger
 * @returns {number} Database creation duration in ms
 */
async function createReviewRecord(
  reviewId,
  s3Result,
  title,
  contentLength,
  logger
) {
  const dbCreateStart = performance.now()
  await reviewRepository.createReview({
    id: reviewId,
    sourceType: SOURCE_TYPES.TEXT,
    fileName: title || CONTENT_DEFAULTS.TITLE,
    fileSize: contentLength,
    mimeType: CONTENT_TYPES.TEXT_PLAIN,
    s3Key: s3Result.key
  })
  const dbCreateDuration = Math.round(performance.now() - dbCreateStart)

  logger.info(
    {
      reviewId,
      s3Key: s3Result.key,
      fileName: title || CONTENT_DEFAULTS.TITLE,
      title,
      filename: title || CONTENT_DEFAULTS.TITLE,
      durationMs: dbCreateDuration
    },
    `⏱️ [STEP 3/6] Review record created in S3 repository - COMPLETED in ${dbCreateDuration}ms`
  )

  return dbCreateDuration
}

// ============ SQS QUEUE HELPERS ============

/**
 * Sends review message to SQS queue
 * @param {string} reviewId - Review ID
 * @param {Object} s3Result - S3 upload result
 * @param {string} title - Content title
 * @param {number} contentLength - Content length in bytes
 * @param {Object} headers - Request headers
 * @param {Object} logger - Request logger
 * @returns {number} SQS send duration in ms
 */
async function queueReviewJob(
  reviewId,
  s3Result,
  title,
  contentLength,
  headers,
  logger
) {
  const sqsSendStart = performance.now()

  try {
    await sqsClient.sendMessage({
      uploadId: reviewId,
      reviewId,
      filename: title || CONTENT_DEFAULTS.TITLE,
      messageType: MESSAGE_TYPES.TEXT_REVIEW,
      s3Bucket: s3Result.bucket,
      s3Key: s3Result.key,
      s3Location: s3Result.location,
      contentType: CONTENT_TYPES.TEXT_PLAIN,
      fileSize: contentLength,
      userId: headers['x-user-id'] || 'anonymous',
      sessionId: headers['x-session-id'] || null
    })

    const sqsSendDuration = Math.round(performance.now() - sqsSendStart)

    logger.info(
      {
        reviewId,
        sqsQueue: 'content_review_queue',
        durationMs: sqsSendDuration
      },
      `⏱️ [STEP 4/6] SQS message sent successfully - COMPLETED in ${sqsSendDuration}ms`
    )

    return sqsSendDuration
  } catch (sqsError) {
    logger.error(
      {
        reviewId,
        error: sqsError.message,
        errorName: sqsError.name,
        stack: sqsError.stack
      },
      'Failed to send SQS message - marking review as failed'
    )

    await reviewRepository.updateReviewStatus(
      reviewId,
      REVIEW_STATUSES.FAILED,
      {
        error: {
          message: `Failed to queue review: ${sqsError.message}`,
          code: ERROR_CODES.SQS_SEND_FAILED,
          timestamp: new Date().toISOString()
        }
      }
    )

    throw sqsError
  }
}

// ============ TEXT REVIEW HANDLER HELPERS ============

/**
 * Processes text review submission
 * @param {Object} payload - Request payload with content and title
 * @param {Object} headers - Request headers
 * @param {Object} logger - Request logger
 * @returns {Object} Processing result with reviewId and timings
 */
async function processTextReviewSubmission(payload, headers, logger) {
  const { content, title } = payload

  const reviewId = `review_${randomUUID()}`

  logger.info(
    {
      reviewId,
      contentLength: content.length,
      title: title || CONTENT_DEFAULTS.TITLE
    },
    '⏱️ [STEP 1/6] Processing text review request - START'
  )

  // Upload text content to S3
  const { s3Result, s3UploadDuration } = await uploadTextToS3(
    content,
    reviewId,
    title,
    logger
  )

  // Create review record in database
  const dbCreateDuration = await createReviewRecord(
    reviewId,
    s3Result,
    title,
    content.length,
    logger
  )

  // Queue review job in SQS
  const sqsSendDuration = await queueReviewJob(
    reviewId,
    s3Result,
    title,
    content.length,
    headers,
    logger
  )

  return {
    reviewId,
    s3Result,
    timings: {
      s3UploadDuration,
      dbCreateDuration,
      sqsSendDuration
    }
  }
}

// ============ RESPONSE HELPERS ============

/**
 * Calculates processing time between two timestamps
 * @param {Date|string} completedAt - Processing completed timestamp
 * @param {Date|string} startedAt - Processing started timestamp
 * @returns {number|null} Processing time in ms or null if not available
 */
function calculateProcessingTime(completedAt, startedAt) {
  if (!completedAt || !startedAt) {
    return null
  }
  return new Date(completedAt).getTime() - new Date(startedAt).getTime()
}

/**
 * Formats a review record for API response
 * @param {Object} review - Review record from database
 * @returns {Object} Formatted review data
 */
function formatReviewForResponse(review) {
  return {
    id: review.id || review._id,
    status: review.status,
    sourceType: review.sourceType,
    fileName: review.fileName,
    fileSize: review.fileSize,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    result: review.result,
    error: review.error,
    processingTime: calculateProcessingTime(
      review.processingCompletedAt,
      review.processingStartedAt
    )
  }
}

/**
 * Derives review ID from various possible fields
 * @param {Object} review - Review record
 * @returns {string|undefined} Derived ID
 */
function deriveReviewId(review) {
  return review.id || review._id || review.jobId
}

/**
 * Checks if review has default or missing fileName
 * @param {Object} review - Review record
 * @returns {boolean} True if fileName is default or missing
 */
function hasDefaultFileName(review) {
  return !review.fileName || review.fileName === CONTENT_DEFAULTS.TITLE
}

/**
 * Calculates processing time in seconds for review list
 * @param {Date|string} completedAt - Processing completed timestamp
 * @param {Date|string} startedAt - Processing started timestamp
 * @returns {number|null} Processing time in seconds or null
 */
function calculateProcessingTimeInSeconds(completedAt, startedAt) {
  if (!completedAt || !startedAt) {
    return null
  }
  return Math.round(
    (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
  )
}

/**
 * Formats a review record for review list API response
 * @param {Object} review - Review record from database
 * @param {Object} logger - Request logger for warnings
 * @returns {Object} Formatted review data
 */
function formatReviewForList(review, logger) {
  const derivedId = deriveReviewId(review)

  if (!derivedId) {
    logger.warn(
      { s3Key: review.s3Key },
      'Review missing id/reviewId; could not derive from s3Key'
    )
  }

  if (hasDefaultFileName(review)) {
    logger.warn(
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
    logger.warn(
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
    filename: review.fileName,
    fileSize: review.fileSize,
    createdAt: review.createdAt,
    uploadedAt: review.createdAt,
    updatedAt: review.updatedAt,
    hasResult: !!review.result,
    hasError: !!review.error,
    errorMessage: review.error?.message || review.error || null,
    processingTime: calculateProcessingTimeInSeconds(
      review.processingCompletedAt,
      review.processingStartedAt
    )
  }
}

/**
 * Determines appropriate error status code based on error message
 * @param {string} errorMessage - Error message
 * @returns {number} HTTP status code
 */
function getErrorStatusCode(errorMessage) {
  return errorMessage.includes('not found')
    ? HTTP_STATUS.NOT_FOUND
    : HTTP_STATUS.INTERNAL_SERVER_ERROR
}

/**
 * Gets CORS configuration object
 * @returns {Object} CORS configuration
 */
function getCorsConfig() {
  return {
    origin: config.get(CORS_CONFIG_KEYS.ORIGIN),
    credentials: config.get(CORS_CONFIG_KEYS.CREDENTIALS)
  }
}

// ============ MAIN ROUTE EXPORTS ============
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
        path: ENDPOINTS.REVIEW_TEXT,
        options: {
          payload: {
            maxBytes: 1024 * 1024, // 1MB max for text
            parse: true
          },
          cors: getCorsConfig()
        },
        handler: async (request, h) => {
          const requestStartTime = performance.now()

          try {
            const { content, title } = request.payload

            request.logger.info(
              {
                endpoint: ENDPOINTS.REVIEW_TEXT,
                hasContent: !!content,
                contentLength: content?.length,
                hasTitle: !!title,
                title: title || 'untitled',
                titleLength: title?.length
              },
              `Text review request received with title: "${title || 'NO TITLE PROVIDED'}"`
            )

            // Validate text content
            const validation = validateTextContent(
              request.payload,
              request.logger
            )
            if (!validation.valid) {
              return h
                .response({
                  success: false,
                  error: validation.error
                })
                .code(validation.statusCode)
            }

            // Process text review submission (upload, record, queue)
            const { reviewId, s3Result, timings } =
              await processTextReviewSubmission(
                request.payload,
                request.headers,
                request.logger
              )

            const requestEndTime = performance.now()
            const requestDuration = Math.round(
              requestEndTime - requestStartTime
            )

            request.logger.info(
              {
                reviewId,
                contentLength: content.length,
                s3Key: s3Result.key,
                totalDurationMs: requestDuration,
                ...timings,
                endpoint: ENDPOINTS.REVIEW_TEXT
              },
              `⏱️ [UPLOAD PHASE] Text review queued successfully - TOTAL: ${requestDuration}ms (S3: ${timings.s3UploadDuration}ms, DB: ${timings.dbCreateDuration}ms, SQS: ${timings.sqsSendDuration}ms)`
            )

            return h
              .response({
                success: true,
                reviewId,
                status: REVIEW_STATUSES.PENDING,
                message: 'Review queued for processing'
              })
              .code(HTTP_STATUS.ACCEPTED)
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
              .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          }
        }
      })

      /**
       * GET /api/review/:id
       * Get review status and result
       */
      server.route({
        method: 'GET',
        path: ENDPOINTS.REVIEW_BY_ID,
        options: {
          cors: getCorsConfig()
        },
        handler: async (request, h) => {
          const requestStartTime = performance.now()

          try {
            const { id } = request.params

            request.logger.info(
              {
                reviewId: id,
                endpoint: ENDPOINTS.REVIEW_BY_ID
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
                .code(HTTP_STATUS.NOT_FOUND)
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
                data: formatReviewForResponse(review)
              })
              .code(HTTP_STATUS.OK)
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
              .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          }
        }
      })

      /**
       * GET /api/reviews
       * Get all reviews (history)
       */
      server.route({
        method: 'GET',
        path: ENDPOINTS.REVIEWS_LIST,
        options: {
          cors: getCorsConfig()
        },
        handler: async (request, h) => {
          request.logger.info(
            { query: request.query },
            `${ENDPOINTS.REVIEWS_LIST} request received`
          )

          try {
            const limit =
              Number.parseInt(request.query.limit, 10) ||
              PAGINATION_DEFAULTS.LIMIT
            const skip =
              Number.parseInt(request.query.skip, 10) ||
              PAGINATION_DEFAULTS.SKIP

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
            const formattedReviews = reviews.map((review) =>
              formatReviewForList(review, request.logger)
            )

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
              .code(HTTP_STATUS.OK)
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
              .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          }
        }
      })

      /**
       * DELETE /api/reviews/:reviewId
       * Delete a review and its associated S3 content
       */
      server.route({
        method: 'DELETE',
        path: ENDPOINTS.REVIEWS_DELETE,
        options: {
          cors: getCorsConfig()
        },
        handler: async (request, h) => {
          const { reviewId } = request.params

          request.logger.info(
            { reviewId },
            `DELETE ${ENDPOINTS.REVIEWS_DELETE} request received`
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
              .code(HTTP_STATUS.OK)
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
            const statusCode = getErrorStatusCode(error.message)

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
