import { verifyAccessToken } from '../common/helpers/auth/jwt-service.js'
import { config } from '../config.js'
import { createLogger } from '../common/helpers/logging/logger.js'

const logger = createLogger()

const HTTP_UNAUTHORIZED = 401
const BEARER_PREFIX_LENGTH = 7 // 'Bearer '.length

// Paths that do not require a Bearer token
const PUBLIC_PATHS = [
  /^\/health$/,
  /^\/api\/auth\/login$/,
  /^\/api\/auth\/refresh$/,
  /^\/api\/auth\/logout$/,
  /^\/api\/sqs-worker\/status$/,
  /^\/upload-callback$/
]

function isPublicPath(path) {
  return PUBLIC_PATHS.some((pattern) => pattern.test(path))
}

/**
 * Hapi plugin that validates a JWT Bearer token on every non-public route.
 *
 * On success the decoded payload is attached to request.app.jwtUser so
 * handlers can access { sub, email, name } without re-parsing the token.
 *
 * Auth can be disabled entirely via AUTH_ENABLED=false for local development
 * without Azure AD.
 */
export const jwtAuth = {
  plugin: {
    name: 'jwt-auth',
    register: (server) => {
      server.ext('onPreHandler', (request, h) => {
        if (!config.get('auth.enabled')) {
          return h.continue
        }

        if (isPublicPath(request.path)) {
          return h.continue
        }

        const authHeader = request.headers.authorization
        if (!authHeader?.startsWith('Bearer ')) {
          logger.warn(
            { method: request.method.toUpperCase(), path: request.path },
            'Missing Bearer token'
          )
          return h
            .response({
              statusCode: HTTP_UNAUTHORIZED,
              error: 'Unauthorized',
              message: 'Missing Bearer token'
            })
            .code(HTTP_UNAUTHORIZED)
            .takeover()
        }

        const token = authHeader.slice(BEARER_PREFIX_LENGTH)
        try {
          const claims = verifyAccessToken(token)
          request.app.jwtUser = claims
          logger.debug(
            { userId: claims.sub, path: request.path },
            'JWT verified'
          )
        } catch (error) {
          logger.warn(
            { path: request.path, error: error.message },
            'JWT verification failed'
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

        return h.continue
      })
    }
  }
}
