import { describe, test, expect, beforeEach, vi } from 'vitest'

// Test constants - defined first
const TEST_BUCKET = 'test-bucket'
const TEST_REVIEW_ID = 'test-review-123'
const TEST_FILE_NAME = 'test-document.pdf'
const TEST_FILE_SIZE = 1024
const TEST_MIME_TYPE = 'application/pdf'
const TEST_S3_KEY = 'uploads/test-file.pdf'
const TEST_STATUS_PENDING = 'pending'
const TEST_STATUS_PROCESSING = 'processing'
const TEST_STATUS_COMPLETED = 'completed'
const TEST_STATUS_FAILED = 'failed'
const TEST_LIMIT_20 = 20
const TEST_LIMIT_50 = 50
const TEST_LIMIT_100 = 100
const TEST_SKIP_0 = 0
const TEST_SKIP_10 = 10
const TEST_CREATED_AT = '2026-02-25T00:00:00.000Z'
const TEST_ERROR_PROCESSING = 'Processing failed'
const TEST_ERROR_UPDATE = 'Update failed'
const TEST_ERROR_DELETION = 'Deletion failed'
const TEST_ERROR_FETCH = 'Failed to fetch'
const TEST_ERROR_NOT_FOUND = 'Review not found'
const TEST_ERROR_MESSAGE = 'Error message'
const TEST_COUNT_42 = 42
const TEST_COUNT_5 = 5

// Use vi.hoisted to ensure mock functions are available before module loading
const {
  mockS3Send,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
  mockRedactPIIFromReview,
  mockDeleteUploadedContent,
  mockDeleteReviewMetadataFile,
  mockDeleteOldReviewsHelper,
  mockPreserveImmutableFields,
  mockSanitizeAdditionalData,
  mockRestoreImmutableFields,
  mockUpdateProcessingTimestamps,
  mockGetRecentReviewsHelper,
  mockGetReviewCountHelper,
  mockSearchReviewHelper
} = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockRedactPIIFromReview: vi.fn(),
  mockDeleteUploadedContent: vi.fn(),
  mockDeleteReviewMetadataFile: vi.fn(),
  mockDeleteOldReviewsHelper: vi.fn(),
  mockPreserveImmutableFields: vi.fn(),
  mockSanitizeAdditionalData: vi.fn(),
  mockRestoreImmutableFields: vi.fn(),
  mockUpdateProcessingTimestamps: vi.fn(),
  mockGetRecentReviewsHelper: vi.fn(),
  mockGetReviewCountHelper: vi.fn(),
  mockSearchReviewHelper: vi.fn()
}))

// Mock AWS SDK with a class
/* eslint-disable no-restricted-syntax, max-classes-per-file */
vi.mock('@aws-sdk/client-s3', async () => {
  return {
    S3Client: class {
      constructor() {
        this.send = mockS3Send
      }
    },
    PutObjectCommand: class {
      constructor(params) {
        Object.assign(this, params)
      }
    },
    GetObjectCommand: class {
      constructor(params) {
        Object.assign(this, params)
      }
    },
    ListObjectsV2Command: class {
      constructor(params) {
        Object.assign(this, params)
      }
    },
    DeleteObjectCommand: class {
      constructor(params) {
        Object.assign(this, params)
      }
    }
  }
})
/* eslint-enable no-restricted-syntax, max-classes-per-file */

vi.mock('../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const configMap = {
        'aws.region': 'us-east-1',
        'aws.endpoint': null,
        's3.bucket': 'test-bucket'
      }
      return configMap[key]
    })
  }
}))

vi.mock('./logging/logger.js', () => ({
  createLogger: () => ({
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError
  })
}))

vi.mock('./review-repository-pii.js', () => ({
  redactPIIFromReview: mockRedactPIIFromReview
}))

vi.mock('./review-repository-deletion.js', () => ({
  deleteUploadedContent: mockDeleteUploadedContent,
  deleteReviewMetadataFile: mockDeleteReviewMetadataFile,
  deleteOldReviews: mockDeleteOldReviewsHelper
}))

