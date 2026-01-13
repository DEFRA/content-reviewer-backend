import { resultsStorage } from '../common/helpers/results-storage.js'
import { createLogger } from '../common/helpers/logging/logger.js'
import { config } from '../config.js'

const logger = createLogger()

export const results = {
  plugin: {
    name: 'results',
    register(server) {
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
        handler: async (request, h) => {
          try {
            const { jobId } = request.params

            if (!jobId || !jobId.trim()) {
              return h
                .response({
                  success: false,
                  error: 'Job ID is required'
                })
                .code(400)
            }

            logger.info({ jobId }, 'Fetching review result')

            // Get result from storage
            const result = await resultsStorage.getResult(jobId)

            if (!result) {
              // Result not found - job may still be processing
              logger.info({ jobId }, 'Result not found - job may be processing')
              return h.response({
                success: true,
                status: 'processing',
                jobId,
                message: 'Job is still being processed'
              })
            }

            logger.info(
              {
                jobId,
                status: result.status
              },
              'Result retrieved successfully'
            )

            return h.response({
              success: true,
              status: result.status,
              jobId,
              result: result.result || result,
              completedAt: result.completedAt,
              failedAt: result.failedAt
            })
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
              .code(500)
          }
        }
      })

      // GET /api/results/:jobId/status - Check if result is ready (lightweight)
      server.route({
        method: 'GET',
        path: '/api/results/{jobId}/status',
        options: {
          auth: false
        },
        handler: async (request, h) => {
          try {
            const { jobId } = request.params

            if (!jobId || !jobId.trim()) {
              return h
                .response({
                  success: false,
                  error: 'Job ID is required'
                })
                .code(400)
            }

            logger.debug({ jobId }, 'Checking result status')

            const hasResult = await resultsStorage.hasResult(jobId)

            return h.response({
              success: true,
              jobId,
              ready: hasResult,
              status: hasResult ? 'completed' : 'processing'
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
              .code(500)
          }
        }
      })
    }
  }
}
