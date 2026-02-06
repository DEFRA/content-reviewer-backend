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

            const review = await reviewRepository.getReview(jobId)

            if (!review) {
              logger.info({ jobId }, 'Review not found - job may be processing')
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

            const s3ResultLocation = review.s3Key
              ? `${config.get('s3.bucket')}/${review.s3Key}`
              : null

            const metadata = review.s3Key
              ? {
                  bucket: config.get('s3.bucket'),
                  s3Key: review.s3Key
                }
              : null

            logger.info(
              {
                jobId,
                status: review.status,
                hasResult: !!review.result,
                filename: review.fileName,
                createdAt: review.createdAt
              },
              'Result retrieved successfully from review repository'
            )

            return h.response({
              success: true,
              data: {
                id: jobId,
                jobId,
                status: review.status,
                result: review.result?.reviewData || null,
                originalText: review.result?.originalText || null,
                issues: review.result?.issues || [],
                summary: review.result?.summary || null,
                metrics: review.result?.metrics || null,
                completedAt: review.processingCompletedAt,
                failedAt: review.status === 'failed' ? review.updatedAt : null,
                filename: review.fileName,
                createdAt: review.createdAt,
                s3ResultLocation,
                metadata,
                error: review.error
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

            const review = await reviewRepository.getReview(jobId)
            const hasResult = review && review.status === 'completed'

            return h.response({
              success: true,
              jobId,
              ready: hasResult,
              status: review ? review.status : 'processing'
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
