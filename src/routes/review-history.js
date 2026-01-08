import { reviewStatusTracker } from '../common/helpers/review-status-tracker.js'

/**
 * Review History routes plugin
 */
export const reviewHistoryRoutes = {
  plugin: {
    name: 'review-history-routes',
    register: async (server) => {
      /**
       * GET /api/review-history
       * Get all review history for a user
       */
      server.route({
        method: 'GET',
        path: '/api/review-history',
        options: {
          description: 'Get review history',
          notes: 'Returns all reviews for the current user or all reviews',
          tags: ['api', 'review-history'],
          cors: {
            origin: ['*'],
            credentials: true
          }
        },
        handler: async (request, h) => {
          try {
            const userId = request.query.userId || request.headers['x-user-id']
            const limit = parseInt(request.query.limit) || 50
            const status = request.query.status // optional filter

            request.logger.info(
              { userId, limit, status },
              'Fetching review history'
            )

            let reviews

            if (userId && userId !== 'all') {
              // Get reviews for specific user
              reviews = await reviewStatusTracker.getUserStatuses(userId, limit)
            } else {
              // Get all reviews (for admin/testing)
              reviews = await reviewStatusTracker.getAllStatuses(limit, status)
            }

            // Transform data for frontend
            const transformedReviews = reviews.map((review) => ({
              reviewId: review.uploadId,
              filename: review.filename,
              status: review.status,
              overallStatus: review.result?.overallStatus || 'pending',
              uploadedAt: review.createdAt,
              completedAt: review.completedAt,
              processingTime: review.completedAt
                ? Math.round(
                    (new Date(review.completedAt) -
                      new Date(review.createdAt)) /
                      1000
                  )
                : null,
              metrics: {
                totalIssues: review.result?.metrics?.totalIssues || 0,
                wordsToAvoid: review.result?.metrics?.wordsToAvoidCount || 0,
                passiveSentences:
                  review.result?.metrics?.passiveSentencesCount || 0
              },
              s3Location: review.s3Location || 'N/A',
              s3ResultLocation: review.s3ResultLocation || null,
              progress: review.progress || 0
            }))

            return h
              .response({
                success: true,
                count: transformedReviews.length,
                reviews: transformedReviews
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              { error: error.message },
              'Failed to get review history'
            )

            return h
              .response({
                success: false,
                error: 'Failed to retrieve review history'
              })
              .code(500)
          }
        }
      })

      /**
       * GET /api/review-history/{uploadId}
       * Get specific review details
       */
      server.route({
        method: 'GET',
        path: '/api/review-history/{uploadId}',
        options: {
          description: 'Get specific review',
          notes: 'Returns detailed review information',
          tags: ['api', 'review-history'],
          cors: {
            origin: ['*'],
            credentials: true
          }
        },
        handler: async (request, h) => {
          try {
            const { uploadId } = request.params

            request.logger.info({ uploadId }, 'Fetching review details')

            const review = await reviewStatusTracker.getStatus(uploadId)

            if (!review) {
              return h
                .response({
                  success: false,
                  error: 'Review not found'
                })
                .code(404)
            }

            return h
              .response({
                success: true,
                review: {
                  reviewId: review.uploadId,
                  filename: review.filename,
                  status: review.status,
                  uploadedAt: review.createdAt,
                  completedAt: review.completedAt,
                  result: review.result,
                  s3Location: review.s3Location,
                  s3ResultLocation: review.s3ResultLocation,
                  statusHistory: review.statusHistory,
                  progress: review.progress,
                  error: review.error
                }
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              { error: error.message },
              'Failed to get review details'
            )

            return h
              .response({
                success: false,
                error: 'Failed to retrieve review details'
              })
              .code(500)
          }
        }
      })

      /**
       * DELETE /api/review-history/{uploadId}
       * Delete a review from history
       */
      server.route({
        method: 'DELETE',
        path: '/api/review-history/{uploadId}',
        options: {
          description: 'Delete review',
          notes: 'Removes a review from history',
          tags: ['api', 'review-history'],
          cors: {
            origin: ['*'],
            credentials: true
          }
        },
        handler: async (request, h) => {
          try {
            const { uploadId } = request.params

            request.logger.info({ uploadId }, 'Deleting review')

            const result = await reviewStatusTracker.deleteStatus(uploadId)

            if (result.deletedCount === 0) {
              return h
                .response({
                  success: false,
                  error: 'Review not found'
                })
                .code(404)
            }

            return h
              .response({
                success: true,
                message: 'Review deleted successfully'
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              { error: error.message },
              'Failed to delete review'
            )

            return h
              .response({
                success: false,
                error: 'Failed to delete review'
              })
              .code(500)
          }
        }
      })
    }
  }
}
