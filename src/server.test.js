import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Constants ──────────────────────────────────────────────────────────────
// vi.hoisted() ensures these are available when vi.mock() factories are hoisted
// to the top of the file — plain const declarations are not hoisted in ESM.
const { MOCK_HOST, MOCK_PORT, MOCK_ORIGIN, MOCK_MONGO } = vi.hoisted(() => ({
  MOCK_HOST: 'localhost',
  MOCK_PORT: 3000,
  MOCK_ORIGIN: ['*'],
  MOCK_MONGO: { enabled: true, uri: 'mongodb://localhost:27017/test' }
}))

// Rate-limiting test constants
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_LOW = 2 // low threshold so tests can exceed it easily
const TEST_IP_HEALTH = '1.1.1.1'
const TEST_IP_UNDER = '2.2.2.2'
const TEST_IP_OVER = '3.3.3.3'
const TEST_IP_RESET = '4.4.4.4'

// ── Hapi server mock ───────────────────────────────────────────────────────
const mockServerLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const mockServerEvents = { on: vi.fn() }
const mockServer = {
  register: vi.fn().mockResolvedValue(undefined),
  ext: vi.fn(),
  logger: mockServerLogger,
  events: mockServerEvents
}

vi.mock('@hapi/hapi', () => ({
  default: {
    server: vi.fn(() => mockServer)
  }
}))

vi.mock('@defra/hapi-secure-context', () => ({
  secureContext: { plugin: { name: 'secureContext', register: vi.fn() } }
}))

vi.mock('./config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const vals = {
        host: MOCK_HOST,
        port: MOCK_PORT,
        'cors.origin': MOCK_ORIGIN,
        'cors.credentials': true,
        mongo: MOCK_MONGO,
        'mockMode.skipSqsWorker': false
      }
      return vals[key] ?? null
    })
  }
}))

vi.mock('./plugins/router.js', () => ({
  router: { plugin: { name: 'router', register: vi.fn() } }
}))

vi.mock('./plugins/service-token-auth.js', () => ({
  serviceTokenAuth: { plugin: { name: 'serviceTokenAuth', register: vi.fn() } }
}))

vi.mock('./common/helpers/logging/request-logger.js', () => ({
  requestLogger: { plugin: { name: 'requestLogger', register: vi.fn() } }
}))

vi.mock('./common/helpers/mongodb.js', () => ({
  mongoDb: { name: 'mongoDb', register: vi.fn() }
}))

vi.mock('./common/helpers/fail-action.js', () => ({
  failAction: vi.fn()
}))

vi.mock('./common/helpers/pulse.js', () => ({
  pulse: { plugin: { name: 'pulse', register: vi.fn() } }
}))

vi.mock('./common/helpers/request-tracing.js', () => ({
  requestTracing: { plugin: { name: 'requestTracing', register: vi.fn() } }
}))

vi.mock('./common/helpers/proxy/setup-proxy.js', () => ({
  setupProxy: vi.fn()
}))

vi.mock('./common/helpers/sqs-worker.js', () => ({
  sqsWorker: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn()
  }
}))

vi.mock('./common/helpers/cleanup-scheduler.js', () => ({
  cleanupScheduler: {
    start: vi.fn(),
    stop: vi.fn()
  }
}))

import Hapi from '@hapi/hapi'
import { config } from './config.js'
import { setupProxy } from './common/helpers/proxy/setup-proxy.js'
import { sqsWorker } from './common/helpers/sqs-worker.js'
import { cleanupScheduler } from './common/helpers/cleanup-scheduler.js'
import { createServer } from './server.js'

// ── Tests ──────────────────────────────────────────────────────────────────
describe('createServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockServer.register.mockResolvedValue(undefined)
    sqsWorker.start.mockResolvedValue(undefined)
  })

  it('calls setupProxy before creating the Hapi server', async () => {
    await createServer()
    expect(setupProxy).toHaveBeenCalledTimes(1)
  })

  it('creates a Hapi server with host and port from config', async () => {
    await createServer()
    expect(Hapi.server).toHaveBeenCalledWith(
      expect.objectContaining({
        host: MOCK_HOST,
        port: MOCK_PORT
      })
    )
  })

  it('returns the created server', async () => {
    const result = await createServer()
    expect(result).toBe(mockServer)
  })

  it('calls server.register with the plugins array', async () => {
    await createServer()
    expect(mockServer.register).toHaveBeenCalledTimes(1)
  })

  it('starts the cleanup scheduler', async () => {
    await createServer()
    expect(cleanupScheduler.start).toHaveBeenCalledTimes(1)
  })

  it('registers a stop event listener for the cleanup scheduler', async () => {
    await createServer()
    const stopListeners = mockServerEvents.on.mock.calls
      .filter(([event]) => event === 'stop')
      .map(([, cb]) => cb)
    expect(stopListeners.length).toBeGreaterThanOrEqual(1)
    // Trigger the cleanup scheduler stop listener
    const lastStopListener = stopListeners[stopListeners.length - 1]
    lastStopListener()
    expect(cleanupScheduler.stop).toHaveBeenCalled()
  })
})

