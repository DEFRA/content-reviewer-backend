import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('form-data', () => ({
  default: class FormData {
    append() {}
    getHeaders() {
      return {}
    }
  }
}))

vi.mock('../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const map = {
        'cdpUploader.url': 'http://cdp-uploader',
        's3.bucket': 'test-bucket',
        serverUrl: 'http://localhost:3001'
      }
      return map[key]
    })
  }
}))

vi.mock('../common/helpers/canonical-document.js', () => ({
  SOURCE_TYPES: { FILE: 'file' }
}))

vi.mock('./review-helpers.js', () => ({
  HTTP_STATUS: { OK: 200, ACCEPTED: 202, INTERNAL_SERVER_ERROR: 500 },
  REVIEW_STATUSES: { PENDING: 'pending' },
  getCorsConfig: vi.fn(() => ({ origin: ['*'] })),
  createCanonicalDocument: vi.fn(),
  createReviewRecord: vi.fn(),
  queueReviewJob: vi.fn()
}))

import {
  createCanonicalDocument,
  createReviewRecord,
  queueReviewJob
} from './review-helpers.js'

import { uploadRoutes } from './upload.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockH() {
  const responseMock = { code: vi.fn().mockReturnThis() }
  return { response: vi.fn(() => responseMock), _response: responseMock }
}

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeStream(content = 'file content') {
  return Readable.from([Buffer.from(content)])
}

function fetchOk(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body))
  }
}

/** Returns a mock request for POST /api/upload */
function uploadRequest(overrides = {}) {
  return {
    headers: {
      'x-file-name': encodeURIComponent('report.pdf'),
      'content-length': '1024',
      'x-user-id': 'user-123',
      ...overrides.headers
    },
    payload: makeStream(),
    logger: mockLogger(),
    ...overrides
  }
}

/** Returns a valid CDP Uploader callback payload */
function callbackPayload(overrides = {}) {
  return {
    uploadStatus: 'ready',
    metadata: { reviewId: 'review-abc', userId: 'user-123' },
    form: {
      file: {
        filename: 'report.pdf',
        s3Key: 'uploads/report.pdf',
        s3Bucket: 'test-bucket',
        detectedContentType: 'application/pdf',
        fileStatus: 'complete',
        hasError: false
      }
    },
    numberOfRejectedFiles: 0,
    ...overrides
  }
}

/** Returns a mock request for POST /upload-callback */
function callbackRequest(payload = callbackPayload()) {
  return { payload, logger: mockLogger() }
}

/** Extracts the handler for the nth registered route (0 = /api/upload, 1 = /upload-callback) */
async function getHandler(index) {
  const routes = []
  const server = { route: vi.fn((r) => routes.push(r)) }
  await uploadRoutes.plugin.register(server)
  return routes[index].handler
}

// ─── POST /api/upload — handleFileUpload ──────────────────────────────────────

