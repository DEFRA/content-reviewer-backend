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
const ENDPOINT_CALLBACK = '/upload-callback'
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
const SOURCE_TYPE_FILE = 'file'
const HTTP_REDIRECT_MIN = 300
const HTTP_REDIRECT_MAX = 400

const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]

// ─── Step 1: /initiate ───────────────────────────────────────────────────────

/**
 * POST /initiate — tell CDP Uploader we are starting a new upload.
 *
 * Per the CDP Uploader docs:
 *  - redirect: 'manual' — we are a server client, not a browser; no browser
 *    redirect is needed after the file is scanned.
 *  - callback: our /upload-callback URL — CDP Uploader POSTs here when
 *    scanning + S3 delivery is complete (server-to-server notification).
 *  - metadata: { reviewId, userId } — echoed back verbatim in the callback
 *    payload so we can correlate the result to our review record.
 *
 * Returns { uploadId, uploadUrl } from the CDP Uploader response.
 */
async function initiateUpload(
  cdpUploaderUrl,
  s3Bucket,
  reviewId,
  userId,
  logger
) {
  const serverUrl = (config.get('serverUrl') || '').replace(/\/$/, '')
  const callbackUrl = `${serverUrl}${ENDPOINT_CALLBACK}`

  const initBody = {
    s3Bucket,
    redirect: 'manual',
    callback: callbackUrl,
    mimeTypes: ACCEPTED_MIME_TYPES,
    maxFileSize: MAX_FILE_BYTES,
    metadata: { reviewId, userId }
  }

  logger.info(
    { cdpUploaderUrl, callbackUrl, reviewId },
    '[UPLOAD] Initiating CDP Uploader session'
  )

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
    throw new Error(`cdp-uploader /initiate failed: ${initResp.status}`)
  }

  const initJson = await initResp.json().catch(() => ({}))
  const { uploadId, uploadUrl } = initJson

  if (!uploadUrl) {
    throw new Error('cdp-uploader /initiate did not return an uploadUrl')
  }

  logger.info(
    { uploadId, uploadUrl },
    '[UPLOAD] CDP Uploader session initiated'
  )
  return { uploadId, uploadUrl }
}

// ─── Step 2: /upload-and-scan ────────────────────────────────────────────────

/**
 * POST /upload-and-scan/{uploadId} — send the file to CDP Uploader for virus
 * scanning and quarantine.
 *
 * CDP Uploader returns HTTP 302 on success (it redirects a browser to the
 * 'redirect' path from /initiate).  Because we passed redirect:'manual' in
 * /initiate and we set redirect:'manual' on the fetch itself, we accept any
 * 3xx as a success — we never follow the redirect.
 *
 * The file is buffered from the incoming octet-stream and wrapped in
 * multipart/form-data (field name: 'file') as CDP Uploader expects.
 */
async function performUpload(uploadAndScanUrl, fileStream, fileName, logger) {
  // Buffer the incoming stream — avoids the Node.js 18+ 'duplex' requirement
  // that applies when passing a ReadableStream as a fetch body.
  const chunks = []
  for await (const chunk of fileStream) {
    chunks.push(chunk)
  }
  const fileBuffer = Buffer.concat(chunks)

  const formData = new FormData()
  formData.append('file', new Blob([fileBuffer]), fileName ?? 'upload')

  logger.info(
    { uploadAndScanUrl, fileSize: fileBuffer.length, fileName },
    '[UPLOAD] Sending file to CDP Uploader /upload-and-scan'
  )

  const uploadRes = await fetch(uploadAndScanUrl, {
    method: 'POST',
    body: formData,
    redirect: 'manual' // CDP Uploader returns 302 — accept it, do not follow
  })

  // 2xx = immediate success (shouldn't happen in practice)
  // 3xx = expected redirect response from CDP Uploader — treat as success
  // anything else = genuine error
  const isSuccess =
    uploadRes.ok ||
    (uploadRes.status >= HTTP_REDIRECT_MIN &&
      uploadRes.status < HTTP_REDIRECT_MAX)
  if (!isSuccess) {
    const txt = await uploadRes.text().catch(() => '')
    logger.error(
      { status: uploadRes.status, body: txt },
      'cdp-uploader /upload-and-scan failed'
    )
    throw new Error(`cdp-uploader /upload-and-scan failed: ${uploadRes.status}`)
  }

  logger.info(
    { status: uploadRes.status },
    '[UPLOAD] File accepted by CDP Uploader — awaiting callback'
  )
}

// ─── POST /api/upload ────────────────────────────────────────────────────────

/**
 * POST /api/upload
 *
 * Receives the file from the frontend (octet-stream with x-file-name header),
 * initiates a CDP Uploader session, and forwards the file for virus scanning.
 *
 * Returns 202 Accepted immediately — the rest of the pipeline (canonical
 * document → DB record → SQS) runs asynchronously inside handleUploadCallback
 * once CDP Uploader POSTs back to /upload-callback.
 */