vi.mock('./review-repository-helpers.js', () => ({
  preserveImmutableFields: mockPreserveImmutableFields,
  sanitizeAdditionalData: mockSanitizeAdditionalData,
  restoreImmutableFields: mockRestoreImmutableFields,
  updateProcessingTimestamps: mockUpdateProcessingTimestamps
}))

vi.mock('./review-repository-queries.js', () => ({
  getRecentReviews: mockGetRecentReviewsHelper,
  getReviewCount: mockGetReviewCountHelper
}))

vi.mock('./review-repository-search.js', () => ({
  searchReview: mockSearchReviewHelper
}))

// Import after mocks are set up
import { reviewRepository } from './review-repository.js'

describe('ReviewRepositoryS3 - initialization', () => {
  test('Should initialize with correct S3 configuration', () => {
    expect(reviewRepository.bucket).toBe(TEST_BUCKET)
    expect(reviewRepository.prefix).toBe('reviews/')
    expect(reviewRepository.s3Client).toBeDefined()
    // Singleton is initialized at module load time
  })

  test('Should generate correct S3 key for review', () => {
    const key = reviewRepository.getReviewKey(TEST_REVIEW_ID)

    expect(key).toBe(`reviews/${TEST_REVIEW_ID}.json`)
  })
})

describe('ReviewRepositoryS3 - connect and disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should connect successfully (no-op)', async () => {
    const result = await reviewRepository.connect()

    expect(result).toBe(true)
    expect(mockLoggerInfo).toHaveBeenCalledWith('S3 client ready')
  })

  test('Should disconnect successfully (no-op)', async () => {
    await reviewRepository.disconnect()

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('S3 client disconnected')
    )
  })
})

describe('ReviewRepositoryS3 - createReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedactPIIFromReview.mockReturnValue({
      hasPII: false,
      redactionCount: 0
    })
    mockS3Send.mockResolvedValue({})
    mockDeleteOldReviewsHelper.mockResolvedValue(0)
  })

  test('Should create review with file data', async () => {
    const reviewData = {
      id: TEST_REVIEW_ID,
      sourceType: 'file',
      fileName: TEST_FILE_NAME,
      fileSize: TEST_FILE_SIZE,
      mimeType: TEST_MIME_TYPE,
      s3Key: TEST_S3_KEY
    }

    const review = await reviewRepository.createReview(reviewData)

    expect(review.id).toBe(TEST_REVIEW_ID)
    expect(review.status).toBe(TEST_STATUS_PENDING)
    expect(review.sourceType).toBe('file')
    expect(review.fileName).toBe(TEST_FILE_NAME)
    expect(review.fileSize).toBe(TEST_FILE_SIZE)
    expect(review.mimeType).toBe(TEST_MIME_TYPE)
    expect(review.s3Key).toBe(TEST_S3_KEY)
    expect(review.createdAt).toBeDefined()
    expect(review.updatedAt).toBeDefined()
    expect(review.result).toBeNull()
    expect(review.error).toBeNull()
    expect(mockS3Send).toHaveBeenCalled()
  })

  test('Should create review with text data', async () => {
    const reviewData = {
      id: TEST_REVIEW_ID,
      sourceType: 'text',
      s3Key: TEST_S3_KEY
    }

    const review = await reviewRepository.createReview(reviewData)

    expect(review.id).toBe(TEST_REVIEW_ID)
    expect(review.status).toBe(TEST_STATUS_PENDING)
    expect(review.sourceType).toBe('text')
    expect(review.fileName).toBeNull()
    expect(review.fileSize).toBeNull()
    expect(review.mimeType).toBeNull()
    expect(review.s3Key).toBe(TEST_S3_KEY)
  })

  test('Should trigger background cleanup after creating review', async () => {
    const reviewData = {
      id: TEST_REVIEW_ID,
      sourceType: 'file',
      fileName: TEST_FILE_NAME
    }

    await reviewRepository.createReview(reviewData)

    // Wait a bit for the async cleanup to be triggered
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID
      }),
      expect.stringContaining('Creating review')
    )
  })
})

