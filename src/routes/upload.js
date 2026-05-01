import { getCorsConfig } from './review-helpers.js'
import {
  handleFileUpload,
  handleUploadCallback,
  handleUploadSuccess,
  handleUploadStatus
} from './file-upload-handlers.js'

export const uploadRoutes = {
  plugin: {
    name: 'upload-routes',
    register: async (server) => {
      server.route({
        method: 'POST',
        path: '/api/upload',
        options: {
          payload: {
            output: 'stream',
            parse: false,
            maxBytes: 10 * 1024 * 1024,
            allow: 'application/octet-stream'
          },
          cors: getCorsConfig()
        },
        handler: handleFileUpload
      })

      server.route({
        method: 'POST',
        path: '/upload-callback',
        options: {
          cors: getCorsConfig()
        },
        handler: handleUploadCallback
      })

      server.route({
        method: 'GET',
        path: '/upload-success',
        options: {
          cors: getCorsConfig()
        },
        handler: handleUploadSuccess
      })

      server.route({
        method: 'GET',
        path: '/api/upload-status/{reviewId}',
        options: { cors: getCorsConfig() },
        handler: handleUploadStatus
      })
    }
  }
}
