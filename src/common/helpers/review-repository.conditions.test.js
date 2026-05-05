import { describe, it, expect, vi, beforeEach } from 'vitest'

const REVIEW_ID = 'review_test-123'
const S3_KEY = `reviews/${REVIEW_ID}.json`

const { MOCK_S3_SEND } = vi.hoisted(() => ({ MOCK_S3_SEND: vi.fn() }))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: MOCK_S3_SEND }
  }),
  PutObjectCommand: vi.fn(function (input) {
    return input
  }),
  GetObjectCommand: vi.fn(function (input) {
    return input
  })
}))

vi.mock('../../config.js', () => {
  const configValues = {
    'aws.region': 'eu-west-2',
    'aws.endpoint': null,
    's3.bucket': 'test-bucket'
  }
  return { config: { get: vi.fn((key) => configValues[key] ?? null) } }
})

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

vi.mock('./review-repository-pii.js', () => ({
  redactPIIFromReview: vi.fn(() => ({ hasPII: false, redactionCount: 0 }))
}))

vi.mock('./review-repository-deletion.js', () => ({
  deleteUploadedContent: vi.fn(),
  deleteReviewMetadataFile: vi.fn(),
  deleteOldReviews: vi.fn().mockResolvedValue(0)
}))

vi.mock('./review-repository-helpers.js', () => ({
  preserveImmutableFields: vi.fn((review) => ({
    fileName: review.fileName,
    createdAt: review.createdAt,
    sourceType: review.sourceType
  })),
  sanitizeAdditionalData: vi.fn((data) => data),
  restoreImmutableFields: vi.fn(),
  updateProcessingTimestamps: vi.fn()
}))

vi.mock('./review-repository-queries.js', () => ({
  getRecentReviews: vi.fn(),
  getReviewCount: vi.fn()
}))

vi.mock('./review-repository-search.js', () => ({
  searchReview: vi.fn()
}))

import { reviewRepository } from './review-repository.js'
import { redactPIIFromReview } from './review-repository-pii.js'
import { sanitizeAdditionalData } from './review-repository-helpers.js'

function buildStoredReview(overrides = {}) {
  return {
    id: REVIEW_ID,
    status: 'pending',
    sourceType: 'text',
    fileName: 'test-file.txt',
    fileSize: 100,
    s3Key: S3_KEY,
    userId: 'user-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    result: null,
    error: null,
    ...overrides
  }
}

function makeS3GetResponse(review) {
  return {
    Body: {
      transformToString: vi.fn().mockResolvedValue(JSON.stringify(review))
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockReset()
})

// ============ createReview – optional field fallbacks (lines 110-111, 113) ============

describe('reviewRepository.createReview – optional field fallbacks', () => {
  it('defaults fileName, fileSize and s3Key to null when not provided', async () => {
    MOCK_S3_SEND.mockResolvedValue({})
    const reviewData = {
      id: REVIEW_ID,
      sourceType: 'text',
      userId: 'user-1'
      // fileName, fileSize and s3Key intentionally absent
    }

    const result = await reviewRepository.createReview(reviewData)

    expect(result.fileName).toBeNull()
    expect(result.fileSize).toBeNull()
    expect(result.s3Key).toBeNull()
  })
})

// ============ saveReview – piiRedacted metadata (line 162) ============

describe('reviewRepository.saveReview – piiRedacted metadata', () => {
  it('sets piiRedacted to "true" in S3 metadata when PII is detected', async () => {
    MOCK_S3_SEND.mockResolvedValue({})
    redactPIIFromReview.mockReturnValueOnce({ hasPII: true, redactionCount: 2 })
    const review = buildStoredReview()

    await reviewRepository.saveReview(review)

    const command = MOCK_S3_SEND.mock.calls[0][0]
    expect(command.Metadata.piiRedacted).toBe('true')
  })
})

// ============ updateReviewMetadata – existing metadata (line 238) ============

describe('reviewRepository.updateReviewMetadata – existing metadata', () => {
  it('skips metadata initialisation when review already has metadata', async () => {
    const stored = buildStoredReview({ metadata: { existingKey: 'existing' } })
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))
    MOCK_S3_SEND.mockResolvedValueOnce({})

    await reviewRepository.updateReviewMetadata(REVIEW_ID, { newKey: 'new' })

    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(2)
  })
})

// ============ saveReviewResult – with envelope (line 330) ============

describe('reviewRepository.saveReviewResult – with envelope', () => {
  it('includes envelope in the update when envelope argument is provided', async () => {
    const stored = buildStoredReview()
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))
    MOCK_S3_SEND.mockResolvedValueOnce({})
    const reviewResult = { scores: {}, improvements: [] }
    const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
    const envelope = { status: 'completed', documentId: REVIEW_ID }

    await reviewRepository.saveReviewResult(
      REVIEW_ID,
      reviewResult,
      usage,
      envelope
    )

    expect(sanitizeAdditionalData).toHaveBeenCalledWith(
      expect.objectContaining({ envelope }),
      expect.any(String),
      expect.any(Object)
    )
  })
})

// ============ savePositions – missing issues property (line 349) ============

describe('reviewRepository.savePositions – missing improvements property', () => {
  it('defaults improvements to empty array when positionsData has no improvements property', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})

    await reviewRepository.savePositions(REVIEW_ID, {
      rawResponse: 'some text',
      guardrailAssessment: null
    })

    const command = MOCK_S3_SEND.mock.calls[0][0]
    const body = JSON.parse(command.Body)
    expect(body.improvements).toEqual([])
  })
})
