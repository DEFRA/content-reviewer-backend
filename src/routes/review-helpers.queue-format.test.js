import { describe, it, expect, vi, beforeEach } from 'vitest'

const CONFIG_MAX_CHAR = 'contentReview.maxCharLength'
const CONFIG_CORS_ORIGIN = 'cors.origin'
const CONFIG_CORS_CREDENTIALS = 'cors.credentials'
const CORS_ORIGIN_VALUE = ['http://localhost:3000']
const MAX_CHAR_LENGTH = 100000

const SQS_ERROR_MSG = 'SQS failure'
const FILE_SIZE_MEDIUM = 100
const PROCESSING_TIME_MS = 500
const VALID_CONTENT_PROCESS = 'This is valid content for processing'
const TIMESTAMP_ISO = '2024-01-01T00:00:00.000Z'
const TIMESTAMP_ISO_500 = '2024-01-01T00:00:00.500Z'
const DATE_JAN_2024 = '2024-01-01'

vi.mock('../config.js', () => {
  const configValues = {
    'contentReview.maxCharLength': 100000,
    'cors.origin': ['http://localhost:3000'],
    'cors.credentials': true
  }
  return {
    config: {
      get: vi.fn((key) => configValues[key] ?? null)
    }
  }
})

vi.mock('../common/helpers/review-repository.js', () => ({
  reviewRepository: {
    createReview: vi.fn(),
    updateReviewStatus: vi.fn()
  }
}))

vi.mock('../common/helpers/sqs-client.js', () => ({
  sqsClient: {
    sendMessage: vi.fn()
  }
}))

vi.mock('../common/helpers/s3-uploader.js', () => ({
  s3Uploader: {
    uploadTextContent: vi.fn()
  }
}))

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234')
}))

vi.mock('../common/helpers/canonical-document.js', () => ({
  canonicalDocumentStore: {
    createFromText: vi.fn(),
    createCanonicalDocument: vi.fn()
  },
  SOURCE_TYPES: {
    TEXT: 'text',
    FILE: 'file'
  }
}))

vi.mock('../common/helpers/result-envelope.js', () => ({
  resultEnvelopeStore: {
    buildEnvelope: vi.fn().mockReturnValue({ status: 'completed' }),
    buildStubEnvelope: vi.fn().mockReturnValue({ status: 'pending' })
  }
}))

vi.mock('../common/helpers/logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

import { config } from '../config.js'
import { reviewRepository } from '../common/helpers/review-repository.js'
import { sqsClient } from '../common/helpers/sqs-client.js'
import { canonicalDocumentStore } from '../common/helpers/canonical-document.js'
import { resultEnvelopeStore } from '../common/helpers/result-envelope.js'
import {
  REVIEW_STATUSES,
  HTTP_STATUS,
  queueReviewJob,
  processTextReviewSubmission,
  formatReviewForResponse,
  formatReviewForList,
  getErrorStatusCode,
  getCorsConfig
} from './review-helpers.js'

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function buildDefaultConfigMock() {
  const configValues = {
    [CONFIG_MAX_CHAR]: MAX_CHAR_LENGTH,
    [CONFIG_CORS_ORIGIN]: CORS_ORIGIN_VALUE,
    [CONFIG_CORS_CREDENTIALS]: true
  }
  return (key) => configValues[key] ?? null
}

beforeEach(() => {
  vi.resetAllMocks()
  config.get.mockImplementation(buildDefaultConfigMock())
  // vi.resetAllMocks() strips return values, so restore the Promise return
  // that review-helpers.js relies on (.catch() is called on the result)
})

// ============ queueReviewJob ============

const DEFAULT_S3_RESULT = {
  key: 'reviews/rev-1/content.txt',
  bucket: 'my-bucket',
  location: 's3://...'
}
const DEFAULT_HEADERS = { 'x-user-id': 'user-1', 'x-session-id': 'session-1' }

describe('queueReviewJob', () => {
  it('calls sqsClient.sendMessage with correct payload', async () => {
    sqsClient.sendMessage.mockResolvedValueOnce({})
    const logger = createLogger()

    await queueReviewJob(
      'review-1',
      DEFAULT_S3_RESULT,
      'My Title',
      FILE_SIZE_MEDIUM,
      DEFAULT_HEADERS,
      logger
    )

    expect(sqsClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: 'review-1',
        s3Key: DEFAULT_S3_RESULT.key
      })
    )
  })

  it('returns a numeric sqsSendDuration', async () => {
    sqsClient.sendMessage.mockResolvedValueOnce({})
    const logger = createLogger()

    const duration = await queueReviewJob(
      'review-2',
      DEFAULT_S3_RESULT,
      'Title',
      FILE_SIZE_MEDIUM,
      DEFAULT_HEADERS,
      logger
    )

    expect(typeof duration).toBe('number')
    expect(duration).toBeGreaterThanOrEqual(0)
  })

  it('logs and rethrows when sendMessage fails', async () => {
    const error = new Error(SQS_ERROR_MSG)
    sqsClient.sendMessage.mockRejectedValueOnce(error)
    reviewRepository.updateReviewStatus.mockResolvedValueOnce({})
    const logger = createLogger()

    await expect(
      queueReviewJob(
        'review-3',
        DEFAULT_S3_RESULT,
        'Title',
        FILE_SIZE_MEDIUM,
        DEFAULT_HEADERS,
        logger
      )
    ).rejects.toThrow(SQS_ERROR_MSG)
    expect(logger.error).toHaveBeenCalled()
  })

  it('updates review status to failed on error', async () => {
    sqsClient.sendMessage.mockRejectedValueOnce(new Error(SQS_ERROR_MSG))
    reviewRepository.updateReviewStatus.mockResolvedValueOnce({})
    const logger = createLogger()

    await expect(
      queueReviewJob(
        'review-4',
        DEFAULT_S3_RESULT,
        'Title',
        FILE_SIZE_MEDIUM,
        DEFAULT_HEADERS,
        logger
      )
    ).rejects.toThrow()
    expect(reviewRepository.updateReviewStatus).toHaveBeenCalledWith(
      'review-4',
      REVIEW_STATUSES.FAILED,
      expect.any(Object)
    )
  })
})

