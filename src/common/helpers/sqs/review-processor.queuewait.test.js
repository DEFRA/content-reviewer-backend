import { describe, test, expect, beforeEach, vi } from 'vitest'
import { ReviewProcessor } from './review-processor.js'

// ── Constants ─────────────────────────────────────────────────────────────────
const REVIEW_ID = 'review_wait_test'
const RECEIPT_HANDLE = 'rh-wait-test'
const MAX_QUEUE_WAIT_MS = 600_000 // 10 minutes
const OVER_LIMIT_MS = 700_000 // 11.7 minutes — exceeds limit
const UNDER_LIMIT_MS = 60_000 // 1 minute — within limit

// ── Mocks ─────────────────────────────────────────────────────────────────────
const mockLoggerError = vi.fn()
const mockLoggerWarn = vi.fn()
const mockSaveReviewError = vi.fn()

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: (...args) => mockLoggerError(...args),
    warn: (...args) => mockLoggerWarn(...args)
  })
}))

vi.mock('../review-repository.js', () => ({
  reviewRepository: {
    updateReviewStatus: vi.fn(),
    saveReviewResult: vi.fn(),
    saveReviewError: (...args) => mockSaveReviewError(...args),
    savePositions: vi.fn().mockResolvedValue()
  }
}))

vi.mock('../result-envelope.js', () => ({
  resultEnvelopeStore: {
    buildEnvelope: vi.fn().mockReturnValue({ status: 'completed' }),
    buildStubEnvelope: vi.fn().mockReturnValue({ status: 'pending' })
  }
}))

vi.mock('./content-extractor.js', () => ({
  ContentExtractor: vi.fn(function () {
    return { extractTextContent: vi.fn() }
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
      formatErrorForUI: vi.fn().mockReturnValue('Formatted error'),
      handleSaveErrorFailure: vi.fn()
    }
  })
}))

vi.mock('./message-handler.js', () => ({
  truncateReceiptHandle: vi.fn().mockReturnValue('truncated...')
}))

vi.mock('../../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const configValues = {
        'sqs.maxReceiveCount': 3,
        'sqs.maxQueueWaitMs': MAX_QUEUE_WAIT_MS
      }
      return configValues[key] ?? null
    })
  }
}))

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeMessage(sentMsAgo) {
  return {
    MessageId: 'msg-wait-1',
    ReceiptHandle: RECEIPT_HANDLE,
    Attributes: {
      SentTimestamp: String(Date.now() - sentMsAgo)
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('ReviewProcessor - isQueueWaitExceeded', () => {
  let processor
  let mockMessageHandler

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
    mockSaveReviewError.mockResolvedValue()
    mockMessageHandler = {
      deleteMessage: vi.fn().mockResolvedValue()
    }
  })

  test('returns false when SentTimestamp attribute is missing', async () => {
    const message = {
      MessageId: 'msg-1',
      ReceiptHandle: RECEIPT_HANDLE,
      Attributes: {}
    }
    const result = await processor.isQueueWaitExceeded(
      message,
      mockMessageHandler,
      { reviewId: REVIEW_ID }
    )
    expect(result).toBe(false)
    expect(mockMessageHandler.deleteMessage).not.toHaveBeenCalled()
    expect(mockSaveReviewError).not.toHaveBeenCalled()
  })

  test('returns false when Attributes is absent', async () => {
    const message = { MessageId: 'msg-1', ReceiptHandle: RECEIPT_HANDLE }
    const result = await processor.isQueueWaitExceeded(
      message,
      mockMessageHandler,
      { reviewId: REVIEW_ID }
    )
    expect(result).toBe(false)
    expect(mockMessageHandler.deleteMessage).not.toHaveBeenCalled()
  })

  test('returns false when wait time is within the limit', async () => {
    const result = await processor.isQueueWaitExceeded(
      makeMessage(UNDER_LIMIT_MS),
      mockMessageHandler,
      { reviewId: REVIEW_ID }
    )
    expect(result).toBe(false)
    expect(mockMessageHandler.deleteMessage).not.toHaveBeenCalled()
    expect(mockSaveReviewError).not.toHaveBeenCalled()
  })

  test('returns true and saves high-demand error when wait time exceeds limit', async () => {
    const result = await processor.isQueueWaitExceeded(
      makeMessage(OVER_LIMIT_MS),
      mockMessageHandler,
      { reviewId: REVIEW_ID }
    )
    expect(result).toBe(true)
    expect(mockSaveReviewError).toHaveBeenCalledWith(
      REVIEW_ID,
      'Review failed due to high demand. Enter shorter content or try again later.'
    )
    expect(mockMessageHandler.deleteMessage).toHaveBeenCalledWith(
      RECEIPT_HANDLE
    )
  })

  test('logs a warning with waitMs and maxWaitMs when limit is exceeded', async () => {
    await processor.isQueueWaitExceeded(
      makeMessage(OVER_LIMIT_MS),
      mockMessageHandler,
      { reviewId: REVIEW_ID }
    )
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: REVIEW_ID,
        maxWaitMs: MAX_QUEUE_WAIT_MS
      }),
      expect.stringContaining('high-demand')
    )
  })

  test('skips saveReviewError and still deletes message when reviewId is absent', async () => {
    const result = await processor.isQueueWaitExceeded(
      makeMessage(OVER_LIMIT_MS),
      mockMessageHandler,
      {} // no reviewId
    )
    expect(result).toBe(true)
    expect(mockSaveReviewError).not.toHaveBeenCalled()
    expect(mockMessageHandler.deleteMessage).toHaveBeenCalledWith(
      RECEIPT_HANDLE
    )
  })

  test('uses uploadId as fallback when reviewId is absent but uploadId is present', async () => {
    const result = await processor.isQueueWaitExceeded(
      makeMessage(OVER_LIMIT_MS),
      mockMessageHandler,
      { uploadId: 'upload_fallback' }
    )
    expect(result).toBe(true)
    expect(mockSaveReviewError).toHaveBeenCalledWith(
      'upload_fallback',
      'Review failed due to high demand. Enter shorter content or try again later.'
    )
  })

  test('logs error and still deletes message when saveReviewError throws', async () => {
    mockSaveReviewError.mockRejectedValueOnce(new Error('S3 write failed'))
    const result = await processor.isQueueWaitExceeded(
      makeMessage(OVER_LIMIT_MS),
      mockMessageHandler,
      { reviewId: REVIEW_ID }
    )
    expect(result).toBe(true)
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: REVIEW_ID }),
      'Failed to save high-demand error to repository'
    )
    expect(mockMessageHandler.deleteMessage).toHaveBeenCalledWith(
      RECEIPT_HANDLE
    )
  })
})
