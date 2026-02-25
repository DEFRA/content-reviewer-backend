import { describe, test, expect, beforeEach, vi } from 'vitest'

// Test constants - IDs and handles
const TEST_RECEIPT_HANDLE = 'receipt-123'
const TEST_UPLOAD_ID = 'upload-123'
const TEST_MESSAGE_ID = 'msg-123'
const TEST_TRUNCATED_HANDLE = 'ABC123...'

// Test constants - File paths and keys
const TEST_S3_KEY = 'file.txt'

// Test constants - Numbers
const LONG_BODY_LENGTH = 300
const BODY_PREVIEW_LENGTH = 200

const mockLoggerInfo = vi.fn()
const mockLoggerError = vi.fn()
const mockDeleteMessage = vi.fn()
const mockTruncateReceiptHandle = vi.fn()

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: (...args) => mockLoggerInfo(...args),
    error: (...args) => mockLoggerError(...args)
  })
}))

vi.mock('../review-repository.js', () => ({
  reviewRepository: {
    updateReviewStatus: vi.fn(),
    saveReviewResult: vi.fn(),
    saveReviewError: vi.fn()
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
      formatErrorForUI: vi.fn(),
      handleSaveErrorFailure: vi.fn()
    }
  })
}))

vi.mock('./message-handler.js', () => ({
  truncateReceiptHandle: (...args) => mockTruncateReceiptHandle(...args)
}))

import { ReviewProcessor } from './review-processor.js'

describe('ReviewProcessor - validateAndParseMessage - missing Body', () => {
  let processor
  let messageHandler

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
    messageHandler = {
      deleteMessage: mockDeleteMessage
    }
    mockTruncateReceiptHandle.mockReturnValue(TEST_TRUNCATED_HANDLE)
  })

  describe('when message has no Body field', () => {
    test('Should return null for message without Body', async () => {
      const message = { MessageId: TEST_MESSAGE_ID }

      const result = await processor.validateAndParseMessage(
        message,
        messageHandler
      )

      expect(result).toBeNull()
      expect(mockLoggerError).toHaveBeenCalledWith(
        { messageId: TEST_MESSAGE_ID },
        'Invalid SQS message: missing Body'
      )
    })

    test('Should delete message and return null when Body is missing', async () => {
      const message = {
        MessageId: TEST_MESSAGE_ID,
        ReceiptHandle: TEST_RECEIPT_HANDLE
      }

      const result = await processor.validateAndParseMessage(
        message,
        messageHandler
      )

      expect(result).toBeNull()
      expect(mockDeleteMessage).toHaveBeenCalledWith(TEST_RECEIPT_HANDLE)
    })
  })
})

describe('ReviewProcessor - validateAndParseMessage - valid messages', () => {
  let processor
  let messageHandler

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
    messageHandler = {
      deleteMessage: mockDeleteMessage
    }
    mockTruncateReceiptHandle.mockReturnValue(TEST_TRUNCATED_HANDLE)
  })

  describe('when message has valid structure', () => {
    test('Should parse valid message body with uploadId', async () => {
      const message = {
        MessageId: TEST_MESSAGE_ID,
        Body: JSON.stringify({ uploadId: TEST_UPLOAD_ID, s3Key: TEST_S3_KEY }),
        ReceiptHandle: TEST_RECEIPT_HANDLE
      }

      const result = await processor.validateAndParseMessage(
        message,
        messageHandler
      )

      expect(result).toEqual({ uploadId: TEST_UPLOAD_ID, s3Key: TEST_S3_KEY })
      expect(mockDeleteMessage).not.toHaveBeenCalled()
    })

    test('Should parse valid message body with reviewId', async () => {
      const message = {
        MessageId: TEST_MESSAGE_ID,
        Body: JSON.stringify({ reviewId: 'review-123', s3Key: TEST_S3_KEY }),
        ReceiptHandle: TEST_RECEIPT_HANDLE
      }

      const result = await processor.validateAndParseMessage(
        message,
        messageHandler
      )

      expect(result).toEqual({ reviewId: 'review-123', s3Key: TEST_S3_KEY })
    })
  })
})

describe('ReviewProcessor - validateAndParseMessage - invalid messages', () => {
  let processor
  let messageHandler

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
    messageHandler = {
      deleteMessage: mockDeleteMessage
    }
    mockTruncateReceiptHandle.mockReturnValue(TEST_TRUNCATED_HANDLE)
  })

  describe('when message has invalid structure', () => {
    test('Should delete message when missing both uploadId and reviewId', async () => {
      const message = {
        MessageId: TEST_MESSAGE_ID,
        Body: JSON.stringify({ someOtherField: 'value' }),
        ReceiptHandle: TEST_RECEIPT_HANDLE
      }

      const result = await processor.validateAndParseMessage(
        message,
        messageHandler
      )

      expect(result).toBeNull()
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: TEST_MESSAGE_ID,
          body: { someOtherField: 'value' }
        }),
        'SQS message missing both uploadId and reviewId - deleting invalid message'
      )
      expect(mockDeleteMessage).toHaveBeenCalledWith(TEST_RECEIPT_HANDLE)
    })

    test('Should delete message when Body is not valid JSON', async () => {
      const message = {
        MessageId: TEST_MESSAGE_ID,
        Body: 'invalid json {',
        ReceiptHandle: TEST_RECEIPT_HANDLE
      }

      const result = await processor.validateAndParseMessage(
        message,
        messageHandler
      )

      expect(result).toBeNull()
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: TEST_MESSAGE_ID,
          parseError: expect.any(String),
          bodyPreview: 'invalid json {'
        }),
        'Failed to parse SQS message body as JSON - deleting invalid message'
      )
      expect(mockDeleteMessage).toHaveBeenCalledWith(TEST_RECEIPT_HANDLE)
    })

    test('Should truncate long body preview in error log', async () => {
      const longBody = 'x'.repeat(LONG_BODY_LENGTH)
      const message = {
        MessageId: TEST_MESSAGE_ID,
        Body: longBody,
        ReceiptHandle: TEST_RECEIPT_HANDLE
      }

      await processor.validateAndParseMessage(message, messageHandler)

      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyPreview: 'x'.repeat(BODY_PREVIEW_LENGTH)
        }),
        'Failed to parse SQS message body as JSON - deleting invalid message'
      )
    })
  })
})
