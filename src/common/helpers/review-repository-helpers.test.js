import { describe, test, expect, beforeEach, vi } from 'vitest'

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))

vi.mock('./logging/logger.js', () => ({
  createLogger: () => mockLogger
}))

import {
  preserveImmutableFields,
  sanitizeAdditionalData,
  restoreImmutableFields,
  updateProcessingTimestamps
} from './review-repository-helpers.js'

const TEST_CONSTANTS = {
  REVIEW_ID: 'test-review-id-123',
  FILE_NAME: 'test-document.pdf',
  S3_KEY: 's3://bucket/test-key',
  SOURCE_TYPE: 'upload',
  TIMESTAMP_CREATED: '2024-01-01T00:00:00.000Z',
  TIMESTAMP_PROCESSING: '2024-01-01T00:01:00.000Z',
  TIMESTAMP_COMPLETED: '2024-01-01T00:02:00.000Z',
  STATUS_PENDING: 'pending',
  STATUS_PROCESSING: 'processing',
  STATUS_COMPLETED: 'completed',
  STATUS_FAILED: 'failed',
  NEW_CONTENT: 'New content',
  ZERO: 0,
  ONE: 1
}

describe('preserveImmutableFields', () => {
  test('Should preserve all immutable fields from review', () => {
    const review = {
      id: TEST_CONSTANTS.REVIEW_ID,
      fileName: TEST_CONSTANTS.FILE_NAME,
      createdAt: TEST_CONSTANTS.TIMESTAMP_CREATED,
      s3Key: TEST_CONSTANTS.S3_KEY,
      sourceType: TEST_CONSTANTS.SOURCE_TYPE,
      status: 'pending',
      content: 'Some content'
    }
    const preserved = preserveImmutableFields(review)
    expect(preserved.id).toBe(TEST_CONSTANTS.REVIEW_ID)
    expect(preserved.fileName).toBe(TEST_CONSTANTS.FILE_NAME)
    expect(preserved.createdAt).toBe(TEST_CONSTANTS.TIMESTAMP_CREATED)
    expect(preserved.s3Key).toBe(TEST_CONSTANTS.S3_KEY)
    expect(preserved.sourceType).toBe(TEST_CONSTANTS.SOURCE_TYPE)
  })
  test('Should only include immutable fields and handle edge cases', () => {
    const review = {
      id: TEST_CONSTANTS.REVIEW_ID,
      fileName: TEST_CONSTANTS.FILE_NAME,
      status: 'processing',
      content: 'Content'
    }
    const preserved = preserveImmutableFields(review)
    expect(preserved.id).toBe(TEST_CONSTANTS.REVIEW_ID)
    expect(preserved.fileName).toBe(TEST_CONSTANTS.FILE_NAME)
    expect(preserved.status).toBeUndefined()
    expect(preserved.content).toBeUndefined()
    const emptyReview = {}
    const emptyPreserved = preserveImmutableFields(emptyReview)
    expect(emptyPreserved.id).toBeUndefined()
  })
  test('Should not modify original review object', () => {
    const review = {
      id: TEST_CONSTANTS.REVIEW_ID,
      fileName: TEST_CONSTANTS.FILE_NAME,
      status: 'pending'
    }
    const originalReview = { ...review }
    preserveImmutableFields(review)
    expect(review).toEqual(originalReview)
  })
})