describe('ReviewRepositoryS3 - saveReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockRedactPIIFromReview.mockReturnValue({
      hasPII: false,
      redactionCount: 0
    })
    mockS3Send.mockResolvedValue({})
  })

  test('Should save review without PII redaction', async () => {
    const review = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_PENDING,
      fileName: TEST_FILE_NAME,
      createdAt: new Date().toISOString()
    }

    await reviewRepository.saveReview(review)

    expect(mockRedactPIIFromReview).toHaveBeenCalledWith(review)
    expect(mockS3Send).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: TEST_BUCKET,
        Key: `reviews/${TEST_REVIEW_ID}.json`,
        ContentType: 'application/json'
      })
    )
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID,
        piiRedacted: false
      }),
      expect.stringContaining('Saving review to S3')
    )
  })

  test('Should save review with PII redaction', async () => {
    const review = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_COMPLETED,
      result: { rawResponse: 'Some content with PII' }
    }

    mockRedactPIIFromReview.mockReturnValue({
      hasPII: true,
      redactionCount: 2
    })

    await reviewRepository.saveReview(review)

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID,
        piiRedacted: true,
        piiRedactionCount: 2
      }),
      expect.stringContaining('PII REDACTED')
    )
  })

  test('Should handle save errors', async () => {
    const review = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_PENDING
    }

    const error = new Error('S3 error')
    mockS3Send.mockRejectedValue(error)

    await expect(reviewRepository.saveReview(review)).rejects.toThrow(
      'S3 error'
    )
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'S3 error',
        reviewId: TEST_REVIEW_ID
      }),
      expect.stringContaining('Failed to save review')
    )
  })
})

describe('ReviewRepositoryS3 - getReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should get review successfully', async () => {
    const mockReview = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_COMPLETED,
      fileName: TEST_FILE_NAME
    }

    mockS3Send.mockResolvedValue({
      Body: {
        transformToString: async () => JSON.stringify(mockReview)
      }
    })

    const review = await reviewRepository.getReview(TEST_REVIEW_ID)

    expect(review).toEqual(mockReview)
    expect(mockS3Send).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: TEST_BUCKET,
        Key: `reviews/${TEST_REVIEW_ID}.json`
      })
    )
  })

  test('Should search for review if not found in direct lookup', async () => {
    const mockReview = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_COMPLETED
    }

    const noSuchKeyError = new Error('Not found')
    noSuchKeyError.name = 'NoSuchKey'
    mockS3Send.mockRejectedValue(noSuchKeyError)
    mockSearchReviewHelper.mockResolvedValue(mockReview)

    const review = await reviewRepository.getReview(TEST_REVIEW_ID)

    expect(review).toEqual(mockReview)
    expect(mockSearchReviewHelper).toHaveBeenCalled()
  })

  test('Should throw error for other S3 errors', async () => {
    const error = new Error('Access denied')
    error.name = 'AccessDenied'
    mockS3Send.mockRejectedValue(error)

    await expect(reviewRepository.getReview(TEST_REVIEW_ID)).rejects.toThrow(
      'Access denied'
    )
    expect(mockLoggerError).toHaveBeenCalled()
  })
})

describe('ReviewRepositoryS3 - updateReviewMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockRedactPIIFromReview.mockReturnValue({
      hasPII: false,
      redactionCount: 0
    })
    mockS3Send.mockResolvedValue({})
  })

  test('Should update review metadata', async () => {
    const existingReview = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_COMPLETED,
      metadata: { tag1: 'value1' }
    }

    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: async () => JSON.stringify(existingReview)
      }
    })

    const newMetadata = { tag2: 'value2', tag3: 'value3' }
    await reviewRepository.updateReviewMetadata(TEST_REVIEW_ID, newMetadata)

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID,
        metadataKeys: ['tag2', 'tag3']
      }),
      expect.stringContaining('Updating review metadata')
    )
  })

  test('Should initialize metadata if not exists', async () => {
    const existingReview = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_COMPLETED
    }

    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: async () => JSON.stringify(existingReview)
      }
    })

    const newMetadata = { tag1: 'value1' }
    await reviewRepository.updateReviewMetadata(TEST_REVIEW_ID, newMetadata)

    expect(mockS3Send).toHaveBeenCalledTimes(2)
  })

  test('Should throw error when metadata update fails for non-existent review', async () => {
    mockS3Send.mockResolvedValue({
      Body: {
        transformToString: async () => {
          throw new Error('Not found')
        }
      }
    })
    mockSearchReviewHelper.mockResolvedValue(null)

    await expect(
      reviewRepository.updateReviewMetadata(TEST_REVIEW_ID, {})
    ).rejects.toThrow()
  })
})

