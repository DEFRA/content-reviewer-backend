import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Constants ──────────────────────────────────────────────────────────────
const MOCK_HOST = 'localhost'
const MOCK_PORT = 3000
const MOCK_ORIGIN = ['*']
const MOCK_MONGO = { enabled: true, uri: 'mongodb://localhost:27017/test' }

// ── Hapi server mock ───────────────────────────────────────────────────────
const mockServerLogger = { info: vi.fn(), error: vi.fn() }
const mockServerEvents = { on: vi.fn() }
const mockServer = {
  register: vi.fn().mockResolvedValue(undefined),
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
