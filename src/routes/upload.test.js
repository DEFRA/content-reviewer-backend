import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { uploadFileToCdpUploader, runPipeline, uploadRoutes } from './upload.js'

// ─── Mock all external dependencies ───────────────────────────────────────────

vi.mock('../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const map = {
        'cdpUploader.url': 'http://cdp-uploader',
        'cdpUploader.pollTimeoutMs': 100,
        'cdpUploader.pollIntervalMs': 10,
        's3.bucket': 'test-bucket'
      }
      return map[key]
    })
  }
}))

vi.mock('../common/helpers/canonical-document.js', () => ({
  SOURCE_TYPES: { FILE: 'file' }
}))

vi.mock('./review-helpers.js', () => ({
  HTTP_STATUS: {
    BAD_REQUEST: 400,
    ACCEPTED: 202,
    INTERNAL_SERVER_ERROR: 500
  },
  REVIEW_STATUSES: {
    PENDING: 'pending'
  },
  getCorsConfig: vi.fn(() => ({ origin: ['*'] })),
  createCanonicalDocument: vi.fn(),
  createReviewRecord: vi.fn(),
  queueReviewJob: vi.fn()
}))

// ─── Import mocked modules after vi.mock ──────────────────────────────────────
import {
  createCanonicalDocument,
  createReviewRecord,
  queueReviewJob
} from './review-helpers.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a mock Hapi response toolkit (h)
 */
function mockH() {
  const responseMock = {
    code: vi.fn().mockReturnThis()
  }
  return {
    response: vi.fn().mockReturnValue(responseMock),
    _response: responseMock
  }
}

/**
 * Creates a mock logger
 */
function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}

/**
 * Creates a readable stream from a buffer or string
 */
function makeStream(content = 'hello') {
  return Readable.from([Buffer.from(content)])
}

/**
 * Creates a mock fetch response
 */
function mockFetchResponse(body, status = 200, ok = true) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body))
  }
}

/**
 * Creates a mock Hapi request for handleFileUpload
 */
function mockRequest(overrides = {}) {
  return {
    headers: {
      'Content-Type': 'multipart/form-data; boundary=----boundary123',
      'Content-Length': '1024',
      'x-user-id': 'user-123',
      ...overrides.headers
    },
    payload: makeStream('fake file content'),
    logger: mockLogger(),
    ...overrides
  }
}

/**
 * Default pipeline result returned by runPipeline mock
 */
function defaultPipelineResult() {
  return {
    s3Result: {
      bucket: 'test-bucket',
      key: 'uploads/upload-123/report.pdf',
      fileName: 'report.pdf',
      mimeType: 'application/pdf'
    },
    canonicalResult: {
      s3: { key: 'documents/review-abc.json', bucket: 'test-bucket' },
      document: { charCount: 1000 }
    },
    s3UploadDuration: 100,
    canonicalDuration: 50,
    dbCreateDuration: 20,
    sqsSendDuration: 10
  }
}

// ─── uploadFileToCdpUploader ──────────────────────────────────────────────────