describe('sanitizeAdditionalData - Field Removal', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear()
  })
  test('Should remove fileName from additionalData and log warning', () => {
    const additionalData = {
      fileName: 'malicious-file.pdf',
      status: 'completed',
      content: TEST_CONSTANTS.NEW_CONTENT
    }
    const preservedFields = {
      fileName: TEST_CONSTANTS.FILE_NAME,
      id: TEST_CONSTANTS.REVIEW_ID
    }
    const sanitized = sanitizeAdditionalData(
      additionalData,
      TEST_CONSTANTS.REVIEW_ID,
      preservedFields
    )
    expect(sanitized.fileName).toBeUndefined()
    expect(sanitized.status).toBe('completed')
    expect(sanitized.content).toBe(TEST_CONSTANTS.NEW_CONTENT)
    expect(mockLogger.warn).toHaveBeenCalledTimes(TEST_CONSTANTS.ONE)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_CONSTANTS.REVIEW_ID,
        attemptedFileName: 'malicious-file.pdf',
        preservedFileName: TEST_CONSTANTS.FILE_NAME
      }),
      'Blocked attempt to overwrite fileName in additionalData'
    )
  })
  test('Should remove multiple immutable fields and handle various cases', () => {
    const additionalData = {
      fileName: 'new-file.pdf',
      createdAt: '2025-01-01T00:00:00.000Z',
      s3Key: 's3://malicious/key',
      id: 'different-id',
      sourceType: 'malicious',
      status: 'completed'
    }
    const preservedFields = {
      fileName: TEST_CONSTANTS.FILE_NAME,
      createdAt: TEST_CONSTANTS.TIMESTAMP_CREATED,
      s3Key: TEST_CONSTANTS.S3_KEY,
      id: TEST_CONSTANTS.REVIEW_ID,
      sourceType: TEST_CONSTANTS.SOURCE_TYPE
    }
    const sanitized = sanitizeAdditionalData(
      additionalData,
      TEST_CONSTANTS.REVIEW_ID,
      preservedFields
    )
    expect(sanitized.fileName).toBeUndefined()
    expect(sanitized.createdAt).toBeUndefined()
    expect(sanitized.s3Key).toBeUndefined()
    expect(sanitized.id).toBeUndefined()
    expect(sanitized.sourceType).toBeUndefined()
    expect(sanitized.status).toBe('completed')
    expect(mockLogger.warn.mock.calls.length).toBeGreaterThan(
      TEST_CONSTANTS.ZERO
    )
  })
})

describe('sanitizeAdditionalData - Edge Cases', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear()
  })
  test('Should handle clean data, empty data and null values', () => {
    const cleanData = {
      status: 'completed',
      content: TEST_CONSTANTS.NEW_CONTENT
    }
    const preservedFields = {
      fileName: TEST_CONSTANTS.FILE_NAME,
      id: TEST_CONSTANTS.REVIEW_ID
    }
    const sanitized = sanitizeAdditionalData(
      cleanData,
      TEST_CONSTANTS.REVIEW_ID,
      preservedFields
    )
    expect(sanitized).toEqual(cleanData)
    mockLogger.warn.mockClear()
    const emptyData = {}
    const emptySanitized = sanitizeAdditionalData(
      emptyData,
      TEST_CONSTANTS.REVIEW_ID,
      preservedFields
    )
    expect(emptySanitized).toEqual({})
    const nullData = { fileName: null, status: 'completed' }
    const nullSanitized = sanitizeAdditionalData(
      nullData,
      TEST_CONSTANTS.REVIEW_ID,
      preservedFields
    )
    expect(nullSanitized.fileName).toBeUndefined()
  })
  test('Should not modify original additionalData object', () => {
    const additionalData = {
      fileName: 'new-file.pdf',
      status: 'completed'
    }
    const originalData = { ...additionalData }
    const preservedFields = {
      fileName: TEST_CONSTANTS.FILE_NAME,
      id: TEST_CONSTANTS.REVIEW_ID
    }
    sanitizeAdditionalData(
      additionalData,
      TEST_CONSTANTS.REVIEW_ID,
      preservedFields
    )
    expect(additionalData).toEqual(originalData)
  })
})

