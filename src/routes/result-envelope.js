import { resultEnvelopeStore } from '../common/helpers/result-envelope.js'
import { createLogger } from '../common/helpers/logging/logger.js'
import { config } from '../config.js'

const logger = createLogger()

const HTTP_NOT_FOUND = 404
const HTTP_BAD_REQUEST = 400
const HTTP_INTERNAL_SERVER_ERROR = 500

/**
 * GET /api/result/:reviewId
 *
 * Returns the spec-compliant result envelope from result/{reviewId}.json.
 * Used by the frontend results page as its primary data source.
 *
 * Possible responses:
 *   200  { documentId, status: "pending"|"processing"|"completed"|"failed",
 *          processedAt, tokenUsed, issueCount, issues[], scores{} }
 *   404  when the envelope file does not yet exist
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
    const envelope = await resultEnvelopeStore.get(reviewId)

    if (!envelope) {
      // File not yet written — review may still be very early in the pipeline
      logger.info(
        { reviewId },
        '[result-envelope] Not found — returning pending stub'
      )
      return h.response({
        success: true,
        data: {
          documentId: reviewId,
          status: 'pending',
          processedAt: null,
          tokenUsed: 0,
          issueCount: 0,
          canonicalText: '',
          annotatedSections: [],
          issues: [],
          improvements: [],
          scores: {
            plainEnglish: 0,
            plainEnglishNote: '',
            clarity: 0,
            clarityNote: '',
            accessibility: 0,
            accessibilityNote: '',
            govukStyle: 0,
            govukStyleNote: '',
            completeness: 0,
            completenessNote: '',
            overall: 0,
            style: 0,
            tone: 0
          }
        }
      })
    }

    logger.info(
      { reviewId, status: envelope.status, issueCount: envelope.issueCount },
      '[result-envelope] Returning result envelope'
    )

    return h.response({ success: true, data: envelope })
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
