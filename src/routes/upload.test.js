import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'

// ── Mocks must be hoisted above imports ─────────────────────────────────────

vi.mock('../config.js', () => ({
  config: { get: vi.fn(() => 100000) }
}))

vi.mock('../common/helpers/text-extractor.js', () => ({
  textExtractor: { extractText: vi.fn() }
}))

vi.mock('../common/helpers/canonical-document.js', () => ({
  SOURCE_TYPES: { FILE: 'file', URL: 'url', TEXT: 'text' },
  canonicalDocumentStore: { createCanonicalDocument: vi.fn() }
}))

vi.mock('../common/helpers/review-repository.js', () => ({
  reviewRepository: {
    createReview: vi.fn(),
    getReview: vi.fn(),
    getAllReviews: vi.fn(),
    getReviewCount: vi.fn(),
    deleteReview: vi.fn()
  }
}))

vi.mock('../common/helpers/sqs-client.js', () => ({
  sqsClient: { sendMessage: vi.fn() }
}))

vi.mock('../common/helpers/s3-uploader.js', () => ({
  s3Uploader: { uploadTextContent: vi.fn() }
}))

vi.mock('./review-helpers.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getCorsConfig: vi.fn(() => ({ origin: ['*'], credentials: true })),
    uploadTextToS3: vi.fn(),
    createCanonicalDocument: vi.fn(),
    createReviewRecord: vi.fn(),
    queueReviewJob: vi.fn()
  }
})

// ── Imports after mocks ──────────────────────────────────────────────────────

import { config } from '../config.js'
import { textExtractor } from '../common/helpers/text-extractor.js'
import {
  getCorsConfig,
  uploadTextToS3,
  createCanonicalDocument,
  createReviewRecord,
  queueReviewJob,
  HTTP_STATUS,
  REVIEW_STATUSES
} from './review-helpers.js'
import { uploadRoutes, streamToBuffer } from './upload.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides
  }
}

/**
 * Build a minimal Hapi multipart file field (Readable stream with .hapi metadata).
 */
function makeHapiFile({
  content = 'PDF content',
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

function getHandler() {
  const routes = []
  const server = { route: vi.fn((r) => routes.push(r)) }
  uploadRoutes.plugin.register(server)
  return routes[0]?.handler
}

function makeDefaultPipelineSuccess() {
  uploadTextToS3.mockResolvedValue({
    s3Result: { key: 's3-key', bucket: 'bucket', location: 'loc' },
    s3UploadDuration: 10
  })
  createCanonicalDocument.mockResolvedValue({
    canonicalResult: { s3: { key: 'canon-key' }, document: {} },
    canonicalDuration: 5
  })
  createReviewRecord.mockResolvedValue(3)
  queueReviewJob.mockResolvedValue(7)
}

// ── beforeEach ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks()
  getCorsConfig.mockReturnValue({ origin: ['*'], credentials: true })
  config.get.mockReturnValue(100000)
  textExtractor.extractText.mockResolvedValue('Extracted text content')
  makeDefaultPipelineSuccess()
})

// ── Plugin shape ─────────────────────────────────────────────────────────────

describe('uploadRoutes plugin', () => {
  it('exports a hapi plugin named upload-routes', () => {
    expect(uploadRoutes.plugin.name).toBe('upload-routes')
    expect(typeof uploadRoutes.plugin.register).toBe('function')
  })

  it('registers one route at POST /api/upload', () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    uploadRoutes.plugin.register(server)
    expect(routes).toHaveLength(1)
    expect(routes[0].method).toBe('POST')
    expect(routes[0].path).toBe('/api/upload')
  })

  it('configures multipart stream payload', () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    uploadRoutes.plugin.register(server)
    expect(routes[0].options.payload).toMatchObject({
      output: 'stream',
      parse: true,
      multipart: true
    })
  })
})

// ── streamToBuffer ────────────────────────────────────────────────────────────

describe('streamToBuffer', () => {
  it('collects stream chunks into a single Buffer', async () => {
    const stream = Readable.from([Buffer.from('hello '), Buffer.from('world')])
    const buf = await streamToBuffer(stream)
    expect(buf.toString()).toBe('hello world')
  })

  it('rejects when the stream emits an error', async () => {
    const stream = new Readable({ read() {} })
    const promise = streamToBuffer(stream)
    stream.emit('error', new Error('stream error'))
    await expect(promise).rejects.toThrow('stream error')
  })
})

// ── handleFileUpload — missing / malformed file ───────────────────────────────

describe('handleFileUpload — missing file', () => {
  it('returns 400 when payload has no file field', async () => {
    const handler = getHandler()
    const req = createMockRequest({ payload: {} })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'No file provided' })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })

  it('returns 400 when file field exists but has no hapi metadata', async () => {
    const handler = getHandler()
    const req = createMockRequest({ payload: { file: {} } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'No file provided' })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })
})

// ── handleFileUpload — file type validation ───────────────────────────────────

describe('handleFileUpload — file type validation', () => {
  it('returns 400 for unsupported MIME type and extension', async () => {
    const handler = getHandler()
    const file = makeHapiFile({ filename: 'image.png', mimeType: 'image/png' })
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'The selected file must be a PDF or Word document'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })

  it('accepts a file with a valid MIME type even without a recognised extension', async () => {
    const handler = getHandler()
    const file = makeHapiFile({
      filename: 'report',
      mimeType: 'application/pdf'
    })
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.ACCEPTED)
  })

  it('accepts a file with a valid extension even with an unrecognised MIME type', async () => {
    const handler = getHandler()
    const file = makeHapiFile({
      filename: 'report.docx',
      mimeType: 'application/octet-stream'
    })
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.ACCEPTED)
  })
})

