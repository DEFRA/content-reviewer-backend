import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'
import { piiRedactor } from './pii-redactor.js'

const logger = createLogger()

/**
 * Source types for canonical documents
 */
export const SOURCE_TYPES = {
  FILE: 'file',
  URL: 'url',
  TEXT: 'text'
}

/**
 * Canonical document statuses
 */
export const CANONICAL_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETE: 'complete',
  ERROR: 'error'
}

/**
 * Manages canonical document JSON files stored under documents/{documentId}.json in S3.
 *
 * The canonical document is the single source of truth for content submitted for review.
 * documentId === reviewId, wiring together S3, SQS and Bedrock AI.
 *
 * Schema (matches API Technical Requirements):
 * {
 *   documentId:    string   - UUID, same as reviewId
 *   sourceType:    string   - "file" | "url" | "text"
 *   canonicalText: string   - Single normalised full-content string
 *   charCount:     number   - Length of canonicalText
 *   tokenEst:      number   - Approx charCount / 4
 *   sourceMap:     array    - Offset-to-origin mapping (optional)
 *   createdAt:     string   - ISO 8601 timestamp
 *   status:        string   - "pending" | "processing" | "complete" | "error"
 * }
 */
class CanonicalDocumentStore {
  constructor() {
    const s3Config = { region: config.get('aws.region') }

    const awsEndpoint = config.get('aws.endpoint')
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true
    }

    this.s3Client = new S3Client(s3Config)
    this.bucket = config.get('s3.bucket')
    this.prefix = 'documents'
  }

  /**
   * Build the S3 key for a canonical document.
   * @param {string} documentId - Same as reviewId
   * @returns {string} e.g. "documents/review_<uuid>.json"
   */
  getDocumentKey(documentId) {
    return `${this.prefix}/${documentId}.json`
  }

  /**
   * Create a canonical document from plain text input and persist it to S3.
   *
   * @param {Object} options
   * @param {string} options.documentId  - reviewId (primary key shared across S3/SQS/Bedrock)
   * @param {string} options.text        - Raw text content submitted by the user
   * @param {string} [options.title]     - Optional title / filename hint
   * @param {string} [options.sourceType] - 'text' | 'file' | 'url'
   * @returns {Promise<Object>} The canonical document record and S3 metadata
   */
  async createFromText({
    documentId,
    text,
    title = 'Text Content',
    sourceType = SOURCE_TYPES.TEXT
  }) {
    // Redact PII before persisting
    const redactionResult = piiRedactor.redactUserContent(text)
    const canonicalText = redactionResult.redactedText

    const charCount = canonicalText.length
    const tokenEst = Math.round(charCount / 4)
    const createdAt = new Date().toISOString()

    /** @type {import('./canonical-document.js').CanonicalDocument} */
    const document = {
      documentId,
      sourceType,
      canonicalText,
      charCount,
      tokenEst,
      sourceMap: [
        {
          canonicalStart: 0,
          canonicalEnd: charCount,
          originType: 'textarea',
          originRef: null
        }
      ],
      createdAt,
      status: CANONICAL_STATUS.PENDING,
      ...(title && title !== 'Text Content' ? { title } : {})
    }

    const key = this.getDocumentKey(documentId)

    logger.info(
      {
        documentId,
        sourceType,
        charCount,
        tokenEst,
        hasPII: redactionResult.hasPII,
        piiRedactionCount: redactionResult.redactionCount,
        bucket: this.bucket,
        key
      },
      redactionResult.hasPII
        ? `Creating canonical document - PII REDACTED (${redactionResult.redactionCount} instances) | ${charCount} chars`
        : `Creating canonical document | ${charCount} chars`
    )

    const startTime = performance.now()

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(document, null, 2),
        ContentType: 'application/json',
        Metadata: {
          documentId,
          sourceType,
          charCount: charCount.toString(),
          createdAt,
          piiRedacted: redactionResult.hasPII ? 'true' : 'false'
        }
      })
    )

    const duration = Math.round(performance.now() - startTime)

    logger.info(
      { documentId, key, bucket: this.bucket, durationMs: duration },
      `Canonical document created in S3 in ${duration}ms`
    )

    return {
      document,
      s3: {
        bucket: this.bucket,
        key,
        location: `s3://${this.bucket}/${key}`
      },
      durationMs: duration
    }
  }

  /**
   * Create a canonical document from an already-extracted file buffer.
   *
   * @param {Object} options
   * @param {string} options.documentId   - reviewId
   * @param {string} options.canonicalText - Extracted plain text from file
   * @param {string} options.filename      - Original filename
   * @param {string} [options.sourceType]  - 'file' (default)
   * @returns {Promise<Object>} The canonical document record and S3 metadata
   */
  async createFromFile({
    documentId,
    canonicalText,
    filename,
    sourceType = SOURCE_TYPES.FILE
  }) {
    const charCount = canonicalText.length
    const tokenEst = Math.round(charCount / 4)
    const createdAt = new Date().toISOString()

    const document = {
      documentId,
      sourceType,
      canonicalText,
      charCount,
      tokenEst,
      sourceMap: [
        {
          canonicalStart: 0,
          canonicalEnd: charCount,
          originType: 'page',
          originRef: filename || null
        }
      ],
      createdAt,
      status: CANONICAL_STATUS.PENDING,
      filename: filename || null
    }

    const key = this.getDocumentKey(documentId)

    logger.info(
      { documentId, sourceType, charCount, tokenEst, bucket: this.bucket, key },
      `Creating canonical document from file | ${charCount} chars`
    )

    const startTime = performance.now()

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(document, null, 2),
        ContentType: 'application/json',
        Metadata: {
          documentId,
          sourceType,
          charCount: charCount.toString(),
          createdAt,
          filename: filename || ''
        }
      })
    )

    const duration = Math.round(performance.now() - startTime)

    logger.info(
      { documentId, key, bucket: this.bucket, durationMs: duration },
      `Canonical document (file) created in S3 in ${duration}ms`
    )

    return {
      document,
      s3: {
        bucket: this.bucket,
        key,
        location: `s3://${this.bucket}/${key}`
      },
      durationMs: duration
    }
  }

  /**
   * Read a canonical document from S3 and return the parsed object.
   *
   * @param {string} documentId - Same as reviewId
   * @returns {Promise<Object>} Parsed canonical document
   */
  async getDocument(documentId) {
    const key = this.getDocumentKey(documentId)

    logger.info({ documentId, key }, 'Fetching canonical document from S3')

    const startTime = performance.now()

    const response = await this.s3Client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    )

    const chunks = []
    for await (const chunk of response.Body) {
      chunks.push(chunk)
    }
    const json = Buffer.concat(chunks).toString('utf-8')
    const document = JSON.parse(json)

    const duration = Math.round(performance.now() - startTime)

    logger.info(
      { documentId, charCount: document.charCount, durationMs: duration },
      `Canonical document fetched in ${duration}ms`
    )

    return document
  }

  /**
   * Generate a unique document/review ID.
   * @returns {string}
   */
  static generateId() {
    return `review_${randomUUID()}`
  }
}

export const canonicalDocumentStore = new CanonicalDocumentStore()
