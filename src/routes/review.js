import { reviewRepository } from '../common/helpers/review-repository.js'
import {
  HTTP_STATUS,
  ENDPOINTS,
  PAGINATION_DEFAULTS,
  PAGINATION_LIMITS,
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
        hasContent: !!content,
        contentLength: content?.length,
        hasTitle: !!title,
        title: title || 'untitled',
        titleLength: title?.length
      },
      `POST ${ENDPOINTS.REVIEW_TEXT} request received with title: "${title || 'NO TITLE PROVIDED'}"`
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
        ...timings
      },
      `[RESPONSE TIME] POST ${ENDPOINTS.REVIEW_TEXT} queued successfully - TOTAL: ${requestDuration}ms (S3: ${timings.s3UploadDuration}ms, DB: ${timings.dbCreateDuration}ms, SQS: ${timings.sqsSendDuration}ms)`
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
      `POST ${ENDPOINTS.REVIEW_TEXT} failed to queue text review after ${requestDuration}ms`
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
      { reviewId: id },
      `GET ${ENDPOINTS.REVIEW_BY_ID} request received`
    )

    const review = await reviewRepository.getReview(id)

    if (!review) {
      request.logger.warn(
        { reviewId: id },
        `GET ${ENDPOINTS.REVIEW_BY_ID} - Review not found`
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
      `[RESPONSE TIME] GET ${ENDPOINTS.REVIEW_BY_ID} status retrieved in ${requestDuration}ms`
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
      `GET ${ENDPOINTS.REVIEW_BY_ID} failed to retrieve review after ${requestDuration}ms`
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
 * Parse pagination params and fetch reviews + total count from the repository,
 * returning per-operation durations for response-time logging.
 */
async function fetchAllReviewsData(query) {
  const limit = Math.min(
    Math.max(
      Number.parseInt(query.limit, 10) || PAGINATION_DEFAULTS.LIMIT,
      PAGINATION_LIMITS.MIN_LIMIT
    ),
    PAGINATION_LIMITS.MAX_LIMIT
  )
  const skip = Math.max(
    Number.parseInt(query.skip, 10) || PAGINATION_DEFAULTS.SKIP,
    PAGINATION_LIMITS.MIN_SKIP
  )
  const userId = query.userId || null

  const s3ListStart = performance.now()
  const reviews = await reviewRepository.getAllReviews(limit, skip, userId)
  const s3ListDuration = Math.round(performance.now() - s3ListStart)

  const countStart = performance.now()
  const totalCount = await reviewRepository.getReviewCount(userId)
  const countDuration = Math.round(performance.now() - countStart)

  return {
    limit,
    skip,
    userId,
    reviews,
    totalCount,
    s3ListDuration,
    countDuration
  }
}

/**
 * GET /api/reviews - Get all reviews (history)
 * Supports optional ?userId= query param to filter to a specific user's reviews.
 */
const handleGetAllReviews = async (request, h) => {
  const requestStartTime = performance.now()

  try {
    const {
      limit,
      skip,
      userId,
      reviews,
      totalCount,
      s3ListDuration,
      countDuration
    } = await fetchAllReviewsData(request.query)

    const formattedReviews = reviews.map((review) =>
      formatReviewForList(review, request.logger)
    )

    const requestDuration = Math.round(performance.now() - requestStartTime)
    const lastKnownCount = Number.parseInt(request.query.lastKnownCount, 10)
    const countChanged =
      Number.isNaN(lastKnownCount) || lastKnownCount !== formattedReviews.length

    if (countChanged) {
      request.logger.info(
        {
          count: formattedReviews.length,
          totalCount,
          limit,
          skip,
          userId: userId || 'all',
          s3ListDurationMs: s3ListDuration,
          countDurationMs: countDuration,
          totalDurationMs: requestDuration
        },
        `[RESPONSE TIME] GET /api/reviews returned in ${requestDuration}ms (S3 list: ${s3ListDuration}ms, count: ${countDuration}ms, reviewCount: ${formattedReviews.length})`
      )
    }

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
    const requestDuration = Math.round(performance.now() - requestStartTime)
    request.logger.error(
      {
        errorName: error.name,
        errorCode: error.Code || error.code,
        errorMessage: error.message,
        httpStatusCode: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId,
        durationMs: requestDuration
      },
      `GET ${ENDPOINTS.REVIEWS_LIST} failed to get reviews`
    )
    return h
      .response({ success: false, error: 'Failed to retrieve reviews' })
      .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  }
}

/**
 * DELETE /api/reviews/:reviewId - Delete a review and its associated S3 content
 */
const handleDeleteReview = async (request, h) => {
  const requestStartTime = performance.now()
  const { reviewId } = request.params

  request.logger.info(
    { reviewId },
    `DELETE ${ENDPOINTS.REVIEWS_DELETE} request received`
  )

  try {
    // Delete the review and associated content
    const deleteStart = performance.now()
    const result = await reviewRepository.deleteReview(reviewId)
    const deleteDuration = Math.round(performance.now() - deleteStart)
    const totalDuration = Math.round(performance.now() - requestStartTime)

    request.logger.info(
      {
        reviewId,
        deletedKeys: result.deletedKeys,
        deletedCount: result.deletedCount,
        deleteDurationMs: deleteDuration,
        totalDurationMs: totalDuration
      },
      `[RESPONSE TIME] DELETE ${ENDPOINTS.REVIEWS_DELETE} deleted in ${totalDuration}ms (S3: ${deleteDuration}ms, ${result.deletedCount} keys removed)`
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
    const totalDuration = Math.round(performance.now() - requestStartTime)
    request.logger.error(
      {
        reviewId,
        error: error.message,
        stack: error.stack,
        durationMs: totalDuration
      },
      `DELETE ${ENDPOINTS.REVIEWS_DELETE} failed to delete review`
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
