import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

// vi.hoisted ensures mockFetch is available when vi.mock factories run
const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn()
}))

vi.mock('../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const defaults = {
        'cdpUploader.url': 'https://cdp-uploader.test',
        'cdpUploader.s3Bucket': 'uploader-bucket',
        'cdpUploader.pollTimeoutMs': 2000,
        'cdpUploader.pollIntervalMs': 50,
        'contentReview.maxCharLength': 100000
      }
      return defaults[key] ?? null
    })
  }
}))

vi.mock('../common/helpers/canonical-document.js', () => ({
  SOURCE_TYPES: { FILE: 'file', URL: 'url', TEXT: 'text' },
  canonicalDocumentStore: { createCanonicalDocument: vi.fn() }
}))

vi.mock('./review-helpers.js', () => ({
  getCorsConfig: vi.fn(() => ({ origin: ['*'], credentials: true })),
  createCanonicalDocument: vi.fn(),
  createReviewRecord: vi.fn(),
  queueReviewJob: vi.fn(),
  HTTP_STATUS: {
    OK: 200,
    ACCEPTED: 202,
    BAD_REQUEST: 400,
    NOT_FOUND: 404,
    INTERNAL_SERVER_ERROR: 500
  },
  REVIEW_STATUSES: { PENDING: 'pending', FAILED: 'failed' },
  CANONICAL_SOURCE_TYPES: { FILE: 'file' },
  SOURCE_TYPE_FILE: 'file',
  ENDPOINT_UPLOAD: '/api/upload'
}))

vi.mock('node-fetch', () => ({ default: mockFetch }))

// ── Imports after mocks ───────────────────────────────────────────────────────
import { config } from '../config.js'
import {
  getCorsConfig,
  createCanonicalDocument,
  createReviewRecord,
  queueReviewJob,
  HTTP_STATUS,
  REVIEW_STATUSES
} from './review-helpers.js'
import {
  uploadRoutes,
  streamToBuffer,
  uploadFileToCdpUploader,
  runPipeline
} from './upload.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockH() {
  const responseMock = { code: vi.fn().mockReturnThis() }
  return {
    response: vi.fn(() => responseMock),
    _responseMock: responseMock
  }
}

function createMockRequest(overrides = {}) {
  return {
    payload: {},
    headers: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    },
    ...overrides
  }
}

/**
 * Create a Hapi-style multipart file stream with .hapi metadata.
 */
function makeHapiFile({
  content = 'PDF file content for testing purposes',
  filename = 'report.pdf',
  mimeType = 'application/pdf'
} = {}) {
  const stream = Readable.from([Buffer.from(content)])
  stream.hapi = {
    filename,
    headers: { 'content-type': mimeType }
  }
  return stream
}

/**
 * Build a mock fetch response object.
 */
function makeFetchResponse({
  ok = true,
  status = 200,
  json = null,
  text = null
} = {}) {
  return {
    ok,
    status,
    json: async () => (json === null ? {} : json),
    text: async () => (text === null ? JSON.stringify(json ?? {}) : text)
  }
}

/**
 * Register the plugin and return the /api/upload route handler.
 */
function getUploadHandler() {
  const routes = []
  const server = { route: vi.fn((r) => routes.push(r)) }
  uploadRoutes.plugin.register(server)
  return routes.find((r) => r.path === '/api/upload')?.handler
}

/**
 * Queue cdp-uploader fetch responses for the happy path:
 *   1. POST /initiate  → returns uploadId + uploadUrl + statusUrl
 *   2. PUT presigned   → 200 no body
 *   3. GET status      → { status: 'completed', bucket, key, location }
 *
 * Must be called before every test that invokes runPipeline or the upload handler,
 * because runPipeline calls uploadFileToCdpUploader which uses mockFetch.
 */