describe('uploadFileToCdpUploader', () => {
  let logger

  beforeEach(() => {
    logger = mockLogger()
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('performance', { now: vi.fn().mockReturnValue(0) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns bucket, key, fileName and mimeType on success', async () => {
    const initiateResponse = mockFetchResponse({
      uploadId: 'upload-123',
      uploadUrl: 'http://cdp-uploader/upload/upload-123',
      statusUrl: 'http://cdp-uploader/status/upload-123'
    })

    const uploadResponse = mockFetchResponse({}, 200, true)

    const statusResponse = mockFetchResponse({
      uploadStatus: 'ready',
      form: {
        file: {
          fileStatus: 'complete',
          s3Bucket: 'test-bucket',
          s3Key: 'uploads/upload-123/report.pdf',
          filename: 'report.pdf',
          detectedContentType: 'application/pdf',
          hasError: false
        }
      }
    })

    fetch
      .mockResolvedValueOnce(initiateResponse) // /initiate
      .mockResolvedValueOnce(uploadResponse) // performUpload
      .mockResolvedValueOnce(statusResponse) // fetchStatus poll

    const result = await uploadFileToCdpUploader(
      makeStream('pdf content'),
      'multipart/form-data; boundary=abc',
      logger
    )

    expect(result.bucket).toBe('test-bucket')
    expect(result.key).toBe('uploads/upload-123/report.pdf')
    expect(result.fileName).toBe('report.pdf')
  })

  it('throws when cdp-uploader base URL is not configured', async () => {
    const { config } = await import('../config.js')
    config.get.mockImplementation((key) => {
      if (key === 'cdpUploader.url') return ''
      return undefined
    })

    await expect(
      uploadFileToCdpUploader(makeStream(), 'multipart/form-data', logger)
    ).rejects.toThrow('cdp-uploader base URL not configured')

    // restore
    config.get.mockImplementation((key) => {
      const map = {
        'cdpUploader.url': 'http://cdp-uploader',
        'cdpUploader.pollTimeoutMs': 100,
        'cdpUploader.pollIntervalMs': 10,
        's3.bucket': 'test-bucket'
      }
      return map[key]
    })
  })

  it('throws when /initiate returns non-2xx', async () => {
    fetch.mockResolvedValueOnce(mockFetchResponse({}, 500, false))

    await expect(
      uploadFileToCdpUploader(makeStream(), 'multipart/form-data', logger)
    ).rejects.toThrow('cdp-uploader initiate failed: 500')
  })

  it('throws when /initiate does not return uploadUrl', async () => {
    fetch.mockResolvedValueOnce(
      mockFetchResponse({
        uploadId: 'upload-123',
        statusUrl: 'http://cdp-uploader/status/123'
      })
    )

    await expect(
      uploadFileToCdpUploader(makeStream(), 'multipart/form-data', logger)
    ).rejects.toThrow('cdp-uploader initiate did not return an uploadUrl')
  })

  it('throws when /initiate does not return statusUrl', async () => {
    fetch
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadId: 'upload-123',
          uploadUrl: 'http://cdp-uploader/upload/123'
        })
      )
      .mockResolvedValueOnce(mockFetchResponse({}, 200, true)) // performUpload

    await expect(
      uploadFileToCdpUploader(makeStream(), 'multipart/form-data', logger)
    ).rejects.toThrow('cdp-uploader initiate did not return an statusUrl')
  })

  it('throws when performUpload returns non-2xx', async () => {
    fetch
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadId: 'upload-123',
          uploadUrl: 'http://cdp-uploader/upload/123',
          statusUrl: 'http://cdp-uploader/status/123'
        })
      )
      .mockResolvedValueOnce(mockFetchResponse({}, 400, false)) // performUpload fails

    await expect(
      uploadFileToCdpUploader(makeStream(), 'multipart/form-data', logger)
    ).rejects.toThrow('Raw upload failed: 400')
  })

  it('throws when resolveS3Location hasError is true', async () => {
    fetch
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadId: 'upload-123',
          uploadUrl: 'http://cdp-uploader/upload/123',
          statusUrl: 'http://cdp-uploader/status/123'
        })
      )
      .mockResolvedValueOnce(mockFetchResponse({}, 200, true)) // performUpload
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadStatus: 'ready',
          form: {
            file: {
              fileStatus: 'rejected',
              hasError: true,
              errorMessage: 'File type not allowed'
            }
          }
        })
      )

    await expect(
      uploadFileToCdpUploader(makeStream(), 'multipart/form-data', logger)
    ).rejects.toThrow('File type not allowed')
  })

  it('throws with default message when hasError true but no errorMessage', async () => {
    fetch
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadId: 'upload-123',
          uploadUrl: 'http://cdp-uploader/upload/123',
          statusUrl: 'http://cdp-uploader/status/123'
        })
      )
      .mockResolvedValueOnce(mockFetchResponse({}, 200, true))
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadStatus: 'ready',
          form: {
            file: {
              fileStatus: 'rejected',
              hasError: true,
              errorMessage: null
            }
          }
        })
      )

    await expect(
      uploadFileToCdpUploader(makeStream(), 'multipart/form-data', logger)
    ).rejects.toThrow('Unknown error from cdp-uploader')
  })

  it('returns null bucket and key when pollStatus times out', async () => {
    fetch
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadId: 'upload-123',
          uploadUrl: 'http://cdp-uploader/upload/123',
          statusUrl: 'http://cdp-uploader/status/123'
        })
      )
      .mockResolvedValueOnce(mockFetchResponse({}, 200, true))
      // always return pending — never ready
      .mockResolvedValue(
        mockFetchResponse({
          uploadStatus: 'pending',
          form: { file: { fileStatus: 'pending', hasError: false } }
        })
      )

    const result = await uploadFileToCdpUploader(
      makeStream(),
      'multipart/form-data',
      logger
    )

    expect(result.bucket).toBeNull()
    expect(result.key).toBeNull()
  })
})

