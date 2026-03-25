import { promptManager } from '../common/helpers/prompt-manager.js'
import { createLogger } from '../common/helpers/logging/logger.js'

const logger = createLogger()

const adminRoutes = {
  plugin: {
    name: 'adminRoutes',
    register: (server) => {
      server.route([
        {
          method: 'POST',
          path: '/admin/prompt/upload',
          handler: async (_request, h) => {
            try {
              await promptManager.uploadPrompt()
              logger.info('System prompt uploaded to S3 via admin endpoint')
              return h
                .response({
                  message: 'System prompt uploaded to S3 successfully',
                  timestamp: new Date().toISOString()
                })
                .code(200)
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
                .code(500)
            }
          }
        },
        {
          method: 'POST',
          path: '/admin/prompt/cache/clear',
          handler: (_request, h) => {
            promptManager.clearCache()
            logger.info('System prompt cache cleared via admin endpoint')
            return h
              .response({
                message:
                  'System prompt cache cleared — next review will fetch fresh prompt',
                timestamp: new Date().toISOString()
              })
              .code(200)
          }
        }
      ])
    }
  }
}

export { adminRoutes }
