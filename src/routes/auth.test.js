import { describe, test, expect, beforeEach, vi } from 'vitest'

// ── Constants ────────────────────────────────────────────────────────────────
const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401

const TEST_USER_ID = 'user-abc-123'
const TEST_EMAIL = 'user@defra.gov.uk'
const TEST_NAME = 'Test User'
const TEST_SECRET = 'test-jwt-secret-at-least-32-chars-padded'
const ACCESS_EXPIRY = 3600
const REFRESH_EXPIRY = 604800

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock('../config.js', () => ({
  config: { get: vi.fn() }
}))

vi.mock('../common/helpers/logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

// jwt.js uses config internally — set up before importing auth.js
import { config } from '../config.js'

config.get.mockImplementation((key) => {
  if (key === 'jwt.secret') return TEST_SECRET
  if (key === 'jwt.accessTokenExpirySeconds') return ACCESS_EXPIRY
  if (key === 'jwt.refreshTokenExpirySeconds') return REFRESH_EXPIRY
  return null
})

import { authRoutes } from './auth.js'

// ── Helpers ──────────────────────────────────────────────────────────────────
function createMockH() {
  const responseMock = { code: vi.fn().mockReturnThis() }
  return {
    response: vi.fn(() => responseMock),
    _responseMock: responseMock
  }
}

function getHandlers() {
  const routes = []
  const server = { route: vi.fn((defs) => routes.push(...defs)) }
  authRoutes.plugin.register(server)
  const login = routes.find((r) => r.path === '/api/v1/auth/login').handler
  const refresh = routes.find((r) => r.path === '/api/v1/auth/refresh').handler
  return { login, refresh }
}

// ── Plugin structure ──────────────────────────────────────────────────────────
describe('authRoutes plugin', () => {
  test('Should export a Hapi plugin named authRoutes', () => {
    expect(authRoutes.plugin.name).toBe('authRoutes')
    expect(typeof authRoutes.plugin.register).toBe('function')
  })

  test('Should register login and refresh routes with auth: false', () => {
    const routes = []
    const server = { route: vi.fn((defs) => routes.push(...defs)) }
    authRoutes.plugin.register(server)

    const loginRoute = routes.find((r) => r.path === '/api/v1/auth/login')
    const refreshRoute = routes.find((r) => r.path === '/api/v1/auth/refresh')

    expect(loginRoute).toBeDefined()
    expect(loginRoute.method).toBe('POST')
    expect(loginRoute.options.auth).toBe(false)

    expect(refreshRoute).toBeDefined()
    expect(refreshRoute.method).toBe('POST')
    expect(refreshRoute.options.auth).toBe(false)
  })
})

// ── POST /api/v1/auth/login ───────────────────────────────────────────────────
describe('loginHandler - success', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.get.mockImplementation((key) => {
      if (key === 'jwt.secret') return TEST_SECRET
      if (key === 'jwt.accessTokenExpirySeconds') return ACCESS_EXPIRY
      if (key === 'jwt.refreshTokenExpirySeconds') return REFRESH_EXPIRY
      return null
    })
  })

  test('Should return 200 with accessToken, refreshToken, and expiresIn', async () => {
    const { login } = getHandlers()
    const h = createMockH()
    const request = {
      payload: { userId: TEST_USER_ID, email: TEST_EMAIL, name: TEST_NAME }
    }

    await login(request, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        expiresIn: ACCESS_EXPIRY
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_OK)
  })

  test('Should issue tokens with correct JWT structure (3 parts)', async () => {
    const { login } = getHandlers()
    const h = createMockH()
    const request = {
      payload: { userId: TEST_USER_ID, email: TEST_EMAIL, name: TEST_NAME }
    }

    await login(request, h)

    const [[{ accessToken, refreshToken }]] = h.response.mock.calls
    expect(accessToken.split('.')).toHaveLength(3)
    expect(refreshToken.split('.')).toHaveLength(3)
  })

  test('Should issue access and refresh tokens with correct type claims', async () => {
    const { login } = getHandlers()
    const h = createMockH()
    const request = {
      payload: { userId: TEST_USER_ID, email: TEST_EMAIL, name: TEST_NAME }
    }

    await login(request, h)

    const [[{ accessToken, refreshToken }]] = h.response.mock.calls
    const accessPayload = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')
    )
    const refreshPayload = JSON.parse(
      Buffer.from(refreshToken.split('.')[1], 'base64url').toString('utf8')
    )
    expect(accessPayload.type).toBe('access')
    expect(refreshPayload.type).toBe('refresh')
    expect(accessPayload.sub).toBe(TEST_USER_ID)
    expect(refreshPayload.sub).toBe(TEST_USER_ID)
  })

  test('Should work when name is omitted from payload', async () => {
    const { login } = getHandlers()
    const h = createMockH()
    const request = {
      payload: { userId: TEST_USER_ID, email: TEST_EMAIL }
    }

    await login(request, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_OK)
  })
})

