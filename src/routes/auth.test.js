import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockGenerateAccessToken = vi.hoisted(() => vi.fn())
const mockGenerateRefreshToken = vi.hoisted(() => vi.fn())
const mockHashRefreshToken = vi.hoisted(() => vi.fn())
const mockStoreRefreshToken = vi.hoisted(() => vi.fn())
const mockFindRefreshToken = vi.hoisted(() => vi.fn())
const mockDeleteRefreshToken = vi.hoisted(() => vi.fn())
const mockConfigGet = vi.hoisted(() => vi.fn())
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))

vi.mock('../common/helpers/auth/jwt-service.js', () => ({
  generateAccessToken: mockGenerateAccessToken,
  generateRefreshToken: mockGenerateRefreshToken,
  hashRefreshToken: mockHashRefreshToken
}))

vi.mock('../common/helpers/auth/refresh-token-repository.js', () => ({
  storeRefreshToken: mockStoreRefreshToken,
  findRefreshToken: mockFindRefreshToken,
  deleteRefreshToken: mockDeleteRefreshToken
}))

vi.mock('../config.js', () => ({
  config: { get: mockConfigGet }
}))

vi.mock('../common/helpers/logging/logger.js', () => ({
  createLogger: () => mockLogger
}))

import { authRoutes } from './auth.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const HTTP = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_SERVER_ERROR: 500
}
const ACCESS_TOKEN = 'header.payload.signature'
const REFRESH_TOKEN = 'opaque-refresh-token'
const REFRESH_TOKEN_HASH = 'sha256-hash-of-refresh-token'
const EXPIRES_IN = 900

// ── Helpers ───────────────────────────────────────────────────────────────────

function getHandlers() {
  const handlers = {}
  const server = {
    route: vi.fn((routes) => {
      for (const r of routes) {
        handlers[r.path] = r.handler
      }
    })
  }
  authRoutes.plugin.register(server)
  return handlers
}

function createH() {
  const mockResp = { code: vi.fn().mockReturnThis() }
  return {
    response: vi.fn().mockReturnValue(mockResp),
    _resp: mockResp
  }
}

function createRequest(payload, db = {}) {
  return { payload, db }
}

// ── authRoutes plugin ─────────────────────────────────────────────────────────

describe('authRoutes plugin - registration', () => {
  it('has the correct plugin name', () => {
    expect(authRoutes.plugin.name).toBe('auth-routes')
  })

  it('registers POST /api/auth/login, /api/auth/refresh and /api/auth/logout', () => {
    const handlers = getHandlers()
    expect(handlers).toHaveProperty('/api/auth/login')
    expect(handlers).toHaveProperty('/api/auth/refresh')
    expect(handlers).toHaveProperty('/api/auth/logout')
  })
})

// ── handleLogin ───────────────────────────────────────────────────────────────

describe('handleLogin - db unavailable', () => {
  it('returns 503 when request.db is falsy', async () => {
    const { '/api/auth/login': login } = getHandlers()
    const h = createH()
    await login({ payload: {}, db: null }, h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.SERVICE_UNAVAILABLE)
  })
})

describe('handleLogin - validation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when userId is missing', async () => {
    const { '/api/auth/login': login } = getHandlers()
    const h = createH()
    await login(createRequest({ email: 'a@b.com' }), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'userId and email are required' })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.BAD_REQUEST)
  })

  it('returns 400 when email is missing', async () => {
    const { '/api/auth/login': login } = getHandlers()
    const h = createH()
    await login(createRequest({ userId: 'u1' }), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'userId and email are required' })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.BAD_REQUEST)
  })

  it('returns 400 when payload is null', async () => {
    const { '/api/auth/login': login } = getHandlers()
    const h = createH()
    await login(createRequest(null), h)
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.BAD_REQUEST)
  })
})