describe('handleFileUpload (POST /api/upload)', () => {
  let handler

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('performance', { now: vi.fn().mockReturnValue(0) })
    handler = await getHandler(0)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  // ── happy path ──────────────────────────────────────────────────────────────

  it('returns 202 with reviewId and pending status on success', async () => {
    fetch
      .mockResolvedValueOnce(
        fetchOk({ uploadId: 'up-1', uploadUrl: '/upload-and-scan/up-1' })
      )
      .mockResolvedValueOnce({ ok: false, status: 302 }) // upload-and-scan returns 302

    const h = mockH()
    await handler(uploadRequest(), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        status: 'pending',
        reviewId: expect.any(String)
      })
    )
    expect(h._response.code).toHaveBeenCalledWith(202)
  })

  it('accepts a 302 redirect from /upload-and-scan as success', async () => {
    fetch
      .mockResolvedValueOnce(
        fetchOk({ uploadId: 'up-1', uploadUrl: '/upload-and-scan/up-1' })
      )
      .mockResolvedValueOnce({ ok: false, status: 302 })

    const h = mockH()
    await handler(uploadRequest(), h)

    expect(h._response.code).toHaveBeenCalledWith(202)
  })

  it('accepts a 200 response from /upload-and-scan as success', async () => {
    fetch
      .mockResolvedValueOnce(
        fetchOk({ uploadId: 'up-1', uploadUrl: '/upload-and-scan/up-1' })
      )
      .mockResolvedValueOnce(fetchOk({}, 200))

    const h = mockH()
    await handler(uploadRequest(), h)

    expect(h._response.code).toHaveBeenCalledWith(202)
  })

  // ── /initiate failures ───────────────────────────────────────────────────────

  it('returns 500 when CDP Uploader URL is not configured', async () => {
    const { config } = await import('../config.js')
    config.get.mockImplementation((key) =>
      key === 'cdpUploader.url' ? '' : undefined
    )

    const h = mockH()
    await handler(uploadRequest(), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    )
    expect(h._response.code).toHaveBeenCalledWith(500)

    config.get.mockImplementation((key) => {
      const map = {
        'cdpUploader.url': 'http://cdp-uploader',
        's3.bucket': 'test-bucket',
        serverUrl: 'http://localhost:3001'
      }
      return map[key]
    })
  })

  it('returns 500 when /initiate returns non-2xx', async () => {
    fetch.mockResolvedValueOnce(fetchOk({}, 500))

    const h = mockH()
    await handler(uploadRequest(), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringContaining('500')
      })
    )
    expect(h._response.code).toHaveBeenCalledWith(500)
  })

  it('returns 500 when /initiate does not return an uploadUrl', async () => {
    fetch.mockResolvedValueOnce(fetchOk({ uploadId: 'up-1' })) // no uploadUrl

    const h = mockH()
    await handler(uploadRequest(), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    )
    expect(h._response.code).toHaveBeenCalledWith(500)
  })

  // ── /upload-and-scan failures ────────────────────────────────────────────────

  it('returns 500 when /upload-and-scan returns a 4xx error', async () => {
    fetch
      .mockResolvedValueOnce(
        fetchOk({ uploadId: 'up-1', uploadUrl: '/upload-and-scan/up-1' })
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: vi.fn().mockResolvedValue('bad request')
      })

    const h = mockH()
    await handler(uploadRequest(), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringContaining('400')
      })
    )
    expect(h._response.code).toHaveBeenCalledWith(500)
  })

  it('returns 500 when /upload-and-scan returns a 5xx error', async () => {
    fetch
      .mockResolvedValueOnce(
        fetchOk({ uploadId: 'up-1', uploadUrl: '/upload-and-scan/up-1' })
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue('service unavailable')
      })

    const h = mockH()
    await handler(uploadRequest(), h)

    expect(h._response.code).toHaveBeenCalledWith(500)
  })

  // ── headers ─────────────────────────────────────────────────────────────────

  it('decodes URI-encoded x-file-name header', async () => {
    fetch
      .mockResolvedValueOnce(
        fetchOk({ uploadId: 'up-1', uploadUrl: '/upload-and-scan/up-1' })
      )
      .mockResolvedValueOnce({ ok: false, status: 302 })

    const request = uploadRequest({
      headers: { 'x-file-name': encodeURIComponent('my report (2024).pdf') }
    })
    const h = mockH()
    await handler(request, h)

    // Confirm the handler ran (202 returned) — file name decoding didn't throw
    expect(h._response.code).toHaveBeenCalledWith(202)
  })

  it('uses null fileName when x-file-name header is absent', async () => {
    fetch
      .mockResolvedValueOnce(
        fetchOk({ uploadId: 'up-1', uploadUrl: '/upload-and-scan/up-1' })
      )
      .mockResolvedValueOnce({ ok: false, status: 302 })

    const request = uploadRequest({ headers: {} })
    const h = mockH()
    await handler(request, h)

    expect(h._response.code).toHaveBeenCalledWith(202)
  })

  it('uses null userId when x-user-id header is absent', async () => {
    fetch
      .mockResolvedValueOnce(
        fetchOk({ uploadId: 'up-1', uploadUrl: '/upload-and-scan/up-1' })
      )
      .mockResolvedValueOnce({ ok: false, status: 302 })

    const request = uploadRequest({
      headers: { 'x-file-name': 'report.pdf' } // no x-user-id
    })
    const h = mockH()
    await handler(request, h)

    expect(h._response.code).toHaveBeenCalledWith(202)
  })

  // ── /initiate request body ───────────────────────────────────────────────────

  it('sends redirect:manual and callback URL in /initiate body', async () => {
    fetch
      .mockResolvedValueOnce(
        fetchOk({ uploadId: 'up-1', uploadUrl: '/upload-and-scan/up-1' })
      )
      .mockResolvedValueOnce({ ok: false, status: 302 })

    await handler(uploadRequest(), mockH())

    const [initiateUrl, initiateOpts] = fetch.mock.calls[0]
    expect(initiateUrl).toBe('http://cdp-uploader/initiate')

    const body = JSON.parse(initiateOpts.body)
    expect(body.redirect).toBe('manual')
    expect(body.callback).toBe('http://localhost:3001/upload-callback')
    expect(body.metadata).toMatchObject({ userId: 'user-123' })
  })
})

