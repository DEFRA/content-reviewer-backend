import { beforeEach, afterEach, it, expect, vi } from 'vitest'

// ── Constants ──────────────────────────────────────────────────────────────
const HTTP_OK = 200
const HTTP_ACCEPTED = 202
const HTTP_INTERNAL_SERVER_ERROR = 500

const ROUTE_API_UPLOAD = 'POST /api/upload'
const ROUTE_CALLBACK = 'POST /upload-callback'

const CONTENT_TYPE_OCTET = 'application/octet-stream'
const FILENAME_DOC = 'doc.pdf'
const USER_ID = 'tester'
const UPLOAD_ID = 'upload-123'
const UPLOAD_URL = `/upload-and-scan/${UPLOAD_ID}`

// ── Mock helpers ───────────────────────────────────────────────────────────
function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}

function makeUploadRequest(payloadOverride) {
  return {
    headers: {
      'content-type': CONTENT_TYPE_OCTET,
      'x-file-name': encodeURIComponent(FILENAME_DOC),
      'x-user-id': USER_ID
    },
    payload: payloadOverride ?? Buffer.from('dummy-bytes'),
    logger: makeLogger()
  }
}

function makeInitiateFetch({
  uploadId = UPLOAD_ID,
  uploadUrl = UPLOAD_URL
} = {}) {
  return vi.fn((url) => {
    if (String(url).endsWith('/initiate')) {
      return Promise.resolve({
        ok: true,
        status: HTTP_OK,
        json: async () => ({ uploadId, uploadUrl })
      })
    }
    return Promise.resolve({ ok: true, status: HTTP_OK, text: async () => '' })
  })
}

// ── Module mocks ───────────────────────────────────────────────────────────
vi.mock('../common/helpers/logging/logger-options.js', () => ({
  loggerOptions: { isEnabled: () => false, level: 'info' }
}))

vi.mock('node:crypto', () => ({ randomUUID: () => 'test-review-id' }))

vi.mock('../config.js', () => {
  const configValues = {
    'cdpUploader.url': 'http://cdp-uploader:3002',
    's3.bucket': 'test-bucket',
    serverUrl: 'http://backend',
    's3.rawS3Path': '/raw',
    'aws.region': 'eu-west-1',
    maxMultipartUploadSize: 10 * 1024 * 1024
  }
  return { config: { get: (key) => configValues[key] ?? null } }
})

vi.mock('./review-helpers.js', () => ({
  HTTP_STATUS: { ACCEPTED: 202, OK: 200, INTERNAL_SERVER_ERROR: 500 },
  REVIEW_STATUSES: { PENDING: 'pending' },
  getCorsConfig: () => ({}),
  createCanonicalDocument: vi.fn(),
  createReviewRecord: vi.fn(),
  queueReviewJob: vi.fn()
}))

vi.mock('../common/helpers/text-extractor.js', () => ({
  textExtractor: { extractText: vi.fn(async () => 'parsed-text') }
}))

vi.mock('pdf-parse', () => ({
  default: vi.fn(async () => ({ text: 'parsed-pdf-text' })),
  __esModule: true
}))

vi.mock('mammoth', () => ({
  default: {
    extractRawText: vi.fn(async () => ({ value: 'parsed-docx-text' }))
  },
  __esModule: true
}))

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    async send(_cmd) {
      const body = (async function* () {
        yield Buffer.from('s3-file-bytes')
      })()
      return { Body: body, ContentLength: 12 }
    }
  }
  class GetObjectCommand {}
  return { S3Client, GetObjectCommand }
})

// ── Test setup ─────────────────────────────────────────────────────────────
let storedRoutes = {}

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

