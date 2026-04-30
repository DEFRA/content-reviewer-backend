import { describe, it, expect, vi, beforeEach } from 'vitest'

const REVIEW_ID = 'review_test-123'
const S3_BUCKET = 'test-bucket'
const S3_KEY = `reviews/${REVIEW_ID}.json`
const AWS_REGION = 'eu-west-2'
const AWS_ENDPOINT = 'http://localhost:4566'
const STATUS_PENDING = 'pending'
const STATUS_COMPLETED = 'completed'
const ERROR_REVIEW_NOT_FOUND = 'Review not found'
const REVIEW_LIMIT = 50
const PAGE_LIMIT = 3
const PAGE_SKIP = 2
const REVIEW_COUNT = 42
const DELETED_COUNT = 5
const RETENTION_DAYS = 30

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
import {
  deleteUploadedContent,
  deleteReviewMetadataFile,
  deleteOldReviews as deleteOldReviewsHelper
} from './review-repository-deletion.js'
import {
  getRecentReviews as getRecentReviewsHelper,
  getReviewCount as getReviewCountHelper
} from './review-repository-queries.js'
import { searchReview as searchReviewHelper } from './review-repository-search.js'
import {
  preserveImmutableFields,
  sanitizeAdditionalData,
  updateProcessingTimestamps
} from './review-repository-helpers.js'

function buildReviewData(overrides = {}) {
  return {
    id: REVIEW_ID,
    sourceType: 'text',
    fileName: 'test-file.txt',
    fileSize: 100,
    s3Key: S3_KEY,
    userId: 'user-1',
    ...overrides
  }
}

function buildStoredReview(overrides = {}) {
  return {
    id: REVIEW_ID,
    status: STATUS_PENDING,
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

// ============ connect ============

describe('reviewRepository.connect', () => {
  it('resolves to true', async () => {
    const result = await reviewRepository.connect()

    expect(result).toBe(true)
  })
})

// ============ disconnect ============

describe('reviewRepository.disconnect', () => {
  it('resolves without error', async () => {
    await expect(reviewRepository.disconnect()).resolves.not.toThrow()
  })
})

// ============ getReviewKey ============

describe('reviewRepository.getReviewKey', () => {
  it('returns correct S3 key for a review ID', () => {
    const key = reviewRepository.getReviewKey(REVIEW_ID)

    expect(key).toBe(`reviews/${REVIEW_ID}.json`)
  })
})

// ============ createReview ============

describe('reviewRepository.createReview', () => {
  it('saves review to S3 via PutObjectCommand', async () => {
    MOCK_S3_SEND.mockResolvedValue({})

    await reviewRepository.createReview(buildReviewData())

    expect(MOCK_S3_SEND).toHaveBeenCalled()
  })

  it('returns a review object with correct id', async () => {
    MOCK_S3_SEND.mockResolvedValue({})

    const result = await reviewRepository.createReview(buildReviewData())

    expect(result.id).toBe(REVIEW_ID)
  })

  it('sets initial status to pending', async () => {
    MOCK_S3_SEND.mockResolvedValue({})

    const result = await reviewRepository.createReview(buildReviewData())

    expect(result.status).toBe(STATUS_PENDING)
  })

  it('sets createdAt and updatedAt timestamps', async () => {
    MOCK_S3_SEND.mockResolvedValue({})

    const result = await reviewRepository.createReview(buildReviewData())

    expect(result.createdAt).toBeDefined()
    expect(result.updatedAt).toBeDefined()
  })

  it('sets userId from reviewData', async () => {
    MOCK_S3_SEND.mockResolvedValue({})

    const result = await reviewRepository.createReview(
      buildReviewData({ userId: 'user-42' })
    )

    expect(result.userId).toBe('user-42')
  })

  it('sets userId to null when not provided', async () => {
    MOCK_S3_SEND.mockResolvedValue({})

    const result = await reviewRepository.createReview(
      buildReviewData({ userId: null })
    )

    expect(result.userId).toBeNull()
  })

  it('calls redactPIIFromReview when saving', async () => {
    MOCK_S3_SEND.mockResolvedValue({})

    await reviewRepository.createReview(buildReviewData())

    expect(redactPIIFromReview).toHaveBeenCalled()
  })
})

// ============ saveReview ============

describe('reviewRepository.saveReview', () => {
  it('sends a PutObjectCommand to S3', async () => {
    MOCK_S3_SEND.mockResolvedValue({})
    const review = buildStoredReview()

    await reviewRepository.saveReview(review)

    expect(MOCK_S3_SEND).toHaveBeenCalled()
  })

  it('throws when S3 send fails', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('S3 write error'))
    const review = buildStoredReview()

    await expect(reviewRepository.saveReview(review)).rejects.toThrow(
      'S3 write error'
    )
  })
})

