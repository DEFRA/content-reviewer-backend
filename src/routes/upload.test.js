import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
      if (key === 'aws.region') return 'eu-west-1'
      if (key === 'maxMultipartUploadSize') return 10 * 1024 * 1024
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

// text-extractor mock (used by upload.js)
const extractTextMock = vi.fn(
  async (buf, contentType, filename) => 'parsed-text'
)
vi.mock('../common/helpers/text-extractor.js', () => ({
  textExtractor: { extractText: extractTextMock }
}))

// ensure aws-sdk client isn't used in tests that don't need it
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor() {}
    async send(cmd) {
      // default: emulate GetObject returning a small Buffer stream-like Body
      const body = (async function* () {
        yield Buffer.from('s3-file-bytes')
      })()
      return { Body: body, ContentLength: 12 }
    }
  }
  const GetObjectCommand = function () {}
  return { S3Client, GetObjectCommand }
})

let uploadModule
let fakeServer
let storedRoutes = {}
let mockFetch

beforeEach(async () => {
  // default fetch stub used by many tests; individual tests may override
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

it('returns 500 when /initiate call fails', async () => {
  // override fetch so /initiate returns not ok
  const failingFetch = vi.fn((url) => {
    const u = String(url)
    if (u.endsWith('/initiate')) {
      return Promise.resolve({
        ok: false,
        status: 500,
        text: async () => 'initiate-fail'
      })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        uploadId: 'upload-123',
        uploadUrl: '/upload-and-scan/upload-123'
      })
    })
  })
  vi.stubGlobal('fetch', failingFetch)

  const handler = storedRoutes['POST /api/upload'].handler
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
  expect(res.statusCode).toBe(500)
  expect(res.payload).toHaveProperty('success', false)
})

