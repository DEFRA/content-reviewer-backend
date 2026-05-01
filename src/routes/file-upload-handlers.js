import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { SOURCE_TYPES as CANONICAL_SOURCE_TYPES } from '../common/helpers/canonical-document.js'
import {
  HTTP_STATUS,
  REVIEW_STATUSES,
  createCanonicalDocument,
  createReviewRecord,
  queueReviewJob
} from './review-helpers.js'
import { textExtractor } from '../common/helpers/text-extractor.js'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

// constants (kept local to handlers file)
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
const SOURCE_TYPE_FILE = 'file'
const MAX_REVIEW_CHARS = 100000
const APPLICATION_PDF = 'application/pdf'

const ACCEPTED_MIME_TYPES = [
  APPLICATION_PDF,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]

const uploadStatusStore = new Map()

// ─────────────────────────────────────────────────────────────────────────────
// initiate + upload helpers (used by the upload endpoint)
async function initiateUpload(
  cdpUploaderUrl,
  s3Bucket,
  reviewId,
  userId,
  logger
) {
  const serverUrl = (config.get('serverUrl') || '').replace(/\/$/, '')
  const rawS3Path = config.get('s3.rawS3Path')
  const callbackUrl = `${serverUrl}/upload-callback`
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

async function performUpload(
  uploadAndScanUrl,
  fileBuffer,
  fileName,
  mimeType,
  logger
) {
  try {
    logger.info('[UPLOAD] Sending file to CDP Uploader /upload-and-scan')

    const uploadRes = await fetch(uploadAndScanUrl, {
      method: 'POST',
      body: fileBuffer,
      headers: {
        'Content-Type': mimeType,
        'x-filename': encodeURIComponent(fileName)
      },
      redirect: 'manual'
    })

    if (uploadRes.status >= 300 && uploadRes.status < 400) {
      const location = uploadRes.headers.get('location')
      logger.info(
        `cdp-uploader redirected after upload with Location: ${location} and status: ${uploadRes.status}`
      )
      logger.info(
        `[UPLOAD] File accepted by CDP Uploader — awaiting callback to complete pipeline`
      )
    }
  } catch (error) {
    logger.error(
      { error: error.message, stack: error.stack },
      '[UPLOAD] Upload failed'
    )
    throw new Error(`cdp-uploader /upload-and-scan failed: ${error.message}`)
  }
}

// POST /api/upload handler
export const handleFileUpload = async (request, h) => {
  const requestStartTime = performance.now()

  const userId = request.headers['x-user-id'] || 'content-reviewer-frontend'
  const fileName = request.headers['x-file-name']
    ? decodeURIComponent(request.headers['x-file-name'])
    : `upload-${Date.now()}`

  const mimeType = request.headers['x-file-content-type']

  request.logger.info(
    `[UPLOAD] Received upload request from userId: ${userId} with filename: ${fileName} and content-type: ${mimeType}`
  )

  const fileStream = request.payload

  request.logger.info(
    `[UPLOAD] Received upload request with content-type: ${request.headers['content-type']}`
  )

  const reviewId = randomUUID()

  try {
    if (!fileStream) {
      throw new Error('No file provided')
    }
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
    const uploadAndScanUrl = new URL(uploadUrl, CDP_UPLOADER).href

    request.logger.info(
      `[UPLOAD] Upload URL resolved for CDP Uploader: ${uploadAndScanUrl}`
    )

    const fileBuffer = await streamToBuffer(fileStream)

    await performUpload(
      uploadAndScanUrl,
      fileBuffer,
      fileName,
      mimeType,
      request.logger
    )

    const totalDuration = Math.round(performance.now() - requestStartTime)
    request.logger.info(
      `[UPLOAD] File sent to CDP Uploader — awaiting callback to complete pipeline with reviewId: ${reviewId}, uploadId: ${uploadId} and totalDurationMs: ${totalDuration}`
    )

    // seed status store for FE polling
    uploadStatusStore.set(reviewId, {
      status: 'initiated',
      message: 'upload started',
      updatedAt: Date.now()
    })

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

    if (!file || !file.on) {
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

// ─────────────────────────────────────────────────────────────────────────────
// S3 helpers
async function bufferFromS3(s3Client, bucket, key) {
  const resp = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  )

  if (!resp.Body) {
    throw new Error('S3 GetObject returned no Body')
  }

  const chunks = []
  try {
    for await (const chunk of resp.Body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
  } catch (err) {
    throw new Error(`Failed to read S3 object body: ${err.message}`)
  }

  return Buffer.concat(chunks)
}

async function getBufferFromField(fileField, { s3Client, s3Bucket } = {}) {
  if (fileField.s3Key) {
    if (!s3Client || !s3Bucket) {
      throw new Error('S3 client/bucket required to fetch s3Key')
    }
    return bufferFromS3(s3Client, s3Bucket, fileField.s3Key)
  }

  throw new Error('No file data available on fileField')
}

// ─────────────────────────────────────────────────────────────────────────────
// extraction helpers and routing logic for callback

function isPdf(contentType, filename) {
  return (
    contentType === APPLICATION_PDF || filename?.toLowerCase().endsWith('.pdf')
  )
}

function isDocx(contentType, filename) {
  return (
    contentType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    filename?.toLowerCase().endsWith('.docx')
  )
}

async function extractPdfText(buf, contentType, filename) {
  try {
    const text = await textExtractor.extractText(buf, contentType, filename)
    return text || ''
  } catch (err) {
    throw new Error(`PDF parsing failed: ${err.message}`)
  }
}

async function extractDocxText(buf, contentType, filename) {
  try {
    const text = await textExtractor.extractText(buf, contentType, filename)
    return text || ''
  } catch (err) {
    throw new Error(`docx parsing failed: ${err.message}`)
  }
}

async function extractTextFromFileField(
  fileField,
  { s3Client, s3Bucket } = {}
) {
  const buf = await getBufferFromField(fileField, { s3Client, s3Bucket })

  const contentType = fileField.contentType || ''
  let text = ''

  if (isPdf(contentType, fileField.filename)) {
    text = await extractPdfText(buf, contentType, fileField.filename)
  } else if (isDocx(contentType, fileField.filename)) {
    text = await extractDocxText(buf, contentType, fileField.filename)
  } else {
    throw new Error(
      `Unsupported file type for text extraction: ${contentType} with filename: ${fileField.filename}`
    )
  }

  if (text.length > MAX_REVIEW_CHARS) {
    text = text.slice(0, MAX_REVIEW_CHARS)
  }

  return { text, textLength: text.length }
}

// handle rejected file
export function handleRejectedFile(fileField, reviewId, request, h) {
  request.logger.error(
    { errorMessage: fileField.errorMessage },
    'File rejected with error in callback'
  )
  uploadStatusStore.set(reviewId, {
    status: 'rejected',
    message: `upload failed with error: ${fileField.errorMessage}`,
    updatedAt: Date.now()
  })
  return h
    .response({
      success: false,
      message: fileField.errorMessage || 'File validation failed'
    })
    .code(HTTP_STATUS.OK)
}

// POST /upload-callback handler
export const handleUploadCallback = async (request, h) => {
  const requestStartTime = performance.now()
  const reviewId = request.payload?.metadata?.reviewId

  try {
    const { metadata, form } = request.payload

    request.logger.info(
      `Upload callback received from CDP Uploader with payload: ${JSON.stringify(request.payload)}`
    )

    const fileField = form.file

    if (!form || !fileField) {
      throw new Error('Callback payload missing form/file')
    }

    if (fileField.hasError) {
      return handleRejectedFile(fileField, reviewId, request, h)
    }

    const userId = metadata?.userId || 'content-reviewer-frontend'
    const { contentType, s3Key, filename } = fileField

    request.logger.info(
      `Extracted metadata from callback - reviewId: ${reviewId},userId: ${userId}, s3Key: ${s3Key}, filename: ${filename}, contentType: ${contentType}`
    )

    // update upload status so FE can poll
    uploadStatusStore.set(reviewId, {
      status: 'uploaded',
      message: 'File uploaded and queued for review',
      updatedAt: Date.now()
    })

    const { text, textLength } = await extractTextFromFileField(fileField, {
      s3Client: new S3Client({ region: config.get('aws.region') }),
      s3Bucket: config.get('s3.bucket')
    })

    request.logger.info(
      `Extracted text from file - reviewId: ${reviewId}, charCount: ${textLength}`
    )

    launchAsyncPipeline(
      text,
      s3Key,
      filename,
      contentType,
      reviewId,
      userId,
      request.logger
    )

    const totalDuration = Math.round(performance.now() - requestStartTime)

    request.logger.info(
      { reviewId, totalDurationMs: totalDuration },
      '[CALLBACK] Pipeline started asynchronously'
    )

    request.logger.info(
      `reviewId: ${reviewId} - Callback received from CDP Uploader`
    )
    uploadStatusStore.set(reviewId, {
      status: 'completed',
      message: 'review completed for the uploaded file',
      updatedAt: Date.now()
    })

    return h
      .response({ success: true, message: 'Callback received' })
      .code(HTTP_STATUS.OK)
  } catch (error) {
    const totalDuration = Math.round(performance.now() - requestStartTime)
    request.logger.error(
      `[CALLBACK] Handler failed after ${totalDuration}ms with error: ${error.message}`
    )
    uploadStatusStore.set(reviewId, {
      status: 'error',
      message: error.message,
      updatedAt: Date.now()
    })
    return h
      .response({ success: false, message: error.message })
      .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  }
}

// pipeline functions
export async function runCallbackPipeline(
  text,
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
    text,
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

export function launchAsyncPipeline(
  text,
  s3Key,
  filename,
  contentType,
  reviewId,
  userId,
  logger
) {
  runCallbackPipeline(
    text,
    s3Key,
    filename,
    contentType,
    reviewId,
    userId,
    logger
  ).catch((error) => {
    logger.error(
      { reviewId, error: error.message, stack: error.stack },
      '[CALLBACK] Async pipeline failed'
    )
  })
}

// GET /upload-success
export const handleUploadSuccess = async (request, h) => {
  try {
    const { reviewId } = request.query

    request.logger.info(
      { reviewId, source: 'browser-redirect' },
      '[REDIRECT] Browser redirected from CDP Uploader'
    )

    return h
      .response({
        success: true,
        message: 'File upload completed successfully',
        reviewId,
        status: 'processing'
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

// GET /api/upload-status/{reviewId}
export const handleUploadStatus = (request, h) => {
  const { reviewId } = request.params
  const status = uploadStatusStore.get(reviewId)
  if (!status) {
    return h.response({ found: false }).code(404)
  }
  return h.response({ found: true, ...status }).code(200)
}