describe('ReviewRepositoryS3 - updateReviewStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockRedactPIIFromReview.mockReturnValue({
      hasPII: false,
      redactionCount: 0
    })
    mockS3Send.mockResolvedValue({})
    mockPreserveImmutableFields.mockReturnValue({
      id: TEST_REVIEW_ID,
      createdAt: TEST_CREATED_AT,
      fileName: TEST_FILE_NAME
    })
    mockSanitizeAdditionalData.mockReturnValue({})
    mockRestoreImmutableFields.mockImplementation((review, preserved) => {
      // Restore immutable fields
      review.id = preserved.id
      review.createdAt = preserved.createdAt
      review.fileName = preserved.fileName
    })
    mockUpdateProcessingTimestamps.mockImplementation(
      (review, _status, now) => {
        // Update timestamps based on status
        review.updatedAt = now
      }
    )
  })

  test('Should update review status', async () => {
    const existingReview = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_PENDING,
      fileName: TEST_FILE_NAME,
      createdAt: TEST_CREATED_AT
    }

    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: async () => JSON.stringify(existingReview)
      }
    })

    await reviewRepository.updateReviewStatus(
      TEST_REVIEW_ID,
      TEST_STATUS_PROCESSING
    )

    expect(mockPreserveImmutableFields).toHaveBeenCalledWith(
      expect.objectContaining({
        id: TEST_REVIEW_ID,
        createdAt: TEST_CREATED_AT,
        fileName: TEST_FILE_NAME
      })
    )
    expect(mockSanitizeAdditionalData).toHaveBeenCalled()
    expect(mockRestoreImmutableFields).toHaveBeenCalled()
    expect(mockUpdateProcessingTimestamps).toHaveBeenCalledWith(
      expect.any(Object),
      TEST_STATUS_PROCESSING,
      expect.any(String)
    )
  })

  test('Should update review status with additional data', async () => {
    const existingReview = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_PROCESSING
    }

    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: async () => JSON.stringify(existingReview)
      }
    })

    const additionalData = { result: { score: 5 } }
    await reviewRepository.updateReviewStatus(
      TEST_REVIEW_ID,
      TEST_STATUS_COMPLETED,
      additionalData
    )

    expect(mockSanitizeAdditionalData).toHaveBeenCalledWith(
      additionalData,
      TEST_REVIEW_ID,
      expect.any(Object)
    )
  })

  test('Should throw error when status update fails for non-existent review', async () => {
    mockS3Send.mockResolvedValue({
      Body: {
        transformToString: async () => {
          throw new Error('Not found')
        }
      }
    })
    mockSearchReviewHelper.mockResolvedValue(null)

    await expect(
      reviewRepository.updateReviewStatus(TEST_REVIEW_ID, TEST_STATUS_COMPLETED)
    ).rejects.toThrow()
  })
})

describe('ReviewRepositoryS3 - saveReviewResult', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockRedactPIIFromReview.mockReturnValue({
      hasPII: false,
      redactionCount: 0
    })
    mockS3Send.mockResolvedValue({})
    mockPreserveImmutableFields.mockReturnValue({})
    mockSanitizeAdditionalData.mockReturnValue({})
    mockRestoreImmutableFields.mockImplementation(() => {})
    mockUpdateProcessingTimestamps.mockImplementation(() => {})
  })

  test('Should save review result and update status to completed', async () => {
    const existingReview = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_PROCESSING
    }

    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: async () => JSON.stringify(existingReview)
      }
    })

    const result = { scores: { clarity: 5 } }
    const usage = { inputTokens: 100, outputTokens: 50 }

    await reviewRepository.saveReviewResult(TEST_REVIEW_ID, result, usage)

    expect(mockSanitizeAdditionalData).toHaveBeenCalledWith(
      expect.objectContaining({
        result,
        bedrockUsage: usage
      }),
      TEST_REVIEW_ID,
      expect.any(Object)
    )
  })
})

