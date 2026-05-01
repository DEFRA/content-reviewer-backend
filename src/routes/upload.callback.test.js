import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// ── Constants ──────────────────────────────────────────────────────────────
const HTTP_OK = 200
const HTTP_INTERNAL_SERVER_ERROR = 500

const ROUTE_CALLBACK = 'POST /upload-callback'

const CONTENT_TYPE_PDF = 'application/pdf'
const CONTENT_TYPE_DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const CONTENT_TYPE_TEXT = 'text/plain'
const S3_KEY_DEFAULT = 'some/key.pdf'
const FILENAME_PDF = 'document.pdf'
const FILENAME_DOC = 'doc.pdf'
const USER_ID = 'user1'
const MAX_REVIEW_CHARS = 100000

// ── Mock helpers ───────────────────────────────────────────────────────────
function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}

function makeCallbackRequest(reviewId, fileOverrides = {}) {
  return {
    payload: {
      metadata: { reviewId, userId: USER_ID },
      form: {
        file: {
          s3Key: S3_KEY_DEFAULT,
          filename: FILENAME_PDF,
          contentType: CONTENT_TYPE_PDF,
          hasError: false,
          ...fileOverrides
        }
      }
    },
    logger: makeLogger()
  }
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

const extractTextMock = vi.fn(async () => 'parsed-text')
vi.mock('../common/helpers/text-extractor.js', () => ({
  textExtractor: { extractText: extractTextMock }
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
  vi.stubGlobal(
    'fetch',
    vi.fn((url) => {
      if (String(url).endsWith('/initiate')) {
        return Promise.resolve({
          ok: true,
          status: HTTP_OK,
          json: async () => ({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        })
      }
      return Promise.resolve({
        ok: true,
        status: HTTP_OK,
        text: async () => ''
      })
    })
  )

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

it('returns 500 for unsupported text/plain file type', async () => {
  const req = makeCallbackRequest('review-1', {
    filename: 'plain.txt',
    contentType: CONTENT_TYPE_TEXT
  })
  const res = await storedRoutes[ROUTE_CALLBACK].handler(req, makeH())

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(res.payload).toMatchObject({ success: false })
  expect(String(res.payload.message)).toContain(
    'Unsupported file type for text extraction'
  )
})

it('returns 200 with success:false when fileField.hasError is truthy', async () => {
  const request = {
    payload: {
      metadata: { reviewId: 'review-2', userId: USER_ID },
      form: { file: { hasError: true, errorMessage: 'virus-detected' } }
    },
    logger: makeLogger()
  }
  const res = await storedRoutes[ROUTE_CALLBACK].handler(request, makeH())

  expect(res.statusCode).toBe(HTTP_OK)
  expect(res.payload).toMatchObject({
    success: false,
    message: 'virus-detected'
  })
})

it('fetches S3 object and parses PDF text successfully', async () => {
  extractTextMock.mockResolvedValueOnce('s3-pdf-extracted-text')
  const res = await storedRoutes[ROUTE_CALLBACK].handler(
    makeCallbackRequest('review-s3-pdf'),
    makeH()
  )

  expect(res.statusCode).toBe(HTTP_OK)
  expect(res.payload).toMatchObject({ success: true })
  expect(extractTextMock).toHaveBeenCalled()
})

it('parses DOCX buffer via text-extractor', async () => {
  extractTextMock.mockResolvedValueOnce('docx-extracted')
  const req = makeCallbackRequest('review-docx', {
    filename: 'doc.docx',
    contentType: CONTENT_TYPE_DOCX
  })
  const res = await storedRoutes[ROUTE_CALLBACK].handler(req, makeH())

  expect(res.statusCode).toBe(HTTP_OK)
  expect(res.payload).toMatchObject({ success: true })
  expect(extractTextMock).toHaveBeenCalled()
})

it('returns 500 when PDF parsing fails', async () => {
  extractTextMock.mockRejectedValueOnce(new Error('pdf-bad'))
  const req = makeCallbackRequest('review-bad-pdf', { filename: 'bad.pdf' })
  const res = await storedRoutes[ROUTE_CALLBACK].handler(req, makeH())

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(res.payload).toHaveProperty('success', false)
  expect(String(res.payload.message)).toContain('PDF parsing failed: pdf-bad')
})

it('returns 500 when file has local path only and no s3Key', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-test-'))
  const tmpFile = path.join(tmpDir, 'temp.pdf')
  await fs.writeFile(tmpFile, 'dummy-pdf-bytes')
  extractTextMock.mockResolvedValueOnce('local-pdf-text')

  const request = {
    payload: {
      metadata: { reviewId: 'review-local', userId: USER_ID },
      form: {
        file: {
          path: tmpFile,
          filename: 'temp.pdf',
          contentType: CONTENT_TYPE_PDF,
          hasError: false
        }
      }
    },
    logger: makeLogger()
  }
  const res = await storedRoutes[ROUTE_CALLBACK].handler(request, makeH())
  await fs.rm(tmpDir, { recursive: true, force: true })

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(res.payload).toMatchObject({ success: false })
})

it('returns 500 when payload is missing the form field', async () => {
  const request = {
    payload: { metadata: { reviewId: 'missing-form', userId: USER_ID } },
    logger: makeLogger()
  }
  const res = await storedRoutes[ROUTE_CALLBACK].handler(request, makeH())

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(res.payload).toHaveProperty('success', false)
})

it('starts async pipeline and calls createCanonicalDocument', async () => {
  extractTextMock.mockResolvedValueOnce('s3-pdf-extracted-text-small')

  const reviewHelpers = await import('./review-helpers.js')
  reviewHelpers.createCanonicalDocument.mockResolvedValueOnce({
    canonicalResult: { s3: 's3://bucket/key', document: { charCount: 22 } },
    canonicalDuration: 5
  })
  reviewHelpers.createReviewRecord.mockResolvedValueOnce(1)
  reviewHelpers.queueReviewJob.mockResolvedValueOnce(1)

  const res = await storedRoutes[ROUTE_CALLBACK].handler(
    makeCallbackRequest('review-pipeline'),
    makeH()
  )

  expect(res.statusCode).toBe(HTTP_OK)
  expect(res.payload).toMatchObject({ success: true })

  await new Promise((r) => setImmediate(r))

  expect(reviewHelpers.createCanonicalDocument).toHaveBeenCalled()
  const [, callReviewId, callFilename] =
    reviewHelpers.createCanonicalDocument.mock.calls[0]
  expect(callReviewId).toBe('review-pipeline')
  expect(callFilename).toBe(FILENAME_PDF)
})

it('truncates extracted text longer than MAX_REVIEW_CHARS before canonicalization', async () => {
  extractTextMock.mockResolvedValueOnce('a'.repeat(150000))

  const reviewHelpers = await import('./review-helpers.js')
  reviewHelpers.createCanonicalDocument.mockResolvedValueOnce({
    canonicalResult: {
      s3: 's3://b/k',
      document: { charCount: MAX_REVIEW_CHARS }
    },
    canonicalDuration: 1
  })
  reviewHelpers.createReviewRecord.mockResolvedValueOnce(1)
  reviewHelpers.queueReviewJob.mockResolvedValueOnce(1)

  const req = makeCallbackRequest('review-truncate', {
    filename: 'long.pdf',
    s3Key: 'some/long.pdf'
  })
  const res = await storedRoutes[ROUTE_CALLBACK].handler(req, makeH())

  expect(res.statusCode).toBe(HTTP_OK)
  await new Promise((r) => setImmediate(r))

  const passedText = reviewHelpers.createCanonicalDocument.mock.calls[0][0]
  expect(passedText.length).toBe(MAX_REVIEW_CHARS)
})

it('logs error when async pipeline rejects', async () => {
  extractTextMock.mockResolvedValueOnce('some-text')

  const reviewHelpers = await import('./review-helpers.js')
  reviewHelpers.createCanonicalDocument.mockRejectedValueOnce(
    new Error('pipeline-failure')
  )

  const logger = makeLogger()
  const res = await storedRoutes[ROUTE_CALLBACK].handler(
    { ...makeCallbackRequest('pipeline-fail'), logger },
    makeH()
  )

  expect(res.statusCode).toBe(HTTP_OK)
  await new Promise((r) => setImmediate(r))

  expect(logger.error).toHaveBeenCalledWith(
    expect.objectContaining({
      reviewId: 'pipeline-fail',
      error: 'pipeline-failure',
      stack: expect.any(String)
    }),
    '[CALLBACK] Async pipeline failed'
  )
})

it('returns 500 when S3 GetObject returns no Body', async () => {
  const { S3Client } = await import('@aws-sdk/client-s3')
  vi.spyOn(S3Client.prototype, 'send').mockResolvedValueOnce({ Body: null })

  const res = await storedRoutes[ROUTE_CALLBACK].handler(
    makeCallbackRequest('no-body-review'),
    makeH()
  )
  vi.restoreAllMocks()

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(String(res.payload.message)).toContain('S3 GetObject returned no Body')
})

it('returns 500 when S3 body stream throws during iteration', async () => {
  const { S3Client } = await import('@aws-sdk/client-s3')
  vi.spyOn(S3Client.prototype, 'send').mockResolvedValueOnce({
    Body: (async function* () {
      throw new Error('stream-read-error')
    })()
  })

  const res = await storedRoutes[ROUTE_CALLBACK].handler(
    makeCallbackRequest('stream-err-review'),
    makeH()
  )
  vi.restoreAllMocks()

  expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR)
  expect(String(res.payload.message)).toContain(
    'Failed to read S3 object body: stream-read-error'
  )
})
