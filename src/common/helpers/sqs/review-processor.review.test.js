import { describe, test, expect, beforeEach, vi } from 'vitest'

// Test constants - IDs and handles
const TEST_UPLOAD_ID = 'upload-123'
const TEST_REVIEW_ID = 'review-123'
const TEST_REVIEW_ID_456 = 'review-456'

// Test constants - File paths and keys
const TEST_S3_KEY_UPLOADS = 'uploads/test.txt'

// Test constants - Message types
const MESSAGE_TYPE_REVIEW_REQUEST = 'review-request'

// Test constants - Content strings
const TEST_SAMPLE_TEXT = 'Sample text'
const TEST_REVIEW_CONTENT = 'Review content'
const TEST_USER_FRIENDLY_ERROR = 'User-friendly error'

const mockLoggerInfo = vi.fn()
const mockUpdateReviewStatus = vi.fn()
const mockSaveReviewResult = vi.fn()
const mockSaveReviewError = vi.fn()
const mockExtractTextContent = vi.fn()
const mockPerformBedrockReview = vi.fn()
const mockParseBedrockResponseData = vi.fn()
const mockFormatErrorForUI = vi.fn()

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: (...args) => mockLoggerInfo(...args),
    error: vi.fn()
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
      extractTextContent: (...args) => mockExtractTextContent(...args)
    }
  })
}))

vi.mock('./bedrock-processor.js', () => ({
  BedrockReviewProcessor: vi.fn(function () {
    return {
      performBedrockReview: (...args) => mockPerformBedrockReview(...args),
      parseBedrockResponseData: (...args) =>
        mockParseBedrockResponseData(...args)
    }
  })
}))

vi.mock('./error-handler.js', () => ({
  ErrorHandler: vi.fn(function () {
    return {
      formatErrorForUI: (...args) => mockFormatErrorForUI(...args),
      handleSaveErrorFailure: vi.fn()
    }
  })
}))

vi.mock('./message-handler.js', () => ({
  truncateReceiptHandle: vi.fn()
}))

import { ReviewProcessor } from './review-processor.js'

describe('ReviewProcessor - processContentReview - uploadId processing', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  describe('when review is processed with uploadId', () => {
    test('Should process review with uploadId successfully', async () => {
      const messageBody = {
        uploadId: TEST_UPLOAD_ID,
        messageType: MESSAGE_TYPE_REVIEW_REQUEST,
        filename: 'test.txt',
        s3Key: TEST_S3_KEY_UPLOADS,
        fileSize: 1024
      }

      mockUpdateReviewStatus.mockResolvedValue()
      mockExtractTextContent.mockResolvedValue(TEST_SAMPLE_TEXT)
      mockPerformBedrockReview.mockResolvedValue({
        bedrockResponse: {
          usage: { inputTokens: 100, outputTokens: 50 },
          guardrailAssessment: null,
          stopReason: 'end_turn'
        },
        bedrockDuration: 1500
      })
      mockParseBedrockResponseData.mockResolvedValue({
        parsedReview: { score: 85 },
        finalReviewContent: TEST_REVIEW_CONTENT,
        parseDuration: 200
      })
      mockSaveReviewResult.mockResolvedValue()

      const result = await processor.processContentReview(messageBody)

      expect(result).toEqual({
        reviewId: TEST_UPLOAD_ID,
        status: 'completed',
        message: 'Review completed successfully'
      })
      expect(mockUpdateReviewStatus).toHaveBeenCalledWith(
        TEST_UPLOAD_ID,
        'processing'
      )
      expect(mockExtractTextContent).toHaveBeenCalledWith(
        TEST_UPLOAD_ID,
        messageBody
      )
      expect(mockPerformBedrockReview).toHaveBeenCalledWith(
        TEST_UPLOAD_ID,
        TEST_SAMPLE_TEXT
      )
      expect(mockSaveReviewResult).toHaveBeenCalled()
    })
  })
})

describe('ReviewProcessor - processContentReview - reviewId processing', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  describe('when review is processed with reviewId', () => {
    test('Should process review with reviewId successfully', async () => {
      const messageBody = {
        reviewId: TEST_REVIEW_ID_456,
        messageType: MESSAGE_TYPE_REVIEW_REQUEST
      }

      mockUpdateReviewStatus.mockResolvedValue()
      mockExtractTextContent.mockResolvedValue(TEST_SAMPLE_TEXT)
      mockPerformBedrockReview.mockResolvedValue({
        bedrockResponse: {
          usage: {},
          guardrailAssessment: null,
          stopReason: 'end_turn'
        },
        bedrockDuration: 1500
      })
      mockParseBedrockResponseData.mockResolvedValue({
        parsedReview: { score: 85 },
        finalReviewContent: TEST_REVIEW_CONTENT,
        parseDuration: 200
      })
      mockSaveReviewResult.mockResolvedValue()

      const result = await processor.processContentReview(messageBody)

      expect(result.reviewId).toBe(TEST_REVIEW_ID_456)
      expect(mockUpdateReviewStatus).toHaveBeenCalledWith(
        TEST_REVIEW_ID_456,
        'processing'
      )
    })
  })
})

describe('ReviewProcessor - processContentReview - error handling', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  describe('when errors occur', () => {
    test('Should throw error when reviewId is missing', async () => {
      const messageBody = {
        messageType: MESSAGE_TYPE_REVIEW_REQUEST
      }

      await expect(processor.processContentReview(messageBody)).rejects.toThrow(
        'Missing reviewId in message body'
      )
    })

    test('Should handle error during review processing', async () => {
      const messageBody = {
        uploadId: TEST_UPLOAD_ID
      }

      const error = new Error('Bedrock error')
      mockUpdateReviewStatus.mockResolvedValue()
      mockExtractTextContent.mockResolvedValue(TEST_SAMPLE_TEXT)
      mockPerformBedrockReview.mockRejectedValue(error)
      mockFormatErrorForUI.mockReturnValue(TEST_USER_FRIENDLY_ERROR)
      mockSaveReviewError.mockResolvedValue()

      await expect(processor.processContentReview(messageBody)).rejects.toThrow(
        'Bedrock error'
      )

      expect(mockFormatErrorForUI).toHaveBeenCalledWith(error)
      expect(mockSaveReviewError).toHaveBeenCalledWith(
        TEST_UPLOAD_ID,
        TEST_USER_FRIENDLY_ERROR
      )
    })
  })
})

describe('ReviewProcessor - logReviewStart', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  describe('logReviewStart', () => {
    test('Should log review start information', () => {
      const messageBody = {
        messageType: MESSAGE_TYPE_REVIEW_REQUEST,
        filename: 'test.txt',
        s3Key: TEST_S3_KEY_UPLOADS,
        fileSize: 2048
      }

      processor.logReviewStart(TEST_REVIEW_ID, TEST_UPLOAD_ID, messageBody)

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          reviewId: TEST_REVIEW_ID,
          uploadId: TEST_UPLOAD_ID,
          messageType: MESSAGE_TYPE_REVIEW_REQUEST,
          filename: 'test.txt',
          s3Key: TEST_S3_KEY_UPLOADS,
          fileSize: 2048
        },
        '[STEP 5/6] Content review processing started by SQS worker - START'
      )
    })
  })
})