describe('ReviewRepositoryS3 - saveReviewError', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockRedactPIIFromReview.mockReturnValue({
      hasPII: false,
      redactionCount: 0
    })
    mockS3Send.mockResolvedValue({})
    mockPreserveImmutableFields.mockReturnValue({})
    mockSanitizeAdditionalData.mockReturnValue({})
    mockRestoreImmutableFields.mockImplementation(() => {})
    mockUpdateProcessingTimestamps.mockImplementation(() => {})
  })

  test('Should save review error with Error object', async () => {
    const existingReview = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_PROCESSING
    }

    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: async () => JSON.stringify(existingReview)
      }
    })

    const error = new Error(TEST_ERROR_PROCESSING)
    error.stack = 'Stack trace here'

    await reviewRepository.saveReviewError(TEST_REVIEW_ID, error)

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID,
        errorMessage: TEST_ERROR_PROCESSING,
        hasStack: true
      }),
      expect.stringContaining('Saving review error')
    )
    expect(mockSanitizeAdditionalData).toHaveBeenCalledWith(
      expect.objectContaining({
        error: {
          message: TEST_ERROR_PROCESSING,
          stack: 'Stack trace here'
        }
      }),
      TEST_REVIEW_ID,
      expect.any(Object)
    )
  })

  test('Should save review error with string message', async () => {
    const existingReview = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_PROCESSING
    }

    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: async () => JSON.stringify(existingReview)
      }
    })

    await reviewRepository.saveReviewError(TEST_REVIEW_ID, TEST_ERROR_MESSAGE)

    expect(mockSanitizeAdditionalData).toHaveBeenCalledWith(
      expect.objectContaining({
        error: {
          message: TEST_ERROR_MESSAGE,
          stack: null
        }
      }),
      TEST_REVIEW_ID,
      expect.any(Object)
    )
  })

  test('Should handle error when updating review status fails', async () => {
    mockS3Send.mockRejectedValue(new Error(TEST_ERROR_UPDATE))

    await expect(
      reviewRepository.saveReviewError(TEST_REVIEW_ID, TEST_ERROR_MESSAGE)
    ).rejects.toThrow(TEST_ERROR_UPDATE)
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID,
        updateError: TEST_ERROR_UPDATE
      }),
      expect.stringContaining('Failed to update review status')
    )
  })
})

describe('ReviewRepositoryS3 - getRecentReviews', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should get recent reviews with default options', async () => {
    const mockReviews = [
      { id: 'review1', status: TEST_STATUS_COMPLETED },
      { id: 'review2', status: TEST_STATUS_PENDING }
    ]

    mockGetRecentReviewsHelper.mockResolvedValue({
      reviews: mockReviews,
      continuationToken: null
    })

    const result = await reviewRepository.getRecentReviews()

    expect(mockGetRecentReviewsHelper).toHaveBeenCalledWith(
      expect.any(Object),
      TEST_BUCKET,
      'reviews/',
      expect.objectContaining({
        limit: TEST_LIMIT_20,
        continuationToken: null
      })
    )
    expect(result.reviews).toEqual(mockReviews)
  })

  test('Should get recent reviews with custom limit', async () => {
    mockGetRecentReviewsHelper.mockResolvedValue({
      reviews: [],
      continuationToken: null
    })

    await reviewRepository.getRecentReviews({ limit: TEST_LIMIT_50 })

    expect(mockGetRecentReviewsHelper).toHaveBeenCalledWith(
      expect.any(Object),
      TEST_BUCKET,
      'reviews/',
      expect.objectContaining({
        limit: TEST_LIMIT_50
      })
    )
  })

  test('Should get recent reviews with continuation token', async () => {
    const token = 'next-page-token'
    mockGetRecentReviewsHelper.mockResolvedValue({
      reviews: [],
      continuationToken: null
    })

    await reviewRepository.getRecentReviews({ continuationToken: token })

    expect(mockGetRecentReviewsHelper).toHaveBeenCalledWith(
      expect.any(Object),
      TEST_BUCKET,
      'reviews/',
      expect.objectContaining({
        continuationToken: token
      })
    )
  })
})