describe('handleLogin - success', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGenerateAccessToken.mockReturnValue(ACCESS_TOKEN)
    mockGenerateRefreshToken.mockReturnValue({
      token: REFRESH_TOKEN,
      hash: REFRESH_TOKEN_HASH
    })
    mockStoreRefreshToken.mockResolvedValue(undefined)
    mockConfigGet.mockReturnValue(EXPIRES_IN)
  })

  it('returns 200 with accessToken, refreshToken and expiresIn', async () => {
    const { '/api/auth/login': login } = getHandlers()
    const h = createH()
    await login(
      createRequest({ userId: 'u1', email: 'a@b.com', name: 'Alice' }),
      h
    )
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresIn: EXPIRES_IN
      })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.OK)
  })

  it('calls generateAccessToken with userId, email and name', async () => {
    const { '/api/auth/login': login } = getHandlers()
    await login(
      createRequest({ userId: 'u1', email: 'a@b.com', name: 'Alice' }),
      createH()
    )
    expect(mockGenerateAccessToken).toHaveBeenCalledWith(
      'u1',
      'a@b.com',
      'Alice'
    )
  })

  it('uses empty string for name when name is absent', async () => {
    const { '/api/auth/login': login } = getHandlers()
    await login(createRequest({ userId: 'u1', email: 'a@b.com' }), createH())
    expect(mockGenerateAccessToken).toHaveBeenCalledWith('u1', 'a@b.com', '')
  })

  it('calls storeRefreshToken with db, userId, email, name and hash', async () => {
    const db = {}
    const { '/api/auth/login': login } = getHandlers()
    await login(
      { payload: { userId: 'u1', email: 'a@b.com', name: 'Alice' }, db },
      createH()
    )
    expect(mockStoreRefreshToken).toHaveBeenCalledWith(
      db,
      'u1',
      'a@b.com',
      'Alice',
      REFRESH_TOKEN_HASH
    )
  })

  it('logs an info message on success', async () => {
    const { '/api/auth/login': login } = getHandlers()
    await login(createRequest({ userId: 'u1', email: 'a@b.com' }), createH())
    expect(mockLogger.info).toHaveBeenCalledWith(
      { userId: 'u1', email: 'a@b.com' },
      'JWT tokens issued on login'
    )
  })
})

describe('handleLogin - error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGenerateAccessToken.mockReturnValue(ACCESS_TOKEN)
    mockGenerateRefreshToken.mockReturnValue({
      token: REFRESH_TOKEN,
      hash: REFRESH_TOKEN_HASH
    })
    mockStoreRefreshToken.mockRejectedValue(new Error('DB write failed'))
  })

  it('returns 500 when token storage throws', async () => {
    const { '/api/auth/login': login } = getHandlers()
    const h = createH()
    await login(createRequest({ userId: 'u1', email: 'a@b.com' }), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Failed to generate tokens'
      })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.INTERNAL_SERVER_ERROR)
  })
})

// ── handleRefresh ─────────────────────────────────────────────────────────────

describe('handleRefresh - db unavailable', () => {
  it('returns 503 when request.db is falsy', async () => {
    const { '/api/auth/refresh': refresh } = getHandlers()
    const h = createH()
    await refresh({ payload: {}, db: null }, h)
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.SERVICE_UNAVAILABLE)
  })
})

describe('handleRefresh - validation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when refreshToken is missing', async () => {
    const { '/api/auth/refresh': refresh } = getHandlers()
    const h = createH()
    await refresh(createRequest({}), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'refreshToken is required' })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.BAD_REQUEST)
  })

  it('returns 400 when payload is null', async () => {
    const { '/api/auth/refresh': refresh } = getHandlers()
    const h = createH()
    await refresh(createRequest(null), h)
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.BAD_REQUEST)
  })
})

describe('handleRefresh - token not found', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHashRefreshToken.mockReturnValue(REFRESH_TOKEN_HASH)
    mockFindRefreshToken.mockResolvedValue(null)
  })

  it('returns 401 when the refresh token is not found in the database', async () => {
    const { '/api/auth/refresh': refresh } = getHandlers()
    const h = createH()
    await refresh(createRequest({ refreshToken: REFRESH_TOKEN }), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Invalid or expired refresh token' })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.UNAUTHORIZED)
  })
})