describe('loginHandler - validation errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.get.mockImplementation((key) => {
      if (key === 'jwt.secret') return TEST_SECRET
      if (key === 'jwt.accessTokenExpirySeconds') return ACCESS_EXPIRY
      if (key === 'jwt.refreshTokenExpirySeconds') return REFRESH_EXPIRY
      return null
    })
  })

  test('Should return 400 when userId is missing', async () => {
    const { login } = getHandlers()
    const h = createMockH()
    const request = { payload: { email: TEST_EMAIL } }

    await login(request, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_BAD_REQUEST)
  })

  test('Should return 400 when email is missing', async () => {
    const { login } = getHandlers()
    const h = createMockH()
    const request = { payload: { userId: TEST_USER_ID } }

    await login(request, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_BAD_REQUEST)
  })

  test('Should return 400 when payload is null', async () => {
    const { login } = getHandlers()
    const h = createMockH()
    const request = { payload: null }

    await login(request, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_BAD_REQUEST)
  })
})

// ── POST /api/v1/auth/refresh ─────────────────────────────────────────────────
describe('refreshHandler - success', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.get.mockImplementation((key) => {
      if (key === 'jwt.secret') return TEST_SECRET
      if (key === 'jwt.accessTokenExpirySeconds') return ACCESS_EXPIRY
      if (key === 'jwt.refreshTokenExpirySeconds') return REFRESH_EXPIRY
      return null
    })
  })

  test('Should return 200 with new token pair for a valid refresh token', async () => {
    // First login to get a refresh token
    const { login, refresh } = getHandlers()
    const loginH = createMockH()
    await login(
      { payload: { userId: TEST_USER_ID, email: TEST_EMAIL, name: TEST_NAME } },
      loginH
    )
    const [[{ refreshToken }]] = loginH.response.mock.calls

    // Now use the refresh token
    const h = createMockH()
    await refresh({ payload: { refreshToken } }, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        expiresIn: ACCESS_EXPIRY
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_OK)
  })

  test('Should issue a new access token with type: access on refresh', async () => {
    const { login, refresh } = getHandlers()
    const loginH = createMockH()
    await login(
      { payload: { userId: TEST_USER_ID, email: TEST_EMAIL, name: TEST_NAME } },
      loginH
    )
    const [[{ refreshToken }]] = loginH.response.mock.calls

    const h = createMockH()
    await refresh({ payload: { refreshToken } }, h)

    const [[{ accessToken }]] = h.response.mock.calls
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')
    )
    expect(payload.type).toBe('access')
    expect(payload.sub).toBe(TEST_USER_ID)
  })
})

describe('refreshHandler - validation errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.get.mockImplementation((key) => {
      if (key === 'jwt.secret') return TEST_SECRET
      if (key === 'jwt.accessTokenExpirySeconds') return ACCESS_EXPIRY
      if (key === 'jwt.refreshTokenExpirySeconds') return REFRESH_EXPIRY
      return null
    })
  })

  test('Should return 400 when refreshToken is missing', async () => {
    const { refresh } = getHandlers()
    const h = createMockH()

    await refresh({ payload: {} }, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_BAD_REQUEST)
  })

  test('Should return 400 when payload is null', async () => {
    const { refresh } = getHandlers()
    const h = createMockH()

    await refresh({ payload: null }, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_BAD_REQUEST)
  })

  test('Should return 401 for an invalid refresh token', async () => {
    const { refresh } = getHandlers()
    const h = createMockH()

    await refresh({ payload: { refreshToken: 'not.a.valid.token' } }, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_UNAUTHORIZED)
  })

  test('Should return 401 when an access token is passed instead of refresh token', async () => {
    const { login, refresh } = getHandlers()
    const loginH = createMockH()
    await login(
      { payload: { userId: TEST_USER_ID, email: TEST_EMAIL, name: TEST_NAME } },
      loginH
    )
    // Deliberately pass the access token to the refresh endpoint
    const [[{ accessToken }]] = loginH.response.mock.calls

    const h = createMockH()
    await refresh({ payload: { refreshToken: accessToken } }, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Token is not a refresh token' })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_UNAUTHORIZED)
  })

  test('Should return 401 for a completely malformed token string', async () => {
    const { refresh } = getHandlers()
    const h = createMockH()

    await refresh({ payload: { refreshToken: 'garbage' } }, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_UNAUTHORIZED)
  })
})
