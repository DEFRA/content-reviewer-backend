import { verifyServiceToken } from '../common/helpers/auth/generate-service-token.js'
import { config } from '../config.js'
import { createLogger } from '../common/helpers/logging/logger.js'

const logger = createLogger()

const HTTP_UNAUTHORIZED = 401
const HTTP_INTERNAL_SERVER_ERROR = 500

// Routes that do not require service token authentication
const PUBLIC_ROUTES = [
  /^\/health$/,
  /^\/api\/upload-callback$/,
  /^\/api\/sqs-worker\/status$/
]

/**
 * Check if a route is public (no auth required)
 */
function isPublicRoute(path) {
  return PUBLIC_ROUTES.some((pattern) => pattern.test(path))
}

const serviceTokenAuth = {
  plugin: {
    name: 'serviceTokenAuth',
    register: (server) => {
      // Add pre-handler to validate service token on all routes
      server.ext('onRequest', async (request, h) => {
        const path = request.path
        const method = request.method.toUpperCase()

        // Skip auth for public routes
        if (isPublicRoute(path)) {
          logger.debug(`Public route accessed: ${method} ${path}`)
          return h.continue
        }

        // Extract headers
        const token = request.headers['x-service-token']
        const timestampHeader = request.headers['x-timestamp']

        // Validate headers exist
        if (!token || !timestampHeader) {
          logger.warn(`Missing auth headers for ${method} ${path}`)
          return h
            .response({
              statusCode: HTTP_UNAUTHORIZED,
              error: 'Unauthorized',
              message: 'Missing x-service-token or x-timestamp header'
            })
            .code(HTTP_UNAUTHORIZED)
            .takeover()
        }

        // Parse timestamp — Number.parseInt returns NaN for invalid input without throwing
        const timestamp = Number.parseInt(timestampHeader, 10)
        if (Number.isNaN(timestamp)) {
          logger.warn(`Invalid timestamp format: ${timestampHeader}`)
          return h
            .response({
              statusCode: HTTP_UNAUTHORIZED,
              error: 'Unauthorized',
              message: 'Invalid x-timestamp header'
            })
            .code(HTTP_UNAUTHORIZED)
            .takeover()
        }

        // Verify token
        const secret = config.get('backendServiceToken')
        if (!secret) {
          logger.error('BACKEND_SERVICE_TOKEN is not configured')
          return h
            .response({
              statusCode: HTTP_INTERNAL_SERVER_ERROR,
              error: 'Internal Server Error',
              message: 'Service configuration error'
            })
            .code(HTTP_INTERNAL_SERVER_ERROR)
            .takeover()
        }

        const verification = verifyServiceToken(
          token,
          secret,
          method,
          path,
          timestamp
        )

        if (!verification.valid) {
          logger.warn(
            `Token verification failed for ${method} ${path}: ${verification.reason}`
          )
          return h
            .response({
              statusCode: HTTP_UNAUTHORIZED,
              error: 'Unauthorized',
              message: 'Invalid or expired token'
            })
            .code(HTTP_UNAUTHORIZED)
            .takeover()
        }

        logger.debug(`Token verified for ${method} ${path}`)
        return h.continue
      })
    }
  }
}

export { serviceTokenAuth }
