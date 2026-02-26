import { describe, test, expect, beforeEach, vi } from 'vitest'

import { ReviewProcessor } from './review-processor.js'

// Test constants - IDs and handles
const TEST_RECEIPT_HANDLE = 'receipt-123'
const TEST_UPLOAD_ID = 'upload-123'
const TEST_MESSAGE_ID = 'msg-123'

// Test constants - Content strings
const TEST_SAMPLE_TEXT = 'Sample text'
const TEST_REVIEW_CONTENT = 'Review content'
const TEST_PROCESSING_FAILED = 'Processing failed'

const mockLoggerInfo = vi.fn()
const mockLoggerError = vi.fn()
const mockUpdateReviewStatus = vi.fn()
const mockSaveReviewResult = vi.fn()
const mockDeleteMessage = vi.fn()
const mockExtractTextContent = vi.fn()
const mockPerformBedrockReview = vi.fn()
const mockParseBedrockResponseData = vi.fn()

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
    saveReviewError: vi.fn()
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
      formatErrorForUI: vi.fn(),
      handleSaveErrorFailure: vi.fn()
    }
  })
}))

vi.mock('./message-handler.js', () => ({
  truncateReceiptHandle: vi.fn()
}))

describe('ReviewProcessor - processMessage - successful processing', () => {
  let processor
  let messageHandler

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
    messageHandler = {
      deleteMessage: mockDeleteMessage
    }
  })

  describe('when message is valid', () => {
    test('Should process valid message successfully', async () => {
      const message = {
        MessageId: TEST_MESSAGE_ID,
        Body: JSON.stringify({ uploadId: TEST_UPLOAD_ID }),
        ReceiptHandle: TEST_RECEIPT_HANDLE
      }

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
      mockUpdateReviewStatus.mockResolvedValue()
      mockSaveReviewResult.mockResolvedValue()

      await processor.processMessage(message, messageHandler)

      expect(mockDeleteMessage).toHaveBeenCalledWith(TEST_RECEIPT_HANDLE)
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: TEST_MESSAGE_ID,
          uploadId: TEST_UPLOAD_ID,
          durationMs: expect.any(Number)
        }),
        expect.stringContaining('SQS message processed successfully')
      )
    })
  })
})

describe('ReviewProcessor - processMessage - invalid messages', () => {
  let processor
  let messageHandler

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
    messageHandler = {
      deleteMessage: mockDeleteMessage
    }
  })

  describe('when message body is invalid', () => {
    test('Should handle invalid message body', async () => {
      const message = {
        MessageId: TEST_MESSAGE_ID,
        Body: 'invalid',
        ReceiptHandle: TEST_RECEIPT_HANDLE
      }

      await processor.processMessage(message, messageHandler)

      expect(mockDeleteMessage).toHaveBeenCalledWith(TEST_RECEIPT_HANDLE)
      expect(mockExtractTextContent).not.toHaveBeenCalled()
    })
  })
})

describe('ReviewProcessor - processMessage - error handling', () => {
  let processor
  let messageHandler

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
    messageHandler = {
      deleteMessage: mockDeleteMessage
    }
  })

  describe('when processing fails', () => {
    test('Should log error when processing fails', async () => {
      const message = {
        MessageId: TEST_MESSAGE_ID,
        Body: JSON.stringify({ uploadId: TEST_UPLOAD_ID }),
        ReceiptHandle: TEST_RECEIPT_HANDLE
      }

      const error = new Error(TEST_PROCESSING_FAILED)
      mockUpdateReviewStatus.mockResolvedValue()
      mockExtractTextContent.mockRejectedValue(error)

      await processor.processMessage(message, messageHandler)

      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: TEST_MESSAGE_ID,
          error: TEST_PROCESSING_FAILED,
          errorName: 'Error',
          stack: expect.any(String),
          durationMs: expect.any(Number)
        }),
        expect.stringContaining('Failed to process SQS message')
      )
    })
  })
})
