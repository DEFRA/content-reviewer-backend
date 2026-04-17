/**
 * Upload Callback Handler
 * Receives callbacks from CDP Uploader after virus scanning completes
 */
import Joi from 'joi'
import { SOURCE_TYPES as CANONICAL_SOURCE_TYPES } from '../common/helpers/canonical-document.js'
import {
  HTTP_STATUS,
  REVIEW_STATUSES,
  getCorsConfig,
  createCanonicalDocument,
  createReviewRecord,
  queueReviewJob
} from './review-helpers.js'
import { randomUUID } from 'node:crypto'

const SOURCE_TYPE_FILE = 'file'

/**
 * Upload callback controller
 * Called by CDP Uploader after virus scan completes
 */
const uploadCallbackController = {
  options: {
    auth: false, // CDP Uploader callbacks don't support auth yet
    validate: {
      payload: Joi.object({
        uploadStatus: Joi.string().required(),
        uploadId: Joi.string().optional(),
        metadata: Joi.object().required(),
        form: Joi.object().required(),
        numberOfRejectedFiles: Joi.number().integer().required()
      }),
      failAction: (request, h, err) => {
        request.logger.error(err, 'Upload callback validation failed')
        return h
          .response({ success: false, message: err.message })
          .code(400)
          .takeover()
      }
    }
  },
  handler: async (request, h) => {
    const { uploadStatus, metadata, form, numberOfRejectedFiles } =
      request.payload

    request.logger.info(
      { uploadStatus, metadata, numberOfRejectedFiles },
      'Upload callback received from CDP Uploader'
    )

    // Check if upload is ready
    if (uploadStatus !== 'ready') {
      request.logger.warn({ uploadStatus }, 'Upload not ready yet')
      return h
        .response({ success: false, message: 'Upload not ready' })
        .code(200)
    }

    // Check for rejected files
    if (numberOfRejectedFiles > 0) {
      request.logger.error(
        { numberOfRejectedFiles },
        'Files rejected during scan'
      )
      return h
        .response({
          success: false,
          message:
            'One or more files were rejected (virus detected or validation failed)'
        })
        .code(200)
    }

    // Get file details from form
    const fileField = form.file
    if (!fileField || fileField.fileStatus !== 'complete') {
      request.logger.error({ fileField }, 'File not complete or missing')
      return h
        .response({
          success: false,
          message: 'File not available or incomplete'
        })
        .code(200)
    }

    // Check if file was rejected
    if (fileField.hasError) {
      request.logger.error(
        { errorMessage: fileField.errorMessage },
        'File rejected with error'
      )
      return h
        .response({
          success: false,
          message: fileField.errorMessage || 'File validation failed'
        })
        .code(200)
    }

    const userId = metadata?.userId || 'unknown-user'
    const reviewId = metadata?.reviewId || randomUUID()

    const { contentType, s3Key, filename } = fileField

    request.logger.info(
      { userId, reviewId, contentType, s3Key, filename },
      'Processing uploaded file for review'
    )
   return h
    .response({
      success: true,
      reviewId,
      status: REVIEW_STATUSES.PENDING,
      message: 'File uploaded in S3 for review'
    })
    .code(HTTP_STATUS.ACCEPTED)
      }
}

const uploadCallback = {
  method: 'POST',
  path: '/upload-callback',
  ...uploadCallbackController
}

export { uploadCallback }