// ─── POST /upload-callback — handleUploadCallback ────────────────────────────

describe('handleUploadCallback (POST /upload-callback)', () => {
  let handler
  let capturedImmediate

  /**
   * Fires the captured setImmediate callback and drains the microtask queue.
   * The callback is `() => { runCallbackPipeline(...).catch(...) }` — it does
   * not return the promise, so we must use a real setTimeout to flush all
   * pending microtasks before running assertions.
   */
  async function flushPipeline() {
    if (capturedImmediate) {
      capturedImmediate()
      capturedImmediate = null
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  beforeEach(async () => {
    // Capture the setImmediate callback so tests can explicitly await it
    capturedImmediate = null
    vi.stubGlobal(
      'setImmediate',
      vi.fn((cb) => {
        capturedImmediate = cb
      })
    )
    handler = await getHandler(1)

    createCanonicalDocument.mockResolvedValue({
      canonicalResult: {
        s3: { key: 'documents/review-abc.json', bucket: 'test-bucket' },
        document: { charCount: 5000 }
      },
      canonicalDuration: 30
    })
    createReviewRecord.mockResolvedValue(15)
    queueReviewJob.mockResolvedValue(8)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  // ── always returns 200 ───────────────────────────────────────────────────────

  it('returns 200 on a valid successful callback', async () => {
    const h = mockH()
    await handler(callbackRequest(), h)

    expect(h.response).toHaveBeenCalledWith({ ok: true })
    expect(h._response.code).toHaveBeenCalledWith(200)
  })

  it('returns 200 when reviewId is missing in metadata', async () => {
    const h = mockH()
    await handler(callbackRequest(callbackPayload({ metadata: {} })), h)

    expect(h._response.code).toHaveBeenCalledWith(200)
  })

  it('returns 200 when payload is completely absent', async () => {
    const h = mockH()
    await handler({ payload: undefined, logger: mockLogger() }, h)

    expect(h._response.code).toHaveBeenCalledWith(200)
  })

  it('returns 200 when uploadStatus is not ready', async () => {
    const h = mockH()
    await handler(
      callbackRequest(callbackPayload({ uploadStatus: 'pending' })),
      h
    )

    expect(h._response.code).toHaveBeenCalledWith(200)
  })

  it('returns 200 when hasError is true', async () => {
    const h = mockH()
    const payload = callbackPayload()
    payload.form.file.hasError = true
    payload.form.file.fileStatus = 'rejected'
    await handler(callbackRequest(payload), h)

    expect(h._response.code).toHaveBeenCalledWith(200)
  })

  it('returns 200 when fileStatus is not complete', async () => {
    const h = mockH()
    const payload = callbackPayload()
    payload.form.file.fileStatus = 'rejected'
    await handler(callbackRequest(payload), h)

    expect(h._response.code).toHaveBeenCalledWith(200)
  })

  // ── logging ──────────────────────────────────────────────────────────────────

  it('logs an error when reviewId is missing', async () => {
    const request = callbackRequest(callbackPayload({ metadata: {} }))
    await handler(request, mockH())

    expect(request.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: {} }),
      expect.stringContaining('No reviewId')
    )
  })

  it('logs a warning when upload is rejected or failed', async () => {
    const payload = callbackPayload({ uploadStatus: 'failed' })
    const request = callbackRequest(payload)
    await handler(request, mockH())

    expect(request.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ uploadStatus: 'failed' }),
      expect.stringContaining('rejected or failed')
    )
  })

  // ── pipeline execution ───────────────────────────────────────────────────────

  it('calls createCanonicalDocument with correct args', async () => {
    await handler(callbackRequest(), mockH())
    await flushPipeline()

    expect(createCanonicalDocument).toHaveBeenCalledWith(
      null,
      'review-abc',
      'report.pdf',
      expect.any(Object),
      'file',
      'uploads/report.pdf'
    )
  })

  it('calls createReviewRecord with correct args', async () => {
    await handler(callbackRequest(), mockH())
    await flushPipeline()

    expect(createReviewRecord).toHaveBeenCalledWith(
      'review-abc',
      expect.objectContaining({ key: 'documents/review-abc.json' }),
      'report.pdf',
      5000,
      expect.any(Object),
      expect.objectContaining({
        userId: 'user-123',
        mimeType: 'application/pdf',
        dbSourceType: 'file'
      })
    )
  })

  it('calls queueReviewJob with correct args', async () => {
    await handler(callbackRequest(), mockH())
    await flushPipeline()

    expect(queueReviewJob).toHaveBeenCalledWith(
      'review-abc',
      expect.objectContaining({ key: 'documents/review-abc.json' }),
      'report.pdf',
      5000,
      {},
      expect.any(Object)
    )
  })

  it('falls back to file.contentType when detectedContentType is absent', async () => {
    const payload = callbackPayload()
    delete payload.form.file.detectedContentType
    payload.form.file.contentType = 'application/pdf'

    await handler(callbackRequest(payload), mockH())
    await flushPipeline()

    expect(createReviewRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(String),
      expect.any(Number),
      expect.any(Object),
      expect.objectContaining({ mimeType: 'application/pdf' })
    )
  })

  it('uses 0 for charCount when canonicalResult has no charCount', async () => {
    createCanonicalDocument.mockResolvedValueOnce({
      canonicalResult: {
        s3: { key: 'documents/review-abc.json' },
        document: {} // no charCount
      },
      canonicalDuration: 10
    })

    await handler(callbackRequest(), mockH())
    await flushPipeline()

    expect(createReviewRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(String),
      0,
      expect.any(Object),
      expect.any(Object)
    )
  })

  it('does not call the pipeline when reviewId is missing', async () => {
    await handler(callbackRequest(callbackPayload({ metadata: {} })), mockH())

    expect(createCanonicalDocument).not.toHaveBeenCalled()
  })

  it('does not call the pipeline when uploadStatus is not ready', async () => {
    await handler(
      callbackRequest(callbackPayload({ uploadStatus: 'pending' })),
      mockH()
    )

    expect(createCanonicalDocument).not.toHaveBeenCalled()
  })

  it('logs pipeline error but still returns 200 when pipeline throws', async () => {
    createCanonicalDocument.mockRejectedValueOnce(new Error('canonical failed'))

    const request = callbackRequest()
    const h = mockH()
    await handler(request, h)
    await flushPipeline()

    expect(h._response.code).toHaveBeenCalledWith(200)
    expect(request.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'canonical failed' }),
      expect.stringContaining('Pipeline failed')
    )
  })

  it('logs pipeline error but still returns 200 when queueReviewJob throws', async () => {
    queueReviewJob.mockRejectedValueOnce(new Error('sqs failed'))

    const request = callbackRequest()
    const h = mockH()
    await handler(request, h)
    await flushPipeline()

    expect(h._response.code).toHaveBeenCalledWith(200)
    expect(request.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'sqs failed' }),
      expect.stringContaining('Pipeline failed')
    )
  })
})

