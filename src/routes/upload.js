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

const ACCEPTED_MIME_TYPES = {
  'application/pdf': true,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true
}

const ACCEPTED_EXTENSIONS = ['.pdf', '.docx']

/**
 * Read a Hapi multipart stream field into a Buffer.
 * @param {import('stream').Readable} stream
 * @returns {Promise<Buffer>}
 */
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/**
 * POST /api/upload
 * Accepts a multipart file upload (PDF or DOCX), extracts the text and feeds
 * it through the standard S3 → canonical document → DB → SQS pipeline.
 */
const handleFileUpload = async (request, h) => {
  const requestStartTime = performance.now()

  try {
    const file = request.payload?.file

    if (!file || !file.hapi) {
      return h
        .response({ success: false, message: 'No file provided' })
        .code(HTTP_STATUS.BAD_REQUEST)
    }

    const { filename, headers: fileHeaders } = file.hapi
    const mimeType = fileHeaders?.['content-type'] ?? ''
    const filenameLower = (filename ?? '').toLowerCase()

    request.logger.info(
      { filename, mimeType, endpoint: ENDPOINT_UPLOAD },
      'File upload request received'
    )

    // Validate file type by MIME and extension
    const hasValidMime = Object.prototype.hasOwnProperty.call(
      ACCEPTED_MIME_TYPES,
      mimeType
    )
    const hasValidExt = ACCEPTED_EXTENSIONS.some((ext) =>
      filenameLower.endsWith(ext)
    )

    if (!hasValidMime && !hasValidExt) {
      return h
        .response({
          success: false,
          message: 'The selected file must be a PDF or Word document'
        })
        .code(HTTP_STATUS.BAD_REQUEST)
    }

    // Read the stream into a buffer so we can validate size and extract text
    const buffer = await streamToBuffer(file)

    if (buffer.length === 0) {
      return h
        .response({ success: false, message: 'The uploaded file is empty' })
        .code(HTTP_STATUS.BAD_REQUEST)
    }

    if (buffer.length > MAX_FILE_BYTES) {
      return h
        .response({
          success: false,
          message: 'The file must be smaller than 10 MB'
        })
        .code(HTTP_STATUS.BAD_REQUEST)
    }

    // Extract text from PDF or DOCX
    const extractedText = await textExtractor.extractText(
      buffer,
      mimeType,
      filename
    )

    if (!extractedText || extractedText.trim().length === 0) {
      return h
        .response({
          success: false,
          message: 'No text could be extracted from the file'
        })
        .code(HTTP_STATUS.BAD_REQUEST)
    }

    // Truncate to the configured maximum character length
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

    // STEP 2: Upload raw extracted text to S3
    const { s3Result, s3UploadDuration } = await uploadTextToS3(
      content,
      reviewId,
      title,
      request.logger
    )

    // STEP 3: Create canonical document in S3
    const { canonicalResult, canonicalDuration } =
      await createCanonicalDocument(
        content,
        reviewId,
        title,
        request.logger,
        CANONICAL_SOURCE_TYPES.FILE,
        s3Result.key
      )

    // STEP 4: Create review record in the DB/S3 repository
    const dbCreateDuration = await createReviewRecord(
      reviewId,
      s3Result,
      title,
      content.length,
      request.logger,
      userId,
      mimeType,
      'file' // SOURCE_TYPES.FILE
    )

    // STEP 5–6: Queue the review job via SQS
    const sqsSendDuration = await queueReviewJob(
      reviewId,
      s3Result,
      title,
      content.length,
      request.headers,
      request.logger
    )

    const totalDuration = Math.round(performance.now() - requestStartTime)

    request.logger.info(
      {
        reviewId,
        filename,
        mimeType,
        s3Key: s3Result.key,
        canonicalKey: canonicalResult?.s3?.key,
        totalDurationMs: totalDuration,
        s3UploadDuration,
        canonicalDuration,
        dbCreateDuration,
        sqsSendDuration,
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
  } catch (error) {
    const totalDuration = Math.round(performance.now() - requestStartTime)

    request.logger.error(
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
        message: error.message || 'Failed to process file upload'
      })
      .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
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