describe('handleRefresh - success', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHashRefreshToken.mockReturnValue(REFRESH_TOKEN_HASH)
    mockFindRefreshToken.mockResolvedValue({
      userId: 'u1',
      email: 'a@b.com',
      name: 'Alice'
    })
    mockGenerateAccessToken.mockReturnValue(ACCESS_TOKEN)
    mockConfigGet.mockReturnValue(EXPIRES_IN)
  })

  it('returns 200 with a new accessToken and expiresIn', async () => {
    const { '/api/auth/refresh': refresh } = getHandlers()
    const h = createH()
    await refresh(createRequest({ refreshToken: REFRESH_TOKEN }), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        accessToken: ACCESS_TOKEN,
        expiresIn: EXPIRES_IN
      })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.OK)
  })

  it('calls generateAccessToken with stored userId, email and name', async () => {
    const { '/api/auth/refresh': refresh } = getHandlers()
    await refresh(createRequest({ refreshToken: REFRESH_TOKEN }), createH())
    expect(mockGenerateAccessToken).toHaveBeenCalledWith(
      'u1',
      'a@b.com',
      'Alice'
    )
  })

  it('logs an info message on success', async () => {
    const { '/api/auth/refresh': refresh } = getHandlers()
    await refresh(createRequest({ refreshToken: REFRESH_TOKEN }), createH())
    expect(mockLogger.info).toHaveBeenCalledWith(
      { userId: 'u1' },
      'Access token refreshed'
    )
  })
})

describe('handleRefresh - error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHashRefreshToken.mockReturnValue(REFRESH_TOKEN_HASH)
    mockFindRefreshToken.mockRejectedValue(new Error('DB read error'))
  })

  it('returns 500 when findRefreshToken throws', async () => {
    const { '/api/auth/refresh': refresh } = getHandlers()
    const h = createH()
    await refresh(createRequest({ refreshToken: REFRESH_TOKEN }), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Failed to refresh token'
      })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.INTERNAL_SERVER_ERROR)
  })
})

// ── handleLogout ──────────────────────────────────────────────────────────────

describe('handleLogout - db unavailable', () => {
  it('returns 200 with success:true when request.db is falsy (nothing to revoke)', async () => {
    const { '/api/auth/logout': logout } = getHandlers()
    const h = createH()
    await logout({ payload: { refreshToken: REFRESH_TOKEN }, db: null }, h)
    expect(h.response).toHaveBeenCalledWith({ success: true })
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.OK)
  })
})

describe('handleLogout - success', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHashRefreshToken.mockReturnValue(REFRESH_TOKEN_HASH)
    mockDeleteRefreshToken.mockResolvedValue(undefined)
  })

  it('returns 200 with success:true when refreshToken is provided', async () => {
    const { '/api/auth/logout': logout } = getHandlers()
    const h = createH()
    await logout(createRequest({ refreshToken: REFRESH_TOKEN }), h)
    expect(h.response).toHaveBeenCalledWith({ success: true })
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.OK)
  })

  it('calls deleteRefreshToken with db and the hashed token', async () => {
    const db = {}
    const { '/api/auth/logout': logout } = getHandlers()
    await logout({ payload: { refreshToken: REFRESH_TOKEN }, db }, createH())
    expect(mockDeleteRefreshToken).toHaveBeenCalledWith(db, REFRESH_TOKEN_HASH)
  })

  it('returns 200 with success:true when no refreshToken is supplied', async () => {
    const { '/api/auth/logout': logout } = getHandlers()
    const h = createH()
    await logout(createRequest({}), h)
    expect(h.response).toHaveBeenCalledWith({ success: true })
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.OK)
    expect(mockDeleteRefreshToken).not.toHaveBeenCalled()
  })

  it('returns 200 when payload is null', async () => {
    const { '/api/auth/logout': logout } = getHandlers()
    const h = createH()
    await logout(createRequest(null), h)
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.OK)
  })
})

describe('handleLogout - error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHashRefreshToken.mockReturnValue(REFRESH_TOKEN_HASH)
    mockDeleteRefreshToken.mockRejectedValue(new Error('DB error'))
  })

  it('returns 500 when deleteRefreshToken throws', async () => {
    const { '/api/auth/logout': logout } = getHandlers()
    const h = createH()
    await logout(createRequest({ refreshToken: REFRESH_TOKEN }), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Logout failed' })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP.INTERNAL_SERVER_ERROR)
  })
})
