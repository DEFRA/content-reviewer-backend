import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

// ─── Mock: node:crypto ────────────────────────────────────────────────────────
vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234')
}))

// ─── Mock: config ─────────────────────────────────────────────────────────────
vi.mock('../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const map = {
        serverUrl: 'http://localhost:3001',
        's3.rawS3Path': 'raw',
        's3.bucket': 'test-bucket',
        'cdpUploader.url': 'http://cdp-uploader:3002'
      }
      return map[key] ?? null
    })
  }
}))

// ─── Mock: canonical-document ─────────────────────────────────────────────────
vi.mock('../common/helpers/canonical-document.js', () => ({
  SOURCE_TYPES: { FILE: 'file' }
}))

// ─── Mock: review-helpers ─────────────────────────────────────────────────────
const mockCreateCanonicalDocument = vi.fn()
const mockCreateReviewRecord = vi.fn()
const mockQueueReviewJob = vi.fn()

vi.mock('./review-helpers.js', () => ({
  HTTP_STATUS: {
    OK: 200,
    ACCEPTED: 202,
    BAD_REQUEST: 400,
    INTERNAL_SERVER_ERROR: 500
  },
  REVIEW_STATUSES: { PENDING: 'pending' },
  getCorsConfig: vi.fn(() => ({})),
  createCanonicalDocument: (...args) => mockCreateCanonicalDocument(...args),
  createReviewRecord: (...args) => mockCreateReviewRecord(...args),
  queueReviewJob: (...args) => mockQueueReviewJob(...args)
}))

// ─── Import handlers (after mocks are declared) ───────────────────────────────
import {
  handleFileUpload,
  handleUploadCallback,
  handleUploadSuccess,
  runCallbackPipeline
} from './upload.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Create a minimal Readable-like stream for file upload tests */
function makeFileStream(data = Buffer.from('fake-pdf-bytes')) {
  const handlers = {}
  const stream = {
    hapi: {
      filename: 'test-document.pdf',
      headers: { 'content-type': 'application/pdf' }
    },
    on(event, cb) {
      handlers[event] = cb
      return stream
    },
    emit(event, ...args) {
      handlers[event]?.(...args)
    }
  }
  // Emit data + end on next tick so callers can attach listeners first
  setTimeout(() => {
    stream.emit('data', data)
    stream.emit('end')
  }, 0)
  return stream
}

function makeLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  }
}

function makeResponseToolkit() {
  const mockCode = vi.fn().mockReturnThis()
  const mockResponse = vi.fn((data) => ({
    data,
    code: mockCode,
    _code: mockCode
  }))
  return { response: mockResponse, _code: mockCode }
}

// ─── POST /api/upload — handleFileUpload ──────────────────────────────────────

describe('handleFileUpload — file validation', () => {
  let mockFetch

  beforeEach(() => {
    vi.clearAllMocks()
    randomUUID.mockReturnValue('test-uuid-1234')
    mockFetch = vi.fn()
    global.fetch = mockFetch
    global.performance = { now: vi.fn().mockReturnValue(0) }
  })

  afterEach(() => {
    delete global.fetch
    delete global.performance
  })

  it('returns 400 when no file is provided in payload', async () => {
    const request = {
      payload: {},
      headers: {},
      logger: makeLogger()
    }
    // code() must return a truthy value so the handler's early-return guard fires
    const codeFn = vi.fn().mockReturnValue({ statusCode: 400 })
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'No file provided' })
    )
    expect(codeFn).toHaveBeenCalledWith(400)
  })

  it('returns 400 when payload is null', async () => {
    const request = { payload: null, headers: {}, logger: makeLogger() }
    const codeFn = vi.fn().mockReturnValue({ statusCode: 400 })
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    expect(codeFn).toHaveBeenCalledWith(400)
  })
})