// ============ getReview ============

describe('reviewRepository.getReview', () => {
  it('returns parsed review from S3', async () => {
    const stored = buildStoredReview()
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))

    const result = await reviewRepository.getReview(REVIEW_ID)

    expect(result.id).toBe(REVIEW_ID)
    expect(result.status).toBe(STATUS_PENDING)
  })

  it('calls searchReview when NoSuchKey error is thrown', async () => {
    const noSuchKey = new Error('NoSuchKey')
    noSuchKey.name = 'NoSuchKey'
    MOCK_S3_SEND.mockRejectedValueOnce(noSuchKey)
    searchReviewHelper.mockResolvedValueOnce(buildStoredReview())

    const result = await reviewRepository.getReview(REVIEW_ID)

    expect(searchReviewHelper).toHaveBeenCalled()
    expect(result.id).toBe(REVIEW_ID)
  })

  it('throws on non-NoSuchKey S3 errors', async () => {
    const s3Error = new Error('Access denied')
    s3Error.name = 'AccessDenied'
    MOCK_S3_SEND.mockRejectedValueOnce(s3Error)

    await expect(reviewRepository.getReview(REVIEW_ID)).rejects.toThrow(
      'Access denied'
    )
  })
})

// ============ updateReviewMetadata ============

describe('reviewRepository.updateReviewMetadata', () => {
  it('merges metadata and saves review', async () => {
    const stored = buildStoredReview()
    MOCK_S3_SEND.mockResolvedValue({})
    // getReview
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))
    // saveReview
    MOCK_S3_SEND.mockResolvedValueOnce({})

    await reviewRepository.updateReviewMetadata(REVIEW_ID, { tag: 'urgent' })

    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(2)
  })

  it('throws when review not found for metadata update', async () => {
    const noSuchKey = new Error('NoSuchKey')
    noSuchKey.name = 'NoSuchKey'
    MOCK_S3_SEND.mockRejectedValueOnce(noSuchKey)
    searchReviewHelper.mockResolvedValueOnce(null)

    await expect(
      reviewRepository.updateReviewMetadata(REVIEW_ID, { tag: 'x' })
    ).rejects.toThrow(ERROR_REVIEW_NOT_FOUND)
  })
})

// ============ updateReviewStatus ============

describe('reviewRepository.updateReviewStatus', () => {
  it('updates status and saves review', async () => {
    const stored = buildStoredReview()
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))
    MOCK_S3_SEND.mockResolvedValueOnce({})

    await reviewRepository.updateReviewStatus(REVIEW_ID, STATUS_COMPLETED)

    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(2)
  })

  it('throws when review not found for status update', async () => {
    const noSuchKey = new Error('NoSuchKey')
    noSuchKey.name = 'NoSuchKey'
    MOCK_S3_SEND.mockRejectedValueOnce(noSuchKey)
    searchReviewHelper.mockResolvedValueOnce(null)

    await expect(
      reviewRepository.updateReviewStatus(REVIEW_ID, STATUS_COMPLETED)
    ).rejects.toThrow(ERROR_REVIEW_NOT_FOUND)
  })

  it('calls preserveImmutableFields during update', async () => {
    const stored = buildStoredReview()
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))
    MOCK_S3_SEND.mockResolvedValueOnce({})

    await reviewRepository.updateReviewStatus(REVIEW_ID, STATUS_COMPLETED)

    expect(preserveImmutableFields).toHaveBeenCalled()
  })

  it('calls updateProcessingTimestamps during update', async () => {
    const stored = buildStoredReview()
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))
    MOCK_S3_SEND.mockResolvedValueOnce({})

    await reviewRepository.updateReviewStatus(REVIEW_ID, STATUS_COMPLETED)

    expect(updateProcessingTimestamps).toHaveBeenCalled()
  })
})