// ─── runPipeline ──────────────────────────────────────────────────────────────

describe('runPipeline', () => {
  let logger

  beforeEach(() => {
    logger = mockLogger()
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('performance', { now: vi.fn().mockReturnValue(0) })

    // Default happy path mocks
    fetch
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadId: 'upload-123',
          uploadUrl: 'http://cdp-uploader/upload/123',
          statusUrl: 'http://cdp-uploader/status/123'
        })
      )
      .mockResolvedValueOnce(mockFetchResponse({}, 200, true))
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadStatus: 'ready',
          form: {
            file: {
              fileStatus: 'complete',
              s3Bucket: 'test-bucket',
              s3Key: 'uploads/upload-123/report.pdf',
              filename: 'report.pdf',
              detectedContentType: 'application/pdf',
              hasError: false
            }
          }
        })
      )

    createCanonicalDocument.mockResolvedValue({
      canonicalResult: {
        s3: { key: 'documents/review-abc.json', bucket: 'test-bucket' },
        document: { charCount: 1000 }
      },
      canonicalDuration: 50
    })

    createReviewRecord.mockResolvedValue(20)
    queueReviewJob.mockResolvedValue(10)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('returns full pipeline result on success', async () => {
    const result = await runPipeline(
      makeStream('pdf content'),
      'review-id-123',
      'multipart/form-data; boundary=abc',
      'user-123',
      { 'x-user-id': 'user-123' },
      logger
    )

    expect(result).toMatchObject({
      s3Result: expect.objectContaining({
        key: 'uploads/upload-123/report.pdf'
      }),
      canonicalResult: expect.objectContaining({
        s3: expect.objectContaining({ key: 'documents/review-abc.json' })
      }),
      s3UploadDuration: expect.any(Number),
      canonicalDuration: expect.any(Number),
      dbCreateDuration: expect.any(Number),
      sqsSendDuration: expect.any(Number)
    })
  })

  it('calls createCanonicalDocument with correct args', async () => {
    await runPipeline(
      makeStream(),
      'review-id-123',
      'multipart/form-data; boundary=abc',
      'user-123',
      {},
      logger
    )

    expect(createCanonicalDocument).toHaveBeenCalledWith(
      null,
      'review-id-123',
      'report.pdf',
      logger,
      'file',
      'uploads/upload-123/report.pdf'
    )
  })

  it('calls createReviewRecord with correct args', async () => {
    await runPipeline(
      makeStream(),
      'review-id-123',
      'multipart/form-data; boundary=abc',
      'user-123',
      {},
      logger
    )

    expect(createReviewRecord).toHaveBeenCalledWith(
      'review-id-123',
      expect.objectContaining({ key: 'documents/review-abc.json' }),
      'report.pdf',
      1000,
      logger,
      expect.objectContaining({
        userId: 'user-123',
        mimeType: 'application/pdf',
        dbSourceType: 'file'
      })
    )
  })

  it('calls queueReviewJob with correct args', async () => {
    await runPipeline(
      makeStream(),
      'review-id-123',
      'multipart/form-data; boundary=abc',
      'user-123',
      { 'x-user-id': 'user-123' },
      logger
    )

    expect(queueReviewJob).toHaveBeenCalledWith(
      'review-id-123',
      expect.objectContaining({ key: 'documents/review-abc.json' }),
      'report.pdf',
      1000,
      { 'x-user-id': 'user-123' },
      logger
    )
  })

  it('throws when uploadFileToCdpUploader fails', async () => {
    fetch.mockReset()
    fetch.mockResolvedValueOnce(mockFetchResponse({}, 500, false))

    await expect(
      runPipeline(
        makeStream(),
        'review-id-123',
        'multipart/form-data',
        'user-123',
        {},
        logger
      )
    ).rejects.toThrow('cdp-uploader initiate failed: 500')
  })

  it('throws when createCanonicalDocument fails', async () => {
    createCanonicalDocument.mockRejectedValueOnce(new Error('canonical failed'))

    await expect(
      runPipeline(
        makeStream(),
        'review-id-123',
        'multipart/form-data',
        'user-123',
        {},
        logger
      )
    ).rejects.toThrow('canonical failed')
  })

  it('throws when createReviewRecord fails', async () => {
    createReviewRecord.mockRejectedValueOnce(new Error('db failed'))

    await expect(
      runPipeline(
        makeStream(),
        'review-id-123',
        'multipart/form-data',
        'user-123',
        {},
        logger
      )
    ).rejects.toThrow('db failed')
  })

  it('throws when queueReviewJob fails', async () => {
    queueReviewJob.mockRejectedValueOnce(new Error('sqs failed'))

    await expect(
      runPipeline(
        makeStream(),
        'review-id-123',
        'multipart/form-data',
        'user-123',
        {},
        logger
      )
    ).rejects.toThrow('sqs failed')
  })

  it('uses charCount 0 when canonicalResult has no charCount', async () => {
    createCanonicalDocument.mockResolvedValueOnce({
      canonicalResult: {
        s3: { key: 'documents/review-abc.json', bucket: 'test-bucket' },
        document: {} // no charCount
      },
      canonicalDuration: 50
    })

    await runPipeline(
      makeStream(),
      'review-id-123',
      'multipart/form-data',
      'user-123',
      {},
      logger
    )

    expect(createReviewRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(String),
      0, // ← charCount defaults to 0
      expect.any(Object),
      expect.any(Object)
    )
  })
})