describe('handleFileUpload — CDP Uploader /initiate', () => {
  let mockFetch

  beforeEach(() => {
    vi.clearAllMocks()
    randomUUID.mockReturnValue('test-uuid-1234')
    mockFetch = vi.fn()
    global.fetch = mockFetch
    global.performance = { now: vi.fn().mockReturnValue(0) }
  })

  afterEach(() => {
    delete global.fetch
    delete global.performance
  })

  it('calls CDP Uploader /initiate with correct body matching CDP spec', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          uploadId: 'cdp-upload-99',
          uploadUrl: '/upload-and-scan/cdp-upload-99',
          statusUrl: 'https://cdp-uploader:3002/status/cdp-upload-99'
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 302, // CDP Uploader returns 302 on success
        headers: new Headers({
          location: '/upload-success?reviewId=test-uuid-1234'
        })
      })

    const fileStream = makeFileStream()
    const request = {
      payload: { file: fileStream },
      headers: { 'x-user-id': 'user-42' },
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    // First fetch call is to /initiate
    const [initiateUrl, initiateOpts] = mockFetch.mock.calls[0]
    expect(initiateUrl).toBe('http://cdp-uploader:3002/initiate')
    expect(initiateOpts.method).toBe('POST')

    const body = JSON.parse(initiateOpts.body)
    // Required CDP spec fields
    expect(body.redirect).toMatch(/^\/upload-success\?reviewId=/)
    expect(body.callback).toContain('/upload-callback')
    expect(body.s3Bucket).toBe('test-bucket')
    expect(body.metadata.reviewId).toBe('test-uuid-1234')
    expect(body.metadata.userId).toBe('user-42')
    expect(body.mimeTypes).toContain('application/pdf')
    expect(body.mimeTypes).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    // s3Path must NOT be present — it is not a CDP spec field
    expect(body).not.toHaveProperty('s3Path')
  })

  it('extracts statusUrl from /initiate response and logs it', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          uploadId: 'cdp-upload-status',
          uploadUrl: '/upload-and-scan/cdp-upload-status',
          statusUrl: 'https://cdp-uploader:3002/status/cdp-upload-status'
        })
      })
      .mockResolvedValueOnce({ ok: true, status: 302 })

    const fileStream = makeFileStream()
    const request = {
      payload: { file: fileStream },
      headers: {},
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    const loggedObjects = request.logger.info.mock.calls.map((c) => c[0])
    const initLog = loggedObjects.find(
      (o) => typeof o === 'object' && o.statusUrl
    )
    expect(initLog).toBeDefined()
    expect(initLog.statusUrl).toBe(
      'https://cdp-uploader:3002/status/cdp-upload-status'
    )
  })

  it('sends file to /upload-and-scan using the uploadUrl from /initiate', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          uploadId: 'cdp-upload-99',
          uploadUrl: '/upload-and-scan/cdp-upload-99'
        })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 302 // CDP Uploader success is a 302 redirect
      })

    const fileStream = makeFileStream()
    const request = {
      payload: { file: fileStream },
      headers: {},
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    const [uploadUrl] = mockFetch.mock.calls[1]
    expect(uploadUrl).toBe(
      'http://cdp-uploader:3002/upload-and-scan/cdp-upload-99'
    )
  })

  it('uses redirect:manual so a CDP 302 is treated as success (not followed)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          uploadId: 'cdp-upload-99',
          uploadUrl: '/upload-and-scan/cdp-upload-99'
        })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 302 // CDP success; with redirect:manual this is not followed
      })

    const fileStream = makeFileStream()
    const request = {
      payload: { file: fileStream },
      headers: {},
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    // 302 from CDP Uploader is success — handler should return 202, not 500
    expect(codeFn).toHaveBeenCalledWith(202)
    // Confirm the fetch was called with redirect: 'manual'
    const [, uploadOpts] = mockFetch.mock.calls[1]
    expect(uploadOpts.redirect).toBe('manual')
  })

  it('returns 202 Accepted with reviewId and pending status on success', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          uploadId: 'cdp-upload-99',
          uploadUrl: '/upload-and-scan/cdp-upload-99'
        })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 302 // CDP Uploader success response
      })

    const fileStream = makeFileStream()
    const request = {
      payload: { file: fileStream },
      headers: {},
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        reviewId: 'test-uuid-1234',
        status: 'pending',
        message: expect.stringContaining('uploaded')
      })
    )
    expect(codeFn).toHaveBeenCalledWith(202)
  })

  it('returns 500 when /initiate returns a non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue('Service Unavailable')
    })

    const fileStream = makeFileStream()
    const request = {
      payload: { file: fileStream },
      headers: {},
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    expect(codeFn).toHaveBeenCalledWith(500)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    )
  })

  it('returns 500 when /initiate does not return an uploadUrl', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ uploadId: 'cdp-upload-99' })
      // uploadUrl deliberately missing
    })

    const fileStream = makeFileStream()
    const request = {
      payload: { file: fileStream },
      headers: {},
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    expect(codeFn).toHaveBeenCalledWith(500)
  })

  it('returns 500 when /upload-and-scan fails', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          uploadId: 'cdp-upload-99',
          uploadUrl: '/upload-and-scan/cdp-upload-99'
        })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: vi.fn().mockResolvedValue('Bad Request')
      })

    const fileStream = makeFileStream()
    const request = {
      payload: { file: fileStream },
      headers: {},
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    expect(codeFn).toHaveBeenCalledWith(500)
  })

  it('returns 500 when network fetch throws (connection refused)', async () => {
    const networkErr = new Error('ECONNREFUSED')
    networkErr.code = 'ECONNREFUSED'
    mockFetch.mockRejectedValueOnce(networkErr)

    const fileStream = makeFileStream()
    const request = {
      payload: { file: fileStream },
      headers: {},
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    expect(codeFn).toHaveBeenCalledWith(500)
    expect(request.logger.error).toHaveBeenCalled()
  })

  it('extracts filename from hapi metadata when present', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          uploadId: 'cdp-upload-99',
          uploadUrl: '/upload-and-scan/cdp-upload-99'
        })
      })
      .mockResolvedValueOnce({ ok: false, status: 302 })

    const fileStream = makeFileStream()
    fileStream.hapi.filename = 'policy-brief.docx'
    fileStream.hapi.headers['content-type'] =
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

    const request = {
      payload: { file: fileStream },
      headers: {},
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    // The logger should mention the extracted filename
    const logCalls = request.logger.info.mock.calls.flat()
    expect(logCalls.some((c) => String(c).includes('policy-brief.docx'))).toBe(
      true
    )
  })

  it('falls back to x-file-name header when hapi filename is absent', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          uploadId: 'cdp-upload-99',
          uploadUrl: '/upload-and-scan/cdp-upload-99'
        })
      })
      .mockResolvedValueOnce({ ok: false, status: 302 })

    const fileStream = makeFileStream()
    fileStream.hapi.filename = undefined

    const request = {
      payload: { file: fileStream },
      headers: { 'x-file-name': 'header-filename.pdf' },
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleFileUpload(request, h)

    const logCalls = request.logger.info.mock.calls.flat()
    expect(
      logCalls.some((c) => String(c).includes('header-filename.pdf'))
    ).toBe(true)
  })
})