describe('createServer - SQS worker (skipWorker = false)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockServer.register.mockResolvedValue(undefined)
    config.get.mockImplementation((key) => {
      const vals = {
        host: MOCK_HOST,
        port: MOCK_PORT,
        'cors.origin': MOCK_ORIGIN,
        'cors.credentials': true,
        mongo: MOCK_MONGO,
        'mockMode.skipSqsWorker': false
      }
      return vals[key] ?? null
    })
    sqsWorker.start.mockResolvedValue(undefined)
  })

  it('starts the SQS worker when skipSqsWorker is false', async () => {
    await createServer()
    expect(sqsWorker.start).toHaveBeenCalledTimes(1)
  })

  it('registers a stop event listener that stops the SQS worker', async () => {
    await createServer()
    // Find the first stop listener (SQS worker stop)
    const stopListeners = mockServerEvents.on.mock.calls
      .filter(([event]) => event === 'stop')
      .map(([, cb]) => cb)
    expect(stopListeners.length).toBeGreaterThanOrEqual(1)
    stopListeners[0]()
    expect(sqsWorker.stop).toHaveBeenCalled()
  })

  it('logs error but does not throw when SQS worker.start() rejects', async () => {
    sqsWorker.start.mockReturnValue(
      Promise.reject(new Error('SQS connection failed'))
    )
    await expect(createServer()).resolves.toBeDefined()
  })
})

describe('createServer - SQS worker (skipWorker = true)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockServer.register.mockResolvedValue(undefined)
    config.get.mockImplementation((key) => {
      const vals = {
        host: MOCK_HOST,
        port: MOCK_PORT,
        'cors.origin': MOCK_ORIGIN,
        'cors.credentials': true,
        mongo: MOCK_MONGO,
        'mockMode.skipSqsWorker': true
      }
      return vals[key] ?? null
    })
  })

  it('does not start the SQS worker when skipSqsWorker is true', async () => {
    await createServer()
    expect(sqsWorker.start).not.toHaveBeenCalled()
  })

  it('logs that SQS worker was skipped', async () => {
    await createServer()
    expect(mockServerLogger.info).toHaveBeenCalledWith(
      'SQS worker not started (SKIP_SQS_WORKER=true)'
    )
  })
})

describe('createServer - MongoDB disabled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockServer.register.mockResolvedValue(undefined)
    config.get.mockImplementation((key) => {
      const vals = {
        host: MOCK_HOST,
        port: MOCK_PORT,
        'cors.origin': MOCK_ORIGIN,
        'cors.credentials': true,
        mongo: { enabled: false },
        'mockMode.skipSqsWorker': true
      }
      return vals[key] ?? null
    })
  })

  it('does not include mongoDb plugin when mongo.enabled is false', async () => {
    await createServer()
    const [pluginsArg] = mockServer.register.mock.calls[0]
    const hasMongoDb = pluginsArg.some(
      (p) => p && p.plugin && p.plugin === 'mongoDb'
    )
    expect(hasMongoDb).toBe(false)
  })
})

// ── Helpers for rate-limit and security-header tests ───────────────────────

function makeRateLimitGetConfig(maxRequests = 100) {
  return (key) => {
    const vals = {
      host: MOCK_HOST,
      port: MOCK_PORT,
      'cors.origin': MOCK_ORIGIN,
      'cors.credentials': true,
      mongo: MOCK_MONGO,
      'mockMode.skipSqsWorker': true,
      'rateLimit.enabled': true,
      'rateLimit.windowMs': RATE_LIMIT_WINDOW_MS,
      'rateLimit.maxRequests': maxRequests
    }
    return vals[key] ?? null
  }
}

async function setupWithRateLimit(maxRequests = 100) {
  vi.clearAllMocks()
  // Re-attach vi.fn() to warn after clearAllMocks wipes implementations
  mockServerLogger.warn = vi.fn()
  mockServer.register.mockResolvedValue(undefined)
  config.get.mockImplementation(makeRateLimitGetConfig(maxRequests))
  await createServer()
  const [[, handler]] = mockServer.ext.mock.calls.filter(
    ([event]) => event === 'onRequest'
  )
  return handler
}

// ── Rate limiting tests ────────────────────────────────────────────────────

