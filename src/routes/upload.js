import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { SOURCE_TYPES as CANONICAL_SOURCE_TYPES } from '../common/helpers/canonical-document.js'
import {
  HTTP_STATUS,
  REVIEW_STATUSES,
  getCorsConfig,
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
  const hasValidMime = Object.hasOwn(ACCEPTED_MIME_TYPES, mimeType)
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
  buffer,
  reviewId,
  title,
  mimeType,
  userId,
  headers,
  logger
) {

  // STEP 2: upload raw original file to cdp-uploader (audit copy)
  const s3UploadStart = performance.now()

  const rawS3Result = await uploadFileToCdpUploader(
    buffer,
    title,
    mimeType,
    logger
  )

  const s3UploadDuration = Math.round(performance.now() - s3UploadStart)

  const rawS3Key = rawS3Result.key || rawS3Result.location || null

  const { canonicalResult, canonicalDuration } = await createCanonicalDocument(
    null,
    reviewId,
    title,
    logger,
    CANONICAL_SOURCE_TYPES.FILE,
    rawS3Key
    )

  const charCount = canonicalResult?.document?.charCount || 0

  // STEP 5: Create review record in DB pointing to the canonical document key
  const dbCreateDuration = await createReviewRecord(
    reviewId,
    canonicalResult.s3,
    title,
    charCount,
    logger,
    { userId, mimeType, dbSourceType: SOURCE_TYPE_FILE }
  )

  // STEP 6: Queue SQS job referencing canonical document (worker reads documents/{reviewId}.json)
  const sqsSendDuration = await queueReviewJob(
    reviewId,
    canonicalResult.s3,
    title,
    charCount,
    headers,
    logger
  )

  return {
    s3Result: rawS3Result,
    canonicalResult,
    s3UploadDuration: s3UploadDuration,
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
  return { filename, mimeType, file }
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
 * Sleep helper
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll a status url until upload is ready or timeout
 */
async function pollStatus(statusUrl, timeoutMs, interval, logger) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(statusUrl, {
        method: 'GET',
        headers: { Accept: 'application/json'}
      })
      if (r.ok) {
        const data = await r.json().catch(() => null)
        const state = data?.uploadStatus || data?.status || data?.state
        logger.info({ statusUrl, state }, 'cdp-uploader status poll')
        if (state === 'ready' || state === 'completed' || state === 'succeeded') return data
        if (state === 'failed' || state === 'error') {
          throw new Error(`cdp-uploader reported upload failed: ${JSON.stringify(data)}`)
        }
      } else {
        logger.warn({ status: r.status, statusUrl }, 'cdp-uploader status poll returned non-2xx')
      }
    } catch (err) {
      logger.warn({ err: err.message, statusUrl }, 'Error polling cdp-uploader status (will retry)')
    }
    await sleep(interval)
  }
  throw new Error('Timeout waiting for cdp-uploader status')
}

/**
 * Upload a file to cdp-uploader by:
 *  1) calling /uploads/initiate to get uploadId / uploadUrl metadata
 *  2) performing the actual upload to the provided uploadUrl (presigned S3 or direct)
 *  4) polling status URL until upload is processed and ready, or failed (optional, if statusUrl provided)
 *
 * Returns: { bucket, key, location, size, uploadId, statusResponse }
 * Throws on fatal errors.
 */
