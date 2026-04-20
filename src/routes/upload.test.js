import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Hapi from '@hapi/hapi'
import { uploadRoutes } from './upload.js'
import * as reviewHelpers from './review-helpers.js'
import { HTTP_STATUS, REVIEW_STATUSES } from './review-helpers.js'

// Mock review helpers
vi.mock('./review-helpers.js', () => ({
  HTTP_STATUS: {
    ACCEPTED: 202,
    OK: 200,
    BAD_REQUEST: 400,
    INTERNAL_SERVER_ERROR: 500
  },
  REVIEW_STATUSES: {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed'
  },
  getCorsConfig: vi.fn(() => ({})),
  createCanonicalDocument: vi.fn(),
  createReviewRecord: vi.fn(),
  queueReviewJob: vi.fn()
}))

// Mock config
vi.mock('../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const configMap = {
        serverUrl: 'http://localhost:3001',
        'cdpUploader.url': 'http://localhost:7337',
        's3.bucket': 'test-bucket',
        's3.rawS3Path': '/raw',
        isProduction: false
      }
      return configMap[key]
    })
  }
}))

// Mock canonical document helpers
vi.mock('../common/helpers/canonical-document.js', () => ({
  SOURCE_TYPES: {
    FILE: 'file'
  }
}))

// Mock logger
const mockLogger = () => ({
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn()
})

// Helper to mock fetch responses
const mockFetchResponse = (data = {}, status = 200, ok = true) => ({
  ok,
  status,
  statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
  json: vi.fn(async () => data),
  text: vi.fn(async () => JSON.stringify(data)),
  clone: vi.fn(() => mockFetchResponse(data, status, ok))
})

