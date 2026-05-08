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

  const startTime = performance.now()
  logger.info({ reviewId }, '[result-envelope] GET request received')

  try {
    const s3Start = performance.now()
    const review = await reviewRepository.getReview(reviewId)
    const s3Duration = Math.round(performance.now() - s3Start)

    if (!review) {
      // Review not yet created — very early in the pipeline
      logger.info(
        { reviewId, s3DurationMs: s3Duration },
        '[result-envelope] Review not found — returning pending stub'
      )
      return h.response({
        success: true,
        data: resultEnvelopeStore.buildStubEnvelope(reviewId, 'pending')
      })
    }

    // Completed review — return the stored envelope
    if (review.status === 'completed' && review.envelope) {
      const completedDuration = Math.round(performance.now() - startTime)
      logger.info(
        {
          reviewId,
          status: review.envelope.status,
          issueCount: review.envelope.issueCount,
          s3DurationMs: s3Duration,
          totalDurationMs: completedDuration
        },
        `[RESPONSE TIME] [result-envelope] Completed envelope returned in ${completedDuration}ms (S3: ${s3Duration}ms)`
      )
      return h.response({ success: true, data: review.envelope })
    }

    // Still processing or failed — return a stub with the current status
    const totalDuration = Math.round(performance.now() - startTime)
    logger.info(
      {
        reviewId,
        status: review.status,
        s3DurationMs: s3Duration,
        totalDurationMs: totalDuration
      },
      `[RESPONSE TIME] [result-envelope] Status stub returned in ${totalDuration}ms (status: ${review.status})`
    )
    const stub = resultEnvelopeStore.buildStubEnvelope(reviewId, review.status)
    if (review.status === 'failed' && review.error?.message) {
      stub.errorMessage = review.error.message
    }
    return h.response({ success: true, data: stub })
  } catch (error) {
    const totalDuration = Math.round(performance.now() - startTime)
    logger.error(
      {
        reviewId,
        error: error.message,
        stack: error.stack,
        totalDurationMs: totalDuration
      },
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