async function uploadFileToCdpUploader(buffer, filename, mimeType, logger) {
  const CDP_UPLOADER = (config.get('cdpUploader.url') || '').replace(/\/$/, '')
  const timeoutMs = config.get('cdpUploader.pollTimeoutMs') || 60_000
  const interval = config.get('cdpUploader.pollIntervalMs') || 1500
  const S3_BUCKET = config.get('cdpUploader.s3Bucket')

  if (!CDP_UPLOADER) {
    throw new Error('cdp-uploader base URL not configured')
  }

   // STEP 1: initiate
  const initBody = {
    s3Bucket: S3_BUCKET,
    filename,
    contentType: mimeType,
    size: buffer.length,
    metadata: { source: 'content-reviewer-backend', requestId: randomUUID() }
  }

  const initStart = performance.now()
  const initResp = await fetch(`${CDP_UPLOADER.replace(/\/$/, '')}/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'content-reviewer-backend'},
    body: JSON.stringify(initBody)
  })

if (!initResp.ok) {
    const txt = await initResp.text().catch(() => '')
    logger.error({ status: initResp.status, body: txt }, 'cdp-uploader /initiate failed')
    throw new Error(`cdp-uploader initiate failed: ${initResp.status}`)
  }
  const initJson = await initResp.json().catch(() => ({}))
  const uploadId = initJson?.uploadId || initJson?.id || null
  const uploadUrl = initJson?.uploadUrl || initJson?.presignedUrl || null
  const uploadMethod = (initJson?.uploadMethod || 'PUT').toUpperCase()
  const statusUrl = initJson?.statusUrl || (uploadId ? `${CDP_UPLOADER}/uploads/${uploadId}/status` : null)

  logger.info({ filename, uploadId, uploadUrl, statusUrl }, 'cdp-uploader initiated')
  const initDuration = Math.round(performance.now() - initStart)

  if (!uploadUrl) {
    throw new Error(`cdp-uploader initiate did not return an uploadUrl`)
  }

  // STEP 2: perform upload
  // presigned or direct upload URL
    const uploadStart = performance.now()
    const uploadRes = await fetch(uploadUrl, {
      method: uploadMethod,
      headers: { 'Content-Type': mimeType },
      body: buffer
    })
    const uploadDuration = Math.round(performance.now() - uploadStart)
    if (!uploadRes.ok && !(uploadRes.status >= 300 && uploadRes.status < 400)) {
      const txt = await uploadRes.text().catch(() => '')
      logger.error({ status: uploadRes.status, body: txt }, 'cdp-uploader raw upload failed')
      throw new Error(`Raw upload failed: ${uploadRes.status}`)
    }
    logger.info({ filename, uploadId, uploadDuration }, 'Uploaded raw bytes to uploadUrl')

  // STEP 3: poll status until ready/failed
  let statusResponse = null
  let bucket = uploadRes?.bucket || initJson?.bucket || null
  let key = uploadRes?.key || initJson?.key || null
  let location = uploadRes?.location || initJson?.location || (bucket && key ? `s3://${bucket}/${key}` : null)
  let size = uploadRes?.size || initJson?.size || buffer.length

  if (statusUrl) {
    statusResponse = await pollStatus(statusUrl, timeoutMs, interval, logger).catch((err) => {
      logger.warn({ err: err.message, uploadId }, 'Polling cdp-uploader status failed or timed out')
      return null
    })

    // if status response contains final bucket/key, adopt them
    if (statusResponse) {
      bucket = bucket || statusResponse?.bucket || statusResponse?.storage?.bucket
      key = key || statusResponse?.key || statusResponse?.storage?.key
      location = location || statusResponse?.location || (bucket && key ? `s3://${bucket}/${key}` : null)
      size = size || statusResponse?.size
    }
  }

  return {
    bucket,
    key,
    location,
    size,
    uploadId,
    statusResponse,
    initDuration
  }
}

/**
 * POST /api/upload handler
 * Accepts a multipart file upload (PDF or DOCX), validates it, uploads the original file to cdp-uploader for safe storage, creates a canonical document record and queues
 * it through canonical document → DB → SQS pipeline.
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

    const { filename, mimeType, file} = prepared
    const reviewId = randomUUID()
    const title = filename || 'Uploaded file'
    const userId = request.headers['x-user-id'] || null

    // ── Buffer validation (size / empty) ──────────────────────────────────
    // Read the stream here so we can validate before entering the pipeline.
    // We re-wrap the buffer as a Readable so runPipeline's streamToBuffer
    // still works without any other changes.
    const buffer = await streamToBuffer(file)
    const bufferError = validateBuffer(buffer, h)
    if (bufferError) return bufferError

    request.logger.info(
      {
        reviewId,
        filename,
        mimeType,
        fileSize: buffer.length
      },
      '[STEP 1/6] File validated  — starting pipeline'
    )

    const pipelineResult = await runPipeline(
      buffer,
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

// export helpers for unit tests and integration use
export { uploadFileToCdpUploader, runPipeline, streamToBuffer }