describe('restoreImmutableFields', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear()
  })
  test('Should restore all immutable fields and handle warnings', () => {
    const review = {
      status: 'completed',
      content: 'Content'
    }
    const preservedFields = {
      id: TEST_CONSTANTS.REVIEW_ID,
      fileName: TEST_CONSTANTS.FILE_NAME,
      createdAt: TEST_CONSTANTS.TIMESTAMP_CREATED,
      s3Key: TEST_CONSTANTS.S3_KEY,
      sourceType: TEST_CONSTANTS.SOURCE_TYPE
    }
    restoreImmutableFields(review, preservedFields, TEST_CONSTANTS.REVIEW_ID)
    expect(review.id).toBe(TEST_CONSTANTS.REVIEW_ID)
    expect(review.fileName).toBe(TEST_CONSTANTS.FILE_NAME)
    expect(review.createdAt).toBe(TEST_CONSTANTS.TIMESTAMP_CREATED)
    expect(review.s3Key).toBe(TEST_CONSTANTS.S3_KEY)
    expect(review.sourceType).toBe(TEST_CONSTANTS.SOURCE_TYPE)
    expect(review.status).toBe('completed')
  })
  test('Should overwrite existing values and handle edge cases', () => {
    const review = {
      id: 'wrong-id',
      fileName: 'wrong-file.pdf',
      status: 'completed'
    }
    const preservedFields = {
      id: TEST_CONSTANTS.REVIEW_ID,
      fileName: TEST_CONSTANTS.FILE_NAME
    }
    restoreImmutableFields(review, preservedFields, TEST_CONSTANTS.REVIEW_ID)
    expect(review.id).toBe(TEST_CONSTANTS.REVIEW_ID)
    expect(review.fileName).toBe(TEST_CONSTANTS.FILE_NAME)
    const emptyFieldsReview = { id: TEST_CONSTANTS.REVIEW_ID }
    restoreImmutableFields(emptyFieldsReview, {}, TEST_CONSTANTS.REVIEW_ID)
    expect(emptyFieldsReview.id).toBe(TEST_CONSTANTS.REVIEW_ID)
    const nullReview = { status: 'completed' }
    const nullFields = { id: null, fileName: null }
    restoreImmutableFields(nullReview, nullFields, TEST_CONSTANTS.REVIEW_ID)
    expect(nullReview.id).toBeNull()
  })
  test('Should modify review object in place', () => {
    const review = {
      status: 'completed'
    }
    const preservedFields = {
      id: TEST_CONSTANTS.REVIEW_ID
    }
    const reviewRef = review
    restoreImmutableFields(review, preservedFields, TEST_CONSTANTS.REVIEW_ID)
    expect(reviewRef).toBe(review)
    expect(reviewRef.id).toBe(TEST_CONSTANTS.REVIEW_ID)
  })
})

describe('updateProcessingTimestamps - Start Timestamps', () => {
  test('Should set processingStartedAt when status is processing', () => {
    const review = {
      id: TEST_CONSTANTS.REVIEW_ID,
      status: TEST_CONSTANTS.STATUS_PENDING
    }
    updateProcessingTimestamps(
      review,
      TEST_CONSTANTS.STATUS_PROCESSING,
      TEST_CONSTANTS.TIMESTAMP_PROCESSING
    )
    expect(review.processingStartedAt).toBe(TEST_CONSTANTS.TIMESTAMP_PROCESSING)
    expect(review.processingCompletedAt).toBeUndefined()
  })
  test('Should not overwrite existing processingStartedAt', () => {
    const review = {
      id: TEST_CONSTANTS.REVIEW_ID,
      processingStartedAt: TEST_CONSTANTS.TIMESTAMP_CREATED
    }
    updateProcessingTimestamps(
      review,
      TEST_CONSTANTS.STATUS_PROCESSING,
      TEST_CONSTANTS.TIMESTAMP_PROCESSING
    )
    expect(review.processingStartedAt).toBe(TEST_CONSTANTS.TIMESTAMP_CREATED)
  })
  test('Should not set timestamps for pending status', () => {
    const review = {
      id: TEST_CONSTANTS.REVIEW_ID
    }
    updateProcessingTimestamps(
      review,
      TEST_CONSTANTS.STATUS_PENDING,
      TEST_CONSTANTS.TIMESTAMP_PROCESSING
    )
    expect(review.processingStartedAt).toBeUndefined()
    expect(review.processingCompletedAt).toBeUndefined()
  })
})

