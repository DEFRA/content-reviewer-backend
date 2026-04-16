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
const DEFAULT_POLL_TIMEOUT_MS = 60_000 // 60 seconds
const DEFAULT_POLL_INTERVAL_MS = 1_500 // 1.5 seconds

const ACCEPTED_MIME_TYPES = {
  'application/pdf': true,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true
}

const ERROR_MESSAGES = {
  NO_FILE: 'No file provided',
  INVALID_TYPE: 'The selected file must be a PDF or Word document',
  EMPTY_FILE: 'The uploaded file is empty',
  FILE_TOO_LARGE: 'The file must be smaller than 10 MB',
  NO_TEXT: 'No text could be extracted from the file',
  PIPELINE_FAILED: 'Failed to process file upload'
}

/**
 * Runs the S3 upload → canonical document → DB record → SQS queue pipeline.
 */
async function runPipeline(
  fileMultipartStream,
  reviewId,
  contentType,
  userId,
  headers,
  logger,
  fallbackFileName
) {
  // STEP 2: upload raw original file to cdp-uploader (audit copy)
  const s3UploadStart = performance.now()

  const rawS3Result = await uploadFileToCdpUploader(
    fileMultipartStream,
    contentType,
    logger
  )

  const s3UploadDuration = Math.round(performance.now() - s3UploadStart)

  const rawS3Key = rawS3Result.key
  const fileName = rawS3Result.fileName ?? fallbackFileName
  const mimeType = rawS3Result.mimeType

  const { canonicalResult, canonicalDuration } = await createCanonicalDocument(
    null,
    reviewId,
    fileName,
    logger,
    CANONICAL_SOURCE_TYPES.FILE,
    rawS3Key
  )

  const charCount = canonicalResult?.document?.charCount || 0

  // STEP 5: Create review record in DB pointing to the canonical document key
  const dbCreateDuration = await createReviewRecord(
    reviewId,
    canonicalResult.s3,
    fileName,
    charCount,
    logger,
    { userId, mimeType, dbSourceType: SOURCE_TYPE_FILE }
  )

  // STEP 6: Queue SQS job referencing canonical document (worker reads documents/{reviewId}.json)
  const sqsSendDuration = await queueReviewJob(
    reviewId,
    canonicalResult.s3,
    fileName,
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
 * Classify a cdp-uploader file status string.
 * Returns 'done', 'rejected', or 'pending'.
 */
function classifyFileStatus(fileStatus) {
  if (fileStatus === 'complete') {
    return 'done'
  }
  if (fileStatus === 'rejected') {
    return 'rejected'
  }
  return 'pending'
}

/**
 * Perform a single status poll request.
 * Returns { data, classification } on 2xx, or null on non-2xx.
 * Throws on network error so the caller can catch and warn.
 */
async function fetchStatus(statusUrl, logger) {
  const uploadStatusResp = await fetch(statusUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  })

  if (!uploadStatusResp.ok) {
    logger.warn(
      { status: uploadStatusResp.status, statusUrl },
      'cdp-uploader status poll returned non-2xx'
    )
    return null
  }
  const data = await uploadStatusResp.json().catch(() => null)
  const uploadStatus = data?.uploadStatus
  const fileStatus = data?.form?.file?.fileStatus
  const classification = classifyFileStatus(fileStatus)

  logger.info(
    { statusUrl, uploadStatus, fileStatus },
    'cdp-uploader status poll'
  )
  return { data, uploadStatus, classification }
}

/**
 * Poll a status URL until upload is complete, rejected, or timed out.
 * Returns the status data object on success, null on timeout/rejected.
 * Max nesting depth: 3
 */
async function pollStatus(statusUrl, timeoutMs, interval, logger) {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      const polled = await fetchStatus(statusUrl, logger)

      if (
        polled?.uploadStatus === 'ready' &&
        (polled?.classification === 'done' ||
          polled?.classification === 'rejected')
      ) {
        return polled.data
      }
    } catch (err) {
      logger.warn(
        { err: err.message, statusUrl },
        'Error polling cdp-uploader status (will retry)'
      )
    }

    await sleep(interval)
  }

  logger.warn({ statusUrl }, 'Timed out waiting for cdp-uploader status')
  return null
}

/**
 * Call /initiate and return { uploadId, uploadUrl, statusUrl }.
 * Throws on non-2xx.
 */