// ============ saveReviewResult ============

describe('reviewRepository.saveReviewResult', () => {
  it('calls updateReviewStatus with completed and result data', async () => {
    const stored = buildStoredReview()
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))
    MOCK_S3_SEND.mockResolvedValueOnce({})
    const reviewResult = { scores: {}, improvements: [] }
    const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 }

    await reviewRepository.saveReviewResult(REVIEW_ID, reviewResult, usage)

    expect(sanitizeAdditionalData).toHaveBeenCalledWith(
      expect.objectContaining({ result: reviewResult, bedrockUsage: usage }),
      expect.any(String),
      expect.any(Object)
    )
  })
})

// ============ saveReviewError ============

describe('reviewRepository.saveReviewError', () => {
  it('saves error when passed as string', async () => {
    const stored = buildStoredReview()
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))
    MOCK_S3_SEND.mockResolvedValueOnce({})

    await reviewRepository.saveReviewError(REVIEW_ID, 'Something failed')

    expect(sanitizeAdditionalData).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'Something failed' })
      }),
      expect.any(String),
      expect.any(Object)
    )
  })

  it('saves error when passed as Error object', async () => {
    const stored = buildStoredReview()
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))
    MOCK_S3_SEND.mockResolvedValueOnce({})
    const error = new Error('Error object failure')

    await reviewRepository.saveReviewError(REVIEW_ID, error)

    expect(sanitizeAdditionalData).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'Error object failure' })
      }),
      expect.any(String),
      expect.any(Object)
    )
  })

  it('merges extraData into the failed status update', async () => {
    const stored = buildStoredReview()
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))
    MOCK_S3_SEND.mockResolvedValueOnce({})
    const guardrailData = {
      guardrailAssessment: { allAssessments: [] },
      policyBreakdown: []
    }

    await reviewRepository.saveReviewError(REVIEW_ID, 'Blocked', guardrailData)

    expect(sanitizeAdditionalData).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'Blocked' }),
        guardrailAssessment: guardrailData.guardrailAssessment,
        policyBreakdown: guardrailData.policyBreakdown
      }),
      expect.any(String),
      expect.any(Object)
    )
  })

  it('rethrows when updateReviewStatus fails', async () => {
    const noSuchKey = new Error('NoSuchKey')
    noSuchKey.name = 'NoSuchKey'
    MOCK_S3_SEND.mockRejectedValueOnce(noSuchKey)
    searchReviewHelper.mockResolvedValueOnce(null)

    await expect(
      reviewRepository.saveReviewError(REVIEW_ID, 'error message')
    ).rejects.toThrow()
  })
})

// ============ getRecentReviews ============

describe('reviewRepository.getRecentReviews', () => {
  it('delegates to getRecentReviewsHelper', async () => {
    getRecentReviewsHelper.mockResolvedValueOnce({
      reviews: [],
      continuationToken: null
    })

    const result = await reviewRepository.getRecentReviews({ limit: 10 })

    expect(getRecentReviewsHelper).toHaveBeenCalledWith(
      expect.anything(),
      S3_BUCKET,
      'reviews/',
      expect.objectContaining({ limit: 10 })
    )
    expect(result.reviews).toEqual([])
  })

  it('uses default limit of 20 when not provided', async () => {
    getRecentReviewsHelper.mockResolvedValueOnce({
      reviews: [],
      continuationToken: null
    })

    await reviewRepository.getRecentReviews()

    expect(getRecentReviewsHelper).toHaveBeenCalledWith(
      expect.anything(),
      S3_BUCKET,
      'reviews/',
      expect.objectContaining({ limit: 20 })
    )
  })
})

// ============ getReviewsByStatus ============

describe('reviewRepository.getReviewsByStatus', () => {
  it('returns only reviews matching the requested status', async () => {
    const reviews = [
      buildStoredReview({ id: 'r1', status: STATUS_COMPLETED }),
      buildStoredReview({ id: 'r2', status: STATUS_PENDING }),
      buildStoredReview({ id: 'r3', status: STATUS_COMPLETED })
    ]
    getRecentReviewsHelper.mockResolvedValueOnce({ reviews })

    const result = await reviewRepository.getReviewsByStatus(STATUS_COMPLETED)

    expect(result).toHaveLength(2)
    expect(result.every((r) => r.status === STATUS_COMPLETED)).toBe(true)
  })
})

