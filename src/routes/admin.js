import { config } from '../config.js'
import { promptManager } from '../common/helpers/prompt-manager.js'
import { createLogger } from '../common/helpers/logging/logger.js'

const logger = createLogger()

const HTTP_OK = 200
const HTTP_UNAUTHORIZED = 401
const HTTP_INTERNAL_SERVER_ERROR = 500

/**
 * Verify the x-admin-api-key header when ADMIN_API_KEY is configured.
 * Returns true when the request is authorised to proceed.
 */
function isAuthorised(request) {
  const requiredKey = config.get('adminApiKey')
  if (!requiredKey) {
    // Key not configured — allow access (local/dev only)
    return true
  }
  return request.headers['x-admin-api-key'] === requiredKey
}

const adminRoutes = {
  plugin: {
    name: 'adminRoutes',
    register: (server) => {
      server.route([
        {
          method: 'POST',
          path: '/admin/prompt/upload',
          handler: async (request, h) => {
            if (!isAuthorised(request)) {
              logger.warn(
                { path: request.path },
                'Unauthorised access attempt to admin endpoint'
              )
              return h
                .response({ error: 'Unauthorized' })
                .code(HTTP_UNAUTHORIZED)
            }
            try {
              await promptManager.uploadPrompt()
              logger.info('System prompt uploaded to S3 via admin endpoint')
              return h
                .response({
                  message: 'System prompt uploaded to S3 successfully',
                  timestamp: new Date().toISOString()
                })
                .code(HTTP_OK)
            } catch (error) {
              logger.error(
                { error: error.message },
                'Failed to upload system prompt via admin endpoint'
              )
              return h
                .response({
                  message: 'Failed to upload system prompt',
                  error: error.message
                })
                .code(HTTP_INTERNAL_SERVER_ERROR)
            }
          }
        },
        {
          method: 'POST',
          path: '/admin/prompt/cache/clear',
          handler: (request, h) => {
            if (!isAuthorised(request)) {
              logger.warn(
                { path: request.path },
                'Unauthorised access attempt to admin endpoint'
              )
              return h
                .response({ error: 'Unauthorized' })
                .code(HTTP_UNAUTHORIZED)
            }
            promptManager.clearCache()
            logger.info('System prompt cache cleared via admin endpoint')
            return h
              .response({
                message:
                  'System prompt cache cleared — next review will fetch fresh prompt',
                timestamp: new Date().toISOString()
              })
              .code(HTTP_OK)
          }
        }
      ])
    }
  }
}

export { adminRoutes }
