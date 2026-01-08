import { rulesRepository } from '../common/helpers/rules-repository.js'
import { config } from '../config.js'

/**
 * Rules management routes
 * Endpoints for managing content review rules in S3
 */
export const rulesRoutes = {
  plugin: {
    name: 'rules-routes',
    register: async (server) => {
      /**
       * POST /api/rules/initialize
       * Initialize rules repository with default rules
       */
      server.route({
        method: 'POST',
        path: '/api/rules/initialize',
        options: {
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          },
          description: 'Initialize rules repository',
          notes: 'Uploads default GOV.UK content QA rules to S3',
          tags: ['api', 'rules', 'admin']
        },
        handler: async (request, h) => {
          try {
            request.logger.info('Initializing rules repository')

            const result = await rulesRepository.initializeDefaultRules()

            return h
              .response({
                success: true,
                message: 'Rules initialized successfully',
                ...result
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              { error: error.message },
              'Failed to initialize rules'
            )
            return h
              .response({
                success: false,
                error: error.message
              })
              .code(500)
          }
        }
      })

      /**
       * GET /api/rules
       * List all available rules
       */
      server.route({
        method: 'GET',
        path: '/api/rules',
        options: {
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          },
          description: 'List all rules',
          notes: 'Returns list of all rule files in S3',
          tags: ['api', 'rules']
        },
        handler: async (request, h) => {
          try {
            request.logger.info('Listing rules')

            const rules = await rulesRepository.listRules()

            return h
              .response({
                success: true,
                count: rules.length,
                rules
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              { error: error.message },
              'Failed to list rules'
            )
            return h
              .response({
                success: false,
                error: error.message
              })
              .code(500)
          }
        }
      })

      /**
       * GET /api/rules/{fileName}
       * Get specific rule file content
       */
      server.route({
        method: 'GET',
        path: '/api/rules/{fileName}',
        options: {
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          },
          description: 'Get rule file',
          notes: 'Returns content of a specific rule file',
          tags: ['api', 'rules']
        },
        handler: async (request, h) => {
          try {
            const { fileName } = request.params

            request.logger.info({ fileName }, 'Retrieving rule file')

            const content = await rulesRepository.getRules(fileName)

            return h
              .response({
                success: true,
                fileName,
                content
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              { error: error.message },
              'Failed to retrieve rule file'
            )

            if (error.name === 'NoSuchKey') {
              return h
                .response({
                  success: false,
                  error: 'Rule file not found'
                })
                .code(404)
            }

            return h
              .response({
                success: false,
                error: error.message
              })
              .code(500)
          }
        }
      })

      /**
       * GET /api/rules/default/content
       * Get default GOV.UK content QA rules
       */
      server.route({
        method: 'GET',
        path: '/api/rules/default/content',
        options: {
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          },
          description: 'Get default rules',
          notes: 'Returns default GOV.UK content QA rules',
          tags: ['api', 'rules']
        },
        handler: async (request, h) => {
          try {
            request.logger.info('Retrieving default rules')

            const content = await rulesRepository.getDefaultRules()

            return h
              .response({
                success: true,
                fileName: 'govuk-content-qa-rules.md',
                content
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              { error: error.message },
              'Failed to retrieve default rules'
            )
            return h
              .response({
                success: false,
                error: error.message
              })
              .code(500)
          }
        }
      })

      /**
       * GET /api/rules/health
       * Health check for rules service
       */
      server.route({
        method: 'GET',
        path: '/api/rules/health',
        options: {
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          }
        },
        handler: async (request, h) => {
          try {
            // Try to list rules to verify S3 connection
            const rules = await rulesRepository.listRules()

            return h
              .response({
                status: 'ok',
                service: 'rules',
                bucket: rulesRepository.bucket,
                rulesCount: rules.length,
                hasDefaultRules: rules.some(
                  (r) => r.name === 'govuk-content-qa-rules.md'
                )
              })
              .code(200)
          } catch (error) {
            return h
              .response({
                status: 'error',
                service: 'rules',
                error: error.message
              })
              .code(500)
          }
        }
      })
    }
  }
}
