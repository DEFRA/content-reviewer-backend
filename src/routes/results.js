import { reviewRepository } from '../common/helpers/review-repository.js'
import { createLogger } from '../common/helpers/logging/logger.js'
import { config } from '../config.js'

const logger = createLogger()

// HTTP Status Code Constants
const HTTP_BAD_REQUEST = 400
const HTTP_INTERNAL_SERVER_ERROR = 500

// Status Constants
const STATUS_PROCESSING = 'processing'
const STATUS_COMPLETED = 'completed'
const STATUS_FAILED = 'failed'

/**
 * Validate job ID parameter
 * @param {string} jobId - The job ID to validate
 * @returns {boolean} True if valid, false otherwise
 */
function isValidJobId(jobId) {
  return !!jobId?.trim()
}

/**
 * Build S3 result location string
 * @param {string} s3Key - S3 key from review
 * @returns {string|null} Full S3 location or null
 */
function buildS3ResultLocation(s3Key) {
  return s3Key ? `${config.get('s3.bucket')}/${s3Key}` : null
}

/**
 * Build S3 metadata object
 * @param {string} s3Key - S3 key from review
 * @returns {Object|null} Metadata object or null
 */
function buildS3Metadata(s3Key) {
  return s3Key
    ? {
        bucket: config.get('s3.bucket'),
        s3Key
      }
    : null
}

/**
 * Build processing-in-progress response
 * @param {string} jobId - The job ID
 * @returns {Object} Response data object
 */
function buildProcessingResponse(jobId) {
  return {
    success: true,
    data: {
      id: jobId,
      jobId,
      status: STATUS_PROCESSING,
      progress: 0
    },
    message: 'Job is still being processed'
  }
}

/**
 * Log successful result retrieval
 * @param {string} jobId - The job ID
 * @param {Object} review - The review object
 */
function logResultRetrieval(jobId, review) {
  logger.info(
    {
      jobId,
      status: review.status,
      hasResult: !!review.result,
      hasReviewData: !!review.result?.reviewData,
      reviewDataKeys: review.result?.reviewData
        ? Object.keys(review.result.reviewData)
        : [],
      filename: review.fileName,
      createdAt: review.createdAt
    },
    'Result retrieved successfully from review repository'
  )
}

/**
 * Build successful result response data
 * @param {string} jobId - The job ID
 * @param {Object} review - The review object
 * @param {string|null} s3ResultLocation - S3 location string
 * @param {Object|null} metadata - S3 metadata
 * @returns {Object} Response data object
 */
function buildResultResponseData(jobId, review, s3ResultLocation, metadata) {
  return {
    success: true,
    data: {
      id: jobId,
      jobId,
      status: review.status,
      result: review.result,
      originalText: review.result?.originalText || null,
      issues: review.result?.issues || [],
      summary: review.result?.summary || null,
      metrics: review.result?.metrics || null,
      completedAt: review.processingCompletedAt,
      failedAt: review.status === STATUS_FAILED ? review.updatedAt : null,
      filename: review.fileName,
      createdAt: review.createdAt,
      s3ResultLocation,
      metadata,
      error: review.error
    }
  }
}

/**
 * Handle GET /api/results/:jobId - Get review result by job ID
 * @param {Object} request - Hapi request object
 * @param {Object} h - Hapi response toolkit
 * @returns {Promise<Object>} Response object
 */
async function getResultHandler(request, h) {
  try {
    const { jobId } = request.params

    if (!isValidJobId(jobId)) {
      return h
        .response({
          success: false,
          error: 'Job ID is required'
        })
        .code(HTTP_BAD_REQUEST)
    }

    logger.info({ jobId }, 'Fetching review result')

    const review = await reviewRepository.getReview(jobId)

    if (!review) {
      logger.info({ jobId }, 'Review not found - job may be processing')
      return h.response(buildProcessingResponse(jobId))
    }

    const s3ResultLocation = buildS3ResultLocation(review.s3Key)
    const metadata = buildS3Metadata(review.s3Key)

    logResultRetrieval(jobId, review)

    const responseData = buildResultResponseData(
      jobId,
      review,
      s3ResultLocation,
      metadata
    )

    return h.response(responseData)
  } catch (error) {
    logger.error(
      {
        jobId: request.params.jobId,
        error: error.message,
        stack: error.stack
      },
      'Failed to fetch result'
    )

    return h
      .response({
        success: false,
        error: 'Failed to fetch result',
        message: error.message
      })
      .code(HTTP_INTERNAL_SERVER_ERROR)
  }
}

/**
 * Handle GET /api/results/:jobId/status - Check if result is ready
 * @param {Object} request - Hapi request object
 * @param {Object} h - Hapi response toolkit
 * @returns {Promise<Object>} Response object
 */
async function getResultStatusHandler(request, h) {
  try {
    const { jobId } = request.params

    if (!isValidJobId(jobId)) {
      return h
        .response({
          success: false,
          error: 'Job ID is required'
        })
        .code(HTTP_BAD_REQUEST)
    }

    logger.debug({ jobId }, 'Checking result status')

    const review = await reviewRepository.getReview(jobId)
    const hasResult = review?.status === STATUS_COMPLETED

    return h.response({
      success: true,
      jobId,
      ready: hasResult,
      status: review?.status || STATUS_PROCESSING
    })
  } catch (error) {
    logger.error(
      {
        jobId: request.params.jobId,
        error: error.message
      },
      'Failed to check result status'
    )

    return h
      .response({
        success: false,
        error: 'Failed to check status'
      })
      .code(HTTP_INTERNAL_SERVER_ERROR)
  }
}

/**
 * Register results routes
 * @param {Object} server - Hapi server instance
 */
function registerResultsRoutes(server) {
  // GET /api/results/:jobId - Get review result by job ID
  server.route({
    method: 'GET',
    path: '/api/results/{jobId}',
    options: {
      auth: false,
      cors: {
        origin: config.get('cors.origin'),
        credentials: config.get('cors.credentials')
      }
    },
    handler: getResultHandler
  })

  // GET /api/results/:jobId/status - Check if result is ready (lightweight)
  server.route({
    method: 'GET',
    path: '/api/results/{jobId}/status',
    options: {
      auth: false
    },
    handler: getResultStatusHandler
  })
}

export const results = {
  plugin: {
    name: 'results',
    register: registerResultsRoutes
  }
}