function setupCdpUploaderSuccess({
  uploadId = 'upload-123',
  bucket = 'uploader-bucket',
  key = 'uploads/upload-123/report.pdf',
  location = 's3://uploader-bucket/uploads/upload-123/report.pdf'
} = {}) {
  mockFetch
    .mockResolvedValueOnce(
      makeFetchResponse({
        ok: true,
        json: {
          uploadId,
          uploadUrl: 'https://presigned.test/upload',
          statusUrl: `https://cdp-uploader.test/uploads/${uploadId}/status`
        }
      })
    )
    .mockResolvedValueOnce(
      makeFetchResponse({ ok: true, status: 200, text: '' })
    )
    .mockResolvedValueOnce(
      makeFetchResponse({
        ok: true,
        json: { status: 'completed', bucket, key, location }
      })
    )
  return { uploadId, bucket, key, location }
}

/**
 * Set createCanonicalDocument / createReviewRecord / queueReviewJob mocks
 * to resolve successfully.
 * NOTE: this does NOT set up mockFetch for cdp-uploader — call setupCdpUploaderSuccess()
 * separately whenever runPipeline is exercised.
 */
function setupPipelineSuccess() {
  createCanonicalDocument.mockResolvedValue({
    canonicalResult: {
      s3: {
        key: 'documents/review_abc.json',
        bucket: 'docs-bucket',
        location: 's3://docs-bucket/documents/review_abc.json'
      },
      document: { charCount: 200 }
    },
    canonicalDuration: 5
  })
  createReviewRecord.mockResolvedValue(3)
  queueReviewJob.mockResolvedValue(7)
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks()
  getCorsConfig.mockReturnValue({ origin: ['*'], credentials: true })
  config.get.mockImplementation((key) => {
    const defaults = {
      'cdpUploader.url': 'https://cdp-uploader.test',
      'cdpUploader.s3Bucket': 'uploader-bucket',
      'cdpUploader.pollTimeoutMs': 2000,
      'cdpUploader.pollIntervalMs': 50,
      'contentReview.maxCharLength': 100000
    }
    return defaults[key] ?? null
  })
  // set up the downstream pipeline mocks (not cdp-uploader fetch)
  setupPipelineSuccess()
})

