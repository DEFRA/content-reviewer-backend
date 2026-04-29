import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockVerifyAccessToken = vi.hoisted(() => vi.fn())
const mockConfigGet = vi.hoisted(() => vi.fn())
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))

vi.mock('../common/helpers/auth/jwt-service.js', () => ({
  verifyAccessToken: mockVerifyAccessToken
}))

vi.mock('../config.js', () => ({
  config: { get: mockConfigGet }
}))

vi.mock('../common/helpers/logging/logger.js', () => ({
  createLogger: () => mockLogger
}))

import { jwtAuth } from './jwt-auth.js'

const HTTP_UNAUTHORIZED = 401

// ── Helpers ───────────────────────────────────────────────────────────────────

function registerAndGetHandler() {
  let handler
  const server = {
    ext: vi.fn((_, fn) => {
      handler = fn
    })
  }
  jwtAuth.plugin.register(server)
  return { server, handler }
}

function createH() {
  const mockResp = {
    code: vi.fn().mockReturnThis(),
    takeover: vi.fn().mockReturnThis()
  }
  return {
    continue: Symbol('hapi-continue'),
    response: vi.fn().mockReturnValue(mockResp),
    _resp: mockResp
  }
}

function createRequest(path, authHeader = undefined, method = 'get') {
  return {
    path,
    method,
    headers: authHeader ? { authorization: authHeader } : {},
    app: {}
  }
}

// ── Plugin registration ───────────────────────────────────────────────────────

describe('jwtAuth plugin - registration', () => {
  it('exports a plugin with name "jwt-auth"', () => {
    expect(jwtAuth.plugin.name).toBe('jwt-auth')
  })

  it('registers an onPreHandler extension on the server', () => {
    const { server } = registerAndGetHandler()
    expect(server.ext).toHaveBeenCalledWith(
      'onPreHandler',
      expect.any(Function)
    )
  })
})

// ── Auth disabled ─────────────────────────────────────────────────────────────

describe('jwtAuth - auth.enabled = false', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigGet.mockImplementation((key) =>
      key === 'auth.enabled' ? false : null
    )
  })

  it('returns h.continue immediately without checking any headers', () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    const result = handler(createRequest('/api/results/123'), h)
    expect(result).toBe(h.continue)
    expect(h.response).not.toHaveBeenCalled()
    expect(mockVerifyAccessToken).not.toHaveBeenCalled()
  })

  it('skips token check even for protected paths when auth is disabled', () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    expect(
      handler(createRequest('/api/review/text', undefined, 'post'), h)
    ).toBe(h.continue)
  })
})

// ── Public paths ──────────────────────────────────────────────────────────────

describe('jwtAuth - public paths bypass token check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigGet.mockImplementation((key) =>
      key === 'auth.enabled' ? true : null
    )
  })

  it.each([
    '/health',
    '/api/auth/login',
    '/api/auth/refresh',
    '/api/auth/logout',
    '/api/sqs-worker/status',
    '/upload-callback'
  ])('allows %s without any Authorization header', (path) => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    expect(handler(createRequest(path), h)).toBe(h.continue)
    expect(h.response).not.toHaveBeenCalled()
  })
})

// ── Missing / malformed Authorization header ──────────────────────────────────

describe('jwtAuth - missing or malformed Authorization header', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigGet.mockImplementation((key) =>
      key === 'auth.enabled' ? true : null
    )
  })

  it('returns 401 when no Authorization header is present', () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    handler(createRequest('/api/results/123'), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HTTP_UNAUTHORIZED,
        error: 'Unauthorized',
        message: 'Missing Bearer token'
      })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP_UNAUTHORIZED)
    expect(h._resp.takeover).toHaveBeenCalled()
  })

  it('returns 401 when Authorization is "Basic ..." (not Bearer)', () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    handler(createRequest('/api/results/123', 'Basic dXNlcjpwYXNz'), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Missing Bearer token' })
    )
  })

  it('returns 401 when Authorization is "bearer ..." (lowercase)', () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    handler(createRequest('/api/results/123', 'bearer sometoken'), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Missing Bearer token' })
    )
  })

  it('logs a warning with uppercased method and path when token is missing', () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    handler(createRequest('/api/upload', undefined, 'post'), h)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { method: 'POST', path: '/api/upload' },
      'Missing Bearer token'
    )
  })
})

// ── Valid token ───────────────────────────────────────────────────────────────

describe('jwtAuth - valid Bearer token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigGet.mockImplementation((key) =>
      key === 'auth.enabled' ? true : null
    )
  })

  it('returns h.continue when token is valid', () => {
    mockVerifyAccessToken.mockReturnValueOnce({ sub: 'u1', email: 'a@b.com' })
    const { handler } = registerAndGetHandler()
    const h = createH()
    const result = handler(
      createRequest('/api/results/123', 'Bearer valid.jwt.token'),
      h
    )
    expect(result).toBe(h.continue)
  })

  it('attaches decoded claims to request.app.jwtUser', () => {
    const claims = { sub: 'user-42', email: 'x@y.com', name: 'Alice' }
    mockVerifyAccessToken.mockReturnValueOnce(claims)
    const { handler } = registerAndGetHandler()
    const h = createH()
    const request = createRequest('/api/results/123', 'Bearer my.jwt.token')
    handler(request, h)
    expect(request.app.jwtUser).toEqual(claims)
  })

  it('calls verifyAccessToken with the raw token (without "Bearer " prefix)', () => {
    mockVerifyAccessToken.mockReturnValueOnce({ sub: 'u1' })
    const { handler } = registerAndGetHandler()
    const h = createH()
    handler(createRequest('/api/results/123', 'Bearer my.test.token'), h)
    expect(mockVerifyAccessToken).toHaveBeenCalledWith('my.test.token')
  })

  it('does not call h.response when token is valid', () => {
    mockVerifyAccessToken.mockReturnValueOnce({ sub: 'u1' })
    const { handler } = registerAndGetHandler()
    const h = createH()
    handler(createRequest('/api/results/123', 'Bearer ok.token'), h)
    expect(h.response).not.toHaveBeenCalled()
  })
})

// ── Invalid / expired token ───────────────────────────────────────────────────

describe('jwtAuth - invalid or expired token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigGet.mockImplementation((key) =>
      key === 'auth.enabled' ? true : null
    )
  })

  it('returns 401 when verifyAccessToken throws', () => {
    mockVerifyAccessToken.mockImplementationOnce(() => {
      throw new Error('Token expired')
    })
    const { handler } = registerAndGetHandler()
    const h = createH()
    handler(createRequest('/api/results/123', 'Bearer expired.jwt.token'), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HTTP_UNAUTHORIZED,
        error: 'Unauthorized',
        message: 'Invalid or expired token'
      })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP_UNAUTHORIZED)
    expect(h._resp.takeover).toHaveBeenCalled()
  })

  it('logs a warning with path and error message when token verification fails', () => {
    mockVerifyAccessToken.mockImplementationOnce(() => {
      throw new Error('Invalid signature')
    })
    const { handler } = registerAndGetHandler()
    const h = createH()
    handler(createRequest('/api/results/123', 'Bearer bad.token'), h)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { path: '/api/results/123', error: 'Invalid signature' },
      'JWT verification failed'
    )
  })

  it('does not set request.app.jwtUser when verification fails', () => {
    mockVerifyAccessToken.mockImplementationOnce(() => {
      throw new Error('Expired')
    })
    const { handler } = registerAndGetHandler()
    const h = createH()
    const request = createRequest('/api/results/123', 'Bearer bad.token')
    handler(request, h)
    expect(request.app.jwtUser).toBeUndefined()
  })
})