describe('updateProcessingTimestamps - Completion Timestamps', () => {
  test('Should set processingCompletedAt when status is completed', () => {
    const review = {
      id: TEST_CONSTANTS.REVIEW_ID,
      status: TEST_CONSTANTS.STATUS_PROCESSING,
      processingStartedAt: TEST_CONSTANTS.TIMESTAMP_PROCESSING
    }
    updateProcessingTimestamps(
      review,
      TEST_CONSTANTS.STATUS_COMPLETED,
      TEST_CONSTANTS.TIMESTAMP_COMPLETED
    )
    expect(review.processingCompletedAt).toBe(
      TEST_CONSTANTS.TIMESTAMP_COMPLETED
    )
    expect(review.processingStartedAt).toBe(TEST_CONSTANTS.TIMESTAMP_PROCESSING)
  })
  test('Should set processingCompletedAt when status is failed', () => {
    const review = {
      id: TEST_CONSTANTS.REVIEW_ID,
      status: TEST_CONSTANTS.STATUS_PROCESSING,
      processingStartedAt: TEST_CONSTANTS.TIMESTAMP_PROCESSING
    }
    updateProcessingTimestamps(
      review,
      TEST_CONSTANTS.STATUS_FAILED,
      TEST_CONSTANTS.TIMESTAMP_COMPLETED
    )
    expect(review.processingCompletedAt).toBe(
      TEST_CONSTANTS.TIMESTAMP_COMPLETED
    )
  })
  test('Should not overwrite existing processingCompletedAt', () => {
    const review = {
      id: TEST_CONSTANTS.REVIEW_ID,
      processingCompletedAt: TEST_CONSTANTS.TIMESTAMP_CREATED
    }
    updateProcessingTimestamps(
      review,
      TEST_CONSTANTS.STATUS_COMPLETED,
      TEST_CONSTANTS.TIMESTAMP_COMPLETED
    )
    expect(review.processingCompletedAt).toBe(TEST_CONSTANTS.TIMESTAMP_CREATED)
  })
})

describe('updateProcessingTimestamps - Edge Cases', () => {
  test('Should handle multiple status transitions correctly', () => {
    const review = {
      id: TEST_CONSTANTS.REVIEW_ID
    }
    updateProcessingTimestamps(
      review,
      TEST_CONSTANTS.STATUS_PROCESSING,
      TEST_CONSTANTS.TIMESTAMP_PROCESSING
    )
    expect(review.processingStartedAt).toBe(TEST_CONSTANTS.TIMESTAMP_PROCESSING)
    updateProcessingTimestamps(
      review,
      TEST_CONSTANTS.STATUS_COMPLETED,
      TEST_CONSTANTS.TIMESTAMP_COMPLETED
    )
    expect(review.processingStartedAt).toBe(TEST_CONSTANTS.TIMESTAMP_PROCESSING)
    expect(review.processingCompletedAt).toBe(
      TEST_CONSTANTS.TIMESTAMP_COMPLETED
    )
  })
  test('Should modify review object in place', () => {
    const review = {
      id: TEST_CONSTANTS.REVIEW_ID
    }
    const reviewRef = review
    updateProcessingTimestamps(
      review,
      TEST_CONSTANTS.STATUS_PROCESSING,
      TEST_CONSTANTS.TIMESTAMP_PROCESSING
    )
    expect(reviewRef).toBe(review)
    expect(reviewRef.processingStartedAt).toBe(
      TEST_CONSTANTS.TIMESTAMP_PROCESSING
    )
  })
  test('Should handle empty review object', () => {
    const review = {}
    updateProcessingTimestamps(
      review,
      TEST_CONSTANTS.STATUS_PROCESSING,
      TEST_CONSTANTS.TIMESTAMP_PROCESSING
    )
    expect(review.processingStartedAt).toBe(TEST_CONSTANTS.TIMESTAMP_PROCESSING)
  })
})