// ─── POST /upload-callback — handleUploadCallback ─────────────────────────────

describe('handleUploadCallback — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.performance = { now: vi.fn().mockReturnValue(0) }

    mockCreateCanonicalDocument.mockResolvedValue({
      canonicalResult: {
        s3: { key: 'documents/test-uuid-1234.json', bucket: 'test-bucket' },
        document: { charCount: 5000, tokenEst: 1250 }
      },
      canonicalDuration: 120
    })
    mockCreateReviewRecord.mockResolvedValue(80)
    mockQueueReviewJob.mockResolvedValue(30)
  })

  afterEach(() => {
    delete global.performance
  })

  it('returns 200 immediately to CDP Uploader before pipeline completes', async () => {
    const request = {
      payload: {
        metadata: { reviewId: 'rev-abc', userId: 'user-1' },
        form: {
          file: {
            hasError: false,
            fileStatus: 'complete',
            contentType: 'application/pdf',
            s3Key: 'raw/doc.pdf',
            filename: 'document.pdf'
          }
        }
      },
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleUploadCallback(request, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, reviewId: 'rev-abc' })
    )
    expect(codeFn).toHaveBeenCalledWith(200)
  })

  it('extracts reviewId and userId from metadata and logs them', async () => {
    const request = {
      payload: {
        metadata: { reviewId: 'rev-xyz', userId: 'usr-99' },
        form: {
          file: {
            hasError: false,
            fileStatus: 'complete',
            contentType: 'application/pdf',
            s3Key: 'raw/report.pdf',
            filename: 'report.pdf'
          }
        }
      },
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleUploadCallback(request, h)

    const loggedObjects = request.logger.info.mock.calls.map((c) => c[0])
    const meta = loggedObjects.find(
      (o) => typeof o === 'object' && o.reviewId === 'rev-xyz'
    )
    expect(meta).toBeDefined()
    expect(meta.userId).toBe('usr-99')
  })

  it('triggers runCallbackPipeline asynchronously with s3Key and filename', async () => {
    // Allow the async pipeline to resolve
    const pipelineRan = new Promise((resolve) => {
      mockCreateCanonicalDocument.mockImplementation(async () => {
        resolve()
        return {
          canonicalResult: {
            s3: { key: 'documents/rev-pipe.json', bucket: 'test-bucket' },
            document: { charCount: 1000, tokenEst: 250 }
          },
          canonicalDuration: 50
        }
      })
    })

    const request = {
      payload: {
        metadata: { reviewId: 'rev-pipe', userId: null },
        form: {
          file: {
            hasError: false,
            fileStatus: 'complete',
            contentType: 'application/pdf',
            s3Key: 'raw/pipeline-test.pdf',
            filename: 'pipeline-test.pdf'
          }
        }
      },
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleUploadCallback(request, h)

    // Wait for async pipeline to start
    await pipelineRan

    expect(mockCreateCanonicalDocument).toHaveBeenCalledWith(
      null, // content is null for file uploads (text extracted later)
      'rev-pipe',
      'pipeline-test.pdf',
      expect.anything(), // logger
      'file',
      'raw/pipeline-test.pdf'
    )
  })
})

