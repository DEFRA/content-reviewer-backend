import {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken
} from '../common/helpers/auth/jwt-service.js'
import {
  storeRefreshToken,
  findRefreshToken,
  deleteRefreshToken
} from '../common/helpers/auth/refresh-token-repository.js'
import { config } from '../config.js'
import { createLogger } from '../common/helpers/logging/logger.js'

const logger = createLogger()

const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_SERVER_ERROR: 500
}

function dbUnavailable(h) {
  return h
    .response({
      success: false,
      error: 'Auth service unavailable — database not connected'
    })
    .code(HTTP_STATUS.SERVICE_UNAVAILABLE)
}

/**
 * POST /api/auth/login
 *
 * Called by the frontend server after a successful Azure AD authentication.
 * Accepts the verified user identity and returns a short-lived JWT access token
 * plus a long-lived refresh token.
 */
async function handleLogin(request, h) {
  if (!request.db) return dbUnavailable(h)
  try {
    const { userId, email, name } = request.payload ?? {}

    if (!userId || !email) {
      return h
        .response({ success: false, error: 'userId and email are required' })
        .code(HTTP_STATUS.BAD_REQUEST)
    }

    const accessToken = generateAccessToken(userId, email, name ?? '')
    const { token: refreshToken, hash: refreshTokenHash } =
      generateRefreshToken()

    await storeRefreshToken(
      request.db,
      userId,
      email,
      name ?? '',
      refreshTokenHash
    )

    const expiresIn = config.get('auth.accessTokenExpirySeconds')

    logger.info({ userId, email }, 'JWT tokens issued on login')

    return h
      .response({ success: true, accessToken, refreshToken, expiresIn })
      .code(HTTP_STATUS.OK)
  } catch (error) {
    logger.error({ error: error.message }, 'Login token generation failed')
    return h
      .response({ success: false, error: 'Failed to generate tokens' })
      .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  }
}

/**
 * POST /api/auth/refresh
 *
 * Accepts a refresh token and returns a new short-lived access token.
 * The refresh token itself is not rotated — only the access token is renewed.
 */
async function handleRefresh(request, h) {
  if (!request.db) return dbUnavailable(h)
  try {
    const { refreshToken } = request.payload ?? {}

    if (!refreshToken) {
      return h
        .response({ success: false, error: 'refreshToken is required' })
        .code(HTTP_STATUS.BAD_REQUEST)
    }

    const tokenHash = hashRefreshToken(refreshToken)
    const stored = await findRefreshToken(request.db, tokenHash)

    if (!stored) {
      return h
        .response({ success: false, error: 'Invalid or expired refresh token' })
        .code(HTTP_STATUS.UNAUTHORIZED)
    }

    const accessToken = generateAccessToken(
      stored.userId,
      stored.email,
      stored.name
    )
    const expiresIn = config.get('auth.accessTokenExpirySeconds')

    logger.info({ userId: stored.userId }, 'Access token refreshed')

    return h
      .response({ success: true, accessToken, expiresIn })
      .code(HTTP_STATUS.OK)
  } catch (error) {
    logger.error({ error: error.message }, 'Token refresh failed')
    return h
      .response({ success: false, error: 'Failed to refresh token' })
      .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  }
}

/**
 * POST /api/auth/logout
 *
 * Revokes the supplied refresh token so it can no longer be used to obtain
 * new access tokens.
 */
async function handleLogout(request, h) {
  if (!request.db) return h.response({ success: true }).code(HTTP_STATUS.OK) // nothing to revoke
  try {
    const { refreshToken } = request.payload ?? {}

    if (refreshToken) {
      const tokenHash = hashRefreshToken(refreshToken)
      await deleteRefreshToken(request.db, tokenHash)
    }

    return h.response({ success: true }).code(HTTP_STATUS.OK)
  } catch (error) {
    logger.error({ error: error.message }, 'Logout failed')
    return h
      .response({ success: false, error: 'Logout failed' })
      .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  }
}

export const authRoutes = {
  plugin: {
    name: 'auth-routes',
    register: (server) => {
      server.route([
        {
          method: 'POST',
          path: '/api/auth/login',
          handler: handleLogin
        },
        {
          method: 'POST',
          path: '/api/auth/refresh',
          handler: handleRefresh
        },
        {
          method: 'POST',
          path: '/api/auth/logout',
          handler: handleLogout
        }
      ])
    }
  }
}