// ─── uploadRoutes plugin registration ────────────────────────────────────────

describe('uploadRoutes plugin', () => {
  it('has plugin name upload-routes', () => {
    expect(uploadRoutes.plugin.name).toBe('upload-routes')
  })

  it('registers exactly two routes', async () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    await uploadRoutes.plugin.register(server)
    expect(routes).toHaveLength(2)
  })

  it('registers POST /api/upload as the first route', async () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    await uploadRoutes.plugin.register(server)
    expect(routes[0].method).toBe('POST')
    expect(routes[0].path).toBe('/api/upload')
  })

  it('/api/upload has stream payload config with 10 MB limit', async () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    await uploadRoutes.plugin.register(server)
    const { payload } = routes[0].options
    expect(payload.output).toBe('stream')
    expect(payload.parse).toBe(false)
    expect(payload.multipart).toBe(false)
    expect(payload.maxBytes).toBe(10 * 1024 * 1024)
  })

  it('registers POST /upload-callback as the second route', async () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    await uploadRoutes.plugin.register(server)
    expect(routes[1].method).toBe('POST')
    expect(routes[1].path).toBe('/upload-callback')
  })

  it('/upload-callback has auth: false', async () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    await uploadRoutes.plugin.register(server)
    expect(routes[1].options.auth).toBe(false)
  })

  it('/upload-callback accepts application/json payload', async () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    await uploadRoutes.plugin.register(server)
    expect(routes[1].options.payload.allow).toBe('application/json')
    expect(routes[1].options.payload.parse).toBe(true)
  })
})