// ============ processTextReviewSubmission ============

describe('processTextReviewSubmission', () => {
  const CANONICAL_MOCK_RESULT = {
    s3: {
      key: 'documents/test-uuid-1234.json',
      bucket: 'bucket',
      location: 's3://...'
    },
    document: { documentId: 'test-uuid-1234', charCount: 100, tokenEst: 25 }
  }

  it('returns reviewId and correct shape on success', async () => {
    const { s3Uploader } = await import('../common/helpers/s3-uploader.js')
    s3Uploader.uploadTextContent.mockResolvedValueOnce({
      key: 's3-key',
      bucket: 'bucket'
    })
    canonicalDocumentStore.createCanonicalDocument.mockResolvedValueOnce(
      CANONICAL_MOCK_RESULT
    )
    reviewRepository.createReview.mockResolvedValueOnce({})
    sqsClient.sendMessage.mockResolvedValueOnce({})

    const logger = createLogger()
    const result = await processTextReviewSubmission(
      { content: VALID_CONTENT_PROCESS, title: 'Title' },
      DEFAULT_HEADERS,
      logger
    )

    expect(result).toHaveProperty('reviewId')
    expect(typeof result.reviewId).toBe('string')
  })

  it('throws when s3 upload fails', async () => {
    const { s3Uploader } = await import('../common/helpers/s3-uploader.js')
    s3Uploader.uploadTextContent.mockRejectedValueOnce(new Error('S3 error'))

    const logger = createLogger()

    await expect(
      processTextReviewSubmission(
        { content: VALID_CONTENT_PROCESS, title: 'Title' },
        DEFAULT_HEADERS,
        logger
      )
    ).rejects.toThrow('S3 error')
  })

  it('throws when queueReviewJob fails', async () => {
    const { s3Uploader } = await import('../common/helpers/s3-uploader.js')
    s3Uploader.uploadTextContent.mockResolvedValueOnce({
      key: 'k',
      bucket: 'b'
    })
    canonicalDocumentStore.createCanonicalDocument.mockResolvedValueOnce(
      CANONICAL_MOCK_RESULT
    )
    reviewRepository.createReview.mockResolvedValueOnce({})
    sqsClient.sendMessage.mockRejectedValueOnce(new Error(SQS_ERROR_MSG))
    reviewRepository.updateReviewStatus.mockResolvedValueOnce({})

    const logger = createLogger()

    await expect(
      processTextReviewSubmission(
        { content: VALID_CONTENT_PROCESS, title: 'Title' },
        DEFAULT_HEADERS,
        logger
      )
    ).rejects.toThrow()
  })
})