// ── handleFileUpload — buffer validation ──────────────────────────────────────

describe('handleFileUpload — buffer validation', () => {
  it('returns 400 when the uploaded file is empty', async () => {
    const handler = getHandler()
    const file = makeHapiFile({ content: '' })
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'The uploaded file is empty'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })

  it('returns 400 when the file exceeds 10 MB', async () => {
    const handler = getHandler()
    // Build a stream whose content is slightly over the 10 MB limit
    const bigContent = Buffer.alloc(10 * 1024 * 1024 + 1, 'x')
    const stream = Readable.from([bigContent])
    stream.hapi = {
      filename: 'big.pdf',
      headers: { 'content-type': 'application/pdf' }
    }
    const req = createMockRequest({ payload: { file: stream } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'The file must be smaller than 10 MB'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })
})

// ── handleFileUpload — text extraction ───────────────────────────────────────

describe('handleFileUpload — text extraction', () => {
  it('returns 400 when extractText returns empty string', async () => {
    textExtractor.extractText.mockResolvedValue('')
    const handler = getHandler()
    const file = makeHapiFile()
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'No text could be extracted from the file'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })

  it('returns 400 when extractText returns only whitespace', async () => {
    textExtractor.extractText.mockResolvedValue('   \n  ')
    const handler = getHandler()
    const file = makeHapiFile()
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })

  it('returns 400 when extractText returns null', async () => {
    textExtractor.extractText.mockResolvedValue(null)
    const handler = getHandler()
    const file = makeHapiFile()
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })
})

// ── handleFileUpload — successful pipeline ────────────────────────────────────

describe('handleFileUpload — successful upload', () => {
  it('returns 202 with reviewId and pending status', async () => {
    const handler = getHandler()
    const file = makeHapiFile()
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        status: REVIEW_STATUSES.PENDING,
        message: 'File uploaded and queued for review'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.ACCEPTED)
  })

  it('passes x-user-id header to createReviewRecord', async () => {
    const handler = getHandler()
    const file = makeHapiFile()
    const req = createMockRequest({
      payload: { file },
      headers: { 'x-user-id': 'user-123' }
    })
    const h = createMockH()

    await handler(req, h)

    expect(createReviewRecord).toHaveBeenCalledWith(
      expect.any(String), // reviewId
      expect.any(Object), // s3Result
      'report.pdf', // title
      expect.any(Number), // content.length
      expect.any(Object), // logger
      'user-123', // userId from header
      'application/pdf', // mimeType
      'file' // SOURCE_TYPE_FILE
    )
  })

  it('uses "Uploaded file" as title when filename is empty', async () => {
    const handler = getHandler()
    const file = makeHapiFile({ filename: '' })
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(uploadTextToS3).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'Uploaded file',
      expect.any(Object)
    )
  })

  it('truncates extracted text to maxCharLength', async () => {
    config.get.mockReturnValue(5)
    textExtractor.extractText.mockResolvedValue('ABCDEFGHIJ')
    const handler = getHandler()
    const file = makeHapiFile()
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    // uploadTextToS3 should receive the truncated content
    expect(uploadTextToS3).toHaveBeenCalledWith(
      'ABCDE',
      expect.any(String),
      expect.any(String),
      expect.any(Object)
    )
  })

  it('sets userId to null when x-user-id header is absent', async () => {
    const handler = getHandler()
    const file = makeHapiFile()
    const req = createMockRequest({ payload: { file }, headers: {} })
    const h = createMockH()

    await handler(req, h)

    expect(createReviewRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(String),
      expect.any(Number),
      expect.any(Object),
      null, // no x-user-id
      expect.any(String),
      'file'
    )
  })

  it('calls all four pipeline helpers in order', async () => {
    const handler = getHandler()
    const file = makeHapiFile()
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(uploadTextToS3).toHaveBeenCalledTimes(1)
    expect(createCanonicalDocument).toHaveBeenCalledTimes(1)
    expect(createReviewRecord).toHaveBeenCalledTimes(1)
    expect(queueReviewJob).toHaveBeenCalledTimes(1)
  })
})

// ── handleFileUpload — error handling ────────────────────────────────────────

describe('handleFileUpload — error handling', () => {
  it('returns 500 when uploadTextToS3 throws', async () => {
    uploadTextToS3.mockRejectedValue(new Error('S3 unavailable'))
    const handler = getHandler()
    const file = makeHapiFile()
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'S3 unavailable'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    )
  })

  it('returns 500 when createCanonicalDocument throws', async () => {
    createCanonicalDocument.mockRejectedValue(new Error('Canonical failed'))
    const handler = getHandler()
    const file = makeHapiFile()
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    )
  })

  it('returns 500 when queueReviewJob throws', async () => {
    queueReviewJob.mockRejectedValue(new Error('SQS down'))
    const handler = getHandler()
    const file = makeHapiFile()
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'SQS down' })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    )
  })

  it('returns 500 with fallback message when error has no message', async () => {
    uploadTextToS3.mockRejectedValue(new Error())
    const handler = getHandler()
    const file = makeHapiFile()
    const req = createMockRequest({ payload: { file } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'Failed to process file upload'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    )
  })
})