// ─── handleFileUpload (via uploadRoutes) ─────────────────────────────────────

describe('handleFileUpload', () => {
  let handler
  let logger

  beforeEach(async () => {
    logger = mockLogger()
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('performance', { now: vi.fn().mockReturnValue(0) })

    // Extract handler from registered route
    const registeredRoutes = []
    const server = {
      route: vi.fn((routeConfig) => registeredRoutes.push(routeConfig))
    }
    await uploadRoutes.plugin.register(server)
    handler = registeredRoutes[0].handler
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('returns 202 on successful upload', async () => {
    // mock full happy path fetch calls
    fetch
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadId: 'upload-123',
          uploadUrl: 'http://cdp-uploader/upload/123',
          statusUrl: 'http://cdp-uploader/status/123'
        })
      )
      .mockResolvedValueOnce(mockFetchResponse({}, 200, true))
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadStatus: 'ready',
          form: {
            file: {
              fileStatus: 'complete',
              s3Bucket: 'test-bucket',
              s3Key: 'uploads/upload-123/report.pdf',
              filename: 'report.pdf',
              detectedContentType: 'application/pdf',
              hasError: false
            }
          }
        })
      )

    createCanonicalDocument.mockResolvedValue({
      canonicalResult: {
        s3: { key: 'documents/review-abc.json', bucket: 'test-bucket' },
        document: { charCount: 1000 }
      },
      canonicalDuration: 50
    })
    createReviewRecord.mockResolvedValue(20)
    queueReviewJob.mockResolvedValue(10)

    const h = mockH()
    const request = mockRequest()

    await handler(request, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        status: 'pending',
        message: 'File uploaded and queued for review'
      })
    )
    expect(h._response.code).toHaveBeenCalledWith(202)
  })

  it('returns 500 when runPipeline throws', async () => {
    fetch.mockResolvedValueOnce(mockFetchResponse({}, 500, false))

    const h = mockH()
    const request = mockRequest()

    await handler(request, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    )
    expect(h._response.code).toHaveBeenCalledWith(500)
  })

  it('returns 500 with error message from cdp-uploader rejection', async () => {
    fetch
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadId: 'upload-123',
          uploadUrl: 'http://cdp-uploader/upload/123',
          statusUrl: 'http://cdp-uploader/status/123'
        })
      )
      .mockResolvedValueOnce(mockFetchResponse({}, 200, true))
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadStatus: 'ready',
          form: {
            file: {
              fileStatus: 'rejected',
              hasError: true,
              errorMessage: 'File type not allowed'
            }
          }
        })
      )

    const h = mockH()
    const request = mockRequest()

    await handler(request, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'File type not allowed'
      })
    )
    expect(h._response.code).toHaveBeenCalledWith(500)
  })

  it('logs reviewId and contentType before pipeline starts', async () => {
    fetch.mockResolvedValueOnce(mockFetchResponse({}, 500, false))

    const h = mockH()
    const request = mockRequest()

    await handler(request, h)

    expect(request.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: 'multipart/form-data; boundary=----boundary123',
        fileName: null,
        fileSize: '1024',
        reviewId: expect.any(String)
      }),
      expect.any(String)
    )
  })

  it('uses null userId when x-user-id header is missing', async () => {
    fetch.mockResolvedValueOnce(mockFetchResponse({}, 500, false))

    const h = mockH()
    const request = mockRequest({
      headers: {
        'content-type': 'multipart/form-data; boundary=abc',
        'content-length': '1024'
        // no x-user-id
      }
    })

    await handler(request, h)
    // pipeline is called — error thrown from fetch — respondError called
    expect(h._response.code).toHaveBeenCalledWith(500)
  })
})

