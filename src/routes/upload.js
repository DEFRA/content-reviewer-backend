import multer from 'multer'
import { randomUUID } from 'crypto'
import mime from 'mime-types'
import { config } from '../config.js'
import { s3Uploader } from '../common/helpers/s3-uploader.js'

// Configure multer for memory storage (used for validation reference)
const storage = multer.memoryStorage()

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = config.get('upload.allowedMimeTypes')

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true)
  } else {
    cb(
      new Error(`File type not allowed. Accepted types: PDF, Word documents`),
      false
    )
  }
}

// Multer configuration (for reference - Hapi handles multipart natively)
multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.get('upload.maxFileSize')
  }
})

/**
 * Upload route plugin
 */
export const uploadRoutes = {
  plugin: {
    name: 'upload-routes',
    register: async (server) => {
      /**
       * POST /api/upload
       * Upload a file
       */
      server.route({
        method: 'POST',
        path: '/api/upload',
        options: {
          payload: {
            maxBytes: config.get('upload.maxFileSize'),
            output: 'stream',
            parse: true,
            multipart: true,
            allow: 'multipart/form-data'
          },
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          }
        },
        handler: async (request, h) => {
          try {
            const data = request.payload

            if (!data || !data.file) {
              return h
                .response({
                  success: false,
                  error: 'No file provided'
                })
                .code(400)
            }

            const file = data.file
            const uploadId = randomUUID()

            // Validate file type
            const allowedMimeTypes = config.get('upload.allowedMimeTypes')
            const detectedMimeType =
              mime.lookup(file.hapi.filename) || 'application/octet-stream'

            if (!allowedMimeTypes.includes(detectedMimeType)) {
              return h
                .response({
                  success: false,
                  error: `File type not allowed. Accepted types: PDF, Word documents. Detected: ${detectedMimeType}`
                })
                .code(400)
            }

            // Read file buffer
            const chunks = []
            for await (const chunk of file) {
              chunks.push(chunk)
            }
            const buffer = Buffer.concat(chunks)

            // Validate file size
            if (buffer.length > config.get('upload.maxFileSize')) {
              return h
                .response({
                  success: false,
                  error: `File too large. Maximum size: ${config.get('upload.maxFileSize') / 1024 / 1024}MB`
                })
                .code(400)
            }

            // Prepare file object for S3 upload
            const fileObject = {
              originalname: file.hapi.filename,
              mimetype: detectedMimeType,
              size: buffer.length,
              buffer
            }

            // Upload to S3
            const result = await s3Uploader.uploadFile(fileObject, uploadId)

            request.logger.info(
              {
                uploadId,
                filename: file.hapi.filename,
                size: buffer.length,
                s3Location: result.location
              },
              'File uploaded successfully'
            )

            return h
              .response({
                success: true,
                uploadId: result.fileId,
                filename: result.filename,
                size: result.size,
                contentType: result.contentType,
                s3Bucket: result.bucket,
                s3Key: result.key,
                s3Location: result.location
              })
              .code(200)
          } catch (error) {
            request.logger.error({ error }, 'File upload failed')

            return h
              .response({
                success: false,
                error: error.message || 'Upload failed'
              })
              .code(500)
          }
        }
      })

      /**
       * GET /api/upload/health
       * Health check for upload service
       */
      server.route({
        method: 'GET',
        path: '/api/upload/health',
        options: {
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          }
        },
        handler: async (request, h) => {
          return h
            .response({
              status: 'ok',
              service: 'upload',
              bucket: config.get('upload.s3Bucket'),
              maxFileSize: config.get('upload.maxFileSize'),
              allowedTypes: config.get('upload.allowedMimeTypes')
            })
            .code(200)
        }
      })
    }
  }
}
