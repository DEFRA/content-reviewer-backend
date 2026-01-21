import { resultsStorage } from '../common/helpers/results-storage.js'
import { reviewRepository } from '../common/helpers/review-repository.js'
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
                data: {
                  id: jobId,
                  jobId,
                  status: 'processing',
                  progress: 0
                },
                message: 'Job is still being processed'
              })
            }

            // Attempt to enrich with original review metadata (filename, createdAt)
            let filename
            let createdAt
            let s3ResultLocation
            let metadata
            try {
              const review = await reviewRepository.getReview(jobId)
              if (review) {
                filename = review.fileName
                createdAt = review.createdAt
                if (review.s3Key) {
                  s3ResultLocation = `${config.get('s3.bucket')}/${review.s3Key}`
                  metadata = {
                    bucket: config.get('s3.bucket'),
                    s3Key: review.s3Key
                  }
                }
              }
            } catch (e) {
              logger.debug(
                { jobId, error: e.message },
                'Could not enrich result with review metadata'
              )
            }

            logger.info(
              {
                jobId,
                status: result.status,
                hasResult: !!result.result,
                filename,
                createdAt
              },
              'Result retrieved successfully from S3 storage - backend code'
            )

            return h.response({
              success: true,
              data: {
                id: jobId,
                jobId,
                status: result.status,
                result: result.result || result,
                completedAt: result.completedAt,
                failedAt: result.failedAt,
                filename,
                createdAt,
                s3ResultLocation,
                metadata
              }
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