// ─── uploadRoutes plugin registration ────────────────────────────────────────

describe('uploadRoutes plugin', () => {
  it('registers a POST route at /api/upload', async () => {
    const registeredRoutes = []
    const server = {
      route: vi.fn((routeConfig) => registeredRoutes.push(routeConfig))
    }

    await uploadRoutes.plugin.register(server)

    expect(registeredRoutes).toHaveLength(1)
    expect(registeredRoutes[0].method).toBe('POST')
    expect(registeredRoutes[0].path).toBe('/api/upload')
  })

  it('has correct payload config', async () => {
    const registeredRoutes = []
    const server = {
      route: vi.fn((routeConfig) => registeredRoutes.push(routeConfig))
    }

    await uploadRoutes.plugin.register(server)

    const payload = registeredRoutes[0].options.payload
    expect(payload.output).toBe('stream')
    expect(payload.parse).toBe(false)
    expect(payload.multipart).toBe(false)
    expect(payload.maxBytes).toBe(10 * 1024 * 1024)
  })

  it('has plugin name upload-routes', () => {
    expect(uploadRoutes.plugin.name).toBe('upload-routes')
  })
})

// ─── fetchStatus ─────────────────────────────────────────────────────────────

describe('fetchStatus (via pollStatus via resolveS3Location)', () => {
  let logger

  beforeEach(() => {
    logger = mockLogger()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns null and warns on non-2xx status response', async () => {
    fetch
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadId: 'upload-123',
          uploadUrl: 'http://cdp-uploader/upload/123',
          statusUrl: 'http://cdp-uploader/status/123'
        })
      )
      .mockResolvedValueOnce(mockFetchResponse({}, 200, true))
      // status poll returns non-2xx — triggers null return and retry until timeout
      .mockResolvedValue(mockFetchResponse({}, 503, false))

    const result = await uploadFileToCdpUploader(
      makeStream(),
      'multipart/form-data',
      logger
    )

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503 }),
      'cdp-uploader status poll returned non-2xx'
    )
    expect(result.bucket).toBeNull()
  })

  it('handles invalid JSON in status response gracefully', async () => {
    fetch
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadId: 'upload-123',
          uploadUrl: 'http://cdp-uploader/upload/123',
          statusUrl: 'http://cdp-uploader/status/123'
        })
      )
      .mockResolvedValueOnce(mockFetchResponse({}, 200, true))
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new Error('invalid json')),
        text: vi.fn().mockResolvedValue('not json')
      })

    const result = await uploadFileToCdpUploader(
      makeStream(),
      'multipart/form-data',
      logger
    )
    expect(result.bucket).toBeNull()
  })
})

