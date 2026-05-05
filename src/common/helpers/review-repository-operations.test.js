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
  deleteOldReviews: vi.fn().mockResolvedValue(0),
  deleteOldPositionsFiles: vi.fn().mockResolvedValue(0),
  deleteOldContentUploads: vi.fn().mockResolvedValue(0)
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
import {
  deleteUploadedContent,
  deleteReviewMetadataFile,
  deleteOldReviews as deleteOldReviewsHelper,
  deleteOldPositionsFiles as deleteOldPositionsFilesHelper,
  deleteOldContentUploads as deleteOldContentUploadsHelper
} from './review-repository-deletion.js'
import {
  getRecentReviews as getRecentReviewsHelper,
  getReviewCount as getReviewCountHelper
} from './review-repository-queries.js'
import { searchReview as searchReviewHelper } from './review-repository-search.js'

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

// ============ deleteOldPositionsFiles ============

describe('reviewRepository.deleteOldPositionsFiles', () => {
  it('delegates to deleteOldPositionsFilesHelper', async () => {
    deleteOldPositionsFilesHelper.mockResolvedValueOnce(DELETED_COUNT)

    const result =
      await reviewRepository.deleteOldPositionsFiles(RETENTION_DAYS)

    expect(deleteOldPositionsFilesHelper).toHaveBeenCalled()
    expect(result).toBe(DELETED_COUNT)
  })
})

// ============ deleteOldContentUploads ============

describe('reviewRepository.deleteOldContentUploads', () => {
  it('delegates to deleteOldContentUploadsHelper', async () => {
    deleteOldContentUploadsHelper.mockResolvedValueOnce(DELETED_COUNT)

    const result =
      await reviewRepository.deleteOldContentUploads(RETENTION_DAYS)

    expect(deleteOldContentUploadsHelper).toHaveBeenCalled()
    expect(result).toBe(DELETED_COUNT)
  })
})

// ============ savePositions ============

describe('reviewRepository.savePositions', () => {
  it('saves position data to S3 under positions/{reviewId}.json', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})

    const positionsData = {
      rawResponse: '[SCORES]\nPlain English: 4/5\n[/SCORES]',
      guardrailAssessment: null,
      improvements: [{ ref: 1, category: 'Plain English', current: 'utilise' }]
    }

    await reviewRepository.savePositions(REVIEW_ID, positionsData)

    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(1)
    const command = MOCK_S3_SEND.mock.calls[0][0]
    expect(command.Key).toBe(`positions/${REVIEW_ID}.json`)
    expect(command.Bucket).toBe(S3_BUCKET)
  })

  it('includes rawResponse, guardrailAssessment, and improvements in the saved payload', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})

    const positionsData = {
      rawResponse: 'raw bedrock text',
      guardrailAssessment: { blocked: false },
      improvements: [{ ref: 1, category: 'Plain English', current: 'utilise' }]
    }

    await reviewRepository.savePositions(REVIEW_ID, positionsData)

    const command = MOCK_S3_SEND.mock.calls[0][0]
    const body = JSON.parse(command.Body)
    expect(body.rawResponse).toBe('raw bedrock text')
    expect(body.guardrailAssessment).toEqual({ blocked: false })
    expect(body.improvements).toHaveLength(1)
    expect(body.reviewId).toBe(REVIEW_ID)
  })

  it('handles empty improvements array gracefully', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})

    await reviewRepository.savePositions(REVIEW_ID, {
      rawResponse: '',
      guardrailAssessment: null,
      improvements: []
    })

    const command = MOCK_S3_SEND.mock.calls[0][0]
    const body = JSON.parse(command.Body)
    expect(body.improvements).toHaveLength(0)
    expect(command.Metadata.improvementCount).toBe('0')
  })

  it('throws when S3 send fails', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('S3 write failed'))

    await expect(
      reviewRepository.savePositions(REVIEW_ID, {
        rawResponse: '',
        guardrailAssessment: null,
        improvements: []
      })
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

    const repo = new Ctor() // triggers the LocalStack endpoint branch
    expect(repo).toBeDefined()

    // Verify S3Client was constructed with the LocalStack endpoint
    const lastCall =
      S3ClientMock.mock.calls[S3ClientMock.mock.calls.length - 1][0]
    expect(lastCall.endpoint).toBe(AWS_ENDPOINT)
    expect(lastCall.forcePathStyle).toBe(true)
  })
})