// ============ getAllReviews ============

describe('reviewRepository.getAllReviews', () => {
  it('returns reviews with default skip and limit', async () => {
    const reviews = Array.from({ length: 5 }, (_, i) =>
      buildStoredReview({ id: `r${i}` })
    )
    getRecentReviewsHelper.mockResolvedValueOnce({ reviews })

    const result = await reviewRepository.getAllReviews()

    expect(Array.isArray(result)).toBe(true)
  })

  it('filters reviews by userId when provided', async () => {
    const reviews = [
      buildStoredReview({ id: 'r1', userId: 'user-A' }),
      buildStoredReview({ id: 'r2', userId: 'user-B' }),
      buildStoredReview({ id: 'r3', userId: 'user-A' })
    ]
    getRecentReviewsHelper.mockResolvedValueOnce({ reviews })

    const result = await reviewRepository.getAllReviews(
      REVIEW_LIMIT,
      0,
      'user-A'
    )

    expect(result).toHaveLength(2)
    expect(result.every((r) => r.userId === 'user-A')).toBe(true)
  })

  it('applies skip and limit after filtering', async () => {
    const reviews = Array.from({ length: 10 }, (_, i) =>
      buildStoredReview({ id: `r${i}` })
    )
    getRecentReviewsHelper.mockResolvedValueOnce({ reviews })

    const result = await reviewRepository.getAllReviews(PAGE_LIMIT, PAGE_SKIP)

    expect(result).toHaveLength(PAGE_LIMIT)
  })

  it('throws and logs on S3 error', async () => {
    getRecentReviewsHelper.mockRejectedValueOnce(new Error('S3 list error'))

    await expect(reviewRepository.getAllReviews()).rejects.toThrow(
      'S3 list error'
    )
  })
})

// ============ getReviewCount ============

describe('reviewRepository.getReviewCount', () => {
  it('delegates to getReviewCountHelper when no userId', async () => {
    getReviewCountHelper.mockResolvedValueOnce(REVIEW_COUNT)

    const count = await reviewRepository.getReviewCount()

    expect(getReviewCountHelper).toHaveBeenCalled()
    expect(count).toBe(REVIEW_COUNT)
  })

  it('counts only the userId reviews when userId is provided', async () => {
    const reviews = [
      buildStoredReview({ id: 'r1', userId: 'user-X' }),
      buildStoredReview({ id: 'r2', userId: 'user-Y' }),
      buildStoredReview({ id: 'r3', userId: 'user-X' })
    ]
    getRecentReviewsHelper.mockResolvedValueOnce({ reviews })

    const count = await reviewRepository.getReviewCount('user-X')

    expect(count).toBe(2)
  })

  it('throws on error when counting for userId', async () => {
    getRecentReviewsHelper.mockRejectedValueOnce(new Error('list error'))

    await expect(reviewRepository.getReviewCount('user-Z')).rejects.toThrow(
      'list error'
    )
  })
})

// ============ deleteReview ============

describe('reviewRepository.deleteReview', () => {
  it('calls deleteUploadedContent when review has s3Key', async () => {
    const stored = buildStoredReview({ s3Key: S3_KEY })
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))

    await reviewRepository.deleteReview(REVIEW_ID)

    expect(deleteUploadedContent).toHaveBeenCalled()
  })

  it('calls deleteReviewMetadataFile', async () => {
    const stored = buildStoredReview()
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))

    await reviewRepository.deleteReview(REVIEW_ID)

    expect(deleteReviewMetadataFile).toHaveBeenCalled()
  })

  it('returns success result with reviewId', async () => {
    const stored = buildStoredReview()
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))

    const result = await reviewRepository.deleteReview(REVIEW_ID)

    expect(result.success).toBe(true)
    expect(result.reviewId).toBe(REVIEW_ID)
  })

  it('throws when review not found for deletion', async () => {
    const noSuchKey = new Error('NoSuchKey')
    noSuchKey.name = 'NoSuchKey'
    MOCK_S3_SEND.mockRejectedValueOnce(noSuchKey)
    searchReviewHelper.mockResolvedValueOnce(null)

    await expect(reviewRepository.deleteReview(REVIEW_ID)).rejects.toThrow(
      ERROR_REVIEW_NOT_FOUND
    )
  })

  it('skips deleteUploadedContent when s3Key is absent', async () => {
    const stored = buildStoredReview({ s3Key: null })
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3GetResponse(stored))

    await reviewRepository.deleteReview(REVIEW_ID)

    expect(deleteUploadedContent).not.toHaveBeenCalled()
  })

  it('throws and logs on unexpected errors', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('Unexpected S3 error'))

    await expect(reviewRepository.deleteReview(REVIEW_ID)).rejects.toThrow(
      'Unexpected S3 error'
    )
  })
})

