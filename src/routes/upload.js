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
const BAD_REQUEST = 400

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
  const rawS3Path = config.get('s3.rawS3Path')
  const callbackUrl = `${serverUrl}${ENDPOINT_CALLBACK}`
  //const redirectUrl = `${serverUrl}/upload-success?reviewId=${reviewId}`
  const redirectUrl = `/upload-success?reviewId=${encodeURIComponent(reviewId)}`
  const initBody = {
    s3Bucket,
    s3Path: rawS3Path,
    redirect: redirectUrl,
    callback: callbackUrl,
    mimeTypes: ACCEPTED_MIME_TYPES,
    maxFileSize: MAX_FILE_BYTES,
    metadata: { reviewId, userId }
  }

  logger.info(
    `[UPLOAD] Initiating CDP Uploader session with callback URL: ${callbackUrl} and redirect URL: ${redirectUrl}`
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
    `[UPLOAD] CDP Uploader session initiated  with uploadId: ${uploadId} and uploadUrl: ${uploadUrl}`
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
 * /initiate
 *
 * The file is buffered from the incoming octet-stream and wrapped in
 * multipart/form-data (field name: 'file') as CDP Uploader expects.
 */
async function performUpload(
  uploadAndScanUrl,
  fileBuffer,
  fileName,
  contentType,
  logger
) {
  try {
    logger.info('[UPLOAD] Sending file to CDP Uploader /upload-and-scan')

    const uploadRes = await fetch(uploadAndScanUrl, {
      method: 'POST',
      body: fileBuffer,
      headers: {
        'Content-Type': contentType,
        'x-filename': encodeURIComponent(fileName)
      },
      redirect: 'follow'
    })

    if (!uploadRes.ok) {
      const txt = await uploadRes.text().catch(() => '')
      logger.error(
        { status: uploadRes.status, body: txt },
        'cdp-uploader /upload-and-scan failed'
      )
      throw new Error(
        `cdp-uploader /upload-and-scan failed: ${uploadRes.status}`
      )
    }

    logger.info(
      { status: uploadRes.status },
      '[UPLOAD] File accepted by CDP Uploader — awaiting callback'
    )

    // Extract final URL after redirect is followed
    const finalUrl = uploadRes.url
    const redirectPath = new URL(finalUrl).pathname

    logger.info({ finalUrl, redirectPath }, '[UPLOAD] Upload completed')
  } catch (error) {
    logger.error(
      { error: error.message, stack: error.stack },
      '[UPLOAD] Upload failed'
    )
    throw new Error(`cdp-uploader /upload-and-scan failed: ${error.message}`)
  }
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

  const userId = request.headers['x-user-id'] || 'content-reviewer-frontend'
  const fileName = request.headers['x-file-name']
    ? decodeURIComponent(request.headers['x-file-name'])
    : `upload-${Date.now()}`

  const mimeType = request.headers['x-file-content-type'] || 'application/pdf'
  const contentType =
    request.headers['content-type'] || 'application/octet-stream'

  request.logger.info(
    `[UPLOAD] Received upload request from userId: ${userId} with filename: ${fileName} and content-type: ${mimeType}`
  )

  const fileStream = request.payload

  request.logger.info(
    `[UPLOAD] Received upload request with content-type: ${request.headers['content-type']}`
  )

  const reviewId = randomUUID()

  try {
    const CDP_UPLOADER = (config.get('cdpUploader.url') || '').replace(
      /\/$/,
      ''
    )
    request.logger.info(`CDP Uploader URL from config: ${CDP_UPLOADER}`)

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

    request.logger.info(
      `[UPLOAD] Upload URL resolved for CDP Uploader: ${uploadAndScanUrl}`
    )

    // Read file stream into buffer
    const fileBuffer = await streamToBuffer(fileStream)

    await performUpload(
      uploadAndScanUrl,
      fileBuffer,
      fileName,
      contentType,
      request.logger
    )

    const totalDuration = Math.round(performance.now() - requestStartTime)
    request.logger.info(
      `[UPLOAD] File sent to CDP Uploader — awaiting callback to complete pipeline with reviewId: ${reviewId}, uploadId: ${uploadId} and totalDurationMs: ${totalDuration}`
    )

    return h
      .response({
        success: true,
        reviewId,
        uploadId,
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

async function streamToBuffer(file) {
  return new Promise((resolve, reject) => {
    const chunks = []

    if (!file.on) {
      // File is already a buffer or blob
      resolve(file)
      return
    }

    file.on('data', (chunk) => {
      chunks.push(chunk)
    })

    file.on('end', () => {
      resolve(Buffer.concat(chunks))
    })

    file.on('error', (error) => {
      reject(new Error(`File stream error: ${error.message}`))
    })
  })
}

/**
 * Validate file exists
 */
function validateFileExists(file, h) {
  if (!file) {
    return h
      .response({
        success: false,
        message: 'No file provided'
      })
      .code(BAD_REQUEST)
  }
  return null
}

/**
 * POST /upload-callback
 *
 * Called by CDP Uploader (server-to-server) after file scanning.
 * Receives complete file metadata.
 * This is where the actual pipeline runs.
 */
const handleUploadCallback = async (request, h) => {
  const requestStartTime = performance.now()

  try {
    const { metadata, form } = request.payload

    // ✅ Extract complete metadata from CDP Uploader POST
    request.logger.info(
      `Upload callback received from CDP Uploader with payload: ${JSON.stringify(request.payload)}`
    )

    // Get file details from form
    const fileField = form.file

    if (fileField.hasError) {
      request.logger.error(
        { errorMessage: fileField.errorMessage },
        'File rejected with error in callback'
      )
      return h
        .response({
          success: false,
          message: fileField.errorMessage || 'File validation failed'
        })
        .code(HTTP_STATUS.OK)
    }

    // validateUploadCallbackPayload(
    //   uploadStatus,
    //   numberOfRejectedFiles,
    //   fileField
    // )

    // const userId = metadata?.userId
    const reviewId = metadata?.reviewId

    // const { contentType, s3Key, filename } = fileField

    // request.logger.info(
    //   { userId, reviewId, contentType, s3Key, filename },
    //   'Processing uploaded file for review'
    // )

    // // ✅ Run pipeline ASYNCHRONOUSLY (don't await)
    // // So we can return quickly to CDP Uploader
    // runCallbackPipeline(
    //   s3Key,
    //   filename,
    //   contentType,
    //   reviewId,
    //   userId,
    //   request.logger
    // ).catch((error) => {
    //   request.logger.error(
    //     {
    //       reviewId,
    //       error: error.message,
    //       stack: error.stack
    //     },
    //     '[CALLBACK] Async pipeline failed'
    //   )
    // })

    // const totalDuration = Math.round(performance.now() - requestStartTime)

    // request.logger.info(
    //   {
    //     reviewId,
    //     totalDurationMs: totalDuration
    //   },
    //   '[CALLBACK] Pipeline started asynchronously'
    // )

    // ✅ Return 200 OK to CDP Uploader immediately
    return h
      .response({
        success: true,
        message: 'Callback received'
      })
      .code(HTTP_STATUS.OK)
  } catch (error) {
    const totalDuration = Math.round(performance.now() - requestStartTime)

    request.logger.error(
      {
        error: error.message,
        stack: error.stack,
        durationMs: totalDuration
      },
      '[CALLBACK] Handler failed'
    )

    return h
      .response({ success: false, message: error.message })
      .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  }
}

// Validate the callback payload structure and values
function validateUploadCallbackPayload(
  uploadStatus,
  numberOfRejectedFiles,
  fileField
) {
  if (uploadStatus !== 'ready') {
    const error = new Error('Upload not ready yet')
    error.statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR
    error.details = { uploadStatus }
    throw error
  }

  if (numberOfRejectedFiles > 0) {
    const error = new Error(
      `Upload validation failed: ${numberOfRejectedFiles} files rejected`
    )
    error.statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR
    error.details = { numberOfRejectedFiles }
    throw error
  }

  if (fileField?.fileStatus !== 'complete') {
    const error = new Error('File not available or incomplete')
    error.statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR
    error.details = { fileStatus: fileField?.fileStatus }
    throw error
  }

  if (fileField?.hasError) {
    const errorMessage = fileField.errorMessage || 'File validation failed'
    const error = new Error(errorMessage)
    error.statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR
    error.details = { hasError: true, errorMessage }
    throw error
  }
}

// ─── POST /upload-callback ───────────────────────────────────────────────────

/**
 * Run the canonical document → DB record → SQS pipeline for a successfully
 * scanned file.  Called asynchronously from handleUploadCallback so the 200
 * response is sent to CDP Uploader before this work begins.
 */
async function runCallbackPipeline(
  s3Key,
  fileName,
  contentType,
  reviewId,
  userId,
  logger
) {
  logger.info(
    { reviewId, s3Key, fileName, contentType },
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
    { userId, contentType, dbSourceType: SOURCE_TYPE_FILE }
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
 * GET /upload-success
 *
 * Called by browser after CDP Uploader redirect.
 * Used for UX (show success message).
 * Real data processing happens in /upload-callback (POST).
 */
const handleUploadSuccess = async (request, h) => {
  try {
    const { reviewId } = request.query

    request.logger.info(
      {
        reviewId,
        source: 'browser-redirect'
      },
      '[REDIRECT] Browser redirected from CDP Uploader'
    )

    // ✅ Can either:
    // 1. Return JSON response (for frontend to handle)

    // Option 1: Return JSON (for single-page app)
    return h
      .response({
        success: true,
        message: 'File upload completed successfully',
        reviewId,
        status: 'processing' // Pipeline is running asynchronously
      })
      .code(HTTP_STATUS.OK)
  } catch (error) {
    request.logger.error(
      { error: error.message, query: request.query },
      '[REDIRECT] Handler failed'
    )

    return h
      .response({ success: false, message: error.message })
      .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  }
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
            output: 'stream', // ✅ Return payload as stream
            parse: false, // ✅ Don't parse - raw binary
            maxBytes: 10 * 1024 * 1024, // ✅ Max 10MB
            allow: 'application/octet-stream' // ✅ Only accept octet-stream
          },
          cors: getCorsConfig()
        },
        handler: handleFileUpload
      })
      server.route({
        method: 'POST',
        path: ENDPOINT_CALLBACK,
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
    }
  }
}