beforeEach(async () => {
  vi.stubGlobal('fetch', makeInitiateFetch())

  storedRoutes = {}
  const fakeServer = {
    route: (cfg) => {
      storedRoutes[`${cfg.method.toUpperCase()} ${cfg.path}`] = cfg
    },
    ext: () => {},
    events: { on: () => {} },
    log: () => {}
  }

  const uploadModule = await import('./upload.js')
  await uploadModule.uploadRoutes.plugin.register(fakeServer)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

// ── Tests ──────────────────────────────────────────────────────────────────

it('plugin registers both the upload and callback routes', () => {
  expect(storedRoutes[ROUTE_API_UPLOAD]).toBeDefined()
  expect(storedRoutes[ROUTE_CALLBACK]).toBeDefined()
})

it('returns 202 Accepted and reviewId on successful upload initiation', async () => {
  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(
    makeUploadRequest(),
    makeH()
  )

  expect(res.statusCode).toBe(HTTP_ACCEPTED)
  expect(res.payload).toMatchObject({
    success: true,
    reviewId: 'test-review-id',
    uploadId: UPLOAD_ID,
    status: 'pending',
    message: expect.any(String)
  })
})

it('returns 500 when no payload provided', async () => {
  const request = {
    headers: { 'content-type': CONTENT_TYPE_OCTET },
    payload: null,
    logger: makeLogger()
  }
  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(request, makeH())

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(res.payload).toHaveProperty('success', false)
})

it('returns 500 when /initiate call fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url) => {
      if (String(url).endsWith('/initiate')) {
        return Promise.resolve({
          ok: false,
          status: HTTP_INTERNAL_SERVER_ERROR,
          text: async () => 'fail'
        })
      }
      return Promise.resolve({
        ok: true,
        status: HTTP_OK,
        text: async () => ''
      })
    })
  )

  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(
    makeUploadRequest(),
    makeH()
  )

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(res.payload).toHaveProperty('success', false)
})

it('returns 202 when upload-and-scan returns 404', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url) => {
      if (String(url).endsWith('/initiate')) {
        return Promise.resolve({
          ok: true,
          status: HTTP_OK,
          json: async () => ({
            uploadId: 'upload-404',
            uploadUrl: '/upload-and-scan/upload-404'
          })
        })
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: async () => 'not found'
      })
    })
  )

  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(
    makeUploadRequest(),
    makeH()
  )

  expect(res.statusCode).toBe(HTTP_ACCEPTED)
  expect(res.payload).toHaveProperty('success', true)
})

it('handles 302 redirect from upload-and-scan and still returns 202', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url) => {
      if (String(url).endsWith('/initiate')) {
        return Promise.resolve({
          ok: true,
          status: HTTP_OK,
          json: async () => ({ uploadId: UPLOAD_ID, uploadUrl: UPLOAD_URL })
        })
      }
      return Promise.resolve({
        ok: false,
        status: 302,
        headers: {
          get: (n) => (n.toLowerCase() === 'location' ? '/some-redirect' : null)
        },
        text: async () => ''
      })
    })
  )

  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(
    makeUploadRequest(),
    makeH()
  )

  expect(res.statusCode).toBe(HTTP_ACCEPTED)
  expect(res.payload).toMatchObject({ success: true, uploadId: UPLOAD_ID })
})

it('returns 500 when /initiate returns non-OK with status code in message', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url) => {
      if (String(url).endsWith('/initiate')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: async () => 'Service unavailable'
        })
      }
      return Promise.resolve({
        ok: true,
        status: HTTP_OK,
        text: async () => ''
      })
    })
  )

  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(
    makeUploadRequest(),
    makeH()
  )

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(String(res.payload.message)).toContain(
    'cdp-uploader /initiate failed: 503'
  )
})

it('returns 500 when /initiate response contains no uploadUrl', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url) => {
      if (String(url).endsWith('/initiate')) {
        return Promise.resolve({
          ok: true,
          status: HTTP_OK,
          json: async () => ({ uploadId: 'uid-no-url' })
        })
      }
      return Promise.resolve({
        ok: true,
        status: HTTP_OK,
        text: async () => ''
      })
    })
  )

  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(
    makeUploadRequest(),
    makeH()
  )

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(String(res.payload.message)).toContain('did not return an uploadUrl')
})

it('returns 500 when CDP Uploader URL is not configured', async () => {
  const { config } = await import('../config.js')
  vi.spyOn(config, 'get').mockImplementation((key) => {
    if (key === 'cdpUploader.url') {
      return ''
    }
    if (key === 's3.bucket') {
      return 'test-bucket'
    }
    return null
  })

  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(
    makeUploadRequest(),
    makeH()
  )
  vi.restoreAllMocks()

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(String(res.payload.message)).toContain(
    'CDP Uploader URL not configured'
  )
})

