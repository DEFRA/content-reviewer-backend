import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { textExtractor } from '../common/helpers/text-extractor.js'
import { SOURCE_TYPES as CANONICAL_SOURCE_TYPES } from '../common/helpers/canonical-document.js'
import {
  HTTP_STATUS,
  REVIEW_STATUSES,
  getCorsConfig,
  uploadTextToS3,
  createCanonicalDocument,
  createReviewRecord,
  queueReviewJob
} from './review-helpers.js'

const ENDPOINT_UPLOAD = '/api/upload'
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
const SOURCE_TYPE_FILE = 'file'

const ACCEPTED_MIME_TYPES = {
  'application/pdf': true,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true
}

const ACCEPTED_EXTENSIONS = ['.pdf', '.docx']

const ERROR_MESSAGES = {
  NO_FILE: 'No file provided',
  INVALID_TYPE: 'The selected file must be a PDF or Word document',
  EMPTY_FILE: 'The uploaded file is empty',
  FILE_TOO_LARGE: 'The file must be smaller than 10 MB',
  NO_TEXT: 'No text could be extracted from the file',
  PIPELINE_FAILED: 'Failed to process file upload'
}

/**
 * Read a Hapi multipart stream field into a Buffer.
 * @param {import('stream').Readable} stream
 * @returns {Promise<Buffer>}
 */
export function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/**
 * Extract filename, MIME type and lower-cased filename from a Hapi file field.
 */
function getFileMetadata(file) {
  const { filename, headers: fileHeaders } = file.hapi
  const mimeType = fileHeaders?.['content-type'] ?? ''
  const filenameLower = (filename ?? '').toLowerCase()
  return { filename, mimeType, filenameLower }
}

/**
 * Returns true when the file passes either MIME-type or extension validation.
 */
function isAcceptedType(mimeType, filenameLower) {
  const hasValidMime = Object.prototype.hasOwnProperty.call(
    ACCEPTED_MIME_TYPES,
    mimeType
  )
  const hasValidExt = ACCEPTED_EXTENSIONS.some((ext) =>
    filenameLower.endsWith(ext)
  )
  return hasValidMime || hasValidExt
}

/**
 * Validates buffer size. Returns a Hapi response on failure, null on success.
 */
function validateBuffer(buffer, h) {
  if (buffer.length === 0) {
    return h
      .response({ success: false, message: ERROR_MESSAGES.EMPTY_FILE })
      .code(HTTP_STATUS.BAD_REQUEST)
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return h
      .response({ success: false, message: ERROR_MESSAGES.FILE_TOO_LARGE })
      .code(HTTP_STATUS.BAD_REQUEST)
  }
  return null
}

/**
 * Runs the S3 upload → canonical document → DB record → SQS queue pipeline.
 */
async function runPipeline(
  content,
  reviewId,
  title,
  mimeType,
  userId,
  headers,
  logger
) {
  const { s3Result, s3UploadDuration } = await uploadTextToS3(
    content,
    reviewId,
    title,
    logger
  )

  const { canonicalResult, canonicalDuration } = await createCanonicalDocument(
    content,
    reviewId,
    title,
    logger,
    CANONICAL_SOURCE_TYPES.FILE,
    s3Result.key
  )

  const dbCreateDuration = await createReviewRecord(
    reviewId,
    s3Result,
    title,
    content.length,
    logger,
    userId,
    mimeType,
    SOURCE_TYPE_FILE
  )

  const sqsSendDuration = await queueReviewJob(
    reviewId,
    s3Result,
    title,
    content.length,
    headers,
    logger
  )

  return {
    s3Result,
    canonicalResult,
    s3UploadDuration,
    canonicalDuration,
    dbCreateDuration,
    sqsSendDuration
  }
}

/**
 * Validates the uploaded file and extracts its text content.
 * Returns `{ errorResponse }` on any validation failure, or
 * `{ filename, mimeType, buffer, extractedText }` on success.
 */
