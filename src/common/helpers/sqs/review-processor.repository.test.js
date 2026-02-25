import { describe, test, expect, beforeEach, vi } from 'vitest'

// Test constants - IDs and handles
const TEST_UPLOAD_ID = 'upload-123'
const TEST_REVIEW_ID = 'review-123'
const TEST_MESSAGE_ID = 'msg-123'
const TEST_TRUNCATED_HANDLE = 'ABC123...'

// Test constants - File paths and keys
const TEST_S3_KEY_UPLOADS = 'uploads/file.txt'

// Test constants - Message types
const MESSAGE_TYPE_REVIEW_REQUEST = 'review-request'

// Test constants - Content strings
const TEST_REVIEW_CONTENT = 'Review content'
const TEST_USER_FRIENDLY_ERROR = 'User-friendly error'
const TEST_PROCESSING_FAILED = 'Processing failed'

// Test constants - Numbers
const PROCESSING_TIME_5000 = 5000
const PROCESSING_TIME_2000 = 2000

const mockLoggerInfo = vi.fn()
const mockLoggerError = vi.fn()
const mockUpdateReviewStatus = vi.fn()
const mockSaveReviewResult = vi.fn()
const mockSaveReviewError = vi.fn()
const mockFormatErrorForUI = vi.fn()
const mockHandleSaveErrorFailure = vi.fn()
const mockTruncateReceiptHandle = vi.fn()

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: (...args) => mockLoggerInfo(...args),
    error: (...args) => mockLoggerError(...args)
  })
}))

vi.mock('../review-repository.js', () => ({
  reviewRepository: {
    updateReviewStatus: (...args) => mockUpdateReviewStatus(...args),
    saveReviewResult: (...args) => mockSaveReviewResult(...args),
    saveReviewError: (...args) => mockSaveReviewError(...args)
  }
}))

vi.mock('./content-extractor.js', () => ({
  ContentExtractor: vi.fn(function () {
    return {
      extractTextContent: vi.fn()
    }
  })
}))

vi.mock('./bedrock-processor.js', () => ({
  BedrockReviewProcessor: vi.fn(function () {
    return {
      performBedrockReview: vi.fn(),
      parseBedrockResponseData: vi.fn()
    }
  })
}))

vi.mock('./error-handler.js', () => ({
  ErrorHandler: vi.fn(function () {
    return {
      formatErrorForUI: (...args) => mockFormatErrorForUI(...args),
      handleSaveErrorFailure: (...args) => mockHandleSaveErrorFailure(...args)
    }
  })
}))

vi.mock('./message-handler.js', () => ({
  truncateReceiptHandle: (...args) => mockTruncateReceiptHandle(...args)
}))

import { ReviewProcessor } from './review-processor.js'

describe('ReviewProcessor - Constructor', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
    mockTruncateReceiptHandle.mockReturnValue(TEST_TRUNCATED_HANDLE)
  })

  describe('initialization', () => {
    test('Should initialize with required components', () => {
      expect(processor.contentExtractor).toBeDefined()
      expect(processor.bedrockProcessor).toBeDefined()
      expect(processor.errorHandler).toBeDefined()
    })
  })
})

describe('ReviewProcessor - logMessageProcessingStart', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
    mockTruncateReceiptHandle.mockReturnValue(TEST_TRUNCATED_HANDLE)
  })

  describe('logMessageProcessingStart', () => {
    test('Should log message processing information', () => {
      const message = {
        MessageId: TEST_MESSAGE_ID,
        ReceiptHandle: 'receipt-handle-123'
      }
      const body = {
        uploadId: TEST_UPLOAD_ID,
        reviewId: TEST_REVIEW_ID,
        messageType: MESSAGE_TYPE_REVIEW_REQUEST,
        s3Key: TEST_S3_KEY_UPLOADS
      }

      processor.logMessageProcessingStart(message, body)

      expect(mockLoggerInfo).toHaveBeenCalledWith({
        messageId: TEST_MESSAGE_ID,
        uploadId: TEST_UPLOAD_ID,
        reviewId: TEST_REVIEW_ID,
        messageType: MESSAGE_TYPE_REVIEW_REQUEST,
        s3Key: TEST_S3_KEY_UPLOADS,
        receiptHandle: TEST_TRUNCATED_HANDLE
      })
      expect(mockTruncateReceiptHandle).toHaveBeenCalledWith(
        'receipt-handle-123'
      )
    })
  })
})