// ============ deleteOldReviews ============

describe('reviewRepository.deleteOldReviews', () => {
  it('delegates to deleteOldReviewsHelper', async () => {
    deleteOldReviewsHelper.mockResolvedValueOnce(DELETED_COUNT)

    const result = await reviewRepository.deleteOldReviews(RETENTION_DAYS)

    expect(deleteOldReviewsHelper).toHaveBeenCalled()
    expect(result).toBe(DELETED_COUNT)
  })
})

// ============ savePositions ============

describe('reviewRepository.savePositions', () => {
  it('saves position data to S3 under positions/{reviewId}.json', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})

    const reviewedContent = {
      plainText: 'Some content',
      issues: [{ start: 0, end: 4, type: 'clarity', text: 'Some' }]
    }

    await reviewRepository.savePositions(REVIEW_ID, reviewedContent)

    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(1)
    const command = MOCK_S3_SEND.mock.calls[0][0]
    expect(command.Key).toBe(`positions/${REVIEW_ID}.json`)
    expect(command.Bucket).toBe(S3_BUCKET)
  })

  it('includes plainText and issues in the saved payload', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})

    const reviewedContent = {
      plainText: 'My review text',
      issues: [{ start: 3, end: 9, type: 'plain-english', text: 'review' }]
    }

    await reviewRepository.savePositions(REVIEW_ID, reviewedContent)

    const command = MOCK_S3_SEND.mock.calls[0][0]
    const body = JSON.parse(command.Body)
    expect(body.plainText).toBe('My review text')
    expect(body.issues).toHaveLength(1)
    expect(body.reviewId).toBe(REVIEW_ID)
  })

  it('handles empty issues array gracefully', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})

    await reviewRepository.savePositions(REVIEW_ID, {
      plainText: 'text',
      issues: []
    })

    const command = MOCK_S3_SEND.mock.calls[0][0]
    const body = JSON.parse(command.Body)
    expect(body.issues).toHaveLength(0)
    expect(command.Metadata.issueCount).toBe('0')
  })

  it('throws when S3 send fails', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('S3 write failed'))

    await expect(
      reviewRepository.savePositions(REVIEW_ID, { plainText: '', issues: [] })
    ).rejects.toThrow('S3 write failed')
  })
})

// ============ ReviewRepositoryS3 constructor - LocalStack endpoint ============

describe('ReviewRepositoryS3 constructor', () => {
  it('uses custom endpoint when aws.endpoint is configured', async () => {
    const { S3Client: S3ClientMock } = await import('@aws-sdk/client-s3')
    const { config: configMock } = await import('../../config.js')

    configMock.get.mockImplementation((key) => {
      const localStackVals = {
        'aws.region': AWS_REGION,
        'aws.endpoint': AWS_ENDPOINT,
        's3.bucket': S3_BUCKET
      }
      return localStackVals[key] ?? null
    })

    // Access the class through the exported singleton's prototype chain
    const mod = await import('./review-repository.js')
    const Ctor = Object.getPrototypeOf(mod.reviewRepository).constructor

    new Ctor() // triggers the LocalStack endpoint branch

    // Verify S3Client was constructed with the LocalStack endpoint
    const lastCall =
      S3ClientMock.mock.calls[S3ClientMock.mock.calls.length - 1][0]
    expect(lastCall.endpoint).toBe(AWS_ENDPOINT)
    expect(lastCall.forcePathStyle).toBe(true)
  })
})