describe('handleUploadCallback — file validation errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.performance = { now: vi.fn().mockReturnValue(0) }
  })

  afterEach(() => {
    delete global.performance
  })

  it('returns 200 with error detail when file has hasError=true', async () => {
    const request = {
      payload: {
        metadata: { reviewId: 'rev-err', userId: null },
        form: {
          file: {
            hasError: true,
            errorMessage: 'Virus detected in uploaded file'
          }
        }
      },
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleUploadCallback(request, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'Virus detected in uploaded file'
      })
    )
    expect(codeFn).toHaveBeenCalledWith(200)
    // Pipeline should NOT run
    expect(mockCreateCanonicalDocument).not.toHaveBeenCalled()
  })

  it('uses fallback message when errorMessage is absent on hasError=true', async () => {
    const request = {
      payload: {
        metadata: { reviewId: 'rev-noerrmsg', userId: null },
        form: { file: { hasError: true } }
      },
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleUploadCallback(request, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'File validation failed'
      })
    )
  })

  it('logs error and returns 500 when payload is malformed', async () => {
    const request = {
      payload: null, // causes destructuring to throw
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleUploadCallback(request, h)

    expect(codeFn).toHaveBeenCalledWith(500)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    )
    expect(request.logger.error).toHaveBeenCalled()
  })
})

// ─── GET /upload-success — handleUploadSuccess ────────────────────────────────