async function initiateUpload(cdpUploaderUrl, s3Bucket, logger) {
  const initBody = {
    s3Bucket: s3Bucket,
    redirect: 'manual',
    maxFileSize: MAX_FILE_BYTES,
    mimeTypes: Object.keys(ACCEPTED_MIME_TYPES),
    metadata: { source: 'content-reviewer-backend', requestId: randomUUID() }
  }

  const initResp = await fetch(`${cdpUploaderUrl}/initiate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'content-reviewer-backend'
    },
    body: JSON.stringify(initBody)
  })

  if (!initResp.ok) {
    const txt = await initResp.text().catch(() => '')
    logger.error(
      { status: initResp.status, body: txt },
      'cdp-uploader /initiate failed'
    )
    throw new Error(`cdp-uploader initiate failed: ${initResp.status}`)
  }

  const initJson = await initResp.json().catch(() => ({}))

  return {
    uploadId: initJson?.uploadId,
    uploadUrl: initJson?.uploadUrl,
    statusUrl: initJson?.statusUrl
  }
}

/**
 * PUT/POST the raw multi-part file to the presigned uploadUrl.
 * Throws on non-2xx.
 */
async function performUpload(
  uploadAndScanUrl,
  fileMultipartStream,
  contentType,
  logger
) {
  const uploadRes = await fetch(uploadAndScanUrl, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: fileMultipartStream
  })

  if (!uploadRes.ok) {
    const txt = await uploadRes.text().catch(() => '')
    logger.error(
      { status: uploadRes.status, body: txt },
      'cdp-uploader raw upload failed'
    )
    throw new Error(`Raw upload failed: ${uploadRes.status}`)
  }
}

/**
 * Log S3 details from the status response if available.
 */
function logS3Details(statusData) {
  const file = statusData?.form?.file
  if (!file?.s3Bucket && !file?.s3Key) {
    return
  }

  console.log('S3 DETAILS:')
  console.log('- S3 Bucket:', file.s3Bucket)
  console.log('- S3 Key:', file.s3Key)
  console.log('- Filename:', file.filename)
  console.log('- Content Type:', file.detectedContentType)
}

/**
 * Poll for status and extract bucket/key from the result.
 * Returns { bucket, key, statusData }.
 */
async function resolveS3Location(
  uploadStatusUrl,
  timeoutMs,
  interval,
  uploadId,
  logger
) {
  const statusData = await pollStatus(
    uploadStatusUrl,
    timeoutMs,
    interval,
    logger
  ).catch((err) => {
    logger.warn(
      { err: err.message, uploadId },
      'Polling cdp-uploader status failed or timed out'
    )
    return null
  })

  // ✅ check hasError from statusData
  const fileStatus = statusData?.form?.file
  const hasError = fileStatus?.hasError

  if (hasError) {
    const errorMessage =
      fileStatus?.errorMessage ?? 'Unknown error from cdp-uploader'
    logger.error(
      {
        uploadId,
        hasError,
        errorMessage,
        fileStatus: fileStatus?.fileStatus
      },
      `cdp-uploader reported file error: ${errorMessage}`
    )
    throw new Error(errorMessage)
  }

  logS3Details(statusData)

  return {
    bucket: statusData?.form?.file?.s3Bucket ?? null,
    key: statusData?.form?.file?.s3Key ?? null,
    fileName: statusData?.form?.file?.filename ?? null,
    mimeType: statusData?.form?.file?.detectedContentType ?? null
  }
}

/**
 * Upload a file to cdp-uploader:
 *  1) /initiate  → get uploadId / uploadUrl / statusUrl
 *  2) upload buffer to uploadUrl
 *  3) poll status until ready or failed
 *
 * Returns { bucket, key }. Throws on fatal errors.
 */
async function uploadFileToCdpUploader(
  fileMultipartStream,
  contentType,
  logger
) {
  const CDP_UPLOADER = (config.get('cdpUploader.url') || '').replace(/\/$/, '')
  const timeoutMs =
    config.get('cdpUploader.pollTimeoutMs') || DEFAULT_POLL_TIMEOUT_MS
  const interval =
    config.get('cdpUploader.pollIntervalMs') || DEFAULT_POLL_INTERVAL_MS
  const S3_BUCKET = config.get('s3.bucket')

  if (!CDP_UPLOADER) {
    throw new Error('cdp-uploader base URL not configured')
  }

  const { uploadId, uploadUrl, statusUrl } = await initiateUpload(
    CDP_UPLOADER,
    S3_BUCKET,
    logger
  )

  logger.info(
    { uploadId, uploadUrl, statusUrl },
    'cdp-uploader initiated successfully'
  )

  if (!uploadUrl) {
    throw new Error('cdp-uploader initiate did not return an uploadUrl')
  }

  const uploadAndScanUrl = new URL(uploadUrl, CDP_UPLOADER).href
  logger.info({ uploadAndScanUrl }, 'Uploading file to cdp-uploader')

  await performUpload(
    uploadAndScanUrl,
    fileMultipartStream,
    contentType,
    logger
  )

  if (!statusUrl) {
    throw new Error('cdp-uploader initiate did not return an statusUrl')
  }

  const uploadStatusUrl = new URL(statusUrl, CDP_UPLOADER).href

  logger.info({ uploadStatusUrl }, 'Polling cdp-uploader for upload status')

  const { bucket, key, fileName, mimeType } = await resolveS3Location(
    uploadStatusUrl,
    timeoutMs,
    interval,
    uploadId,
    logger
  )

  return { bucket, key, fileName, mimeType }
}

/**
 * POST /api/upload handler
 * Accepts a multipart file upload (PDF or DOCX), validates it, uploads the original file to cdp-uploader for safe storage, creates a canonical document record and queues
 * it through canonical document → DB → SQS pipeline.
 */
const handleFileUpload = async (request, h) => {
  const requestStartTime = performance.now()

  const contentType = request.headers['Content-Type']
  const contentLength = request.headers['Content-Length']
  const rawFileName = request.headers['x-file-name']
  const fileName = rawFileName ? decodeURIComponent(rawFileName) : null

  const reviewId = randomUUID()
  const userId = request.headers['x-user-id'] || null

  request.logger.info(
    {
      reviewId,
      contentType,
      fileName,
      fileSize: contentLength
    },
    '[STEP 1/6] File validated  — starting pipeline'
  )

  try {
    const pipelineResult = await runPipeline(
      request.payload,
      reviewId,
      contentType,
      userId,
      request.headers,
      request.logger,
      fileName
    )
    const totalDuration = Math.round(performance.now() - requestStartTime)

    return respondSuccess(
      request.logger,
      h,
      reviewId,
      pipelineResult.s3Result.fileName ?? fileName,
      pipelineResult.s3Result.mimeType,
      pipelineResult,
      totalDuration
    )
  } catch (error) {
    const totalDuration = Math.round(performance.now() - requestStartTime)
    // ✅ respondError sends error.message to frontend
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
            parse: false,
            multipart: false,
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
export { uploadFileToCdpUploader, runPipeline }
