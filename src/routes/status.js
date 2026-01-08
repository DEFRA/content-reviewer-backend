import { reviewStatusTracker } from '../common/helpers/review-status-tracker.js'

/**
 * Status routes plugin
 * Provides endpoints for checking upload/review status
 */
export const statusRoutes = {
  plugin: {
    name: 'status-routes',
    register: async (server) => {
      /**
       * GET /api/status/:uploadId
       * Get status for a specific upload
       */
      server.route({
        method: 'GET',
        path: '/api/status/{uploadId}',
        options: {
          cors: {
            origin: ['*'],
            credentials: true
          },
          description: 'Get upload status',
          notes: 'Returns current status and history for an upload',
          tags: ['api', 'status']
        },
        handler: async (request, h) => {
          try {
            const { uploadId } = request.params

            request.logger.info({ uploadId }, 'Fetching upload status')

            const status = await reviewStatusTracker.getStatus(uploadId)

            if (!status) {
              return h
                .response({
                  success: false,
                  error: 'Upload not found'
                })
                .code(404)
            }

            return h
              .response({
                success: true,
                data: {
                  uploadId: status.uploadId,
                  filename: status.filename,
                  status: status.status,
                  progress: status.progress || 0,
                  statusHistory: status.statusHistory,
                  metadata: status.metadata,
                  createdAt: status.createdAt,
                  updatedAt: status.updatedAt,
                  completedAt: status.completedAt,
                  failedAt: status.failedAt,
                  error: status.error,
                  result: status.result
                }
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              { error: error.message },
              'Failed to get status'
            )
            return h
              .response({
                success: false,
                error: 'Failed to retrieve status'
              })
              .code(500)
          }
        }
      })

      /**
       * GET /api/status
       * Get all statuses for current user
       */
      server.route({
        method: 'GET',
        path: '/api/status',
        options: {
          cors: {
            origin: ['*'],
            credentials: true
          },
          description: 'Get all upload statuses for user',
          notes: 'Returns list of uploads with their current status',
          tags: ['api', 'status']
        },
        handler: async (request, h) => {
          try {
            const userId = request.headers['x-user-id'] || 'anonymous'
            const limit = parseInt(request.query.limit) || 50

            request.logger.info({ userId, limit }, 'Fetching user statuses')

            const statuses = await reviewStatusTracker.getUserStatuses(
              userId,
              limit
            )

            return h
              .response({
                success: true,
                data: {
                  count: statuses.length,
                  statuses: statuses.map((s) => ({
                    uploadId: s.uploadId,
                    filename: s.filename,
                    status: s.status,
                    progress: s.progress || 0,
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                    completedAt: s.completedAt,
                    error: s.error
                  }))
                }
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              { error: error.message },
              'Failed to get statuses'
            )
            return h
              .response({
                success: false,
                error: 'Failed to retrieve statuses'
              })
              .code(500)
          }
        }
      })

      /**
       * GET /api/status/:uploadId/history
       * Get detailed status history for an upload
       */
      server.route({
        method: 'GET',
        path: '/api/status/{uploadId}/history',
        options: {
          cors: {
            origin: ['*'],
            credentials: true
          },
          description: 'Get status history',
          notes: 'Returns detailed history of status changes',
          tags: ['api', 'status']
        },
        handler: async (request, h) => {
          try {
            const { uploadId } = request.params

            request.logger.info({ uploadId }, 'Fetching status history')

            const history = await reviewStatusTracker.getStatusHistory(uploadId)

            if (!history || history.length === 0) {
              return h
                .response({
                  success: false,
                  error: 'Upload not found or no history available'
                })
                .code(404)
            }

            return h
              .response({
                success: true,
                data: {
                  uploadId,
                  history
                }
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              { error: error.message },
              'Failed to get status history'
            )
            return h
              .response({
                success: false,
                error: 'Failed to retrieve status history'
              })
              .code(500)
          }
        }
      })

      /**
       * GET /api/status/statistics
       * Get statistics about upload statuses
       */
      server.route({
        method: 'GET',
        path: '/api/status/statistics',
        options: {
          cors: {
            origin: ['*'],
            credentials: true
          },
          description: 'Get status statistics',
          notes: 'Returns counts of uploads by status',
          tags: ['api', 'status']
        },
        handler: async (request, h) => {
          try {
            const userId = request.query.userId || null

            request.logger.info({ userId }, 'Fetching status statistics')

            const stats = await reviewStatusTracker.getStatistics(userId)

            return h
              .response({
                success: true,
                data: stats
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              { error: error.message },
              'Failed to get statistics'
            )
            return h
              .response({
                success: false,
                error: 'Failed to retrieve statistics'
              })
              .code(500)
          }
        }
      })

      /**
       * DELETE /api/status/:uploadId
       * Delete a status record (admin/testing only)
       */
      server.route({
        method: 'DELETE',
        path: '/api/status/{uploadId}',
        options: {
          cors: {
            origin: ['*'],
            credentials: true
          },
          description: 'Delete status record',
          notes: 'Removes status tracking for an upload (testing only)',
          tags: ['api', 'status']
        },
        handler: async (request, h) => {
          try {
            const { uploadId } = request.params

            request.logger.info({ uploadId }, 'Deleting status record')

            const result = await reviewStatusTracker.deleteStatus(uploadId)

            if (result.deletedCount === 0) {
              return h
                .response({
                  success: false,
                  error: 'Upload not found'
                })
                .code(404)
            }

            return h
              .response({
                success: true,
                message: 'Status deleted successfully'
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              { error: error.message },
              'Failed to delete status'
            )
            return h
              .response({
                success: false,
                error: 'Failed to delete status'
              })
              .code(500)
          }
        }
      })
    }
  }
}