describe('ReviewRepositoryS3 - getReviewsByStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should filter reviews by status', async () => {
    const mockReviews = [
      { id: 'review1', status: TEST_STATUS_COMPLETED },
      { id: 'review2', status: TEST_STATUS_PENDING },
      { id: 'review3', status: TEST_STATUS_COMPLETED }
    ]

    mockGetRecentReviewsHelper.mockResolvedValue({
      reviews: mockReviews,
      continuationToken: null
    })

    const result = await reviewRepository.getReviewsByStatus(
      TEST_STATUS_COMPLETED
    )

    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('review1')
    expect(result[1].id).toBe('review3')
  })

  test('Should return empty array when no reviews match status', async () => {
    const mockReviews = [
      { id: 'review1', status: TEST_STATUS_COMPLETED },
      { id: 'review2', status: TEST_STATUS_COMPLETED }
    ]

    mockGetRecentReviewsHelper.mockResolvedValue({
      reviews: mockReviews,
      continuationToken: null
    })

    const result = await reviewRepository.getReviewsByStatus(TEST_STATUS_FAILED)

    expect(result).toHaveLength(0)
  })
})

describe('ReviewRepositoryS3 - getAllReviews', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should get all reviews with default pagination', async () => {
    const mockReviews = Array.from({ length: TEST_LIMIT_50 }, (_, i) => ({
      id: `review${i}`,
      status: TEST_STATUS_COMPLETED
    }))

    mockGetRecentReviewsHelper.mockResolvedValue({
      reviews: mockReviews,
      continuationToken: null
    })

    const result = await reviewRepository.getAllReviews()

    expect(result).toHaveLength(TEST_LIMIT_50)
    expect(mockGetRecentReviewsHelper).toHaveBeenCalledWith(
      expect.any(Object),
      TEST_BUCKET,
      'reviews/',
      expect.objectContaining({
        limit: TEST_LIMIT_50
      })
    )
  })

  test('Should apply skip and limit correctly', async () => {
    const mockReviews = Array.from({ length: 30 }, (_, i) => ({
      id: `review${i}`,
      status: TEST_STATUS_COMPLETED
    }))

    mockGetRecentReviewsHelper.mockResolvedValue({
      reviews: mockReviews,
      continuationToken: null
    })

    const result = await reviewRepository.getAllReviews(
      TEST_LIMIT_20,
      TEST_SKIP_10
    )

    expect(result).toHaveLength(TEST_LIMIT_20)
    expect(result[0].id).toBe('review10')
    expect(result[TEST_LIMIT_20 - 1].id).toBe('review29')
  })

  test('Should handle errors when fetching reviews', async () => {
    const error = new Error(TEST_ERROR_FETCH)
    mockGetRecentReviewsHelper.mockRejectedValue(error)

    await expect(reviewRepository.getAllReviews()).rejects.toThrow(
      TEST_ERROR_FETCH
    )
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: TEST_ERROR_FETCH
      }),
      expect.stringContaining('Failed to get all reviews')
    )
  })
})

describe('ReviewRepositoryS3 - getReviewCount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should get review count', async () => {
    mockGetReviewCountHelper.mockResolvedValue(TEST_COUNT_42)

    const count = await reviewRepository.getReviewCount()

    expect(count).toBe(TEST_COUNT_42)
    expect(mockGetReviewCountHelper).toHaveBeenCalledWith(
      expect.any(Object),
      TEST_BUCKET,
      'reviews/'
    )
  })

  test('Should get zero count when no reviews exist', async () => {
    mockGetReviewCountHelper.mockResolvedValue(0)

    const count = await reviewRepository.getReviewCount()

    expect(count).toBe(0)
  })
})

