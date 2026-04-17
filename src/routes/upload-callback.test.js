import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Hapi from '@hapi/hapi'
import { uploadCallback } from './upload-callback.js'

describe('Upload Callback Route', () => {
  let server
  let mockLogger

  beforeEach(async () => {
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn()
    }

    server = Hapi.server({
      host: 'localhost',
      port: 3000,
      debug: { request: false }
    })

    server.decorate('request', 'logger', mockLogger)
    server.route(uploadCallback)
    await server.initialize()
  })

  afterEach(async () => {
    try {
      if (server?.started) {
        await server.stop()
      }
    } catch (err) {
      // Ignore stop errors
    }
    vi.clearAllMocks()
  })

  describe('Route Configuration', () => {
    it('should have POST method', () => {
      expect(uploadCallback.method).toBe('POST')
    })

    it('should have /upload-callback path', () => {
      expect(uploadCallback.path).toBe('/upload-callback')
    })

    it('should have handler function', () => {
      expect(uploadCallback.handler).toBeDefined()
      expect(typeof uploadCallback.handler).toBe('function')
    })

    it('should not require authentication', () => {
      expect(uploadCallback.options.auth).toBe(false)
    })

    it('should have validation rules', () => {
      expect(uploadCallback.options.validate).toBeDefined()
      expect(uploadCallback.options.validate.payload).toBeDefined()
    })
  })

  describe('Valid Callback - Success Flow', () => {
    it('should accept valid payload with uploadStatus ready', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'scanned/file.xlsx',
            filename: 'data.xlsx',
            contentType: 'application/vnd.ms-excel',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(202)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(true)
    })

    it('should return 202 Accepted status on success', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(202)
    })

    it('should return success true', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.success).toBe(true)
    })

    it('should return reviewId in response', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.reviewId).toBeDefined()
      expect(typeof body.reviewId).toBe('string')
    })

    it('should return PENDING status', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.status).toBe('pending')
    })

    it('should return success message', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.message).toContain('S3')
    })

    it('should log callback received', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          uploadStatus: 'ready'
        }),
        'Upload callback received from CDP Uploader'
      )
    })

    it('should generate UUID reviewId when not provided', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.reviewId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )
    })

    it('should use provided reviewId from metadata', async () => {
      const providedReviewId = 'custom-review-id-123'
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          reviewId: providedReviewId
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.reviewId).toBe(providedReviewId)
    })

    it('should log processing message with file details', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'uploads/file.xlsx',
            filename: 'data.xlsx',
            contentType: 'application/vnd.ms-excel',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          s3Key: 'uploads/file.xlsx',
          filename: 'data.xlsx',
          contentType: 'application/vnd.ms-excel',
          reviewId: expect.any(String)
        }),
        'Processing uploaded file for review'
      )
    })

    it('should accept optional uploadId', async () => {
      const payload = {
        uploadStatus: 'ready',
        uploadId: 'upload-456',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(202)
    })
  })

  describe('Schema Validation - Missing Required Fields', () => {
    it('should reject missing uploadStatus', async () => {
      const payload = {
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(400)
    })

    it('should reject missing metadata', async () => {
      const payload = {
        uploadStatus: 'ready',
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(400)
    })

    it('should reject missing form', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(400)
    })

    it('should reject missing numberOfRejectedFiles', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        }
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(400)
    })

    it('should return error response on validation failure', async () => {
      const payload = {
        uploadStatus: 'ready',
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
      expect(body.message).toBeDefined()
    })

    it('should log validation errors', async () => {
      const payload = {
        uploadStatus: 'ready',
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.error).toHaveBeenCalled()
    })

    it('should reject numberOfRejectedFiles as float', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 1.5
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(400)
    })
  })

  describe('Upload Status Validation', () => {
    it('should reject uploadStatus not equal to ready', async () => {
      const payload = {
        uploadStatus: 'pending',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
      expect(body.message).toBe('Upload not ready')
    })

    it('should return success false for non-ready status', async () => {
      const payload = {
        uploadStatus: 'processing',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
    })

    it('should log warning for non-ready status', async () => {
      const payload = {
        uploadStatus: 'processing',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ uploadStatus: 'processing' }),
        expect.any(String)
      )
    })

    it('should return HTTP 200 for non-ready status', async () => {
      const payload = {
        uploadStatus: 'failed',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(200)
    })
  })

  describe('Rejected Files Validation', () => {
    it('should reject when numberOfRejectedFiles > 0', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 1
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
    })

    it('should return specific error message for rejected files', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 1
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.message).toContain('rejected')
    })

    it('should log error for rejected files', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 2
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ numberOfRejectedFiles: 2 }),
        expect.stringContaining('rejected')
      )
    })

    it('should accept numberOfRejectedFiles = 0', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.success).toBe(true)
    })

    it('should handle large numberOfRejectedFiles', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 999999
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
    })
  })

  describe('File Status Validation', () => {
    it('should reject when fileStatus is not complete', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'processing',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
      expect(body.message).toContain('not available or incomplete')
    })

    it('should reject when file is missing', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {},
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
      expect(body.message).toContain('not available or incomplete')
    })

    it('should log error for incomplete file', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'processing',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.any(Object),
        expect.stringContaining('not complete or missing')
      )
    })

    it('should accept fileStatus complete', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(202)
    })

    it('should use optional chaining for fileStatus check', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: null
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
    })
  })

  describe('File Error Validation', () => {
    it('should reject when file has error true', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: true,
            errorMessage: 'Virus detected'
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
      expect(body.message).toBe('Virus detected')
    })

    it('should return error message when file has error', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: true,
            errorMessage: 'Invalid format'
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.message).toBe('Invalid format')
    })

    it('should log error when file has error', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: true,
            errorMessage: 'Corrupted file'
          }
        },
        numberOfRejectedFiles: 0
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ errorMessage: 'Corrupted file' }),
        expect.stringContaining('rejected')
      )
    })

    it('should return fallback message when hasError but no errorMessage', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: true
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.message).toBe('File validation failed')
    })

    it('should accept hasError false', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(202)
    })
  })

  describe('File Details in Response', () => {
    it('should include s3Key in logging', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'scanned/uploads/file.xlsx',
            filename: 'report.xlsx',
            contentType: 'application/vnd.ms-excel',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          s3Key: 'scanned/uploads/file.xlsx'
        }),
        expect.any(String)
      )
    })

    it('should include filename in logging', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'myfile.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: 'myfile.xlsx'
        }),
        expect.any(String)
      )
    })

    it('should include contentType in logging when present', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            contentType: 'application/pdf',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          contentType: 'application/pdf'
        }),
        expect.any(String)
      )
    })

    it('should handle missing contentType', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(202)
    })
  })

  describe('User Metadata', () => {
    it('should use provided userId', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'admin-user-456'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-user-456'
        }),
        'Processing uploaded file for review'
      )
    })

    it('should use unknown-user when userId not provided', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'unknown-user'
        }),
        expect.any(String)
      )
    })

    it('should use unknown-user when metadata is empty object', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const infoCall = mockLogger.info.mock.calls.find((call) =>
        call[1]?.includes('Processing')
      )
      expect(infoCall[0].userId).toBe('unknown-user')
    })
  })

  describe('Response Format', () => {
    it('should return JSON response', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.headers['content-type']).toContain('application/json')
    })

    it('should include success property', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body).toHaveProperty('success')
      expect(typeof body.success).toBe('boolean')
    })

    it('should include message property', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body).toHaveProperty('message')
      expect(typeof body.message).toBe('string')
    })

    it('should include reviewId in success response', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body).toHaveProperty('reviewId')
    })

    it('should include status in success response', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body).toHaveProperty('status')
    })

    it('should not include reviewId in error response', async () => {
      const payload = {
        uploadStatus: 'pending',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const body = JSON.parse(response.payload)
      expect(body.reviewId).toBeUndefined()
    })
  })

  describe('HTTP Method Validation', () => {
    it('should only accept POST', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/upload-callback'
      })

      expect([404, 405]).toContain(response.statusCode)
    })

    it('should reject PUT', async () => {
      const response = await server.inject({
        method: 'PUT',
        url: '/upload-callback',
        payload: {}
      })

      expect([404, 405]).toContain(response.statusCode)
    })

    it('should reject DELETE', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: '/upload-callback'
      })

      expect([404, 405]).toContain(response.statusCode)
    })
  })

  describe('Edge Cases', () => {
    it('should handle extra unknown properties', async () => {
      const payload = {
        uploadStatus: 'ready',
        uploadId: 'up-123',
        metadata: {
          userId: 'user-123',
          extraField: 'value'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false,
            extraField: 'value'
          }
        },
        numberOfRejectedFiles: 0,
        extraField: 'value'
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(400)
    })

    it('should handle very long s3Key', async () => {
      const longPath = 'scanned/' + 'folder/'.repeat(50) + 'file.xlsx'
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: longPath,
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(202)
    })

    it('should handle empty filename', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: '',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(202)
    })

    it('should handle special characters in filename', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data-2024_01@special#chars.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(202)
    })

    it('should handle unicode characters in metadata', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-👤-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(202)
    })
  })

  describe('Logging Behavior', () => {
    it('should log successful callback receipt', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      mockLogger.info.mockClear()

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      // First info call - callback received
      expect(mockLogger.info).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          uploadStatus: 'ready',
          numberOfRejectedFiles: 0
        }),
        'Upload callback received from CDP Uploader'
      )

      // Second info call - processing file
      expect(mockLogger.info).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          userId: 'user-123',
          s3Key: 'file.xlsx',
          filename: 'data.xlsx',
          reviewId: expect.any(String)
        }),
        'Processing uploaded file for review'
      )
    })

    it('should call info logger twice on success', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      mockLogger.info.mockClear()

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.info).toHaveBeenCalledTimes(2)
    })

    it('should log initial callback receipt with upload status', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      mockLogger.info.mockClear()

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const firstCall = mockLogger.info.mock.calls[0]
      expect(firstCall[0]).toHaveProperty('uploadStatus', 'ready')
      expect(firstCall[0]).toHaveProperty('numberOfRejectedFiles', 0)
      expect(firstCall[1]).toBe('Upload callback received from CDP Uploader')
    })

    it('should log processing message with reviewId', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            contentType: 'application/vnd.ms-excel',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      mockLogger.info.mockClear()

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const secondCall = mockLogger.info.mock.calls[1]
      expect(secondCall[0]).toHaveProperty('reviewId')
      expect(secondCall[0].reviewId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )
      expect(secondCall[1]).toBe('Processing uploaded file for review')
    })

    it('should not log processing on early failure - upload not ready', async () => {
      const payload = {
        uploadStatus: 'pending',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      mockLogger.info.mockClear()

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      // Only one call - callback received, no processing
      expect(mockLogger.info).toHaveBeenCalledTimes(1)
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.any(Object),
        'Upload callback received from CDP Uploader'
      )
    })

    it('should not log processing on rejected files', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 1
      }

      mockLogger.info.mockClear()

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      // Only one call - callback received, no processing
      expect(mockLogger.info).toHaveBeenCalledTimes(1)
    })

    it('should not log processing on incomplete file', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'processing',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      mockLogger.info.mockClear()

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      // Only one call - callback received, no processing
      expect(mockLogger.info).toHaveBeenCalledTimes(1)
    })

    it('should not log processing on file error', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            hasError: true,
            errorMessage: 'Virus detected'
          }
        },
        numberOfRejectedFiles: 0
      }

      mockLogger.info.mockClear()

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      // Only one call - callback received, no processing
      expect(mockLogger.info).toHaveBeenCalledTimes(1)
    })

    it('should log reviewId from metadata when provided', async () => {
      const customReviewId = 'custom-review-123'
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123',
          reviewId: customReviewId
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      mockLogger.info.mockClear()

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const secondCall = mockLogger.info.mock.calls[1]
      expect(secondCall[0]).toHaveProperty('reviewId', customReviewId)
    })

    it('should log with default userId when not provided', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {},
        form: {
          file: {
            fileStatus: 'complete',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false
          }
        },
        numberOfRejectedFiles: 0
      }

      mockLogger.info.mockClear()

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      const secondCall = mockLogger.info.mock.calls[1]
      expect(secondCall[0]).toHaveProperty('userId', 'unknown-user')
    })
  })
})