it('returns 500 when file stream emits an error during buffering', async () => {
  const { EventEmitter } = await import('node:events')
  const errorStream = new EventEmitter()
  setImmediate(() => errorStream.emit('error', new Error('stream-broken')))

  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(
    makeUploadRequest(errorStream),
    makeH()
  )

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(String(res.payload.message)).toContain(
    'File stream error: stream-broken'
  )
})

it('returns 202 when x-file-name header is absent (auto-generates filename)', async () => {
  // Covers line 176: fallback filename `upload-${Date.now()}` when header missing
  const request = {
    headers: { 'content-type': CONTENT_TYPE_OCTET, 'x-user-id': USER_ID },
    payload: Buffer.from('dummy-bytes'),
    logger: makeLogger()
  }
  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(request, makeH())

  expect(res.statusCode).toBe(HTTP_ACCEPTED)
  expect(res.payload).toHaveProperty('success', true)
})

it('returns 202 when payload is a readable stream that ends normally', async () => {
  // Covers line 278: resolve(Buffer.concat(chunks)) in the stream 'end' event handler
  const { EventEmitter } = await import('node:events')
  const stream = new EventEmitter()
  setImmediate(() => {
    stream.emit('data', Buffer.from('chunk1'))
    stream.emit('data', Buffer.from('chunk2'))
    stream.emit('end')
  })

  const request = {
    headers: {
      'content-type': CONTENT_TYPE_OCTET,
      'x-file-name': encodeURIComponent(FILENAME_DOC),
      'x-user-id': USER_ID
    },
    payload: stream,
    logger: makeLogger()
  }
  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(request, makeH())

  expect(res.statusCode).toBe(HTTP_ACCEPTED)
  expect(res.payload).toHaveProperty('success', true)
})

it('returns 500 when upload-and-scan fetch throws a network error', async () => {
  // Covers lines 149-155: performUpload catch block when fetch itself throws
  vi.stubGlobal(
    'fetch',
    vi.fn((url) => {
      if (String(url).endsWith('/initiate')) {
        return Promise.resolve({
          ok: true,
          status: HTTP_OK,
          json: async () => ({ uploadId: UPLOAD_ID, uploadUrl: UPLOAD_URL })
        })
      }
      throw new Error('network-error')
    })
  )

  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(
    makeUploadRequest(),
    makeH()
  )

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(String(res.payload.message)).toContain(
    'cdp-uploader /upload-and-scan failed: network-error'
  )
})

it('GET /upload-success returns 200 with reviewId and processing status', async () => {
  // Covers lines 584-606: handleUploadSuccess success path
  const handler = storedRoutes['GET /upload-success'].handler
  const request = {
    query: { reviewId: 'review-success-id' },
    logger: makeLogger()
  }

  const res = await handler(request, makeH())

  expect(res.statusCode).toBe(HTTP_OK)
  expect(res.payload).toMatchObject({
    success: true,
    reviewId: 'review-success-id',
    status: 'processing'
  })
})

it('GET /upload-success returns 500 when request.query is null', async () => {
  // Covers lines 607-616: handleUploadSuccess catch path
  const handler = storedRoutes['GET /upload-success'].handler
  const request = { query: null, logger: makeLogger() }

  const res = await handler(request, makeH())

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(res.payload).toHaveProperty('success', false)
})

it('GET /api/upload-status/{reviewId} returns 404 when reviewId not in store', async () => {
  // Covers lines 622-623: handleUploadStatus not-found path (STATUS_404)
  const handler = storedRoutes['GET /api/upload-status/{reviewId}'].handler
  const res = await handler({ params: { reviewId: 'nonexistent-id' } }, makeH())

  expect(res.statusCode).toBe(404)
  expect(res.payload).toMatchObject({ found: false })
})

it('returns 500 when /initiate fails and response body cannot be read', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url) => {
      if (String(url).endsWith('/initiate')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: async () => {
            throw new Error('body-read-error')
          }
        })
      }
      return Promise.resolve({
        ok: true,
        status: HTTP_OK,
        text: async () => ''
      })
    })
  )

  const res = await storedRoutes[ROUTE_API_UPLOAD].handler(
    makeUploadRequest(),
    makeH()
  )

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(String(res.payload.message)).toContain(
    'cdp-uploader /initiate failed: 503'
  )
})
