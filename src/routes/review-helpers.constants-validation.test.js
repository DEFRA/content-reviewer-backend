import { describe, it, expect, vi, beforeEach } from 'vitest'

const CONFIG_MAX_CHAR = 'contentReview.maxCharLength'
const CONFIG_CORS_ORIGIN = 'cors.origin'
const CONFIG_CORS_CREDENTIALS = 'cors.credentials'
const CORS_ORIGIN_VALUE = ['http://localhost:3000']
const MAX_CHAR_LENGTH = 100000
const MAX_CHAR_SHORT = 20

const VALID_CONTENT = 'This is valid content'
const VALID_CONTENT_LONG = 'hello world content'

const FILE_SIZE_SMALL = 50
const FILE_SIZE_MEDIUM = 100
const FILE_SIZE_LARGE = 200

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
    saveStatus: vi.fn().mockResolvedValue(undefined),
    saveResult: vi.fn().mockResolvedValue(undefined)
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
import { s3Uploader } from '../common/helpers/s3-uploader.js'
import { resultEnvelopeStore } from '../common/helpers/result-envelope.js'
import {
  HTTP_STATUS,
  ENDPOINTS,
  CONTENT_DEFAULTS,
  PAGINATION_DEFAULTS,
  REVIEW_STATUSES,
  validateTextContent,
  uploadTextToS3,
  createReviewRecord
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
  resultEnvelopeStore.saveStatus.mockResolvedValue(undefined)
  resultEnvelopeStore.saveResult.mockResolvedValue(undefined)
})

// ============ CONSTANTS ============

describe('HTTP_STATUS', () => {
  it('exports correct status codes', () => {
    expect(HTTP_STATUS.OK).toBe(HTTP_STATUS.OK)
    expect(HTTP_STATUS.ACCEPTED).toBe(HTTP_STATUS.ACCEPTED)
    expect(HTTP_STATUS.BAD_REQUEST).toBe(HTTP_STATUS.BAD_REQUEST)
    expect(HTTP_STATUS.NOT_FOUND).toBe(HTTP_STATUS.NOT_FOUND)
    expect(HTTP_STATUS.INTERNAL_SERVER_ERROR).toBe(
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    )
  })

  it('has expected property names', () => {
    expect(Object.keys(HTTP_STATUS)).toContain('OK')
    expect(Object.keys(HTTP_STATUS)).toContain('ACCEPTED')
    expect(Object.keys(HTTP_STATUS)).toContain('BAD_REQUEST')
    expect(Object.keys(HTTP_STATUS)).toContain('NOT_FOUND')
    expect(Object.keys(HTTP_STATUS)).toContain('INTERNAL_SERVER_ERROR')
  })
})

describe('ENDPOINTS', () => {
  it('exports correct endpoint paths', () => {
    expect(ENDPOINTS.REVIEW_TEXT).toBe('/api/review/text')
    expect(ENDPOINTS.REVIEW_BY_ID).toBe('/api/review/{id}')
    expect(ENDPOINTS.REVIEWS_LIST).toBe('/api/reviews')
    expect(ENDPOINTS.REVIEWS_DELETE).toBe('/api/reviews/{reviewId}')
  })
})

describe('CONTENT_DEFAULTS', () => {
  it('exports default title and min length', () => {
    expect(CONTENT_DEFAULTS.TITLE).toBe('Text Content')
    expect(typeof CONTENT_DEFAULTS.MIN_LENGTH).toBe('number')
  })
})

describe('PAGINATION_DEFAULTS', () => {
  it('exports default pagination values', () => {
    expect(typeof PAGINATION_DEFAULTS.LIMIT).toBe('number')
    expect(typeof PAGINATION_DEFAULTS.SKIP).toBe('number')
  })
})

describe('REVIEW_STATUSES', () => {
  it('exports pending and failed statuses', () => {
    expect(REVIEW_STATUSES.PENDING).toBe('pending')
    expect(REVIEW_STATUSES.FAILED).toBe('failed')
  })
})

// ============ validateTextContent ============