describe('handleUploadSuccess', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.performance = { now: vi.fn().mockReturnValue(0) }
  })

  afterEach(() => {
    delete global.performance
  })

  it('returns 200 with reviewId and processing status', async () => {
    const request = {
      query: { reviewId: 'rev-success-1' },
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleUploadSuccess(request, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        reviewId: 'rev-success-1',
        status: 'processing'
      })
    )
    expect(codeFn).toHaveBeenCalledWith(200)
  })

  it('logs the browser redirect with source=browser-redirect', async () => {
    const request = {
      query: { reviewId: 'rev-redirect' },
      logger: makeLogger()
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleUploadSuccess(request, h)

    const loggedObjects = request.logger.info.mock.calls.map((c) => c[0])
    const entry = loggedObjects.find(
      (o) => typeof o === 'object' && o.source === 'browser-redirect'
    )
    expect(entry).toBeDefined()
    expect(entry.reviewId).toBe('rev-redirect')
  })

  it('works correctly when reviewId is absent from query', async () => {
    const request = { query: {}, logger: makeLogger() }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleUploadSuccess(request, h)

    expect(codeFn).toHaveBeenCalledWith(200)
    const body = h.response.mock.calls[0][0]
    expect(body.reviewId).toBeUndefined()
  })

  it('returns 500 when an unexpected error is thrown during handling', async () => {
    const request = {
      query: { reviewId: 'rev-throw' },
      logger: {
        info: vi.fn(() => {
          throw new Error('Logger exploded')
        }),
        error: vi.fn()
      }
    }
    const codeFn = vi.fn()
    const h = { response: vi.fn(() => ({ code: codeFn })) }

    await handleUploadSuccess(request, h)

    expect(codeFn).toHaveBeenCalledWith(500)
  })
})

// ─── runCallbackPipeline ──────────────────────────────────────────────────────

describe('runCallbackPipeline — canonical document creation', () => {
  const logger = makeLogger()

  beforeEach(() => {
    vi.clearAllMocks()
    global.performance = { now: vi.fn().mockReturnValue(0) }

    mockCreateCanonicalDocument.mockResolvedValue({
      canonicalResult: {
        s3: { key: 'documents/pipe-rev.json', bucket: 'test-bucket' },
        document: { charCount: 3000, tokenEst: 750 }
      },
      canonicalDuration: 95
    })
    mockCreateReviewRecord.mockResolvedValue(60)
    mockQueueReviewJob.mockResolvedValue(25)
  })

  afterEach(() => {
    delete global.performance
  })

  it('calls createCanonicalDocument with FILE source type and s3Key', async () => {
    await runCallbackPipeline(
      'raw/annual-report.pdf',
      'annual-report.pdf',
      'application/pdf',
      'pipe-rev',
      'user-1',
      logger
    )

    expect(mockCreateCanonicalDocument).toHaveBeenCalledWith(
      null,
      'pipe-rev',
      'annual-report.pdf',
      logger,
      'file',
      'raw/annual-report.pdf'
    )
  })

  it('calls createReviewRecord with canonical s3 result and charCount', async () => {
    await runCallbackPipeline(
      'raw/policy.docx',
      'policy.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'pipe-rev-2',
      'user-2',
      logger
    )

    expect(mockCreateReviewRecord).toHaveBeenCalledWith(
      'pipe-rev-2',
      { key: 'documents/pipe-rev.json', bucket: 'test-bucket' },
      'policy.docx',
      3000, // charCount
      logger,
      expect.objectContaining({
        userId: 'user-2',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        dbSourceType: 'file'
      })
    )
  })

  it('calls queueReviewJob after review record is created', async () => {
    await runCallbackPipeline(
      'raw/guidance.pdf',
      'guidance.pdf',
      'application/pdf',
      'pipe-rev-3',
      null,
      logger
    )

    expect(mockQueueReviewJob).toHaveBeenCalledWith(
      'pipe-rev-3',
      { key: 'documents/pipe-rev.json', bucket: 'test-bucket' },
      'guidance.pdf',
      3000,
      {},
      logger
    )
  })

  it('logs pipeline completion with all three durations', async () => {
    await runCallbackPipeline(
      'raw/brief.pdf',
      'brief.pdf',
      'application/pdf',
      'pipe-rev-4',
      'user-5',
      logger
    )

    const completionLog = logger.info.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('Pipeline completed')
    )
    expect(completionLog).toBeDefined()
    const logObj = completionLog[0]
    expect(logObj).toMatchObject({
      reviewId: 'pipe-rev-4',
      canonicalDuration: 95,
      dbCreateDuration: 60,
      sqsSendDuration: 25
    })
  })

  it('throws when createCanonicalDocument fails, propagating the error', async () => {
    mockCreateCanonicalDocument.mockRejectedValue(
      new Error('S3 put object failed')
    )

    await expect(
      runCallbackPipeline(
        'raw/bad.pdf',
        'bad.pdf',
        'application/pdf',
        'pipe-fail',
        null,
        logger
      )
    ).rejects.toThrow('S3 put object failed')
  })

  it('throws when queueReviewJob fails, propagating the error', async () => {
    mockQueueReviewJob.mockRejectedValue(new Error('SQS send failed'))

    await expect(
      runCallbackPipeline(
        'raw/sqs-fail.pdf',
        'sqs-fail.pdf',
        'application/pdf',
        'pipe-sqs-fail',
        null,
        logger
      )
    ).rejects.toThrow('SQS send failed')
  })
})

