import { resultEnvelopeStore } from '../common/helpers/result-envelope.js'
import { reviewRepository } from '../common/helpers/review-repository.js'
import { createLogger } from '../common/helpers/logging/logger.js'
import { config } from '../config.js'

const logger = createLogger()

const HTTP_BAD_REQUEST = 400
const HTTP_INTERNAL_SERVER_ERROR = 500

/**
 * GET /api/result/:reviewId
 *
 * Returns the spec-compliant result envelope for the frontend results page.
 * The envelope is stored as the `envelope` field inside reviews/{reviewId}.json.
 *
 * Possible responses:
 *   200  { documentId, status: "pending"|"processing"|"completed"|"failed",
 *          processedAt, tokenUsed, issueCount, issues[], scores{} }
 *   400  when reviewId is missing
 *   500  on S3 read failure
 */
async function getResultEnvelopeHandler(request, h) {
  const { reviewId } = request.params

  if (!reviewId?.trim()) {
    return h
      .response({ success: false, error: 'reviewId is required' })
      .code(HTTP_BAD_REQUEST)
  }

  logger.info({ reviewId }, '[result-envelope] GET request received')

  try {
    const review = await reviewRepository.getReview(reviewId)

    if (!review) {
      // Review not yet created — very early in the pipeline
      logger.info(
        { reviewId },
        '[result-envelope] Review not found — returning pending stub'
      )
      return h.response({
        success: true,
        data: resultEnvelopeStore.buildStubEnvelope(reviewId, 'pending')
      })
    }

    // Completed review — return the stored envelope
    if (review.status === 'completed' && review.envelope) {
      logger.info(
        {
          reviewId,
          status: review.envelope.status,
          issueCount: review.envelope.issueCount
        },
        '[result-envelope] Returning completed envelope'
      )
      return h.response({ success: true, data: review.envelope })
    }

    // Still processing or failed — return a stub with the current status
    logger.info(
      { reviewId, status: review.status },
      '[result-envelope] Returning status stub'
    )
    const stub = resultEnvelopeStore.buildStubEnvelope(reviewId, review.status)
    return h.response({ success: true, data: stub })
  } catch (error) {
    logger.error(
      { reviewId, error: error.message, stack: error.stack },
      '[result-envelope] Failed to read result envelope'
    )

    return h
      .response({ success: false, error: 'Failed to read result envelope' })
      .code(HTTP_INTERNAL_SERVER_ERROR)
  }
}

/**
 * Register result envelope routes
 * @param {Object} server - Hapi server
 */
function registerResultEnvelopeRoutes(server) {
  server.route({
    method: 'GET',
    path: '/api/result/{reviewId}',
    options: {
      auth: false,
      cors: {
        origin: config.get('cors.origin'),
        credentials: config.get('cors.credentials')
      }
    },
    handler: getResultEnvelopeHandler
  })
}

export const resultEnvelope = {
  plugin: {
    name: 'result-envelope',
    register: registerResultEnvelopeRoutes
  }
}
