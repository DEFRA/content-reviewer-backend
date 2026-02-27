import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { reviewRepository } from '../common/helpers/review-repository.js'
import { sqsClient } from '../common/helpers/sqs-client.js'
import { s3Uploader } from '../common/helpers/s3-uploader.js'

// ============ CONSTANTS ============

// HTTP Status Codes
export const HTTP_STATUS = {
  OK: 200,
  ACCEPTED: 202,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500
}

// Endpoints
export const ENDPOINTS = {
  REVIEW_TEXT: '/api/review/text',
  REVIEW_BY_ID: '/api/review/{id}',
  REVIEWS_LIST: '/api/reviews',
  REVIEWS_DELETE: '/api/reviews/{reviewId}'
}

// CORS Configuration Keys
const CORS_CONFIG_KEYS = {
  ORIGIN: 'cors.origin',
  CREDENTIALS: 'cors.credentials'
}

// Content Defaults
export const CONTENT_DEFAULTS = {
  TITLE: 'Text Content',
  MIN_LENGTH: 10
}

// Pagination Defaults
export const PAGINATION_DEFAULTS = {
  LIMIT: 50,
  SKIP: 0
}

// Content Types
const CONTENT_TYPES = {
  TEXT_PLAIN: 'text/plain'
}

// Message Types
const MESSAGE_TYPES = {
  TEXT_REVIEW: 'text_review'
}

// Source Types
const SOURCE_TYPES = {
  TEXT: 'text'
}

// Review Statuses
export const REVIEW_STATUSES = {
  PENDING: 'pending',
  FAILED: 'failed'
}

// Error Codes
const ERROR_CODES = {
  SQS_SEND_FAILED: 'SQS_SEND_FAILED'
}

// ============ VALIDATION HELPERS ============

/**
 * Validates text content from request payload
 * @param {Object} payload - Request payload
 * @param {Object} logger - Request logger
 * @returns {Object} Validation result with error info if invalid
 */
export function validateTextContent(payload, logger) {
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
 * @returns {Promise<Object>} S3 upload result with duration
 */
export async function uploadTextToS3(content, reviewId, title, logger) {
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
    `[STEP 2/6] Text content uploaded to S3 - COMPLETED in ${s3UploadDuration}ms`
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
 * @returns {Promise<number>} Database creation duration in ms
 */
export async function createReviewRecord(
  reviewId,
  s3Result,
  title,
  contentLength,
  logger,
  userId = null
) {
  const dbCreateStart = performance.now()
  await reviewRepository.createReview({
    id: reviewId,
    sourceType: SOURCE_TYPES.TEXT,
    fileName: title || CONTENT_DEFAULTS.TITLE,
    fileSize: contentLength,
    mimeType: CONTENT_TYPES.TEXT_PLAIN,
    s3Key: s3Result.key,
    userId: userId || null
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
    `[STEP 3/6] Review record created in S3 repository - COMPLETED in ${dbCreateDuration}ms`
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
 * @returns {Promise<number>} SQS send duration in ms
 */
export async function queueReviewJob(
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
      `[STEP 4/6] SQS message sent successfully - COMPLETED in ${sqsSendDuration}ms`
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
 * @returns {Promise<Object>} Processing result with reviewId and timings
 */
export async function processTextReviewSubmission(payload, headers, logger) {
  const { content, title } = payload

  const reviewId = `review_${randomUUID()}`
  const userId = headers['x-user-id'] || null

  logger.info(
    {
      reviewId,
      contentLength: content.length,
      title: title || CONTENT_DEFAULTS.TITLE,
      userId: userId || 'anonymous'
    },
    '[STEP 1/6] Processing text review request - START'
  )

  // Upload text content to S3
  const { s3Result, s3UploadDuration } = await uploadTextToS3(
    content,
    reviewId,
    title,
    logger
  )

  // Create review record in database (includes userId for per-user filtering)
  const dbCreateDuration = await createReviewRecord(
    reviewId,
    s3Result,
    title,
    content.length,
    logger,
    userId
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
export function formatReviewForResponse(review) {
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
export function formatReviewForList(review, logger) {
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
export function getErrorStatusCode(errorMessage) {
  return errorMessage.includes('not found')
    ? HTTP_STATUS.NOT_FOUND
    : HTTP_STATUS.INTERNAL_SERVER_ERROR
}

/**
 * Gets CORS configuration object
 * @returns {Object} CORS configuration
 */
export function getCorsConfig() {
  return {
    origin: config.get(CORS_CONFIG_KEYS.ORIGIN),
    credentials: config.get(CORS_CONFIG_KEYS.CREDENTIALS)
  }
}