describe('ReviewRepositoryS3 - deleteReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockDeleteUploadedContent.mockResolvedValue(undefined)
    mockDeleteReviewMetadataFile.mockResolvedValue(undefined)
  })

  test('Should delete review with uploaded content', async () => {
    const mockReview = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_COMPLETED,
      fileName: TEST_FILE_NAME,
      s3Key: TEST_S3_KEY
    }

    mockS3Send.mockResolvedValue({
      Body: {
        transformToString: async () => JSON.stringify(mockReview)
      }
    })

    const result = await reviewRepository.deleteReview(TEST_REVIEW_ID)

    expect(result.success).toBe(true)
    expect(result.reviewId).toBe(TEST_REVIEW_ID)
    expect(result.fileName).toBe(TEST_FILE_NAME)
    expect(mockDeleteUploadedContent).toHaveBeenCalledWith(
      expect.any(Object),
      TEST_BUCKET,
      TEST_REVIEW_ID,
      TEST_S3_KEY,
      expect.any(Array)
    )
    expect(mockDeleteReviewMetadataFile).toHaveBeenCalled()
  })

  test('Should delete review without uploaded content', async () => {
    const mockReview = {
      id: TEST_REVIEW_ID,
      status: TEST_STATUS_COMPLETED,
      s3Key: null
    }

    mockS3Send.mockResolvedValue({
      Body: {
        transformToString: async () => JSON.stringify(mockReview)
      }
    })

    const result = await reviewRepository.deleteReview(TEST_REVIEW_ID)

    expect(result.success).toBe(true)
    expect(mockDeleteUploadedContent).not.toHaveBeenCalled()
    expect(mockDeleteReviewMetadataFile).toHaveBeenCalled()
  })

  test('Should throw error when attempting to delete non-existent review', async () => {
    const notFoundError = new Error('NoSuchKey')
    notFoundError.name = 'NoSuchKey'
    mockS3Send.mockRejectedValue(notFoundError)
    mockSearchReviewHelper.mockResolvedValue(null)

    await expect(reviewRepository.deleteReview(TEST_REVIEW_ID)).rejects.toThrow(
      TEST_ERROR_NOT_FOUND
    )
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID
      }),
      expect.stringContaining('Review not found for deletion')
    )
  })

  test('Should handle deletion errors', async () => {
    const mockReview = {
      id: TEST_REVIEW_ID,
      s3Key: TEST_S3_KEY
    }

    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: async () => JSON.stringify(mockReview)
      }
    })

    const error = new Error(TEST_ERROR_DELETION)
    mockDeleteUploadedContent.mockRejectedValue(error)

    await expect(reviewRepository.deleteReview(TEST_REVIEW_ID)).rejects.toThrow(
      TEST_ERROR_DELETION
    )
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID,
        error: TEST_ERROR_DELETION
      }),
      expect.stringContaining('Failed to delete review')
    )
  })
})

describe('ReviewRepositoryS3 - deleteOldReviews', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should delete old reviews keeping specified count', async () => {
    mockDeleteOldReviewsHelper.mockResolvedValue(TEST_COUNT_5)

    const result = await reviewRepository.deleteOldReviews(TEST_LIMIT_100)

    expect(result).toBe(TEST_COUNT_5)
    expect(mockDeleteOldReviewsHelper).toHaveBeenCalledWith(
      expect.any(Object),
      TEST_BUCKET,
      'reviews/',
      expect.any(Function),
      TEST_LIMIT_100
    )
  })

  test('Should use default keep count of 100', async () => {
    mockDeleteOldReviewsHelper.mockResolvedValue(0)

    await reviewRepository.deleteOldReviews()

    expect(mockDeleteOldReviewsHelper).toHaveBeenCalledWith(
      expect.any(Object),
      TEST_BUCKET,
      'reviews/',
      expect.any(Function),
      TEST_LIMIT_100
    )
  })
})