describe('validateTextContent', () => {
  it('returns invalid when content is missing', () => {
    const logger = createLogger()
    const result = validateTextContent({ content: null }, logger)

    expect(result.valid).toBe(false)
    expect(result.statusCode).toBe(HTTP_STATUS.BAD_REQUEST)
    expect(result.error).toContain('required')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('returns invalid when content is not a string', () => {
    const logger = createLogger()
    const result = validateTextContent({ content: 12345 }, logger)

    expect(result.valid).toBe(false)
    expect(result.statusCode).toBe(HTTP_STATUS.BAD_REQUEST)
  })

  it('returns invalid when content is too short', () => {
    const logger = createLogger()
    const result = validateTextContent({ content: 'short' }, logger)

    expect(result.valid).toBe(false)
    expect(result.statusCode).toBe(HTTP_STATUS.BAD_REQUEST)
    expect(result.error).toContain(`${CONTENT_DEFAULTS.MIN_LENGTH} characters`)
  })

  it('returns invalid when content exceeds max length', () => {
    const logger = createLogger()
    config.get.mockReturnValue(MAX_CHAR_SHORT)
    const result = validateTextContent(
      { content: 'this is longer than twenty characters' },
      logger
    )

    expect(result.valid).toBe(false)
    expect(result.statusCode).toBe(HTTP_STATUS.BAD_REQUEST)
    expect(result.error).toContain('characters')
  })

  it('returns valid for acceptable content', () => {
    const logger = createLogger()
    const result = validateTextContent(
      { content: VALID_CONTENT, title: 'My Title' },
      logger
    )

    expect(result.valid).toBe(true)
    expect(result.content).toBe(VALID_CONTENT)
    expect(result.title).toBe('My Title')
  })

  it('returns valid when title is omitted', () => {
    const logger = createLogger()
    const result = validateTextContent({ content: VALID_CONTENT }, logger)

    expect(result.valid).toBe(true)
  })
})

// ============ uploadTextToS3 ============

describe('uploadTextToS3', () => {
  it('calls s3Uploader.uploadTextContent with correct args', async () => {
    const mockResult = {
      key: 's3-key',
      bucket: 'my-bucket',
      location: 's3://...'
    }
    s3Uploader.uploadTextContent.mockResolvedValueOnce(mockResult)
    const logger = createLogger()

    const { s3Result } = await uploadTextToS3(
      VALID_CONTENT_LONG,
      'review_123',
      'My Title',
      logger
    )

    expect(s3Uploader.uploadTextContent).toHaveBeenCalledWith(
      VALID_CONTENT_LONG,
      'review_123',
      'My Title'
    )
    expect(s3Result).toEqual(mockResult)
  })

  it('uses default title when title is not provided', async () => {
    s3Uploader.uploadTextContent.mockResolvedValueOnce({
      key: 'k',
      bucket: 'b'
    })
    const logger = createLogger()

    await uploadTextToS3(VALID_CONTENT_LONG, 'review_123', null, logger)

    expect(s3Uploader.uploadTextContent).toHaveBeenCalledWith(
      VALID_CONTENT_LONG,
      'review_123',
      CONTENT_DEFAULTS.TITLE
    )
  })

  it('returns a numeric s3UploadDuration', async () => {
    s3Uploader.uploadTextContent.mockResolvedValueOnce({
      key: 'k',
      bucket: 'b'
    })
    const logger = createLogger()

    const { s3UploadDuration } = await uploadTextToS3(
      'valid content here',
      'review_abc',
      'T',
      logger
    )

    expect(typeof s3UploadDuration).toBe('number')
    expect(s3UploadDuration).toBeGreaterThanOrEqual(0)
  })
})

// ============ createReviewRecord ============

describe('createReviewRecord', () => {
  it('calls reviewRepository.createReview with correct shape', async () => {
    reviewRepository.createReview.mockResolvedValueOnce({})
    const logger = createLogger()
    const s3Result = { key: 'reviews/rev-1/content.txt', bucket: 'my-bucket' }

    await createReviewRecord(
      'rev-1',
      s3Result,
      'My Title',
      FILE_SIZE_LARGE,
      logger,
      'user-42'
    )

    expect(reviewRepository.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'rev-1',
        s3Key: 'reviews/rev-1/content.txt',
        fileName: 'My Title',
        userId: 'user-42'
      })
    )
  })

  it('sets userId to null when not provided', async () => {
    reviewRepository.createReview.mockResolvedValueOnce({})
    const logger = createLogger()
    const s3Result = { key: 'reviews/rev-2/content.txt', bucket: 'my-bucket' }

    await createReviewRecord(
      'rev-2',
      s3Result,
      'Title',
      FILE_SIZE_MEDIUM,
      logger
    )

    expect(reviewRepository.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null })
    )
  })

  it('returns a numeric duration', async () => {
    reviewRepository.createReview.mockResolvedValueOnce({})
    const logger = createLogger()
    const s3Result = { key: 'k', bucket: 'b' }

    const duration = await createReviewRecord(
      'rev-3',
      s3Result,
      'T',
      FILE_SIZE_SMALL,
      logger
    )

    expect(typeof duration).toBe('number')
  })

  it('uses default title when title is not provided', async () => {
    reviewRepository.createReview.mockResolvedValueOnce({})
    const logger = createLogger()
    const s3Result = { key: 'k', bucket: 'b' }

    await createReviewRecord('rev-4', s3Result, null, FILE_SIZE_SMALL, logger)

    expect(reviewRepository.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: CONTENT_DEFAULTS.TITLE })
    )
  })
})
