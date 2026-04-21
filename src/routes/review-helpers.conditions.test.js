import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const values = {
        'contentReview.maxCharLength': 100000,
        'cors.origin': ['http://localhost:3000'],
        'cors.credentials': true
      }
      return values[key] ?? null
    })
  }
}))

vi.mock('../common/helpers/review-repository.js', () => ({
  reviewRepository: {
    createReview: vi.fn(),
    updateReviewStatus: vi.fn()
  }
}))

vi.mock('../common/helpers/sqs-client.js', () => ({
  sqsClient: { sendMessage: vi.fn() }
}))

vi.mock('../common/helpers/s3-uploader.js', () => ({
  s3Uploader: { uploadTextContent: vi.fn() }
}))

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'cond-uuid-5678')
}))

vi.mock('../common/helpers/canonical-document.js', () => ({
  canonicalDocumentStore: { createCanonicalDocument: vi.fn() },
  SOURCE_TYPES: { TEXT: 'text', URL: 'url', FILE: 'file' }
}))

vi.mock('../common/helpers/logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

import { reviewRepository } from '../common/helpers/review-repository.js'
import { sqsClient } from '../common/helpers/sqs-client.js'
import { s3Uploader } from '../common/helpers/s3-uploader.js'
import { canonicalDocumentStore } from '../common/helpers/canonical-document.js'
import {
  formatReviewForResponse,
  formatReviewForList,
  processTextReviewSubmission,
  queueReviewJob,
  HTTP_STATUS,
  REVIEW_STATUSES
} from './review-helpers.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_CONTENT = 'This is valid content for the conditions test'
const DATE_JAN_2024 = '2024-01-01T00:00:00.000Z'
const DATE_JAN_2024_PLUS_1S = '2024-01-01T00:00:01.000Z'
const S3_RESULT = {
  key: 'documents/cond-uuid-5678.json',
  bucket: 'b',
  location: 's3://...'
}
const CANONICAL_RESULT = {
  s3: S3_RESULT,
  document: { documentId: 'cond-uuid-5678', charCount: 50, tokenEst: 12 }
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

beforeEach(() => vi.clearAllMocks())

// ── formatReviewForResponse - _id fallback ────────────────────────────────────

describe('formatReviewForResponse - id fallback branches', () => {
  it('uses _id when id field is absent', () => {
    const review = {
      _id: 'mongo-id-abc',
      status: 'completed',
      fileName: 'doc.pdf'
    }
    const result = formatReviewForResponse(review)
    expect(result.id).toBe('mongo-id-abc')
  })

  it('prefers id over _id when both are present', () => {
    const review = { id: 'explicit-id', _id: 'mongo-id', status: 'pending' }
    const result = formatReviewForResponse(review)
    expect(result.id).toBe('explicit-id')
  })

  it('returns null processingTime when only completedAt is present', () => {
    const review = {
      id: 'r1',
      status: 'completed',
      processingCompletedAt: DATE_JAN_2024
    }
    const result = formatReviewForResponse(review)
    expect(result.processingTime).toBeNull()
  })

  it('returns null processingTime when only startedAt is present', () => {
    const review = {
      id: 'r1',
      status: 'completed',
      processingStartedAt: DATE_JAN_2024
    }
    const result = formatReviewForResponse(review)
    expect(result.processingTime).toBeNull()
  })
})

// ── formatReviewForList - id derivation and error shape branches ──────────────

describe('formatReviewForList - deriveReviewId fallbacks', () => {
  it('uses _id when id is absent', () => {
    const logger = createLogger()
    const review = {
      _id: 'mongo-456',
      status: 'pending',
      fileName: 'f.pdf',
      createdAt: DATE_JAN_2024
    }
    const result = formatReviewForList(review, logger)
    expect(result.id).toBe('mongo-456')
    expect(result.reviewId).toBe('mongo-456')
  })

  it('uses jobId when both id and _id are absent', () => {
    const logger = createLogger()
    const review = {
      jobId: 'job-789',
      status: 'pending',
      fileName: 'f.pdf',
      createdAt: DATE_JAN_2024
    }
    const result = formatReviewForList(review, logger)
    expect(result.id).toBe('job-789')
  })
})

describe('formatReviewForList - hasDefaultFileName branch', () => {
  it('logs warning when fileName equals the default title', () => {
    const logger = createLogger()
    const review = {
      id: 'r1',
      status: 'pending',
      fileName: 'Text Content',
      createdAt: DATE_JAN_2024
    }
    formatReviewForList(review, logger)
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('formatReviewForList - error shape branches', () => {
  it('uses error string directly when error has no .message property', () => {
    const logger = createLogger()
    const review = {
      id: 'r1',
      status: 'failed',
      fileName: 'f.pdf',
      createdAt: DATE_JAN_2024,
      error: 'plain string error'
    }
    const result = formatReviewForList(review, logger)
    expect(result.errorMessage).toBe('plain string error')
  })

  it('returns null errorMessage when error is absent', () => {
    const logger = createLogger()
    const review = {
      id: 'r1',
      status: 'pending',
      fileName: 'f.pdf',
      createdAt: DATE_JAN_2024
    }
    const result = formatReviewForList(review, logger)
    expect(result.errorMessage).toBeNull()
  })

  it('returns null processingTime when timestamps are missing', () => {
    const logger = createLogger()
    const review = {
      id: 'r1',
      status: 'pending',
      fileName: 'f.pdf',
      createdAt: DATE_JAN_2024
    }
    const result = formatReviewForList(review, logger)
    expect(result.processingTime).toBeNull()
  })
})

// ── queueReviewJob - anonymous user / null session branches ───────────────────

describe('queueReviewJob - missing header fallbacks', () => {
  it('sends anonymous when x-user-id header is absent', async () => {
    sqsClient.sendMessage.mockResolvedValueOnce({})
    const logger = createLogger()

    await queueReviewJob('rev-anon', S3_RESULT, 'Title', 100, {}, logger)

    expect(sqsClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'anonymous' })
    )
  })

  it('sends null sessionId when x-session-id header is absent', async () => {
    sqsClient.sendMessage.mockResolvedValueOnce({})
    const logger = createLogger()

    await queueReviewJob(
      'rev-sess',
      S3_RESULT,
      'Title',
      100,
      { 'x-user-id': 'u1' },
      logger
    )

    expect(sqsClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: null })
    )
  })
})

// ── processTextReviewSubmission - sourceType and mimeType branches ────────────

describe('processTextReviewSubmission - URL sourceType branch', () => {
  it('passes url canonical sourceType when payload sourceType is url', async () => {
    s3Uploader.uploadTextContent.mockResolvedValueOnce(S3_RESULT)
    canonicalDocumentStore.createCanonicalDocument.mockResolvedValueOnce(
      CANONICAL_RESULT
    )
    reviewRepository.createReview.mockResolvedValueOnce({})
    sqsClient.sendMessage.mockResolvedValueOnce({})

    const logger = createLogger()
    const result = await processTextReviewSubmission(
      { content: VALID_CONTENT, title: 'page.html', sourceType: 'url' },
      { 'x-user-id': 'u1', 'x-session-id': 's1' },
      logger
    )

    expect(canonicalDocumentStore.createCanonicalDocument).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'url' })
    )
    expect(result).toHaveProperty('reviewId')
  })
})