// ============ formatReviewForResponse ============

describe('formatReviewForResponse', () => {
  it('maps fields correctly for a completed review', () => {
    const review = {
      id: 'rev-1',
      status: 'completed',
      fileName: 'My Doc',
      createdAt: TIMESTAMP_ISO,
      processingStartedAt: TIMESTAMP_ISO,
      processingCompletedAt: TIMESTAMP_ISO_500,
      result: { score: 95 }
    }

    const result = formatReviewForResponse(review)

    expect(result.id).toBe('rev-1')
    expect(result.status).toBe('completed')
    expect(result.fileName).toBe('My Doc')
  })

  it('calculates processingTime from timestamps', () => {
    const review = {
      id: 'rev-2',
      status: 'completed',
      processingStartedAt: TIMESTAMP_ISO,
      processingCompletedAt: TIMESTAMP_ISO_500,
      result: {}
    }

    const result = formatReviewForResponse(review)

    expect(result.processingTime).toBe(PROCESSING_TIME_MS)
  })

  it('returns null processingTime when timestamps are missing', () => {
    const review = {
      id: 'rev-3',
      status: 'pending',
      result: null
    }

    const result = formatReviewForResponse(review)

    expect(result.processingTime).toBeNull()
  })
})

// ============ formatReviewForList ============

describe('formatReviewForList', () => {
  it('maps id and status for a review', () => {
    const logger = createLogger()
    const review = {
      id: 'r1',
      status: 'completed',
      fileName: 'Doc 1',
      createdAt: DATE_JAN_2024
    }

    const result = formatReviewForList(review, logger)

    expect(result.id).toBe('r1')
    expect(result.status).toBe('completed')
  })

  it('includes fileName in the mapped item', () => {
    const logger = createLogger()
    const review = {
      id: 'r1',
      status: 'pending',
      fileName: 'My Title',
      createdAt: DATE_JAN_2024
    }

    const result = formatReviewForList(review, logger)

    expect(result.fileName).toBe('My Title')
  })

  it('includes createdAt in the mapped item', () => {
    const logger = createLogger()
    const review = {
      id: 'r1',
      status: 'pending',
      fileName: 'T',
      createdAt: '2024-06-15'
    }

    const result = formatReviewForList(review, logger)

    expect(result.createdAt).toBe('2024-06-15')
  })

  it('logs warning when id/reviewId cannot be derived', () => {
    const logger = createLogger()
    const review = {
      status: 'pending',
      fileName: 'No ID Doc',
      createdAt: DATE_JAN_2024
    }

    formatReviewForList(review, logger)

    expect(logger.warn).toHaveBeenCalled()
  })

  it('logs warning when fileName is missing', () => {
    const logger = createLogger()
    const review = { id: 'r1', status: 'pending', createdAt: DATE_JAN_2024 }

    formatReviewForList(review, logger)

    expect(logger.warn).toHaveBeenCalled()
  })

  it('logs warning when createdAt is missing', () => {
    const logger = createLogger()
    const review = { id: 'r1', status: 'pending', fileName: 'Doc' }

    formatReviewForList(review, logger)

    expect(logger.warn).toHaveBeenCalled()
  })

  it('calculates processingTime in seconds when both timestamps are present (L545)', () => {
    const logger = createLogger()
    const review = {
      id: 'r1',
      status: 'completed',
      fileName: 'Doc',
      createdAt: DATE_JAN_2024,
      processingStartedAt: TIMESTAMP_ISO,
      processingCompletedAt: TIMESTAMP_ISO_500
    }

    const result = formatReviewForList(review, logger)

    expect(typeof result.processingTime).toBe('number')
    expect(result.processingTime).toBeGreaterThanOrEqual(0)
  })
})

// ============ getErrorStatusCode ============

describe('getErrorStatusCode', () => {
  it('returns NOT_FOUND for not found error messages', () => {
    const result = getErrorStatusCode('Review not found')

    expect(result).toBe(HTTP_STATUS.NOT_FOUND)
  })

  it('returns INTERNAL_SERVER_ERROR as default', () => {
    const result = getErrorStatusCode('unexpected error occurred')

    expect(result).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR)
  })
})

// ============ getCorsConfig ============

describe('getCorsConfig', () => {
  it('returns cors config from config.get', () => {
    const result = getCorsConfig()

    expect(result).toHaveProperty('origin')
    expect(result.origin).toEqual(CORS_ORIGIN_VALUE)
  })
})
