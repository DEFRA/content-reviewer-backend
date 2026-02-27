import { reviewRepository } from '../common/helpers/review-repository.js'
import {
  HTTP_STATUS,
  ENDPOINTS,
  PAGINATION_DEFAULTS,
  REVIEW_STATUSES,
  validateTextContent,
  processTextReviewSubmission,
  formatReviewForResponse,
  formatReviewForList,
  getErrorStatusCode,
  getCorsConfig
} from './review-helpers.js'

/**
 * Review routes - Async review processing
 * Supports both file uploads and direct text input
 */

const ERROR_MESSAGES = {
  REVIEW_NOT_FOUND: 'Review not found'
}

/**
 * POST /api/review/text - Submit text content for review (async)
 */
const handleTextReview = async (request, h) => {
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
    const validation = validateTextContent(request.payload, request.logger)
    if (!validation.valid) {
      return h
        .response({
          success: false,
          error: validation.error
        })
        .code(validation.statusCode)
    }

    // Process text review submission (upload, record, queue)
    const { reviewId, s3Result, timings } = await processTextReviewSubmission(
      request.payload,
      request.headers,
      request.logger
    )

    const requestEndTime = performance.now()
    const requestDuration = Math.round(requestEndTime - requestStartTime)

    request.logger.info(
      {
        reviewId,
        contentLength: content.length,
        s3Key: s3Result.key,
        totalDurationMs: requestDuration,
        ...timings,
        endpoint: ENDPOINTS.REVIEW_TEXT
      },
      `[UPLOAD PHASE] Text review queued successfully - TOTAL: ${requestDuration}ms (S3: ${timings.s3UploadDuration}ms, DB: ${timings.dbCreateDuration}ms, SQS: ${timings.sqsSendDuration}ms)`
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
    const requestDuration = Math.round(requestEndTime - requestStartTime)

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

/**
 * GET /api/review/:id - Get review status and result
 */
const handleGetReview = async (request, h) => {
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
          error: ERROR_MESSAGES.REVIEW_NOT_FOUND
        })
        .code(HTTP_STATUS.NOT_FOUND)
    }

    const requestEndTime = performance.now()
    const requestDuration = Math.round(requestEndTime - requestStartTime)

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
    const requestDuration = Math.round(requestEndTime - requestStartTime)

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

/**
 * GET /api/reviews - Get all reviews (history)
 * Supports optional ?userId= query param to filter to a specific user's reviews.
 */
const handleGetAllReviews = async (request, h) => {
  request.logger.info(
    { query: request.query },
    `${ENDPOINTS.REVIEWS_LIST} request received`
  )

  try {
    const limit =
      Number.parseInt(request.query.limit, 10) || PAGINATION_DEFAULTS.LIMIT
    const skip =
      Number.parseInt(request.query.skip, 10) || PAGINATION_DEFAULTS.SKIP
    const userId = request.query.userId || null

    request.logger.info(
      { limit, skip, userId: userId || 'all' },
      'Fetching reviews from S3 repository'
    )

    const reviews = await reviewRepository.getAllReviews(limit, skip, userId)
    request.logger.info(
      {
        count: reviews.length,
        reviewIds: reviews.map((r) => r.id),
        statuses: reviews.map((r) => r.status)
      },
      `Retrieved ${reviews.length} reviews from S3`
    )

    const totalCount = await reviewRepository.getReviewCount(userId)
    request.logger.info({ totalCount }, 'Retrieved total review count from S3')

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

/**
 * DELETE /api/reviews/:reviewId - Delete a review and its associated S3 content
 */
const handleDeleteReview = async (request, h) => {
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

/**
 * Register POST /api/review/text route
 */
const registerTextReviewRoute = (server) => {
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
    handler: handleTextReview
  })
}

/**
 * Register GET /api/review/:id route
 */
const registerGetReviewRoute = (server) => {
  server.route({
    method: 'GET',
    path: ENDPOINTS.REVIEW_BY_ID,
    options: {
      cors: getCorsConfig()
    },
    handler: handleGetReview
  })
}

/**
 * Register GET /api/reviews route
 */
const registerGetAllReviewsRoute = (server) => {
  server.route({
    method: 'GET',
    path: ENDPOINTS.REVIEWS_LIST,
    options: {
      cors: getCorsConfig()
    },
    handler: handleGetAllReviews
  })
}

/**
 * Register DELETE /api/reviews/:reviewId route
 */
const registerDeleteReviewRoute = (server) => {
  server.route({
    method: 'DELETE',
    path: ENDPOINTS.REVIEWS_DELETE,
    options: {
      cors: getCorsConfig()
    },
    handler: handleDeleteReview
  })
}

export const reviewRoutes = {
  plugin: {
    name: 'review-routes',
    register: async (server) => {
      /**
       * NOTE: File upload functionality (POST /api/review/file) has been
       * disabled for demo purposes. See git history or documentation for
       * the full implementation if needed in the future.
       */

      registerTextReviewRoute(server)
      registerGetReviewRoute(server)
      registerGetAllReviewsRoute(server)
      registerDeleteReviewRoute(server)
    }
  }
}
