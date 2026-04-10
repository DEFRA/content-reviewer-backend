import { describe, test, expect, vi, beforeEach } from 'vitest'

// Mock dependencies first, before importing ReviewProcessor
vi.mock('../logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }))
}))

vi.mock('../../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const config = {
        'sqs.maxReceiveCount': 3
      }
      return config[key]
    })
  }
}))

vi.mock('./message-handler.js', () => ({
  truncateReceiptHandle: vi.fn((handle) => handle?.substring(0, 10) || '')
}))

vi.mock('../review-repository.js', () => ({
  reviewRepository: {
    saveReviewError: vi.fn().mockResolvedValue(undefined),
    updateReviewStatus: vi.fn().mockResolvedValue(undefined),
    saveReviewResult: vi.fn().mockResolvedValue(undefined),
    savePositions: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('../result-envelope.js', () => ({
  resultEnvelopeStore: {
    buildEnvelope: vi.fn(() => ({ annotatedSections: [] }))
  }
}))

vi.mock('./content-extractor.js', () => ({
  ContentExtractor: class {
    async extractTextContent() {
      return { canonicalText: 'test', linkMap: [] }
    }
  }
}))

vi.mock('./bedrock-processor.js', () => ({
  BedrockReviewProcessor: class {
    async performBedrockReview() {
      return {
        bedrockDuration: 100,
        bedrockResponse: {
          usage: {},
          stopReason: 'end_turn',
          guardrailAssessment: []
        }
      }
    }
    async parseBedrockResponseData() {
      return { parsedReview: {}, parseDuration: 50, finalReviewContent: '' }
    }
  }
}))

vi.mock('./error-handler.js', () => ({
  ErrorHandler: class {
    formatErrorForUI(err) {
      return err?.message || ''
    }
    async handleSaveErrorFailure() {
      return undefined
    }
  }
}))

import { ReviewProcessor } from './review-processor.js'

const MAX_RECEIVE_COUNT = 3
const TEST_RECEIVE_COUNT_BELOW = 2
const TEST_RECEIVE_COUNT_ABOVE = 4
const TEST_DURATION_MS = 50
const TEST_FILE_SIZE = 100

describe('ReviewProcessor', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  test('Should instantiate ReviewProcessor', () => {
    expect(processor).toBeDefined()
    expect(processor.contentExtractor).toBeDefined()
    expect(processor.bedrockProcessor).toBeDefined()
    expect(processor.errorHandler).toBeDefined()
  })
})

describe('ReviewProcessor - validateAndParseMessage', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  test('Should return null when message Body is missing', async () => {
    const message = { MessageId: 'msg-1', ReceiptHandle: 'handle' }
    const messageHandler = { deleteMessage: vi.fn() }

    const result = await processor.validateAndParseMessage(
      message,
      messageHandler
    )

    expect(result).toBeNull()
    expect(messageHandler.deleteMessage).toHaveBeenCalledWith('handle')
  })

  test('Should return null for message with no uploadId or reviewId', async () => {
    const message = {
      MessageId: 'msg-1',
      ReceiptHandle: 'handle',
      Body: JSON.stringify({ someOtherField: 'value' })
    }
    const messageHandler = { deleteMessage: vi.fn() }

    const result = await processor.validateAndParseMessage(
      message,
      messageHandler
    )

    expect(result).toBeNull()
    expect(messageHandler.deleteMessage).toHaveBeenCalledWith('handle')
  })

  test('Should return null for invalid JSON', async () => {
    const message = {
      MessageId: 'msg-1',
      ReceiptHandle: 'handle',
      Body: 'invalid-json'
    }
    const messageHandler = { deleteMessage: vi.fn() }

    const result = await processor.validateAndParseMessage(
      message,
      messageHandler
    )

    expect(result).toBeNull()
    expect(messageHandler.deleteMessage).toHaveBeenCalledWith('handle')
  })

  test('Should return parsed body for valid message with uploadId', async () => {
    const body = { uploadId: 'upload-1', messageType: 'review' }
    const message = {
      MessageId: 'msg-1',
      Body: JSON.stringify(body)
    }
    const messageHandler = { deleteMessage: vi.fn() }

    const result = await processor.validateAndParseMessage(
      message,
      messageHandler
    )

    expect(result).toEqual(body)
    expect(messageHandler.deleteMessage).not.toHaveBeenCalled()
  })

  test('Should return parsed body for valid message with reviewId', async () => {
    const body = { reviewId: 'review-1', messageType: 'review' }
    const message = {
      MessageId: 'msg-1',
      Body: JSON.stringify(body)
    }
    const messageHandler = { deleteMessage: vi.fn() }

    const result = await processor.validateAndParseMessage(
      message,
      messageHandler
    )

    expect(result).toEqual(body)
  })
})

describe('ReviewProcessor - isDeadLettered', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  test('Should return false when receive count below threshold', async () => {
    const message = { MessageId: 'msg-1', ReceiptHandle: 'handle' }
    const messageHandler = {
      getReceiveCount: vi.fn(() => TEST_RECEIVE_COUNT_BELOW),
      deleteMessage: vi.fn()
    }
    const body = { reviewId: 'review-1' }

    const result = await processor.isDeadLettered(message, messageHandler, body)

    expect(result).toBe(false)
    expect(messageHandler.deleteMessage).not.toHaveBeenCalled()
  })

  test('Should return true when receive count exceeds threshold', async () => {
    const message = { MessageId: 'msg-1', ReceiptHandle: 'handle' }
    const messageHandler = {
      getReceiveCount: vi.fn(() => TEST_RECEIVE_COUNT_ABOVE),
      deleteMessage: vi.fn()
    }
    const body = { reviewId: 'review-1' }

    const result = await processor.isDeadLettered(message, messageHandler, body)

    expect(result).toBe(true)
    expect(messageHandler.deleteMessage).toHaveBeenCalledWith('handle')
  })
})

describe('ReviewProcessor - markDeadLetteredReviewAsFailed', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  test('Should do nothing when reviewId is null', async () => {
    const { reviewRepository } = await import('../review-repository.js')

    await processor.markDeadLetteredReviewAsFailed(
      null,
      TEST_RECEIVE_COUNT_ABOVE,
      MAX_RECEIVE_COUNT
    )

    expect(reviewRepository.saveReviewError).not.toHaveBeenCalled()
  })

  test('Should save error when reviewId is provided', async () => {
    const { reviewRepository } = await import('../review-repository.js')

    await processor.markDeadLetteredReviewAsFailed(
      'review-1',
      TEST_RECEIVE_COUNT_ABOVE,
      MAX_RECEIVE_COUNT
    )

    expect(reviewRepository.saveReviewError).toHaveBeenCalledWith(
      'review-1',
      expect.stringContaining('maximum')
    )
  })
})

describe('ReviewProcessor - utilities', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new ReviewProcessor()
  })

  test('logMessageProcessingStart should not throw', () => {
    const message = { MessageId: 'msg-1' }
    const body = {
      uploadId: 'upload-1',
      reviewId: 'review-1',
      messageType: 'review',
      filename: 'test.txt',
      s3Key: 'key',
      fileSize: TEST_FILE_SIZE
    }

    expect(() =>
      processor.logMessageProcessingStart(message, body)
    ).not.toThrow()
  })

  test('updateReviewStatusToProcessing should call repository', async () => {
    const { reviewRepository } = await import('../review-repository.js')

    await processor.updateReviewStatusToProcessing('review-1')

    expect(reviewRepository.updateReviewStatus).toHaveBeenCalledWith(
      'review-1',
      'processing'
    )
  })
})