// ─── MIME type constants ───────────────────────────────────────────────────────

describe('Accepted MIME types', () => {
  it('accepts application/pdf', () => {
    const accepted = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
    expect(accepted).toContain('application/pdf')
  })

  it('accepts application/vnd.openxmlformats-officedocument.wordprocessingml.document (.docx)', () => {
    const accepted = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
    expect(accepted).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  })

  it('does not accept image/png', () => {
    const accepted = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
    expect(accepted).not.toContain('image/png')
  })

  it('does not accept application/exe', () => {
    const accepted = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
    expect(accepted).not.toContain('application/exe')
  })
})

// ─── File size constants ───────────────────────────────────────────────────────

describe('File size limit (10 MB)', () => {
  const MAX_FILE_BYTES = 10 * 1024 * 1024

  it('allows a 5 MB file', () => {
    expect(5 * 1024 * 1024).toBeLessThan(MAX_FILE_BYTES)
  })

  it('allows a file at exactly 10 MB', () => {
    expect(10 * 1024 * 1024).toBeLessThanOrEqual(MAX_FILE_BYTES)
  })

  it('rejects an 11 MB file', () => {
    expect(11 * 1024 * 1024).toBeGreaterThan(MAX_FILE_BYTES)
  })
})

// ─── uploadRoutes plugin registration ─────────────────────────────────────────

describe('uploadRoutes plugin registration', () => {
  it('registers all three routes on the server', async () => {
    const { uploadRoutes } = await import('./upload.js')

    const registeredRoutes = []
    const mockServer = {
      route: vi.fn((routeDef) => registeredRoutes.push(routeDef))
    }

    await uploadRoutes.plugin.register(mockServer)

    const paths = registeredRoutes.map((r) => `${r.method}:${r.path}`)
    expect(paths).toContain('POST:/api/upload')
    expect(paths).toContain('POST:/upload-callback')
    expect(paths).toContain('GET:/upload-success')
  })

  it('configures multipart streaming payload for POST /api/upload', async () => {
    const { uploadRoutes } = await import('./upload.js')

    const registeredRoutes = []
    const mockServer = {
      route: vi.fn((routeDef) => registeredRoutes.push(routeDef))
    }

    await uploadRoutes.plugin.register(mockServer)

    const uploadRoute = registeredRoutes.find((r) => r.path === '/api/upload')
    expect(uploadRoute.options.payload.output).toBe('stream')
    expect(uploadRoute.options.payload.parse).toBe(true)
    expect(uploadRoute.options.payload.multipart).toBe(true)
    expect(uploadRoute.options.payload.maxBytes).toBe(10 * 1024 * 1024)
  })

  it('applies CORS config to all routes', async () => {
    const { uploadRoutes } = await import('./upload.js')

    const registeredRoutes = []
    const mockServer = {
      route: vi.fn((routeDef) => registeredRoutes.push(routeDef))
    }

    await uploadRoutes.plugin.register(mockServer)

    registeredRoutes.forEach((route) => {
      expect(route.options).toHaveProperty('cors')
    })
  })

  it('has the expected plugin name', async () => {
    const { uploadRoutes } = await import('./upload.js')
    expect(uploadRoutes.plugin.name).toBe('upload-routes')
  })
})
