import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockVerifyServiceToken = vi.hoisted(() => vi.fn())
const mockConfigGet = vi.hoisted(() => vi.fn())
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))

vi.mock('../common/helpers/auth/generate-service-token.js', () => ({
  verifyServiceToken: mockVerifyServiceToken
}))

vi.mock('../config.js', () => ({
  config: { get: mockConfigGet }
}))

vi.mock('../common/helpers/logging/logger.js', () => ({
  createLogger: () => mockLogger
}))

import { serviceTokenAuth } from './service-token-auth.js'

const HTTP_UNAUTHORIZED = 401
const HTTP_INTERNAL_SERVER_ERROR = 500
const VALID_SECRET = 'shared-service-secret'
const VALID_TOKEN = 'a'.repeat(64)
const VALID_TS = String(Date.now())

// ── Helpers ───────────────────────────────────────────────────────────────────

function registerAndGetHandler() {
  let handler
  const server = {
    ext: vi.fn((_, fn) => {
      handler = fn
    })
  }
  serviceTokenAuth.plugin.register(server)
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

function createRequest(path, method = 'GET', headers = {}) {
  return { path, method, headers }
}

// ── Plugin registration ───────────────────────────────────────────────────────

describe('serviceTokenAuth plugin - registration', () => {
  it('has the correct plugin name', () => {
    expect(serviceTokenAuth.plugin.name).toBe('serviceTokenAuth')
  })

  it('registers an onRequest extension on the server', () => {
    const { server } = registerAndGetHandler()
    expect(server.ext).toHaveBeenCalledWith('onRequest', expect.any(Function))
  })
})

// ── Public routes ─────────────────────────────────────────────────────────────

describe('serviceTokenAuth - public routes bypass auth', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(['/health', '/upload-callback', '/api/sqs-worker/status'])(
    'allows %s without any service token headers',
    async (path) => {
      const { handler } = registerAndGetHandler()
      const h = createH()
      const result = await handler(createRequest(path), h)
      expect(result).toBe(h.continue)
      expect(h.response).not.toHaveBeenCalled()
    }
  )
})

// ── Missing headers ───────────────────────────────────────────────────────────

describe('serviceTokenAuth - missing headers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when both x-service-token and x-timestamp are absent', async () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    await handler(createRequest('/api/review/text', 'POST'), h)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HTTP_UNAUTHORIZED,
        message: 'Missing x-service-token or x-timestamp header'
      })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP_UNAUTHORIZED)
    expect(h._resp.takeover).toHaveBeenCalled()
  })

  it('returns 401 when x-service-token is present but x-timestamp is absent', async () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    await handler(
      createRequest('/api/review/text', 'POST', {
        'x-service-token': VALID_TOKEN
      }),
      h
    )
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Missing x-service-token or x-timestamp header'
      })
    )
  })

  it('returns 401 when x-timestamp is present but x-service-token is absent', async () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    await handler(
      createRequest('/api/review/text', 'POST', { 'x-timestamp': VALID_TS }),
      h
    )
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Missing x-service-token or x-timestamp header'
      })
    )
  })

  it('logs a warning when headers are missing', async () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    await handler(createRequest('/api/review/text', 'POST'), h)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Missing auth headers')
    )
  })
})

// ── Invalid timestamp ─────────────────────────────────────────────────────────

describe('serviceTokenAuth - invalid timestamp', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when x-timestamp is not a number', async () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    await handler(
      createRequest('/api/review/text', 'POST', {
        'x-service-token': VALID_TOKEN,
        'x-timestamp': 'not-a-number'
      }),
      h
    )
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HTTP_UNAUTHORIZED,
        message: 'Invalid x-timestamp header'
      })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP_UNAUTHORIZED)
    expect(h._resp.takeover).toHaveBeenCalled()
  })

  it('logs a warning with the invalid timestamp value', async () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    await handler(
      createRequest('/api/review/text', 'POST', {
        'x-service-token': VALID_TOKEN,
        'x-timestamp': 'abc'
      }),
      h
    )
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid timestamp format: abc')
    )
  })
})

// ── Missing secret ────────────────────────────────────────────────────────────

describe('serviceTokenAuth - secret not configured', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigGet.mockReturnValue(null) // backendServiceToken returns null
  })

  it('returns 500 when BACKEND_SERVICE_TOKEN is not configured', async () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    await handler(
      createRequest('/api/review/text', 'POST', {
        'x-service-token': VALID_TOKEN,
        'x-timestamp': VALID_TS
      }),
      h
    )
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HTTP_INTERNAL_SERVER_ERROR,
        message: 'Service configuration error'
      })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP_INTERNAL_SERVER_ERROR)
    expect(h._resp.takeover).toHaveBeenCalled()
  })

  it('logs an error when secret is not configured', async () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    await handler(
      createRequest('/api/review/text', 'POST', {
        'x-service-token': VALID_TOKEN,
        'x-timestamp': VALID_TS
      }),
      h
    )
    expect(mockLogger.error).toHaveBeenCalledWith(
      'BACKEND_SERVICE_TOKEN is not configured'
    )
  })
})

// ── Token verification fails ──────────────────────────────────────────────────

describe('serviceTokenAuth - token verification fails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigGet.mockReturnValue(VALID_SECRET)
    mockVerifyServiceToken.mockReturnValue({
      valid: false,
      reason: 'Token signature mismatch'
    })
  })

  it('returns 401 when verifyServiceToken returns valid:false', async () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    await handler(
      createRequest('/api/review/text', 'POST', {
        'x-service-token': VALID_TOKEN,
        'x-timestamp': VALID_TS
      }),
      h
    )
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HTTP_UNAUTHORIZED,
        message: 'Invalid or expired token'
      })
    )
    expect(h._resp.code).toHaveBeenCalledWith(HTTP_UNAUTHORIZED)
    expect(h._resp.takeover).toHaveBeenCalled()
  })

  it('logs a warning with the verification failure reason', async () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    await handler(
      createRequest('/api/review/text', 'POST', {
        'x-service-token': VALID_TOKEN,
        'x-timestamp': VALID_TS
      }),
      h
    )
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Token verification failed')
    )
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Token signature mismatch')
    )
  })
})

// ── Token verification passes ─────────────────────────────────────────────────

describe('serviceTokenAuth - token verification passes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigGet.mockReturnValue(VALID_SECRET)
    mockVerifyServiceToken.mockReturnValue({ valid: true })
  })

  it('returns h.continue when token is valid', async () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    const result = await handler(
      createRequest('/api/review/text', 'POST', {
        'x-service-token': VALID_TOKEN,
        'x-timestamp': VALID_TS
      }),
      h
    )
    expect(result).toBe(h.continue)
    expect(h.response).not.toHaveBeenCalled()
  })

  it('calls verifyServiceToken with uppercased method', async () => {
    const { handler } = registerAndGetHandler()
    const h = createH()
    await handler(
      createRequest('/api/review/text', 'post', {
        'x-service-token': VALID_TOKEN,
        'x-timestamp': VALID_TS
      }),
      h
    )
    expect(mockVerifyServiceToken).toHaveBeenCalledWith(
      VALID_TOKEN,
      VALID_SECRET,
      'POST',
      '/api/review/text',
      expect.any(Number)
    )
  })
})