const handleFileUpload = async (request, h) => {
  const requestStartTime = performance.now()

  // Hapi normalises all header names to lowercase
  const rawFileName = request.headers['x-file-name']
  const fileName = rawFileName ? decodeURIComponent(rawFileName) : null
  const contentLength = request.headers['content-length']
  const reviewId = randomUUID()
  const userId = request.headers['x-user-id'] || null

  request.logger.info(
    { reviewId, fileName, fileSize: contentLength },
    '[UPLOAD] File received — initiating CDP Uploader session'
  )

  try {
    const CDP_UPLOADER = (config.get('cdpUploader.url') || '').replace(
      /\/$/,
      ''
    )
    const S3_BUCKET = config.get('s3.bucket')

    if (!CDP_UPLOADER) {
      throw new Error('CDP Uploader URL not configured (CDP_UPLOADER_URL)')
    }

    const { uploadId, uploadUrl } = await initiateUpload(
      CDP_UPLOADER,
      S3_BUCKET,
      reviewId,
      userId,
      request.logger
    )

    // uploadUrl from CDP Uploader is a relative path — resolve against the
    // CDP Uploader base URL to get the absolute upload-and-scan endpoint.
    const uploadAndScanUrl = new URL(uploadUrl, CDP_UPLOADER).href

    await performUpload(
      uploadAndScanUrl,
      request.payload,
      fileName,
      request.logger
    )

    const totalDuration = Math.round(performance.now() - requestStartTime)
    request.logger.info(
      { reviewId, uploadId, totalDurationMs: totalDuration },
      '[UPLOAD] File sent to CDP Uploader — awaiting callback to complete pipeline'
    )

    return h
      .response({
        success: true,
        reviewId,
        status: REVIEW_STATUSES.PENDING,
        message: 'File uploaded — review queued'
      })
      .code(HTTP_STATUS.ACCEPTED)
  } catch (error) {
    const totalDuration = Math.round(performance.now() - requestStartTime)
    request.logger.error(
      {
        reviewId,
        error: error.message,
        stack: error.stack,
        durationMs: totalDuration
      },
      '[UPLOAD] Upload failed'
    )
    return h
      .response({ success: false, message: error.message })
      .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  }
}

// ─── POST /upload-callback ───────────────────────────────────────────────────

/**
 * Run the canonical document → DB record → SQS pipeline for a successfully
 * scanned file.  Called asynchronously from handleUploadCallback so the 200
 * response is sent to CDP Uploader before this work begins.
 */
async function runCallbackPipeline(file, reviewId, userId, logger) {
  const s3Key = file.s3Key
  const fileName = file.filename
  const mimeType = file.detectedContentType ?? file.contentType

  logger.info(
    { reviewId, s3Key, fileName, mimeType },
    '[CALLBACK] Starting canonical document pipeline'
  )

  const { canonicalResult, canonicalDuration } = await createCanonicalDocument(
    null,
    reviewId,
    fileName,
    logger,
    CANONICAL_SOURCE_TYPES.FILE,
    s3Key
  )

  const charCount = canonicalResult?.document?.charCount ?? 0

  const dbCreateDuration = await createReviewRecord(
    reviewId,
    canonicalResult.s3,
    fileName,
    charCount,
    logger,
    { userId, mimeType, dbSourceType: SOURCE_TYPE_FILE }
  )

  const sqsSendDuration = await queueReviewJob(
    reviewId,
    canonicalResult.s3,
    fileName,
    charCount,
    {},
    logger
  )

  logger.info(
    { reviewId, canonicalDuration, dbCreateDuration, sqsSendDuration },
    '[CALLBACK] Pipeline completed — review queued for AI processing'
  )
}

/**
 * POST /upload-callback
 *
 * CDP Uploader calls this endpoint (server-to-server) once virus scanning is
 * complete and the file has been delivered to S3.
 *
 * Payload shape (same as GET /status/{uploadId}):
 * {
 *   uploadStatus: "ready",
 *   metadata: { reviewId, userId },        ← echoed from /initiate
 *   form: { file: { filename, s3Key, s3Bucket, detectedContentType,
 *                   fileStatus, hasError, errorMessage } },
 *   numberOfRejectedFiles: 0
 * }
 *
 * MUST always return 200 OK — any other status causes CDP Uploader to retry.
 */
const handleUploadCallback = async (request, h) => {
  const { uploadStatus, form, metadata } = request.payload ?? {}
  const { reviewId, userId } = metadata ?? {}
  const file = form?.file

  request.logger.info(
    { uploadStatus, reviewId, fileStatus: file?.fileStatus },
    '[CALLBACK] Received CDP Uploader callback'
  )

  if (!reviewId) {
    request.logger.error(
      { metadata },
      '[CALLBACK] No reviewId in metadata — cannot continue pipeline'
    )
    return h.response({ ok: true }).code(HTTP_STATUS.OK)
  }

  if (
    uploadStatus !== 'ready' ||
    file?.hasError ||
    file?.fileStatus !== 'complete'
  ) {
    request.logger.warn(
      {
        uploadStatus,
        fileStatus: file?.fileStatus,
        errorMessage: file?.errorMessage
      },
      '[CALLBACK] Upload rejected or failed — skipping pipeline'
    )
    return h.response({ ok: true }).code(HTTP_STATUS.OK)
  }

  // Fire pipeline asynchronously — 200 is returned to CDP Uploader immediately
  setImmediate(() => {
    runCallbackPipeline(file, reviewId, userId, request.logger).catch(
      (error) => {
        request.logger.error(
          { reviewId, error: error.message, stack: error.stack },
          '[CALLBACK] Pipeline failed after callback'
        )
      }
    )
  })

  return h.response({ ok: true }).code(HTTP_STATUS.OK)
}

// ─── Route registration ──────────────────────────────────────────────────────

export const uploadRoutes = {
  plugin: {
    name: 'upload-routes',
    register: async (server) => {
      // Step 1 & 2: receive file from frontend, initiate CDP Uploader, send file
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

      // Step 3: CDP Uploader calls back here when scanning + S3 delivery is done
      server.route({
        method: 'POST',
        path: ENDPOINT_CALLBACK,
        options: {
          auth: false,
          payload: { parse: true, allow: 'application/json' }
        },
        handler: handleUploadCallback
      })
    }
  }
}