afterEach(() => {
  vi.resetAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════════════
// uploadRoutes plugin
// ═══════════════════════════════════════════════════════════════════════════════

describe('uploadRoutes plugin', () => {
  it('exports a hapi plugin with the correct name', () => {
    expect(uploadRoutes.plugin.name).toBe('upload-routes')
    expect(typeof uploadRoutes.plugin.register).toBe('function')
  })

  it('registers a POST /api/upload route', () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    uploadRoutes.plugin.register(server)
    const route = routes.find((r) => r.path === '/api/upload')
    expect(route).toBeDefined()
    expect(route.method).toBe('POST')
  })

  it('configures multipart stream payload', () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    uploadRoutes.plugin.register(server)
    const route = routes.find((r) => r.path === '/api/upload')
    expect(route.options.payload).toMatchObject({
      output: 'stream',
      parse: true,
      multipart: true
    })
  })

  it('sets maxBytes to 10 MB on the payload', () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    uploadRoutes.plugin.register(server)
    const route = routes.find((r) => r.path === '/api/upload')
    expect(route.options.payload.maxBytes).toBe(10 * 1024 * 1024)
  })

  it('attaches cors config from getCorsConfig()', () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    uploadRoutes.plugin.register(server)
    expect(getCorsConfig).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// streamToBuffer
// ═══════════════════════════════════════════════════════════════════════════════

describe('streamToBuffer', () => {
  it('concatenates multiple chunks into one Buffer', async () => {
    const stream = Readable.from([Buffer.from('hello '), Buffer.from('world')])
    const buf = await streamToBuffer(stream)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.toString()).toBe('hello world')
  })

  it('handles a single-chunk stream', async () => {
    const stream = Readable.from([Buffer.from('single')])
    const buf = await streamToBuffer(stream)
    expect(buf.toString()).toBe('single')
  })

  it('returns an empty Buffer for an empty stream', async () => {
    const stream = Readable.from([])
    const buf = await streamToBuffer(stream)
    expect(buf.length).toBe(0)
  })

  it('rejects when the stream emits an error', async () => {
    const stream = new Readable({ read() {} })
    const promise = streamToBuffer(stream)
    stream.emit('error', new Error('stream broken'))
    await expect(promise).rejects.toThrow('stream broken')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// uploadFileToCdpUploader
// ═══════════════════════════════════════════════════════════════════════════════

describe('uploadFileToCdpUploader', () => {
  it('throws when cdpUploader.url is not configured', async () => {
    config.get.mockReturnValue(null)
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      uploadFileToCdpUploader(Buffer.from('x'), 'f.pdf', 'application/pdf', logger)
    ).rejects.toThrow('cdp-uploader base URL not configured')
  })

  it('calls POST /initiate with filename, contentType, size and s3Bucket', async () => {
    setupCdpUploaderSuccess()
    const buffer = Buffer.from('pdf-content')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await uploadFileToCdpUploader(buffer, 'report.pdf', 'application/pdf', logger)

    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toMatch(/\/initiate$/)
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.filename).toBe('report.pdf')
    expect(body.contentType).toBe('application/pdf')
    expect(body.size).toBe(buffer.length)
    expect(body.s3Bucket).toBe('uploader-bucket')
  })

  it('throws when /initiate returns non-2xx', async () => {
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse({ ok: false, status: 500, text: 'Server Error' })
    )
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      uploadFileToCdpUploader(Buffer.from('x'), 'f.pdf', 'application/pdf', logger)
    ).rejects.toThrow('500')
  })

  it('uploads buffer to presigned uploadUrl via PUT', async () => {
    setupCdpUploaderSuccess()
    const buffer = Buffer.from('pdf-bytes')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await uploadFileToCdpUploader(buffer, 'report.pdf', 'application/pdf', logger)

    const [presignedUrl, opts] = mockFetch.mock.calls[1]
    expect(presignedUrl).toBe('https://presigned.test/upload')
    expect(opts.method).toBe('PUT')
    expect(opts.headers['Content-Type']).toBe('application/pdf')
    expect(opts.body).toBe(buffer)
  })

  it('throws when the presigned PUT fails', async () => {
    mockFetch
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: {
            uploadId: 'u-fail',
            uploadUrl: 'https://presigned.test/upload',
            statusUrl: 'https://cdp-uploader.test/uploads/u-fail/status'
          }
        })
      )
      .mockResolvedValueOnce(
        makeFetchResponse({ ok: false, status: 403, text: 'Forbidden' })
      )

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      uploadFileToCdpUploader(Buffer.from('x'), 'f.pdf', 'application/pdf', logger)
    ).rejects.toThrow('403')
  })

  it('polls status URL and returns completed s3 info', async () => {
    const { uploadId, bucket, key, location } = setupCdpUploaderSuccess()
    const buffer = Buffer.from('pdf-content')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const res = await uploadFileToCdpUploader(buffer, 'report.pdf', 'application/pdf', logger)

    expect(res.uploadId).toBe(uploadId)
    expect(res.bucket).toBe(bucket)
    expect(res.key).toBe(key)
    expect(res.location).toBe(location)
    expect(res.statusResponse).toMatchObject({ status: 'completed' })
  })

  it('adopts bucket/key from statusResponse', async () => {
    mockFetch
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: {
            uploadId: 'u-status',
            uploadUrl: 'https://presigned.test/upload',
            statusUrl: 'https://cdp-uploader.test/uploads/u-status/status'
          }
        })
      )
      .mockResolvedValueOnce(
        makeFetchResponse({ ok: true, status: 200, text: '' })
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: {
            status: 'completed',
            bucket: 'status-bucket',
            key: 'status-key',
            location: 's3://status-bucket/status-key'
          }
        })
      )

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const res = await uploadFileToCdpUploader(Buffer.from('x'), 'f.pdf', 'application/pdf', logger)

    expect(res.bucket).toBe('status-bucket')
    expect(res.key).toBe('status-key')
  })

  it('returns null statusResponse and warns when polling times out', async () => {
    config.get.mockImplementation((key) => {
      if (key === 'cdpUploader.pollTimeoutMs') return 80
      if (key === 'cdpUploader.pollIntervalMs') return 20
      if (key === 'cdpUploader.url') return 'https://cdp-uploader.test'
      if (key === 'cdpUploader.s3Bucket') return 'bucket'
      return null
    })

    mockFetch
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: {
            uploadId: 'u3',
            uploadUrl: 'https://presigned.test/upload',
            statusUrl: 'https://cdp/uploads/u3/status'
          }
        })
      )
      .mockResolvedValueOnce(
        makeFetchResponse({ ok: true, status: 200, text: '' })
      )
      .mockResolvedValue(
        makeFetchResponse({ ok: true, json: { status: 'processing' } })
      )

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const res = await uploadFileToCdpUploader(Buffer.from('x'), 'f.pdf', 'application/pdf', logger)

    expect(res.statusResponse).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('returns full result object with expected keys', async () => {
    setupCdpUploaderSuccess()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const res = await uploadFileToCdpUploader(Buffer.from('data'), 'f.pdf', 'application/pdf', logger)

    expect(res).toHaveProperty('bucket')
    expect(res).toHaveProperty('key')
    expect(res).toHaveProperty('location')
    expect(res).toHaveProperty('size')
    expect(res).toHaveProperty('uploadId')
    expect(res).toHaveProperty('statusResponse')
    expect(res).toHaveProperty('initDuration')
  })

   /**
   * Branch 1: state === 'failed' or state === 'error'
   * pollStatus throws → caught by uploadFileToCdpUploader's .catch → statusResponse is null
   */
  it('returns null statusResponse when poll reports state "failed"', async () => {
    mockFetch
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: {
            uploadId: 'u-failed',
            uploadUrl: 'https://presigned.test/upload',
            statusUrl: 'https://cdp-uploader.test/uploads/u-failed/status'
          }
        })
      )
      .mockResolvedValueOnce(
        makeFetchResponse({ ok: true, status: 200, text: '' })
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: { status: 'failed', reason: 'virus detected' }
        })
      )

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const res = await uploadFileToCdpUploader(
      Buffer.from('x'),
      'f.pdf',
      'application/pdf',
      logger
    )

    // pollStatus throws on 'failed' → caught → statusResponse null
    expect(res.statusResponse).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('failed') }),
      expect.any(String)
    )
  })

  it('returns null statusResponse when poll reports state "error"', async () => {
    mockFetch
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: {
            uploadId: 'u-error',
            uploadUrl: 'https://presigned.test/upload',
            statusUrl: 'https://cdp-uploader.test/uploads/u-error/status'
          }
        })
      )
      .mockResolvedValueOnce(
        makeFetchResponse({ ok: true, status: 200, text: '' })
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: { status: 'error', reason: 'processing error' }
        })
      )

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const res = await uploadFileToCdpUploader(
      Buffer.from('x'),
      'f.pdf',
      'application/pdf',
      logger
    )

    expect(res.statusResponse).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('error') }),
      expect.any(String)
    )
  })

  /**
   * Branch 2: r.ok === false during status poll
   * The else branch logs a warn and retries until timeout
   */
  it('warns and retries when status poll returns non-2xx, then times out', async () => {
    config.get.mockImplementation((key) => {
      if (key === 'cdpUploader.pollTimeoutMs') return 100
      if (key === 'cdpUploader.pollIntervalMs') return 20
      if (key === 'cdpUploader.url') return 'https://cdp-uploader.test'
      if (key === 'cdpUploader.s3Bucket') return 'bucket'
      return null
    })

    mockFetch
      // initiate
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: {
            uploadId: 'u-non2xx',
            uploadUrl: 'https://presigned.test/upload',
            statusUrl: 'https://cdp-uploader.test/uploads/u-non2xx/status'
          }
        })
      )
      // PUT upload
      .mockResolvedValueOnce(
        makeFetchResponse({ ok: true, status: 200, text: '' })
      )
      // status polls always return non-2xx (503)
      .mockResolvedValue(
        makeFetchResponse({ ok: false, status: 503, text: 'Service Unavailable' })
      )

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const res = await uploadFileToCdpUploader(
      Buffer.from('x'),
      'f.pdf',
      'application/pdf',
      logger
    )

    // pollStatus times out → caught → statusResponse null
    expect(res.statusResponse).toBeNull()
    // the non-2xx warn should have been called at least once
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503 }),
      'cdp-uploader status poll returned non-2xx'
    )
  })

  /**
   * Branch 3: fetch itself throws during status poll (network error)
   * The catch block logs a warn and retries until timeout
   */
  it('warns and retries when status poll fetch throws a network error', async () => {
    config.get.mockImplementation((key) => {
      if (key === 'cdpUploader.pollTimeoutMs') return 100
      if (key === 'cdpUploader.pollIntervalMs') return 20
      if (key === 'cdpUploader.url') return 'https://cdp-uploader.test'
      if (key === 'cdpUploader.s3Bucket') return 'bucket'
      return null
    })

    mockFetch
      // initiate
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          json: {
            uploadId: 'u-neterr',
            uploadUrl: 'https://presigned.test/upload',
            statusUrl: 'https://cdp-uploader.test/uploads/u-neterr/status'
          }
        })
      )
      // PUT upload
      .mockResolvedValueOnce(
        makeFetchResponse({ ok: true, status: 200, text: '' })
      )
      // status polls throw a network error every time
      .mockRejectedValue(new Error('ECONNREFUSED'))

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const res = await uploadFileToCdpUploader(
      Buffer.from('x'),
      'f.pdf',
      'application/pdf',
      logger
    )

    // pollStatus times out after retries → caught → statusResponse null
    expect(res.statusResponse).toBeNull()
    // the catch-block warn should have been called at least once
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'ECONNREFUSED' }),
      'Error polling cdp-uploader status (will retry)'
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// handleFileUpload — missing / malformed file
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleFileUpload — missing / malformed file', () => {
  it('returns 400 when payload has no file field', async () => {
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(createMockRequest({ payload: {} }), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'No file provided' })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })

  it('returns 400 when file field has no hapi metadata', async () => {
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(createMockRequest({ payload: { file: {} } }), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'No file provided' })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })

  it('returns 400 when payload is null', async () => {
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(createMockRequest({ payload: null }), h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// handleFileUpload — file type validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleFileUpload — file type validation', () => {
  it('returns 400 for image/png', async () => {
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(
      createMockRequest({
        payload: { file: makeHapiFile({ filename: 'pic.png', mimeType: 'image/png' }) }
      }),
      h
    )

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'The selected file must be a PDF or Word document'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })

  it('returns 400 for text/plain', async () => {
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(
      createMockRequest({
        payload: { file: makeHapiFile({ filename: 'note.txt', mimeType: 'text/plain' }) }
      }),
      h
    )

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })

  it('accepts application/pdf', async () => {
    setupCdpUploaderSuccess()
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(
      createMockRequest({
        payload: { file: makeHapiFile({ filename: 'doc.pdf', mimeType: 'application/pdf' }) }
      }),
      h
    )

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.ACCEPTED)
  })

  it('accepts docx MIME type', async () => {
    setupCdpUploaderSuccess()
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(
      createMockRequest({
        payload: {
          file: makeHapiFile({
            filename: 'doc.docx',
            mimeType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          })
        }
      }),
      h
    )

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.ACCEPTED)
  })

  it('accepts .pdf extension with octet-stream MIME', async () => {
    setupCdpUploaderSuccess()
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(
      createMockRequest({
        payload: {
          file: makeHapiFile({
            filename: 'doc.pdf',
            mimeType: 'application/octet-stream'
          })
        }
      }),
      h
    )

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.ACCEPTED)
  })

  it('accepts .docx extension with octet-stream MIME', async () => {
    setupCdpUploaderSuccess()
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(
      createMockRequest({
        payload: {
          file: makeHapiFile({
            filename: 'doc.docx',
            mimeType: 'application/octet-stream'
          })
        }
      }),
      h
    )

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.ACCEPTED)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// handleFileUpload — buffer validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleFileUpload — buffer validation', () => {
  it('returns 400 when uploaded file is empty', async () => {
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(
      createMockRequest({ payload: { file: makeHapiFile({ content: '' }) } }),
      h
    )

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'The uploaded file is empty'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })

  it('returns 400 when file exceeds 10 MB', async () => {
    const bigContent = Buffer.alloc(10 * 1024 * 1024 + 1, 'x')
    const stream = Readable.from([bigContent])
    stream.hapi = {
      filename: 'big.pdf',
      headers: { 'content-type': 'application/pdf' }
    }

    const handler = getUploadHandler()
    const h = createMockH()
    await handler(createMockRequest({ payload: { file: stream } }), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'The file must be smaller than 10 MB'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// handleFileUpload — successful pipeline
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleFileUpload — successful upload', () => {
  it('returns 202 with success true, pending status and message', async () => {
    setupCdpUploaderSuccess()
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(createMockRequest({ payload: { file: makeHapiFile() } }), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        status: REVIEW_STATUSES.PENDING,
        message: 'File uploaded and queued for review'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.ACCEPTED)
  })

  it('includes a reviewId string in the response', async () => {
    setupCdpUploaderSuccess()
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(createMockRequest({ payload: { file: makeHapiFile() } }), h)

    const [arg] = h.response.mock.calls[0]
    expect(arg).toHaveProperty('reviewId')
    expect(typeof arg.reviewId).toBe('string')
    expect(arg.reviewId.length).toBeGreaterThan(0)
  })

  it('passes x-user-id header value to createReviewRecord', async () => {
    setupCdpUploaderSuccess()
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(
      createMockRequest({
        payload: { file: makeHapiFile() },
        headers: { 'x-user-id': 'user-abc' }
      }),
      h
    )

    expect(createReviewRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      'report.pdf',
      expect.any(Number),
      expect.any(Object),
      'user-abc',
      'application/pdf',
      'file'
    )
  })

  it('passes null userId when x-user-id header is absent', async () => {
    setupCdpUploaderSuccess()
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(
      createMockRequest({ payload: { file: makeHapiFile() }, headers: {} }),
      h
    )

    expect(createReviewRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(String),
      expect.any(Number),
      expect.any(Object),
      null,
      expect.any(String),
      'file'
    )
  })

  it('uses "Uploaded file" as title when filename is empty', async () => {
    setupCdpUploaderSuccess()
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(
      createMockRequest({ payload: { file: makeHapiFile({ filename: '' }) } }),
      h
    )

    expect(createCanonicalDocument).toHaveBeenCalledWith(
      null,
      expect.any(String),
      'Uploaded file',
      expect.any(Object),
      'file',
      expect.any(String)
    )
  })

  it('calls cdp-uploader, createCanonicalDocument, createReviewRecord and queueReviewJob', async () => {
    setupCdpUploaderSuccess()
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(createMockRequest({ payload: { file: makeHapiFile() } }), h)

    expect(mockFetch).toHaveBeenCalled()
    expect(createCanonicalDocument).toHaveBeenCalledTimes(1)
    expect(createReviewRecord).toHaveBeenCalledTimes(1)
    expect(queueReviewJob).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// handleFileUpload — error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleFileUpload — error handling', () => {
  it('returns 500 when cdp-uploader /initiate call fails', async () => {
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse({ ok: false, status: 503, text: 'Service Unavailable' })
    )
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(createMockRequest({ payload: { file: makeHapiFile() } }), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  })

  it('returns 500 when createCanonicalDocument throws', async () => {
    setupCdpUploaderSuccess()
    createCanonicalDocument.mockRejectedValue(new Error('Canonical failed'))
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(createMockRequest({ payload: { file: makeHapiFile() } }), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'Canonical failed' })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  })

  it('returns 500 when createReviewRecord throws', async () => {
    setupCdpUploaderSuccess()
    createReviewRecord.mockRejectedValue(new Error('DB write failed'))
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(createMockRequest({ payload: { file: makeHapiFile() } }), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'DB write failed' })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  })

  it('returns 500 when queueReviewJob throws', async () => {
    setupCdpUploaderSuccess()
    queueReviewJob.mockRejectedValue(new Error('SQS unavailable'))
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(createMockRequest({ payload: { file: makeHapiFile() } }), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'SQS unavailable' })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  })

  it('returns fallback message when thrown error has no message', async () => {
    setupCdpUploaderSuccess()
    createCanonicalDocument.mockRejectedValue(new Error())
    const handler = getUploadHandler()
    const h = createMockH()
    await handler(createMockRequest({ payload: { file: makeHapiFile() } }), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'Failed to process file upload'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// runPipeline (exported helper)
// ═══════════════════════════════════════════════════════════════════════════════

describe('runPipeline', () => {
  it('returns expected shape on success', async () => {
    setupCdpUploaderSuccess()
    const file = makeHapiFile()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const result = await runPipeline(
      file,
      'review-uuid',
      'report.pdf',
      'application/pdf',
      'user-1',
      { 'x-user-id': 'user-1' },
      logger
    )

    expect(result).toHaveProperty('s3Result')
    expect(result).toHaveProperty('canonicalResult')
    expect(result).toHaveProperty('s3UploadDuration')
    expect(result).toHaveProperty('canonicalDuration')
    expect(result).toHaveProperty('dbCreateDuration')
    expect(result).toHaveProperty('sqsSendDuration')
  })

  it('calls createCanonicalDocument with rawS3Key from cdp-uploader result', async () => {
    setupCdpUploaderSuccess()
    const file = makeHapiFile()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await runPipeline(
      file,
      'review-uuid',
      'report.pdf',
      'application/pdf',
      null,
      {},
      logger
    )

    expect(createCanonicalDocument).toHaveBeenCalledWith(
      null,
      'review-uuid',
      'report.pdf',
      logger,
      'file',
      expect.any(String)
    )
  })

  it('calls queueReviewJob with correct reviewId and headers', async () => {
    setupCdpUploaderSuccess()
    const file = makeHapiFile()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const headers = { 'x-user-id': 'user-xyz' }

    await runPipeline(file, 'review-xyz', 'report.pdf', 'application/pdf', 'user-xyz', headers, logger)

    expect(queueReviewJob).toHaveBeenCalledWith(
      'review-xyz',
      expect.any(Object),
      'report.pdf',
      expect.any(Number),
      headers,
      logger
    )
  })

  it('propagates error thrown by uploadFileToCdpUploader', async () => {
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse({ ok: false, status: 500, text: 'Error' })
    )
    const file = makeHapiFile()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runPipeline(file, 'r1', 'f.pdf', 'application/pdf', null, {}, logger)
    ).rejects.toThrow('500')
  })

  it('propagates error thrown by createCanonicalDocument', async () => {
    setupCdpUploaderSuccess()
    createCanonicalDocument.mockRejectedValue(new Error('Canonical boom'))
    const file = makeHapiFile()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runPipeline(file, 'r1', 'f.pdf', 'application/pdf', null, {}, logger)
    ).rejects.toThrow('Canonical boom')
  })

  it('propagates error thrown by createReviewRecord', async () => {
    setupCdpUploaderSuccess()
    createReviewRecord.mockRejectedValue(new Error('DB error'))
    const file = makeHapiFile()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runPipeline(file, 'r1', 'f.pdf', 'application/pdf', null, {}, logger)
    ).rejects.toThrow('DB error')
  })

  it('propagates error thrown by queueReviewJob', async () => {
    setupCdpUploaderSuccess()
    queueReviewJob.mockRejectedValue(new Error('SQS error'))
    const file = makeHapiFile()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runPipeline(file, 'r1', 'f.pdf', 'application/pdf', null, {}, logger)
    ).rejects.toThrow('SQS error')
  })
})