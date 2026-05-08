import { reviewRepository } from '../common/helpers/review-repository.js'
import { createLogger } from '../common/helpers/logging/logger.js'

const logger = createLogger()

const HTTP_BAD_REQUEST = 400
const HTTP_INTERNAL_SERVER_ERROR = 500
const STATUS_PROCESSING = 'processing'
const STATUS_COMPLETED = 'completed'

function isValidJobId(jobId) {
  return !!jobId?.trim()
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
        .response({ success: false, error: 'Job ID is required' })
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
      { jobId: request.params.jobId, error: error.message },
      'Failed to check result status'
    )

    return h
      .response({ success: false, error: 'Failed to check status' })
      .code(HTTP_INTERNAL_SERVER_ERROR)
  }
}

/**
 * Register results routes
 * @param {Object} server - Hapi server instance
 */
function registerResultsRoutes(server) {
  server.route({
    method: 'GET',
    path: '/api/results/{jobId}/status',
    options: { auth: false },
    handler: getResultStatusHandler
  })
}

export const results = {
  plugin: {
    name: 'results',
    register: registerResultsRoutes
  }
}
