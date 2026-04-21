import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'test-review-id')
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn()
}))

vi.mock('../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const configMap = {
        serverUrl: 'http://localhost:3000',
        's3.rawS3Path': '/raw',
        's3.bucket': 'test-bucket',
        'cdpUploader.url': 'http://cdp-uploader:3002'
      }
      return configMap[key] ?? null
    })
  }
}))

vi.mock('../common/helpers/canonical-document.js', () => ({
  SOURCE_TYPES: { FILE: 'file' }
}))

vi.mock('./review-helpers.js', () => ({
  HTTP_STATUS: {
    ACCEPTED: 202,
    OK: 200,
    BAD_REQUEST: 400,
    INTERNAL_SERVER_ERROR: 500
  },
  REVIEW_STATUSES: { PENDING: 'pending' },
  getCorsConfig: vi.fn(() => ({})),
  createCanonicalDocument: vi.fn(),
  createReviewRecord: vi.fn(),
  queueReviewJob: vi.fn()
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { uploadRoutes } from './upload.js'
import { readFile } from 'node:fs/promises'
import { config } from '../config.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const REVIEW_ID = 'test-review-id'
const UPLOAD_ID = 'up-123'
const UPLOAD_URL_PATH = '/upload-and-scan/up-123'
const CDP_UPLOADER_BASE = 'http://cdp-uploader:3002'
const FILE_PATH = '/tmp/test.pdf'
const PDF_FILENAME = 'test.pdf'
const PDF_CONTENT_TYPE = 'application/pdf'
const HTTP_200 = 200
const HTTP_202 = 202
const HTTP_400 = 400
const HTTP_500 = 500
const PATH_UPLOAD = '/api/upload'
const PATH_CALLBACK = '/upload-callback'
const PATH_SUCCESS = '/upload-success'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getHandlers() {
  const routes = []
  const server = { route: vi.fn((r) => routes.push(r)) }
  await uploadRoutes.plugin.register(server)
  return {
    fileUpload: routes.find((r) => r.path === PATH_UPLOAD).handler,
    callback: routes.find((r) => r.path === PATH_CALLBACK).handler,
    success: routes.find((r) => r.path === PATH_SUCCESS).handler
  }
}

function createMockH() {
  const res = { code: vi.fn().mockReturnThis() }
  return { response: vi.fn(() => res), _res: res }
}

function createLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}

function createFileRequest() {
  return {
    payload: {
      file: {
        hapi: {
          filename: PDF_FILENAME,
          headers: { 'content-type': PDF_CONTENT_TYPE }
        },
        path: FILE_PATH
      }
    },
    headers: { 'x-user-id': 'user-1' },
    logger: createLogger()
  }
}

const defaultConfigImpl = (key) =>
  ({
    serverUrl: 'http://localhost:3000',
    's3.rawS3Path': '/raw',
    's3.bucket': 'test-bucket',
    'cdpUploader.url': CDP_UPLOADER_BASE
  })[key] ?? null

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(config.get).mockImplementation(defaultConfigImpl)
})

afterEach(() => {
  delete globalThis.fetch
})

// ── Plugin registration ───────────────────────────────────────────────────────

describe('uploadRoutes plugin', () => {
  it('exports a plugin named upload-routes', () => {
    expect(uploadRoutes.plugin.name).toBe('upload-routes')
  })

  it('registers three routes on the server', async () => {
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    await uploadRoutes.plugin.register(server)
    expect(server.route).toHaveBeenCalledTimes(3)
    expect(routes.some((r) => r.path === PATH_UPLOAD)).toBe(true)
    expect(routes.some((r) => r.path === PATH_CALLBACK)).toBe(true)
    expect(routes.some((r) => r.path === PATH_SUCCESS)).toBe(true)
  })
})

// ── handleFileUpload ─────────────────────────────────────────────────────────

describe('handleFileUpload — no file → 400', () => {
  it('returns 400 when payload.file is null', async () => {
    const { fileUpload } = await getHandlers()
    const req = { payload: { file: null }, headers: {}, logger: createLogger() }
    const h = createMockH()

    await fileUpload(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'No file provided' })
    )
    expect(h._res.code).toHaveBeenCalledWith(HTTP_400)
  })
})

describe('handleFileUpload — CDP_UPLOADER not configured → 500', () => {
  it('returns 500 when cdpUploader.url is empty', async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from('pdf content'))
    vi.mocked(config.get).mockImplementation((key) =>
      key === 'cdpUploader.url' ? '' : defaultConfigImpl(key)
    )

    const { fileUpload } = await getHandlers()
    const h = createMockH()

    await fileUpload(createFileRequest(), h)

    expect(h._res.code).toHaveBeenCalledWith(HTTP_500)
  })
})

describe('handleFileUpload — /initiate non-ok response → 500', () => {
  it('returns 500 when CDP Uploader /initiate returns an error status', async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from('content'))
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue('Service Unavailable')
    })

    const { fileUpload } = await getHandlers()
    const h = createMockH()

    await fileUpload(createFileRequest(), h)

    expect(h._res.code).toHaveBeenCalledWith(HTTP_500)
  })
})

