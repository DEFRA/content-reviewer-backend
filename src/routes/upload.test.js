import { beforeEach, afterEach, it, expect, vi } from 'vitest'

// Mock logger options expected by other modules during import
vi.mock('../common/helpers/logging/logger-options.js', () => ({
  loggerOptions: { isEnabled: () => false, level: 'info' }
}))

// deterministic UUID for tests
vi.mock('node:crypto', () => ({ randomUUID: () => 'test-review-id' }))

// minimal config mock used by upload.js
vi.mock('../config.js', () => ({
  config: {
    get: (key) => {
      if (key === 'cdpUploader.url') return 'http://cdp-uploader:3002'
      if (key === 's3.bucket') return 'test-bucket'
      if (key === 'serverUrl') return 'http://backend'
      if (key === 's3.rawS3Path') return '/raw'
      return null
    }
  }
}))

// minimal review-helpers mock (only what upload.js imports)
vi.mock('./review-helpers.js', () => ({
  HTTP_STATUS: { ACCEPTED: 202, OK: 200, INTERNAL_SERVER_ERROR: 500 },
  REVIEW_STATUSES: { PENDING: 'pending' },
  getCorsConfig: () => ({}),
  createCanonicalDocument: vi.fn(),
  createReviewRecord: vi.fn(),
  queueReviewJob: vi.fn()
}))

let uploadModule
let fakeServer
let storedRoutes = {}
let mockFetch

beforeEach(async () => {
  // stub global fetch before importing upload.js
  mockFetch = vi.fn((url, opts) => {
    const u = String(url)
    if (u.endsWith('/initiate')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          uploadId: 'upload-123',
          uploadUrl: '/upload-and-scan/upload-123'
        })
      })
    }
    // upload-and-scan response (successful)
    return Promise.resolve({
      ok: true,
      status: 200,
      url: 'http://cdp-uploader/upload-and-scan/upload-123',
      text: async () => ''
    })
  })
  vi.stubGlobal('fetch', mockFetch)

  // prepare a fake server object to avoid Hapi route validation during plugin registration
  storedRoutes = {}
  fakeServer = {
    route: (routeConfig) => {
      const key = `${routeConfig.method.toUpperCase()} ${routeConfig.path}`
      storedRoutes[key] = routeConfig
    },
    ext: () => {}, // ignore onRequest ext registrations
    events: { on: () => {} },
    log: () => {}
  }

  // import module under test AFTER mocks are in place
  uploadModule = await import('./upload.js')

  // register plugin using fake server to capture handlers
  await uploadModule.uploadRoutes.plugin.register(fakeServer)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

// Helper: build minimal h object used by handlers
function makeH() {
  return {
    response(payload) {
      return {
        _payload: payload,
        code(status) {
          return { statusCode: status, payload: this._payload }
        }
      }
    }
  }
}

it('returns 202 Accepted and reviewId on successful upload initiation', async () => {
  const handlerKey = 'POST /api/upload'
  const route = storedRoutes[handlerKey]
  expect(route).toBeDefined()

  const handler = route.handler

  // simulate request: raw octet-stream buffer (upload.js uses request.payload as file)
  const request = {
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent('doc.pdf'),
      'x-user-id': 'tester'
    },
    payload: Buffer.from('dummy-file-bytes'),
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  }

  const h = makeH()
  const res = await handler(request, h)

  // response is the object returned by h.response(...).code(...)
  expect(res.statusCode).toBe(202)
  expect(res.payload).toMatchObject({
    success: true,
    reviewId: 'test-review-id',
    uploadId: 'upload-123',
    status: 'pending',
    message: expect.any(String)
  })

  // external calls (initiate + upload) should have been invoked
  expect(mockFetch).toHaveBeenCalled()
  // first call to /initiate
  expect(String(mockFetch.mock.calls[0][0])).toContain('/initiate')
  // second call to upload-and-scan endpoint
  expect(String(mockFetch.mock.calls[1][0])).toContain('/upload-and-scan')
})

it('returns 500 when no payload (file) provided', async () => {
  const handlerKey = 'POST /api/upload'
  const route = storedRoutes[handlerKey]
  expect(route).toBeDefined()

  const handler = route.handler

  const request = {
    headers: { 'content-type': 'application/octet-stream' },
    payload: null,
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  }

  const h = makeH()
  const res = await handler(request, h)

  expect(res.statusCode).toBe(500)
  expect(res.payload).toHaveProperty('success', false)
  expect(res.payload).toHaveProperty('message')
})