it('returns 202 when upload-and-scan returns 404', async () => {
  // initiate ok, upload-and-scan returns 404
  const fetch404 = vi.fn((url) => {
    const u = String(url)
    if (u.endsWith('/initiate')) {
      return Promise.resolve({
        ok: true,
        status: 200,
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
  vi.stubGlobal('fetch', fetch404)

  const handler = storedRoutes['POST /api/upload'].handler
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
  expect(res.statusCode).toBe(202)
  expect(res.payload).toHaveProperty('success', true)
})

it('handles 302 redirect response from upload-and-scan and still accepts', async () => {
  // craft fetch that returns 200 for initiate, then 302 for upload-and-scan
  const redirectFetch = vi.fn((url) => {
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
    // upload-and-scan returns 302 with location header
    return Promise.resolve({
      ok: false,
      status: 302,
      headers: {
        get: (n) => (n.toLowerCase() === 'location' ? '/some-redirect' : null)
      },
      text: async () => ''
    })
  })
  vi.stubGlobal('fetch', redirectFetch)

  const handler = storedRoutes['POST /api/upload'].handler
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
  // upload should still be accepted (202)
  expect(res.statusCode).toBe(202)
  expect(res.payload).toMatchObject({ success: true, uploadId: 'upload-123' })
})

it('callback handler returns 500 for unsupported text/plain file (explicit)', async () => {
  const callbackKey = 'POST /upload-callback'
  const route = storedRoutes[callbackKey]
  expect(route).toBeDefined()
  const handler = route.handler

  const request = {
    payload: {
      metadata: { reviewId: 'review-1', userId: 'user-1' },
      form: {
        file: {
          s3Key: 'some/key.pdf',
          filename: 'plain.txt',
          contentType: 'text/plain',
          hasError: false
        }
      }
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  }

  const h = makeH()
  const res = await handler(request, h)
  // unsupported file type path should return 500 with explicit message
  expect(res.statusCode).toBe(500)
  expect(res.payload).toMatchObject({ success: false })
  expect(String(res.payload.message)).toContain(
    'Unsupported file type for text extraction'
  )
})

it('callback handler returns OK with success:false when fileField.hasError is truthy', async () => {
  const callbackKey = 'POST /upload-callback'
  const route = storedRoutes[callbackKey]
  const handler = route.handler

  const request = {
    payload: {
      metadata: { reviewId: 'review-2', userId: 'user-2' },
      form: {
        file: {
          hasError: true,
          errorMessage: 'virus-detected'
        }
      }
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  }

  const h = makeH()
  const res = await handler(request, h)
  // CDP Uploader expects a 200 OK with success:false when file rejected
  expect(res.statusCode).toBe(200)
  expect(res.payload).toMatchObject({
    success: false,
    message: 'virus-detected'
  })
})

it('callback handler fetches S3 object and parses PDF text', async () => {
  const callbackKey = 'POST /upload-callback'
  const route = storedRoutes[callbackKey]
  const handler = route.handler

  // ensure extractTextMock returns expected text
  extractTextMock.mockResolvedValueOnce('s3-pdf-extracted-text')

  const request = {
    payload: {
      metadata: { reviewId: 'review-s3-pdf', userId: 'user-s3' },
      form: {
        file: {
          s3Key: 'some/key.pdf',
          filename: 'document.pdf',
          contentType: 'application/pdf',
          hasError: false
        }
      }
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  }

  const h = makeH()
  const res = await handler(request, h)

  expect(res.statusCode).toBe(200)
  expect(res.payload).toMatchObject({ success: true })
  // extractor should have been invoked
  expect(extractTextMock).toHaveBeenCalled()
})

it('callback handler parses DOCX buffer via text-extractor', async () => {
  const callbackKey = 'POST /upload-callback'
  const route = storedRoutes[callbackKey]
  const handler = route.handler

  extractTextMock.mockResolvedValueOnce('docx-extracted')

  const request = {
    payload: {
      metadata: { reviewId: 'review-docx', userId: 'user-docx' },
      form: {
        file: {
          s3Key: 'some/key.pdf',
          filename: 'doc.docx',
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          hasError: false
        }
      }
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  }

  const h = makeH()
  const res = await handler(request, h)

  expect(res.statusCode).toBe(200)
  expect(res.payload).toMatchObject({ success: true })
  expect(extractTextMock).toHaveBeenCalled()
})

it('callback handler returns 500 when PDF parsing fails', async () => {
  const callbackKey = 'POST /upload-callback'
  const route = storedRoutes[callbackKey]
  const handler = route.handler

  // cause extractor to throw
  extractTextMock.mockRejectedValueOnce(new Error('pdf-bad'))

  const request = {
    payload: {
      metadata: { reviewId: 'review-bad-pdf', userId: 'user-bad' },
      form: {
        file: {
          s3Key: 'some/key.pdf',
          filename: 'bad.pdf',
          contentType: 'application/pdf',
          hasError: false
        }
      }
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  }

  const h = makeH()
  const res = await handler(request, h)
  expect(res.statusCode).toBe(500)
  expect(res.payload).toHaveProperty('success', false)
  expect(String(res.payload.message)).toContain('PDF parsing failed: pdf-bad')
})

it('callback handler reads local file path and processes PDF (no s3Key -> error)', async () => {
  const callbackKey = 'POST /upload-callback'
  const route = storedRoutes[callbackKey]
  const handler = route.handler

  // create a temp file to simulate uploaded local temp file
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-test-'))
  const tmpFile = path.join(tmpDir, 'temp.pdf')
  await fs.writeFile(tmpFile, 'dummy-pdf-bytes')

  extractTextMock.mockResolvedValueOnce('local-pdf-text')

  const request = {
    payload: {
      metadata: { reviewId: 'review-local-pdf', userId: 'user-local' },
      form: {
        file: {
          path: tmpFile,
          filename: 'temp.pdf',
          contentType: 'application/pdf',
          hasError: false
        }
      }
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  }

  const h = makeH()
  const res = await handler(request, h)

  // cleanup
  await fs.rm(tmpDir, { recursive: true, force: true })

  // getBufferFromField only supports s3Key in current implementation => error path
  expect(res.statusCode).toBe(500)
  expect(res.payload).toMatchObject({ success: false })
})

it('callback handler returns 500 when payload missing form', async () => {
  const callbackKey = 'POST /upload-callback'
  const route = storedRoutes[callbackKey]
  const handler = route.handler

  const request = {
    payload: {
      metadata: { reviewId: 'missing-form', userId: 'u' }
      // form missing
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  }

  const h = makeH()
  const res = await handler(request, h)
  expect(res.statusCode).toBe(500)
  expect(res.payload).toHaveProperty('success', false)
})

// sanity: plugin registered both routes
it('plugin registered upload and callback routes', () => {
  expect(storedRoutes['POST /api/upload']).toBeDefined()
  expect(storedRoutes['POST /upload-callback']).toBeDefined()
  expect(storedRoutes['GET /api/upload-status/{reviewId}']).toBeDefined()
})

it('callback handler starts async pipeline and calls createCanonicalDocument', async () => {
  const callbackKey = 'POST /upload-callback'
  const route = storedRoutes[callbackKey]
  expect(route).toBeDefined()
  const handler = route.handler

  // make extractor return predictable text
  extractTextMock.mockResolvedValueOnce('s3-pdf-extracted-text-small')

  // ensure createCanonicalDocument is available and resolves
  const reviewHelpers = await import('./review-helpers.js')
  reviewHelpers.createCanonicalDocument.mockResolvedValueOnce({
    canonicalResult: { s3: 's3://bucket/key', document: { charCount: 22 } },
    canonicalDuration: 5
  })
  reviewHelpers.createReviewRecord.mockResolvedValueOnce(1)
  reviewHelpers.queueReviewJob.mockResolvedValueOnce(1)

  const request = {
    payload: {
      metadata: { reviewId: 'review-start-pipeline', userId: 'user-start' },
      form: {
        file: {
          s3Key: 'some/key.pdf',
          filename: 'document.pdf',
          contentType: 'application/pdf',
          hasError: false
        }
      }
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  }

  const h = makeH()
  const res = await handler(request, h)

  expect(res.statusCode).toBe(200)
  expect(res.payload).toMatchObject({ success: true })

  // allow async pipeline to run
  await new Promise((r) => setImmediate(r))

  expect(reviewHelpers.createCanonicalDocument).toHaveBeenCalled()
  // check called with review text as first arg
  const firstCallArgs = reviewHelpers.createCanonicalDocument.mock.calls[0]
  expect(firstCallArgs[1]).toBe('review-start-pipeline') // second arg is reviewId
  expect(firstCallArgs[2]).toBe('document.pdf') // third arg is filename
})

it('truncates extracted text longer than MAX_REVIEW_CHARS before canonicalization', async () => {
  const callbackKey = 'POST /upload-callback'
  const route = storedRoutes[callbackKey]
  expect(route).toBeDefined()
  const handler = route.handler

  // create a very long text > MAX_REVIEW_CHARS (100000)
  const veryLong = 'a'.repeat(150000)
  extractTextMock.mockResolvedValueOnce(veryLong)

  const reviewHelpers = await import('./review-helpers.js')
  reviewHelpers.createCanonicalDocument.mockResolvedValueOnce({
    canonicalResult: { s3: 's3://b/k', document: { charCount: 100000 } },
    canonicalDuration: 1
  })
  reviewHelpers.createReviewRecord.mockResolvedValueOnce(1)
  reviewHelpers.queueReviewJob.mockResolvedValueOnce(1)

  const request = {
    payload: {
      metadata: { reviewId: 'review-truncate', userId: 'user-trunc' },
      form: {
        file: {
          s3Key: 'some/long.pdf',
          filename: 'long.pdf',
          contentType: 'application/pdf',
          hasError: false
        }
      }
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  }

  const h = makeH()
  const res = await handler(request, h)

  expect(res.statusCode).toBe(200)
  expect(res.payload).toMatchObject({ success: true })

  // allow async pipeline to run
  await new Promise((r) => setImmediate(r))

  expect(reviewHelpers.createCanonicalDocument).toHaveBeenCalled()
  const passedText = reviewHelpers.createCanonicalDocument.mock.calls[0][0]
  // MAX_REVIEW_CHARS constant in source is 100000
  expect(passedText.length).toBe(100000)
})