describe('processTextReviewSubmission - HTML mimeType branch', () => {
  it('uses text/html mimeType when title ends with .html', async () => {
    s3Uploader.uploadTextContent.mockResolvedValueOnce(S3_RESULT)
    canonicalDocumentStore.createCanonicalDocument.mockResolvedValueOnce(
      CANONICAL_RESULT
    )
    reviewRepository.createReview.mockResolvedValueOnce({})
    sqsClient.sendMessage.mockResolvedValueOnce({})

    const logger = createLogger()
    await processTextReviewSubmission(
      { content: VALID_CONTENT, title: 'doc.html' },
      { 'x-user-id': 'u1', 'x-session-id': 's1' },
      logger
    )

    expect(reviewRepository.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'text/html' })
    )
  })

  it('uses text/plain mimeType when title does not end with .html', async () => {
    s3Uploader.uploadTextContent.mockResolvedValueOnce(S3_RESULT)
    canonicalDocumentStore.createCanonicalDocument.mockResolvedValueOnce(
      CANONICAL_RESULT
    )
    reviewRepository.createReview.mockResolvedValueOnce({})
    sqsClient.sendMessage.mockResolvedValueOnce({})

    const logger = createLogger()
    await processTextReviewSubmission(
      { content: VALID_CONTENT, title: 'doc.txt' },
      { 'x-user-id': 'u1', 'x-session-id': 's1' },
      logger
    )

    expect(reviewRepository.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'text/plain' })
    )
  })
})

describe('processTextReviewSubmission - missing x-user-id header', () => {
  it('sets userId to null in review record when x-user-id is absent', async () => {
    s3Uploader.uploadTextContent.mockResolvedValueOnce(S3_RESULT)
    canonicalDocumentStore.createCanonicalDocument.mockResolvedValueOnce(
      CANONICAL_RESULT
    )
    reviewRepository.createReview.mockResolvedValueOnce({})
    sqsClient.sendMessage.mockResolvedValueOnce({})

    const logger = createLogger()
    await processTextReviewSubmission(
      { content: VALID_CONTENT, title: 'Title' },
      {},
      logger
    )

    expect(reviewRepository.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null })
    )
  })
})

// ── processTextReviewSubmission - null title fallback ─────────────────────────
// Covers lines 282, 361 and 422: `title || CONTENT_DEFAULTS.TITLE` branches
// inside queueReviewJob, createCanonicalDocument, and processTextReviewSubmission.

describe('processTextReviewSubmission - null title uses default', () => {
  it('substitutes default title in log, canonical document, and SQS message when title is absent', async () => {
    s3Uploader.uploadTextContent.mockResolvedValueOnce(S3_RESULT)
    canonicalDocumentStore.createCanonicalDocument.mockResolvedValueOnce(
      CANONICAL_RESULT
    )
    reviewRepository.createReview.mockResolvedValueOnce({})
    sqsClient.sendMessage.mockResolvedValueOnce({})

    const logger = createLogger()
    await processTextReviewSubmission(
      { content: VALID_CONTENT }, // no title
      { 'x-user-id': 'u1', 'x-session-id': 's1' },
      logger
    )

    // Line 361: createCanonicalDocument receives default title
    expect(canonicalDocumentStore.createCanonicalDocument).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Text Content' })
    )
    // Line 282: queueReviewJob / sqsClient receives default title as filename
    expect(sqsClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'Text Content' })
    )
  })
})