describe('ReviewProcessor - updateReviewStatusToProcessing', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  describe('updateReviewStatusToProcessing', () => {
    test('Should update status successfully', async () => {
      mockUpdateReviewStatus.mockResolvedValue()

      await processor.updateReviewStatusToProcessing(TEST_REVIEW_ID)

      expect(mockUpdateReviewStatus).toHaveBeenCalledWith(
        TEST_REVIEW_ID,
        'processing'
      )
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewId: TEST_REVIEW_ID,
          durationMs: expect.any(Number)
        }),
        expect.stringContaining('Review status updated to processing')
      )
    })

    test('Should log error but continue when status update fails', async () => {
      const error = new Error('Database error')
      mockUpdateReviewStatus.mockRejectedValue(error)

      await processor.updateReviewStatusToProcessing(TEST_REVIEW_ID)

      expect(mockLoggerError).toHaveBeenCalledWith(
        {
          reviewId: TEST_REVIEW_ID,
          error: 'Database error',
          stack: expect.any(String)
        },
        'CRITICAL: Failed to update review status to processing - attempting to continue'
      )
    })
  })
})

describe('ReviewProcessor - saveReviewToRepository', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  describe('saveReviewToRepository', () => {
    test('Should save review result successfully', async () => {
      const parseResult = {
        parsedReview: { score: 90 },
        finalReviewContent: TEST_REVIEW_CONTENT
      }
      const bedrockResult = {
        bedrockResponse: {
          guardrailAssessment: null,
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 }
        }
      }

      mockSaveReviewResult.mockResolvedValue()

      await processor.saveReviewToRepository(
        TEST_REVIEW_ID,
        parseResult,
        bedrockResult
      )

      expect(mockSaveReviewResult).toHaveBeenCalledWith(
        TEST_REVIEW_ID,
        expect.objectContaining({
          reviewData: { score: 90 },
          rawResponse: TEST_REVIEW_CONTENT,
          guardrailAssessment: null,
          stopReason: 'end_turn',
          completedAt: expect.any(Date)
        }),
        { inputTokens: 100, outputTokens: 50 }
      )
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewId: TEST_REVIEW_ID,
          durationMs: expect.any(Number)
        }),
        expect.stringContaining('Review result saved to S3')
      )
    })
  })
})

describe('ReviewProcessor - logReviewCompletion', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  describe('logReviewCompletion', () => {
    test('Should log completion with all timing information', () => {
      const processingStartTime = performance.now() - PROCESSING_TIME_5000
      const bedrockResult = { bedrockDuration: 3000 }
      const parseResult = { parseDuration: 500 }

      processor.logReviewCompletion(
        TEST_REVIEW_ID,
        processingStartTime,
        bedrockResult,
        parseResult
      )

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          reviewId: TEST_REVIEW_ID,
          totalDurationMs: expect.any(Number),
          bedrockDurationMs: 3000,
          parseDurationMs: 500
        },
        expect.stringContaining(
          '[STEP 6/6] Content review processing COMPLETED'
        )
      )
    })
  })
})

describe('ReviewProcessor - handleReviewProcessingError', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  describe('handleReviewProcessingError', () => {
    test('Should handle error and save to repository', async () => {
      const error = new Error(TEST_PROCESSING_FAILED)
      error.stack = 'Error stack trace'
      const processingStartTime = performance.now() - PROCESSING_TIME_2000

      mockFormatErrorForUI.mockReturnValue(TEST_USER_FRIENDLY_ERROR)
      mockSaveReviewError.mockResolvedValue()

      await processor.handleReviewProcessingError(
        TEST_REVIEW_ID,
        error,
        processingStartTime
      )

      expect(mockLoggerError).toHaveBeenCalledWith(
        {
          reviewId: TEST_REVIEW_ID,
          error: TEST_PROCESSING_FAILED,
          errorName: 'Error',
          stack: 'Error stack trace',
          totalDurationMs: expect.any(Number)
        },
        expect.stringContaining('Review processing failed')
      )
      expect(mockFormatErrorForUI).toHaveBeenCalledWith(error)
      expect(mockSaveReviewError).toHaveBeenCalledWith(
        TEST_REVIEW_ID,
        TEST_USER_FRIENDLY_ERROR
      )
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          reviewId: TEST_REVIEW_ID,
          errorMessage: TEST_USER_FRIENDLY_ERROR,
          originalError: TEST_PROCESSING_FAILED
        },
        'Review error saved to database - status updated to failed'
      )
    })

    test('Should handle failure when saving error to repository', async () => {
      const error = new Error(TEST_PROCESSING_FAILED)
      const saveError = new Error('Database save failed')
      const processingStartTime = performance.now() - PROCESSING_TIME_2000

      mockFormatErrorForUI.mockReturnValue(TEST_USER_FRIENDLY_ERROR)
      mockSaveReviewError.mockRejectedValue(saveError)
      mockHandleSaveErrorFailure.mockResolvedValue()

      await processor.handleReviewProcessingError(
        TEST_REVIEW_ID,
        error,
        processingStartTime
      )

      expect(mockHandleSaveErrorFailure).toHaveBeenCalled()
    })
  })
})