describe('handleFileUpload — missing uploadUrl → 500', () => {
  it('returns 500 when /initiate response has no uploadUrl', async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from('content'))
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ uploadId: UPLOAD_ID }) // no uploadUrl
    })

    const { fileUpload } = await getHandlers()
    const h = createMockH()

    await fileUpload(createFileRequest(), h)

    expect(h._res.code).toHaveBeenCalledWith(HTTP_500)
  })
})

describe('handleFileUpload — successful upload → 202', () => {
  it('returns 202 with reviewId when initiate and upload both succeed', async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from('pdf content'))
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          uploadId: UPLOAD_ID,
          uploadUrl: UPLOAD_URL_PATH
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 302,
        url: `${CDP_UPLOADER_BASE}/upload-success`
      })

    const { fileUpload } = await getHandlers()
    const h = createMockH()

    await fileUpload(createFileRequest(), h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        reviewId: REVIEW_ID,
        status: 'pending'
      })
    )
    expect(h._res.code).toHaveBeenCalledWith(HTTP_202)
  })
})

describe('handleFileUpload — /upload-and-scan non-ok response → 500', () => {
  it('returns 500 when CDP Uploader /upload-and-scan returns an error status', async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from('pdf content'))
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          uploadId: UPLOAD_ID,
          uploadUrl: UPLOAD_URL_PATH
        })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: vi.fn().mockResolvedValue('Bad Request')
      })

    const { fileUpload } = await getHandlers()
    const h = createMockH()

    await fileUpload(createFileRequest(), h)

    expect(h._res.code).toHaveBeenCalledWith(HTTP_500)
  })
})

describe('handleFileUpload — /upload-and-scan fetch throws → 500', () => {
  it('returns 500 when the /upload-and-scan fetch rejects', async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from('pdf content'))
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          uploadId: UPLOAD_ID,
          uploadUrl: UPLOAD_URL_PATH
        })
      })
      .mockRejectedValueOnce(new Error('Network failure'))

    const { fileUpload } = await getHandlers()
    const h = createMockH()

    await fileUpload(createFileRequest(), h)

    expect(h._res.code).toHaveBeenCalledWith(HTTP_500)
  })
})

// ── handleUploadCallback ──────────────────────────────────────────────────────

describe('handleUploadCallback — file has no error → 200', () => {
  it('returns 200 with success when file is clean', async () => {
    const { callback } = await getHandlers()
    const req = {
      payload: {
        uploadStatus: 'ready',
        metadata: { reviewId: REVIEW_ID },
        form: { file: { hasError: false } },
        numberOfRejectedFiles: 0
      },
      logger: createLogger()
    }
    const h = createMockH()

    await callback(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, reviewId: REVIEW_ID })
    )
    expect(h._res.code).toHaveBeenCalledWith(HTTP_200)
  })
})

describe('handleUploadCallback — fileField.hasError true → 200 with error', () => {
  it('returns 200 with error message when file was rejected by scanner', async () => {
    const { callback } = await getHandlers()
    const req = {
      payload: {
        uploadStatus: 'ready',
        metadata: { reviewId: REVIEW_ID },
        form: {
          file: { hasError: true, errorMessage: 'File rejected by scanner' }
        },
        numberOfRejectedFiles: 1
      },
      logger: createLogger()
    }
    const h = createMockH()

    await callback(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'File rejected by scanner'
      })
    )
    expect(h._res.code).toHaveBeenCalledWith(HTTP_200)
  })

  it('uses fallback message when errorMessage is absent', async () => {
    const { callback } = await getHandlers()
    const req = {
      payload: {
        uploadStatus: 'ready',
        metadata: { reviewId: REVIEW_ID },
        form: { file: { hasError: true } },
        numberOfRejectedFiles: 1
      },
      logger: createLogger()
    }
    const h = createMockH()

    await callback(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    )
    expect(h._res.code).toHaveBeenCalledWith(HTTP_200)
  })
})

describe('handleUploadCallback — null payload throws → 500', () => {
  it('returns 500 when payload is null and destructuring throws', async () => {
    const { callback } = await getHandlers()
    const req = { payload: null, logger: createLogger() }
    const h = createMockH()

    await callback(req, h)

    expect(h._res.code).toHaveBeenCalledWith(HTTP_500)
  })
})

// ── handleUploadSuccess ───────────────────────────────────────────────────────

describe('handleUploadSuccess — success → 200', () => {
  it('returns 200 with reviewId from query string', async () => {
    const { success } = await getHandlers()
    const req = { query: { reviewId: REVIEW_ID }, logger: createLogger() }
    const h = createMockH()

    await success(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, reviewId: REVIEW_ID })
    )
    expect(h._res.code).toHaveBeenCalledWith(HTTP_200)
  })
})

describe('handleUploadSuccess — null query throws → 500', () => {
  it('returns 500 when request.query is null and handler throws', async () => {
    const { success } = await getHandlers()
    const req = { query: null, logger: createLogger() }
    const h = createMockH()

    await success(req, h)

    expect(h._res.code).toHaveBeenCalledWith(HTTP_500)
  })
})