describe('Upload Routes - uploadRoutes plugin', () => {
  let server
  let logger

  beforeEach(async () => {
    logger = mockLogger()

    server = Hapi.server({
      host: 'localhost',
      port: 3000,
      debug: { request: false }
    })

    server.decorate('request', 'logger', logger)
    await server.register(uploadRoutes)

    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('performance', { now: vi.fn().mockReturnValue(100) })
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    if (server) {
      await server.stop()
    }
  })

  describe('POST /api/upload - handleFileUpload', () => {
    it('returns 202 Accepted when file is successfully uploaded', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      const response = await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      expect(response.statusCode).toBe(HTTP_STATUS.ACCEPTED)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(true)
      expect(body.reviewId).toBeDefined()
      expect(body.status).toBe(REVIEW_STATUSES.PENDING)
      expect(body.message).toContain('File uploaded')
    })

    it('generates a unique reviewId for each upload', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      const response1 = await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-124',
            uploadUrl: '/upload-and-scan/upload-124'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const response2 = await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document2.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      const body1 = JSON.parse(response1.payload)
      const body2 = JSON.parse(response2.payload)

      expect(body1.reviewId).not.toBe(body2.reviewId)
    })

    it('calls CDP Uploader /initiate endpoint with correct parameters', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      // Verify /initiate was called
      const initiateCalls = global.fetch.mock.calls.filter((call) =>
        call[0].includes('/initiate')
      )
      expect(initiateCalls.length).toBeGreaterThan(0)

      const initiateCall = initiateCalls[0]
      expect(initiateCall[1].method).toBe('POST')
      expect(initiateCall[1].headers['Content-Type']).toBe('application/json')

      const initiateBody = JSON.parse(initiateCall[1].body)
      expect(initiateBody.s3Bucket).toBe('test-bucket')
      expect(initiateBody.s3Path).toBe('/raw')
      expect(initiateBody.callback).toContain('/upload-callback')
      expect(initiateBody.redirect).toContain('/upload-success')
      expect(initiateBody.mimeTypes).toBeDefined()
      expect(initiateBody.maxFileSize).toBe(10 * 1024 * 1024)
      expect(initiateBody.metadata).toBeDefined()
    })

    it('extracts fileName from x-file-name header', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      const fileName = 'my-important-document.pdf'

      await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': encodeURIComponent(fileName),
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ fileName }),
        expect.any(String)
      )
    })

    it('extracts userId from x-user-id header', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      const userId = 'user-important-test'

      await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': userId,
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      const initiateCall = global.fetch.mock.calls[0]
      const initiateBody = JSON.parse(initiateCall[1].body)

      expect(initiateBody.metadata.userId).toBe(userId)
    })

    it('handles missing x-user-id header gracefully', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      const response = await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'content-length': fileContent.length
          // No x-user-id
        },
        payload: fileContent
      })

      expect(response.statusCode).toBe(HTTP_STATUS.ACCEPTED)
      const initiateCall = global.fetch.mock.calls[0]
      const initiateBody = JSON.parse(initiateCall[1].body)
      expect(initiateBody.metadata.userId).toBeNull()
    })

    it('sends file to CDP Uploader /upload-and-scan', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      // Verify /upload-and-scan was called
      const uploadCalls = global.fetch.mock.calls.filter((call) =>
        call[0].includes('/upload-and-scan')
      )
      expect(uploadCalls.length).toBeGreaterThan(0)

      const uploadCall = uploadCalls[0]
      expect(uploadCall[1].method).toBe('POST')
      expect(uploadCall[1].body).toBeDefined() // FormData
    })

    it('logs file received message', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: 'document.pdf' }),
        expect.stringContaining('File received')
      )
    })

    it('logs upload error when exception occurs', async () => {
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'))

      const fileContent = Buffer.from('test file content')
      await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(String),
          stack: expect.any(String)
        }),
        expect.stringContaining('Upload failed')
      )
    })

    it('measures request duration and includes in logs', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      vi.mocked(performance)
        .now.mockReturnValueOnce(100)
        .mockReturnValueOnce(150)

      const fileContent = Buffer.from('test file content')
      await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          totalDurationMs: expect.any(Number)
        }),
        expect.any(String)
      )
    })

    it('handles special characters in fileName', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      const fileName = 'My Document (Final) - v2.0.pdf'

      const response = await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': encodeURIComponent(fileName),
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      expect(response.statusCode).toBe(HTTP_STATUS.ACCEPTED)
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ fileName }),
        expect.any(String)
      )
    })

    it('handles missing x-file-name header', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      const response = await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-user-id': 'user-123',
          'content-length': fileContent.length
          // No x-file-name
        },
        payload: fileContent
      })

      // Should still succeed but with null fileName
      expect(response.statusCode).toBe(HTTP_STATUS.ACCEPTED)
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: null }),
        expect.any(String)
      )
    })

    it('constructs uploadAndScanUrl correctly from relative uploadUrl', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      // Get the upload-and-scan call
      const uploadCall = global.fetch.mock.calls.find((call) =>
        call[0].includes('/upload-and-scan')
      )

      expect(uploadCall[0]).toContain('http://localhost:7337')
      expect(uploadCall[0]).toContain('/upload-and-scan/upload-123')
    })

    it('includes Content-Type header in /initiate request', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      const initiateCall = global.fetch.mock.calls[0]
      expect(initiateCall[1].headers['Content-Type']).toBe('application/json')
      expect(initiateCall[1].headers['User-Agent']).toBe(
        'content-reviewer-backend'
      )
    })

    it('includes User-Agent header in /initiate request', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      const initiateCall = global.fetch.mock.calls[0]
      expect(initiateCall[1].headers['User-Agent']).toBe(
        'content-reviewer-backend'
      )
    })

    it('includes accepted mime types in /initiate request', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      const initiateCall = global.fetch.mock.calls[0]
      const initiateBody = JSON.parse(initiateCall[1].body)
      expect(initiateBody.mimeTypes).toContain('application/pdf')
      expect(initiateBody.mimeTypes).toContain(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
    })

    it('sets correct max file size in /initiate request', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-123',
            uploadUrl: '/upload-and-scan/upload-123'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('test file content')
      await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'document.pdf',
          'x-user-id': 'user-123',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      const initiateCall = global.fetch.mock.calls[0]
      const initiateBody = JSON.parse(initiateCall[1].body)
      expect(initiateBody.maxFileSize).toBe(10 * 1024 * 1024) // 10 MB
    })
  })

  describe('POST /upload-callback - handleUploadCallback', () => {
    it('returns 200 OK on successful callback with valid payload', async () => {
      reviewHelpers.createCanonicalDocument.mockResolvedValueOnce({
        canonicalResult: {
          s3: { bucket: 'test-bucket', key: 'documents/doc-123.json' },
          document: { charCount: 5000 }
        },
        canonicalDuration: 100
      })
      reviewHelpers.createReviewRecord.mockResolvedValueOnce(20)
      reviewHelpers.queueReviewJob.mockResolvedValueOnce(10)

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId: 'review-123',
            userId: 'user-xyz'
          },
          form: {
            file: {
              fileStatus: 'complete',
              hasError: false,
              s3Key: 's3://bucket/uploads/file-123',
              filename: 'report.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      expect(response.statusCode).toBe(HTTP_STATUS.OK)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(true)
      expect(body.reviewId).toBe('review-123')
      expect(body.message).toContain('Callback received')
    })

    it('returns 500 when uploadStatus is not ready', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'scanning',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId: 'review-123',
            userId: 'user-xyz'
          },
          form: {
            file: {
              fileStatus: 'complete',
              hasError: false,
              s3Key: 's3://bucket/uploads/file-123',
              filename: 'report.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      expect(response.statusCode).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
      expect(body.message).toContain('not ready')
    })

    it('returns 500 when numberOfRejectedFiles is greater than 0', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 1,
          metadata: {
            reviewId: 'review-123',
            userId: 'user-xyz'
          },
          form: {
            file: {
              fileStatus: 'complete',
              hasError: false,
              s3Key: 's3://bucket/uploads/file-123',
              filename: 'report.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      expect(response.statusCode).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
      expect(body.message).toContain('rejected')
    })

    it('returns 500 when fileStatus is not complete', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId: 'review-123',
            userId: 'user-xyz'
          },
          form: {
            file: {
              fileStatus: 'processing',
              hasError: false,
              s3Key: 's3://bucket/uploads/file-123',
              filename: 'report.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      expect(response.statusCode).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
      expect(body.message).toContain('not available or incomplete')
    })

    it('returns 500 when file.hasError is true', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId: 'review-123',
            userId: 'user-xyz'
          },
          form: {
            file: {
              fileStatus: 'complete',
              hasError: true,
              errorMessage: 'File is corrupted',
              s3Key: 's3://bucket/uploads/file-123',
              filename: 'report.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      expect(response.statusCode).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
      expect(body.message).toContain('corrupted')
    })

    it('returns generic validation failed message when errorMessage is missing', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId: 'review-123',
            userId: 'user-xyz'
          },
          form: {
            file: {
              fileStatus: 'complete',
              hasError: true,
              s3Key: 's3://bucket/uploads/file-123',
              filename: 'report.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      expect(response.statusCode).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      const body = JSON.parse(response.payload)
      expect(body.message).toContain('validation failed')
    })

    it('returns 500 when form.file is missing', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId: 'review-123',
            userId: 'user-xyz'
          },
          form: {}
        }
      })

      expect(response.statusCode).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
    })

    it('extracts userId from metadata correctly', async () => {
      reviewHelpers.createCanonicalDocument.mockResolvedValueOnce({
        canonicalResult: {
          s3: { bucket: 'test-bucket', key: 'documents/doc-123.json' },
          document: { charCount: 3000 }
        },
        canonicalDuration: 50
      })
      reviewHelpers.createReviewRecord.mockResolvedValueOnce(20)
      reviewHelpers.queueReviewJob.mockResolvedValueOnce(10)

      const userId = 'user-extracted-correctly'
      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId: 'review-123',
            userId: userId
          },
          form: {
            file: {
              fileStatus: 'complete',
              hasError: false,
              s3Key: 's3://bucket/uploads/file-123',
              filename: 'report.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      expect(response.statusCode).toBe(HTTP_STATUS.OK)
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: userId
        }),
        expect.any(String)
      )
    })

    it('extracts reviewId from metadata correctly', async () => {
      reviewHelpers.createCanonicalDocument.mockResolvedValueOnce({
        canonicalResult: {
          s3: { bucket: 'test-bucket', key: 'documents/doc-123.json' },
          document: { charCount: 2500 }
        },
        canonicalDuration: 75
      })
      reviewHelpers.createReviewRecord.mockResolvedValueOnce(20)
      reviewHelpers.queueReviewJob.mockResolvedValueOnce(10)

      const reviewId = 'review-extracted-correctly'
      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId: reviewId,
            userId: 'user-xyz'
          },
          form: {
            file: {
              fileStatus: 'complete',
              hasError: false,
              s3Key: 's3://bucket/uploads/file-123',
              filename: 'report.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      const body = JSON.parse(response.payload)
      expect(body.reviewId).toBe(reviewId)
    })

    it('logs callback received message at info level', async () => {
      reviewHelpers.createCanonicalDocument.mockResolvedValueOnce({
        canonicalResult: {
          s3: { bucket: 'test-bucket', key: 'documents/doc-123.json' },
          document: { charCount: 1000 }
        },
        canonicalDuration: 60
      })
      reviewHelpers.createReviewRecord.mockResolvedValueOnce(20)
      reviewHelpers.queueReviewJob.mockResolvedValueOnce(10)

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId: 'review-logging-test',
            userId: 'user-xyz'
          },
          form: {
            file: {
              fileStatus: 'complete',
              hasError: false,
              s3Key: 's3://bucket/uploads/file-123',
              filename: 'report.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0
        }),
        expect.stringContaining('Upload callback')
      )
    })

    it('measures request duration and includes in logs', async () => {
      vi.mocked(performance)
        .now.mockReturnValueOnce(100)
        .mockReturnValueOnce(150)

      reviewHelpers.createCanonicalDocument.mockResolvedValueOnce({
        canonicalResult: {
          s3: { bucket: 'test-bucket', key: 'documents/doc-123.json' },
          document: { charCount: 1000 }
        },
        canonicalDuration: 40
      })
      reviewHelpers.createReviewRecord.mockResolvedValueOnce(20)
      reviewHelpers.queueReviewJob.mockResolvedValueOnce(10)

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId: 'review-123',
            userId: 'user-xyz'
          },
          form: {
            file: {
              fileStatus: 'complete',
              hasError: false,
              s3Key: 's3://bucket/uploads/file-123',
              filename: 'report.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          totalDurationMs: 50
        }),
        expect.any(String)
      )
    })

    it('handles missing userId gracefully (null)', async () => {
      reviewHelpers.createCanonicalDocument.mockResolvedValueOnce({
        canonicalResult: {
          s3: { bucket: 'test-bucket', key: 'documents/doc-123.json' },
          document: { charCount: 1000 }
        },
        canonicalDuration: 90
      })
      reviewHelpers.createReviewRecord.mockResolvedValueOnce(20)
      reviewHelpers.queueReviewJob.mockResolvedValueOnce(10)

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId: 'review-no-userid'
            // userId missing
          },
          form: {
            file: {
              fileStatus: 'complete',
              hasError: false,
              s3Key: 's3://bucket/uploads/file-123',
              filename: 'report.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      expect(response.statusCode).toBe(HTTP_STATUS.OK)
    })

    it('returns callback received message in response', async () => {
      reviewHelpers.createCanonicalDocument.mockResolvedValueOnce({
        canonicalResult: {
          s3: { bucket: 'test-bucket', key: 'documents/doc-123.json' },
          document: { charCount: 1000 }
        },
        canonicalDuration: 55
      })
      reviewHelpers.createReviewRecord.mockResolvedValueOnce(20)
      reviewHelpers.queueReviewJob.mockResolvedValueOnce(10)

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId: 'review-123',
            userId: 'user-xyz'
          },
          form: {
            file: {
              fileStatus: 'complete',
              hasError: false,
              s3Key: 's3://bucket/uploads/file-123',
              filename: 'report.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      const body = JSON.parse(response.payload)
      expect(body.message).toContain('Callback received')
    })

    it('handles exceptions in handler gracefully', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: null
      })

      expect(response.statusCode).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
    })

    it('logs handler errors with stack trace', async () => {
      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: null
      })

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          stack: expect.any(String)
        }),
        expect.stringContaining('failed')
      )
    })
  })

  describe('GET /upload-success - handleUploadSuccess', () => {
    it('returns 200 OK with reviewId from query parameters', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/upload-success?reviewId=review-123'
      })

      expect(response.statusCode).toBe(HTTP_STATUS.OK)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(true)
      expect(body.reviewId).toBe('review-123')
      expect(body.status).toBe('processing')
    })

    it('returns success message indicating async processing', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/upload-success?reviewId=review-123'
      })

      expect(response.statusCode).toBe(HTTP_STATUS.OK)
      const body = JSON.parse(response.payload)
      expect(body.message).toContain('completed successfully')
      expect(body.status).toBe('processing')
    })

    it('extracts reviewId from query parameters', async () => {
      const reviewId = 'review-success-test-123'
      const response = await server.inject({
        method: 'GET',
        url: `/upload-success?reviewId=${reviewId}`
      })

      expect(response.statusCode).toBe(HTTP_STATUS.OK)
      const body = JSON.parse(response.payload)
      expect(body.reviewId).toBe(reviewId)
    })

    it('logs browser redirect message', async () => {
      const reviewId = 'review-logging-test'
      await server.inject({
        method: 'GET',
        url: `/upload-success?reviewId=${reviewId}`
      })

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewId,
          source: 'browser-redirect'
        }),
        expect.stringContaining('Browser redirected')
      )
    })

    it('handles multiple redirects with different reviewIds', async () => {
      const reviewId1 = 'review-first'
      const reviewId2 = 'review-second'

      const response1 = await server.inject({
        method: 'GET',
        url: `/upload-success?reviewId=${reviewId1}`
      })

      const response2 = await server.inject({
        method: 'GET',
        url: `/upload-success?reviewId=${reviewId2}`
      })

      expect(response1.statusCode).toBe(HTTP_STATUS.OK)
      expect(response2.statusCode).toBe(HTTP_STATUS.OK)

      const body1 = JSON.parse(response1.payload)
      const body2 = JSON.parse(response2.payload)

      expect(body1.reviewId).toBe(reviewId1)
      expect(body2.reviewId).toBe(reviewId2)
    })

    it('handles special characters in reviewId', async () => {
      const reviewId = 'review-123-abc-xyz-test'

      const response = await server.inject({
        method: 'GET',
        url: `/upload-success?reviewId=${reviewId}`
      })

      expect(response.statusCode).toBe(HTTP_STATUS.OK)
      const body = JSON.parse(response.payload)
      expect(body.reviewId).toBe(reviewId)
    })
  })

  describe('Integration Tests', () => {
    it('completes full upload flow from /api/upload to /upload-callback to /upload-success', async () => {
      // Step 1: Upload file
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({
            uploadId: 'upload-integration',
            uploadUrl: '/upload-and-scan/upload-integration'
          })
        )
        .mockResolvedValueOnce(mockFetchResponse({}, 302, true))

      const fileContent = Buffer.from('integration test file content')
      const uploadResponse = await server.inject({
        method: 'POST',
        url: '/api/upload',
        headers: {
          'x-file-name': 'integration-test.pdf',
          'x-user-id': 'user-integration',
          'content-length': fileContent.length
        },
        payload: fileContent
      })

      expect(uploadResponse.statusCode).toBe(HTTP_STATUS.ACCEPTED)
      const uploadBody = JSON.parse(uploadResponse.payload)
      const reviewId = uploadBody.reviewId

      // Step 2: Simulate callback from CDP Uploader
      reviewHelpers.createCanonicalDocument.mockResolvedValueOnce({
        canonicalResult: {
          s3: { bucket: 'test-bucket', key: 'documents/doc-integration.json' },
          document: { charCount: 5000 }
        },
        canonicalDuration: 100
      })
      reviewHelpers.createReviewRecord.mockResolvedValueOnce(20)
      reviewHelpers.queueReviewJob.mockResolvedValueOnce(10)

      const callbackResponse = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload: {
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0,
          metadata: {
            reviewId,
            userId: 'user-integration'
          },
          form: {
            file: {
              fileStatus: 'complete',
              hasError: false,
              s3Key: 's3://bucket/uploads/integration-file',
              filename: 'integration-test.pdf',
              contentType: 'application/pdf'
            }
          }
        }
      })

      expect(callbackResponse.statusCode).toBe(HTTP_STATUS.OK)

      // Step 3: Simulate browser redirect
      const successResponse = await server.inject({
        method: 'GET',
        url: `/upload-success?reviewId=${reviewId}`
      })

      expect(successResponse.statusCode).toBe(HTTP_STATUS.OK)
      const successBody = JSON.parse(successResponse.payload)
      expect(successBody.reviewId).toBe(reviewId)
      expect(successBody.status).toBe('processing')
    })

    describe('Error Handling', () => {
      it('returns 500 for unexpected errors in /api/upload', async () => {
        global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'))

        const fileContent = Buffer.from('test content')
        const response = await server.inject({
          method: 'POST',
          url: '/api/upload',
          headers: {
            'x-file-name': 'document.pdf',
            'x-user-id': 'user-123',
            'content-length': fileContent.length
          },
          payload: fileContent
        })

        expect(response.statusCode).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        const body = JSON.parse(response.payload)
        expect(body.success).toBe(false)
      })

      it('returns 500 for unexpected errors in /upload-callback', async () => {
        const response = await server.inject({
          method: 'POST',
          url: '/upload-callback',
          payload: null
        })

        expect(response.statusCode).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        const body = JSON.parse(response.payload)
        expect(body.success).toBe(false)
      })

      it('logs errors with stack trace', async () => {
        global.fetch = vi.fn().mockRejectedValueOnce(new Error('Test error'))

        const fileContent = Buffer.from('test content')
        await server.inject({
          method: 'POST',
          url: '/api/upload',
          headers: {
            'x-file-name': 'document.pdf',
            'x-user-id': 'user-123',
            'content-length': fileContent.length
          },
          payload: fileContent
        })

        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            stack: expect.any(String)
          }),
          expect.any(String)
        )
      })
    })

    describe('Route Registration', () => {
      it('registers POST /api/upload route', async () => {
        const table = server.table()
        const uploadRoute = table.find(
          (r) => r.method === 'post' && r.path === '/api/upload'
        )
        expect(uploadRoute).toBeDefined()
      })

      it('registers POST /upload-callback route', async () => {
        const table = server.table()
        const callbackRoute = table.find(
          (r) => r.method === 'post' && r.path === '/upload-callback'
        )
        expect(callbackRoute).toBeDefined()
      })

      it('registers GET /upload-success route', async () => {
        const table = server.table()
        const successRoute = table.find(
          (r) => r.method === 'get' && r.path === '/upload-success'
        )
        expect(successRoute).toBeDefined()
      })

      it('configures CORS for all upload routes', async () => {
        const table = server.table()
        const uploadRoutes = table.filter((r) => r.path.includes('upload'))

        expect(uploadRoutes.length).toBeGreaterThan(0)
        uploadRoutes.forEach((route) => {
          expect(route.settings.cors).toBeDefined()
        })
      })

      it('sets payload output to stream for /api/upload', async () => {
        const table = server.table()
        const uploadRoute = table.find(
          (r) => r.method === 'post' && r.path === '/api/upload'
        )

        expect(uploadRoute.settings.payload.output).toBe('stream')
      })

      it('sets parse to false for /api/upload payload', async () => {
        const table = server.table()
        const uploadRoute = table.find(
          (r) => r.method === 'post' && r.path === '/api/upload'
        )

        expect(uploadRoute.settings.payload.parse).toBe(false)
      })

      it('sets maxBytes to 10 MB for /api/upload', async () => {
        const table = server.table()
        const uploadRoute = table.find(
          (r) => r.method === 'post' && r.path === '/api/upload'
        )

        expect(uploadRoute.settings.payload.maxBytes).toBe(10 * 1024 * 1024)
      })
    })
  })
})