// ─── classifyFileStatus (via pollStatus behaviour) ───────────────────────────

describe('classifyFileStatus behaviour in pollStatus', () => {
  let logger

  beforeEach(() => {
    logger = mockLogger()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const setupInitiateAndUpload = () => {
    fetch
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadId: 'upload-123',
          uploadUrl: '/upload-and-scan/123',
          statusUrl: '/status/123'
        })
      )
      .mockResolvedValueOnce(mockFetchResponse({}, 200, true))
  }

  it('resolves when fileStatus is complete and uploadStatus is ready', async () => {
    setupInitiateAndUpload()
    fetch.mockResolvedValueOnce(
      mockFetchResponse({
        uploadStatus: 'ready',
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'bucket',
            s3Key: 'key/file.pdf',
            filename: 'file.pdf',
            detectedContentType: 'application/pdf',
            hasError: false
          }
        }
      })
    )

    const result = await uploadFileToCdpUploader(
      makeStream(),
      'multipart/form-data',
      logger
    )
    expect(result.key).toBe('key/file.pdf')
  })

  it('throws when fileStatus is rejected and hasError is true', async () => {
    setupInitiateAndUpload()
    fetch.mockResolvedValueOnce(
      mockFetchResponse({
        uploadStatus: 'ready',
        form: {
          file: {
            fileStatus: 'rejected',
            hasError: true,
            errorMessage: 'Virus detected'
          }
        }
      })
    )

    await expect(
      uploadFileToCdpUploader(makeStream(), 'multipart/form-data', logger)
    ).rejects.toThrow('Virus detected')
  })

  it('keeps polling when fileStatus is pending', async () => {
    setupInitiateAndUpload()

    // two pending then complete
    fetch
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadStatus: 'pending',
          form: { file: { fileStatus: 'pending', hasError: false } }
        })
      )
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadStatus: 'ready',
          form: {
            file: {
              fileStatus: 'complete',
              s3Bucket: 'bucket',
              s3Key: 'key/file.pdf',
              filename: 'file.pdf',
              detectedContentType: 'application/pdf',
              hasError: false
            }
          }
        })
      )

    const result = await uploadFileToCdpUploader(
      makeStream(),
      'multipart/form-data',
      logger
    )
    expect(result.key).toBe('key/file.pdf')
  })

  it('returns null bucket/key on timeout with no ready status', async () => {
    setupInitiateAndUpload()
    // always pending — times out
    fetch.mockResolvedValue(
      mockFetchResponse({
        uploadStatus: 'pending',
        form: { file: { fileStatus: 'pending', hasError: false } }
      })
    )

    const result = await uploadFileToCdpUploader(
      makeStream(),
      'multipart/form-data',
      logger
    )
    expect(result.bucket).toBeNull()
    expect(result.key).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ statusUrl: 'http://cdp-uploader/status/123' }),
      'Timed out waiting for cdp-uploader status'
    )
  })

  it('retries polling when fetchStatus throws a network error', async () => {
    setupInitiateAndUpload()

    fetch
      .mockRejectedValueOnce(new Error('network error')) // first poll throws
      .mockResolvedValueOnce(
        mockFetchResponse({
          uploadStatus: 'ready',
          form: {
            file: {
              fileStatus: 'complete',
              s3Bucket: 'bucket',
              s3Key: 'key/file.pdf',
              filename: 'file.pdf',
              detectedContentType: 'application/pdf',
              hasError: false
            }
          }
        })
      )

    const result = await uploadFileToCdpUploader(
      makeStream(),
      'multipart/form-data',
      logger
    )
    expect(result.key).toBe('key/file.pdf')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'network error' }),
      'Error polling cdp-uploader status (will retry)'
    )
  })
})