async function validateAndPrepareContent(file, logger, h) {
  if (!file?.hapi) {
    return {
      errorResponse: h
        .response({ success: false, message: ERROR_MESSAGES.NO_FILE })
        .code(HTTP_STATUS.BAD_REQUEST)
    }
  }

  const { filename, mimeType, filenameLower } = getFileMetadata(file)
  logger.info(
    { filename, mimeType, endpoint: ENDPOINT_UPLOAD },
    'File upload request received'
  )

  if (!isAcceptedType(mimeType, filenameLower)) {
    return {
      errorResponse: h
        .response({ success: false, message: ERROR_MESSAGES.INVALID_TYPE })
        .code(HTTP_STATUS.BAD_REQUEST)
    }
  }

  const buffer = await streamToBuffer(file)
  const bufferError = validateBuffer(buffer, h)
  if (bufferError) {
    return { errorResponse: bufferError }
  }

  const extractedText = await textExtractor.extractText(
    buffer,
    mimeType,
    filename
  )
  if (!extractedText?.trim()) {
    return {
      errorResponse: h
        .response({ success: false, message: ERROR_MESSAGES.NO_TEXT })
        .code(HTTP_STATUS.BAD_REQUEST)
    }
  }

  return { filename, mimeType, buffer, extractedText }
}

/**
 * Logs the pipeline completion and returns the 202 Accepted response.
 */
function respondSuccess(
  logger,
  h,
  reviewId,
  filename,
  mimeType,
  pipelineResult,
  totalDuration
) {
  logger.info(
    {
      reviewId,
      filename,
      mimeType,
      s3Key: pipelineResult.s3Result.key,
      canonicalKey: pipelineResult.canonicalResult?.s3?.key,
      totalDurationMs: totalDuration,
      s3UploadDuration: pipelineResult.s3UploadDuration,
      canonicalDuration: pipelineResult.canonicalDuration,
      dbCreateDuration: pipelineResult.dbCreateDuration,
      sqsSendDuration: pipelineResult.sqsSendDuration,
      endpoint: ENDPOINT_UPLOAD
    },
    `[UPLOAD PHASE] File review queued successfully — TOTAL: ${totalDuration}ms`
  )
  return h
    .response({
      success: true,
      reviewId,
      status: REVIEW_STATUSES.PENDING,
      message: 'File uploaded and queued for review'
    })
    .code(HTTP_STATUS.ACCEPTED)
}

/**
 * Logs the error and returns a 500 response.
 */
function respondError(error, logger, totalDuration, h) {
  logger.error(
    {
      error: error.message,
      errorName: error.name,
      stack: error.stack,
      durationMs: totalDuration
    },
    `Failed to process file upload after ${totalDuration}ms`
  )
  return h
    .response({
      success: false,
      message: error.message || ERROR_MESSAGES.PIPELINE_FAILED
    })
    .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
}

/**
 * POST /api/upload handler
 * Accepts a multipart file upload (PDF or DOCX), extracts the text and feeds
 * it through the standard S3 → canonical document → DB → SQS pipeline.
 */
const handleFileUpload = async (request, h) => {
  const requestStartTime = performance.now()

  try {
    const prepared = await validateAndPrepareContent(
      request.payload?.file,
      request.logger,
      h
    )
    if (prepared.errorResponse) {
      return prepared.errorResponse
    }

    const { filename, mimeType, buffer, extractedText } = prepared
    const maxCharLength = config.get('contentReview.maxCharLength')
    const content = extractedText.substring(0, maxCharLength)
    const reviewId = randomUUID()
    const title = filename || 'Uploaded file'
    const userId = request.headers['x-user-id'] || null

    request.logger.info(
      {
        reviewId,
        filename,
        mimeType,
        bufferBytes: buffer.length,
        extractedChars: extractedText.length,
        truncatedChars: content.length
      },
      '[STEP 1/6] File validated and text extracted — starting pipeline'
    )

    const pipelineResult = await runPipeline(
      content,
      reviewId,
      title,
      mimeType,
      userId,
      request.headers,
      request.logger
    )
    const totalDuration = Math.round(performance.now() - requestStartTime)

    return respondSuccess(
      request.logger,
      h,
      reviewId,
      filename,
      mimeType,
      pipelineResult,
      totalDuration
    )
  } catch (error) {
    const totalDuration = Math.round(performance.now() - requestStartTime)
    return respondError(error, request.logger, totalDuration, h)
  }
}

export const uploadRoutes = {
  plugin: {
    name: 'upload-routes',
    register: async (server) => {
      server.route({
        method: 'POST',
        path: ENDPOINT_UPLOAD,
        options: {
          payload: {
            output: 'stream',
            parse: true,
            multipart: true,
            maxBytes: MAX_FILE_BYTES
          },
          cors: getCorsConfig()
        },
        handler: handleFileUpload
      })
    }
  }
}