describe('createServer - rate limiting', () => {
  const hContinue = Symbol('hapi-continue')

  it('bypasses rate limiting for the /health path', async () => {
    const handler = await setupWithRateLimit()
    const h = { continue: hContinue }
    const request = { path: '/health', info: { remoteAddress: TEST_IP_HEALTH } }
    expect(handler(request, h)).toBe(hContinue)
    expect(mockServerLogger.warn).not.toHaveBeenCalled()
  })

  it('allows requests that are within the rate limit', async () => {
    const handler = await setupWithRateLimit(RATE_LIMIT_MAX_LOW)
    const mockResp = {
      code: vi.fn().mockReturnThis(),
      takeover: vi.fn().mockReturnThis()
    }
    const h = {
      continue: hContinue,
      response: vi.fn().mockReturnValue(mockResp)
    }
    const request = {
      path: '/api/review',
      info: { remoteAddress: TEST_IP_UNDER }
    }
    // First request (count 1) is within limit of 2
    expect(handler(request, h)).toBe(hContinue)
    expect(mockServerLogger.warn).not.toHaveBeenCalled()
  })

  it('returns 429 JSON and logs warn when rate limit is exceeded', async () => {
    const handler = await setupWithRateLimit(RATE_LIMIT_MAX_LOW)
    const mockResp = {
      code: vi.fn().mockReturnThis(),
      takeover: vi.fn().mockReturnThis()
    }
    const h = {
      continue: hContinue,
      response: vi.fn().mockReturnValue(mockResp)
    }
    const request = { path: '/api/data', info: { remoteAddress: TEST_IP_OVER } }
    handler(request, h) // count 1
    handler(request, h) // count 2 — at limit
    handler(request, h) // count 3 — over limit
    expect(mockServerLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ip: TEST_IP_OVER, limit: RATE_LIMIT_MAX_LOW }),
      'Rate limit exceeded'
    )
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) })
    )
    expect(mockResp.code).toHaveBeenCalledWith(429)
    expect(mockResp.takeover).toHaveBeenCalled()
  })

  it('resets the request count after the time window expires', async () => {
    vi.useFakeTimers()
    try {
      const handler = await setupWithRateLimit(RATE_LIMIT_MAX_LOW)
      const mockResp = {
        code: vi.fn().mockReturnThis(),
        takeover: vi.fn().mockReturnThis()
      }
      const h = {
        continue: hContinue,
        response: vi.fn().mockReturnValue(mockResp)
      }
      const request = {
        path: '/api/data',
        info: { remoteAddress: TEST_IP_RESET }
      }
      // Exceed the limit within the current window
      handler(request, h) // 1
      handler(request, h) // 2
      handler(request, h) // 3 — over limit

      // Advance past the window so the entry resets
      vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS + 1000)

      // After reset, the first request in the new window should be allowed
      expect(handler(request, h)).toBe(hContinue)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── Security headers (onPreResponse) tests ────────────────────────────────

describe('createServer - security headers (onPreResponse)', () => {
  const hContinue = Symbol('hapi-continue')
  const h = { continue: hContinue }
  let securityHeadersHandler

  beforeEach(async () => {
    vi.clearAllMocks()
    mockServer.register.mockResolvedValue(undefined)
    config.get.mockImplementation((key) => {
      const vals = {
        host: MOCK_HOST,
        port: MOCK_PORT,
        'cors.origin': MOCK_ORIGIN,
        'cors.credentials': true,
        mongo: MOCK_MONGO,
        'mockMode.skipSqsWorker': true
      }
      return vals[key] ?? null
    })
    await createServer()
    const [[, handler]] = mockServer.ext.mock.calls.filter(
      ([event]) => event === 'onPreResponse'
    )
    securityHeadersHandler = handler
  })

  it('sets CSP, Referrer-Policy and Permissions-Policy on a normal response', () => {
    const mockHeader = vi.fn()
    const request = { response: { isBoom: false, header: mockHeader } }
    const result = securityHeadersHandler(request, h)
    expect(result).toBe(hContinue)
    expect(mockHeader).toHaveBeenCalledWith(
      'Content-Security-Policy',
      expect.stringContaining("default-src 'none'")
    )
    expect(mockHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer')
    expect(mockHeader).toHaveBeenCalledWith(
      'Permissions-Policy',
      expect.stringContaining('geolocation=()')
    )
  })

  it('assigns security headers to Boom error output headers', () => {
    const boomHeaders = {}
    const request = {
      response: { isBoom: true, output: { headers: boomHeaders } }
    }
    const result = securityHeadersHandler(request, h)
    expect(result).toBe(hContinue)
    expect(boomHeaders['Content-Security-Policy']).toContain(
      "default-src 'none'"
    )
    expect(boomHeaders['Referrer-Policy']).toBe('no-referrer')
    expect(boomHeaders['Permissions-Policy']).toContain('geolocation=()')
  })
})

// ── SQS worker error logging ───────────────────────────────────────────────

describe('createServer - SQS worker error logging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockServer.register.mockResolvedValue(undefined)
    config.get.mockImplementation((key) => {
      const vals = {
        host: MOCK_HOST,
        port: MOCK_PORT,
        'cors.origin': MOCK_ORIGIN,
        'cors.credentials': true,
        mongo: MOCK_MONGO,
        'mockMode.skipSqsWorker': false
      }
      return vals[key] ?? null
    })
  })

  it('calls server.logger.error when SQS worker.start() rejects', async () => {
    sqsWorker.start.mockReturnValue(
      Promise.reject(new Error('SQS connection failed'))
    )
    await createServer()
    await Promise.resolve() // flush microtasks so the .catch() handler runs
    expect(mockServerLogger.error).toHaveBeenCalledWith(
      { error: 'SQS connection failed' },
      'Failed to start SQS worker - will continue without it'
    )
  })
})
