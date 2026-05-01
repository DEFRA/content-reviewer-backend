import { config } from '../config.js'
import { signJwt, verifyJwt } from '../common/helpers/jwt.js'
import { createLogger } from '../common/helpers/logging/logger.js'

const logger = createLogger()

const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401

/**
 * Issue a new access + refresh token pair for the given user claims.
 */
function issueTokenPair(userId, email, name) {
  const accessExpirySeconds = config.get('jwt.accessTokenExpirySeconds')
  const refreshExpirySeconds = config.get('jwt.refreshTokenExpirySeconds')

  const accessToken = signJwt(
    { sub: userId, email, name, type: 'access' },
    accessExpirySeconds
  )
  const refreshToken = signJwt(
    { sub: userId, email, name, type: 'refresh' },
    refreshExpirySeconds
  )

  return { accessToken, refreshToken, expiresIn: accessExpirySeconds }
}

/**
 * POST /api/v1/auth/login
 *
 * Called by the frontend immediately after a successful Azure SSO callback.
 * The frontend has already validated the user via MSAL; this endpoint issues
 * backend-scoped JWT tokens that the frontend will attach to all subsequent
 * API calls as `Authorization: Bearer <accessToken>`.
 *
 * Body: { userId, email, name }
 * Response: { accessToken, refreshToken, expiresIn }
 */
async function loginHandler(request, h) {
  const { userId, email, name } = request.payload ?? {}

  if (!userId || !email) {
    logger.warn(
      { path: request.path },
      'Auth login called with missing userId or email'
    )
    return h
      .response({ error: 'userId and email are required' })
      .code(HTTP_BAD_REQUEST)
  }

  const tokens = issueTokenPair(userId, email, name ?? '')
  logger.info({ userId, email }, 'JWT tokens issued for authenticated user')

  return h.response(tokens).code(HTTP_OK)
}

/**
 * POST /api/v1/auth/refresh
 *
 * Accepts a valid refresh token and issues a new access + refresh token pair.
 * The old refresh token is invalidated by virtue of the short-lived replacement.
 *
 * Body: { refreshToken }
 * Response: { accessToken, refreshToken, expiresIn }
 */
async function refreshHandler(request, h) {
  const { refreshToken } = request.payload ?? {}

  if (!refreshToken) {
    return h
      .response({ error: 'refreshToken is required' })
      .code(HTTP_BAD_REQUEST)
  }

  let claims
  try {
    claims = verifyJwt(refreshToken)
  } catch (error) {
    logger.warn({ error: error.message }, 'Refresh token verification failed')
    return h
      .response({ error: 'Invalid or expired refresh token' })
      .code(HTTP_UNAUTHORIZED)
  }

  if (claims.type !== 'refresh') {
    return h
      .response({ error: 'Token is not a refresh token' })
      .code(HTTP_UNAUTHORIZED)
  }

  const tokens = issueTokenPair(claims.sub, claims.email, claims.name ?? '')
  logger.info({ userId: claims.sub }, 'JWT tokens refreshed')

  return h.response(tokens).code(HTTP_OK)
}

export const authRoutes = {
  plugin: {
    name: 'authRoutes',
    register: (server) => {
      server.route([
        {
          method: 'POST',
          path: '/api/v1/auth/login',
          options: { auth: false },
          handler: loginHandler
        },
        {
          method: 'POST',
          path: '/api/v1/auth/refresh',
          options: { auth: false },
          handler: refreshHandler
        }
      ])
    }
  }
}
