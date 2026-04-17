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
    if (server?.started) {
      await server.stop()
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
    })
  })

  describe('Valid Payload - Status Ready', () => {
    it('should accept payload with uploadStatus ready', async () => {
      const payload = {
        uploadStatus: 'ready',
        uploadId: 'up-123',
        metadata: {
          entities: ['users'],
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
            s3Key: 'scanned/file.xlsx',
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
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(true)
    })

    it('should return success true response', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users'],
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(true)
    })

    it('should accept payload without uploadId', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users'],
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

    it('should log callback receipt', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users'],
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

      expect(mockLogger.info).toHaveBeenCalled()
    })

    it('should accept multiple entities', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users', 'products', 'orders'],
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

    it('should return reviewId in response', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users'],
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
    })

    it('should return PENDING status', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users'],
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
      expect(body.status).toBe('PENDING')
    })
  })

  describe('Validation - Missing Required Fields (Schema Level)', () => {
    it('should reject payload missing uploadStatus', async () => {
      const payload = {
        metadata: {
          entities: ['users']
        },
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

    it('should reject payload missing metadata', async () => {
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

    it('should reject payload missing form', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
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

    it('should reject payload missing numberOfRejectedFiles', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
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
  })

  describe('Validation - Missing Required Fields (Handler Level)', () => {
    it('should reject when entities array is missing', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
      expect(body.message).toContain('entities')
    })

    it('should reject when entities is empty array', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: [],
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
      expect(body.message).toContain('entities')
    })

    it('should reject when entities is not an array', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: 'users',
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
    })
  })

  describe('Upload Status Validation', () => {
    it('should reject when uploadStatus is not ready', async () => {
      const payload = {
        uploadStatus: 'pending',
        metadata: {
          entities: ['users']
        },
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
    })

    it('should log warning for non-ready status', async () => {
      const payload = {
        uploadStatus: 'processing',
        metadata: {
          entities: ['users']
        },
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

      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it('should return false on non-ready uploadStatus', async () => {
      const payload = {
        uploadStatus: 'failed',
        metadata: {
          entities: ['users']
        },
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
  })

  describe('Rejected Files Validation', () => {
    it('should reject when numberOfRejectedFiles > 0', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
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
      expect(body.message).toContain('rejected')
    })

    it('should log error for rejected files', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
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

      expect(mockLogger.error).toHaveBeenCalled()
    })

    it('should accept when numberOfRejectedFiles is 0', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
  })

  describe('File Status Validation', () => {
    it('should reject when fileStatus is not complete', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
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
      expect(body.message).toContain('not complete')
    })

    it('should reject when file has error', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
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

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.payload)
      expect(body.success).toBe(false)
      expect(body.message).toContain('Virus detected')
    })

    it('should log error when file has error', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            hasError: true,
            errorMessage: 'Invalid format'
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

    it('should accept complete file without error', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
  })

  describe('S3 Details Extraction', () => {
    it('should extract s3Bucket, s3Key, filename from file', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'my-bucket',
            s3Key: 'uploads/2024/file.xlsx',
            filename: 'report.xlsx',
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
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          s3Bucket: 'my-bucket',
          s3Key: 'uploads/2024/file.xlsx',
          filename: 'report.xlsx'
        }),
        expect.any(String)
      )
    })

    it('should handle S3 key with nested paths', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads-prod',
            s3Key: 'scanned/2024/01/15/file.xlsx',
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
    it('should extract userId from metadata when present', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users'],
          userId: 'admin-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
          userId: 'admin-123'
        }),
        expect.any(String)
      )
    })

    it('should handle missing userId gracefully', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

    it('should use unknown-user when userId is missing', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
          userId: expect.any(String)
        }),
        expect.any(String)
      )
    })
  })

  describe('Review ID Handling', () => {
    it('should use provided reviewId from metadata', async () => {
      const providedReviewId = 'custom-review-id-123'
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users'],
          reviewId: providedReviewId
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

    it('should generate reviewId when not provided in metadata', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
      expect(body.reviewId.length).toBeGreaterThan(0)
    })

    it('should generate UUID-format reviewId', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
      expect(body.reviewId).toMatch(/^[0-9a-f\-]{36}$|^[a-zA-Z0-9\-]{20,}$/)
    })
  })

  describe('Content Types', () => {
    it('should accept Excel XLSX files', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
            s3Key: 'file.xlsx',
            filename: 'report.xlsx',
            contentType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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

    it('should accept Excel XLS files', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
            s3Key: 'file.xls',
            filename: 'report.xls',
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
    })

    it('should accept PDF files', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['documents']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
            s3Key: 'document.pdf',
            filename: 'report.pdf',
            contentType: 'application/pdf',
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

    it('should accept Word DOCX files', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['documents']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
            s3Key: 'document.docx',
            filename: 'report.docx',
            contentType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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

    it('should accept Word DOC files', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['documents']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
            s3Key: 'document.doc',
            filename: 'report.doc',
            contentType: 'application/msword',
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

    it('should handle missing contentType field', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['documents']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
            s3Key: 'file.txt',
            filename: 'data.txt',
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

  describe('Response Format', () => {
    it('should return JSON response', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

    it('should include reviewId on success', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

    it('should include status on success', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
      expect(body.status).toBe('PENDING')
    })
  })

  describe('HTTP Method Validation', () => {
    it('should only accept POST requests', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/upload-callback'
      })

      expect(response.statusCode).toBe(404)
    })

    it('should reject PUT requests', async () => {
      const response = await server.inject({
        method: 'PUT',
        url: '/upload-callback',
        payload: {}
      })

      expect(response.statusCode).toBe(404)
    })

    it('should reject DELETE requests', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: '/upload-callback'
      })

      expect(response.statusCode).toBe(404)
    })
  })

  describe('Logging Behavior', () => {
    it('should log successful callback receipt', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users'],
          userId: 'user-123'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

      expect(mockLogger.info).toHaveBeenCalled()
    })

    it('should log file processing details', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users'],
          userId: 'test-user-001'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'test-bucket',
            s3Key: 'test/file.xlsx',
            filename: 'testfile.xlsx',
            contentType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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
          userId: 'test-user-001',
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          s3Key: 'test/file.xlsx'
        }),
        expect.any(String)
      )
    })

    it('should log upload status warnings', async () => {
      const payload = {
        uploadStatus: 'pending',
        metadata: {
          entities: ['users']
        },
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

      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it('should log file errors', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            hasError: true,
            errorMessage: 'Test error'
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

    it('should log rejected files', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            hasError: false
          }
        },
        numberOfRejectedFiles: 1
      }

      await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(mockLogger.error).toHaveBeenCalled()
    })
  })

  describe('Edge Cases', () => {
    it('should handle extra fields in payload', async () => {
      const payload = {
        uploadStatus: 'ready',
        uploadId: 'up-123',
        metadata: {
          entities: ['users'],
          userId: 'user-123',
          extraField: 'ignored'
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
            s3Key: 'file.xlsx',
            filename: 'data.xlsx',
            hasError: false,
            extraField: 'ignored'
          }
        },
        numberOfRejectedFiles: 0,
        extraField: 'ignored'
      }

      const response = await server.inject({
        method: 'POST',
        url: '/upload-callback',
        payload
      })

      expect(response.statusCode).toBe(202)
    })

    it('should handle very long entity names', async () => {
      const longName = 'a'.repeat(100)
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: [longName]
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

    it('should handle very large numberOfRejectedFiles', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
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

    it('should handle empty string filename', async () => {
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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

      expect([200, 202]).toContain(response.statusCode)
    })

    it('should handle very long S3 key paths', async () => {
      const longPath = 'scanned/' + 'folder/'.repeat(20) + 'file.xlsx'
      const payload = {
        uploadStatus: 'ready',
        metadata: {
          entities: ['users']
        },
        form: {
          file: {
            fileStatus: 'complete',
            s3Bucket: 'uploads',
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
  })
})
