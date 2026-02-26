import { describe, test, expect, beforeEach, vi } from 'vitest'

import { ErrorHandler } from './error-handler.js'

// Test constants for review IDs
const TEST_REVIEW_ID_123 = 'review-123'
const TEST_REVIEW_ID_456 = 'review-456'
const TEST_REVIEW_ID_789 = 'review-789'
const TEST_REVIEW_ID_ERROR = 'review-error'
const TEST_REVIEW_ID_1 = 'review-1'
const TEST_REVIEW_ID_2 = 'review-2'
const TEST_REVIEW_ID_LONG = 'review-long'
const TEST_REVIEW_ID_NO_MSG = 'review-no-msg'

// Test constants for error messages
const TOKEN_QUOTA_EXCEEDED = 'Token Quota Exceeded'
const RATE_LIMIT_EXCEEDED = 'Rate Limit Exceeded'
const SERVICE_UNAVAILABLE = 'Service Temporarily Unavailable'
const ACCESS_DENIED = 'Access Denied'
const RESOURCE_NOT_FOUND = 'Resource Not Found'
const AUTHENTICATION_ERROR = 'Authentication Error'
const INVALID_REQUEST = 'Invalid Request'
const TIMEOUT = 'TIMEOUT'

// Test constants for message lengths
const MAX_ERROR_LENGTH = 100
const TRUNCATE_AT_LENGTH = 97
const LONG_MESSAGE_LENGTH = 150
const TEST_LENGTH_98 = 98
const TEST_LENGTH_101 = 101
const VERY_LONG_MESSAGE_LENGTH = 500

// Test constants for error messages
const ERROR_PLACEHOLDER = 'Error placeholder for testing'
const ELLIPSIS = '...'

const mockLoggerError = vi.fn()
const mockLoggerWarn = vi.fn()

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    error: (...args) => mockLoggerError(...args),
    warn: (...args) => mockLoggerWarn(...args)
  })
}))

describe('ErrorHandler - Initialization', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new ErrorHandler()
  })

  test('Should initialize handler', () => {
    expect(handler).toBeDefined()
  })
})

describe('ErrorHandler - formatErrorForUI - Timeout errors', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new ErrorHandler()
  })

  test('Should return TIMEOUT for TimeoutError name', () => {
    const error = new Error('Operation failed')
    error.name = 'TimeoutError'

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(TIMEOUT)
  })

  test('Should return TIMEOUT for "timed out" message', () => {
    const error = new Error('Connection timed out')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(TIMEOUT)
  })

  test('Should return TIMEOUT for "timeout" message', () => {
    const error = new Error('Request timeout')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(TIMEOUT)
  })

  test('Should return TIMEOUT for ETIMEDOUT error', () => {
    const error = new Error('ETIMEDOUT error occurred')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(TIMEOUT)
  })
})

describe('ErrorHandler - formatErrorForUI - Pattern-based errors', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new ErrorHandler()
  })

  test('Should return Token Quota Exceeded for token quota error', () => {
    const error = new Error('Exceeded token quota for the model')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(TOKEN_QUOTA_EXCEEDED)
  })

  test('Should return Token Quota Exceeded for tokens per minute error', () => {
    const error = new Error('Exceeded tokens per minute limit')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(TOKEN_QUOTA_EXCEEDED)
  })

  test('Should return Rate Limit Exceeded for rate limit error', () => {
    const error = new Error('API rate limit exceeded')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(RATE_LIMIT_EXCEEDED)
  })

  test('Should return Service Temporarily Unavailable for unavailable service', () => {
    const error = new Error('Service temporarily unavailable')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(SERVICE_UNAVAILABLE)
  })

  test('Should return Access Denied for access denied error', () => {
    const error = new Error('Access denied to resource')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(ACCESS_DENIED)
  })

  test('Should return Resource Not Found for not found error', () => {
    const error = new Error('Resource not found')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(RESOURCE_NOT_FOUND)
  })

  test('Should return Authentication Error for credentials error', () => {
    const error = new Error('Invalid credentials provided')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(AUTHENTICATION_ERROR)
  })

  test('Should return Invalid Request for validation error', () => {
    const error = new Error('Request validation error')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(INVALID_REQUEST)
  })
})

describe('ErrorHandler - formatErrorForUI - Bedrock errors', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new ErrorHandler()
  })

  test('Should strip Bedrock API error prefix', () => {
    const error = new Error(
      'Bedrock API error: Model inference failed due to internal error'
    )

    const result = handler.formatErrorForUI(error)

    expect(result).toBe('Model inference failed due to internal error')
  })

  test('Should truncate long Bedrock error messages', () => {
    const longMessage = 'x'.repeat(LONG_MESSAGE_LENGTH)
    const error = new Error(`Bedrock API error: ${longMessage}`)

    const result = handler.formatErrorForUI(error)

    expect(result.length).toBe(MAX_ERROR_LENGTH)
  })

  test('Should handle Bedrock error without prefix', () => {
    const error = new Error('Bedrock connection failed')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe('Bedrock connection failed')
  })
})

describe('ErrorHandler - formatErrorForUI - Long error messages', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new ErrorHandler()
  })

  test('Should truncate messages longer than 100 characters', () => {
    const longMessage = 'x'.repeat(LONG_MESSAGE_LENGTH)
    const error = new Error(longMessage)

    const result = handler.formatErrorForUI(error)

    expect(result).toBe('x'.repeat(TRUNCATE_AT_LENGTH) + ELLIPSIS)
    expect(result.length).toBe(MAX_ERROR_LENGTH)
  })

  test('Should not truncate messages equal to 100 characters', () => {
    const message = 'x'.repeat(MAX_ERROR_LENGTH)
    const error = new Error(message)

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(message)
    expect(result.length).toBe(MAX_ERROR_LENGTH)
  })

  test('Should not truncate messages shorter than 100 characters', () => {
    const message = 'Short error message'
    const error = new Error(message)

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(message)
    expect(result.length).toBeLessThan(MAX_ERROR_LENGTH)
  })
})

describe('ErrorHandler - formatErrorForUI - Generic error messages', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new ErrorHandler()
  })

  test('Should return original message for unmatched error', () => {
    const error = new Error('Some unexpected error occurred')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe('Some unexpected error occurred')
  })

  test('Should handle placeholder error message', () => {
    const error = new Error(ERROR_PLACEHOLDER)

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(ERROR_PLACEHOLDER)
  })

  test('Should handle very short error message', () => {
    const error = new Error('Error')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe('Error')
  })
})

describe('ErrorHandler - formatErrorForUI - Edge cases', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new ErrorHandler()
  })

  test('Should handle case-sensitive pattern matching', () => {
    const error = new Error('access DENIED')

    const result = handler.formatErrorForUI(error)

    expect(result).not.toBe(ACCESS_DENIED)
    expect(result).toBe('access DENIED')
  })

  test('Should match first pattern when multiple patterns match', () => {
    const error = new Error('token quota exceeded and rate limit reached')

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(TOKEN_QUOTA_EXCEEDED)
  })

  test('Should handle message exactly at 97 characters', () => {
    const message = 'x'.repeat(TRUNCATE_AT_LENGTH)
    const error = new Error(message)

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(message)
  })

  test('Should handle message at 98 characters', () => {
    const message = 'x'.repeat(TEST_LENGTH_98)
    const error = new Error(message)

    const result = handler.formatErrorForUI(error)

    expect(result).toBe(message)
  })

  test('Should handle message at 101 characters', () => {
    const message = 'x'.repeat(TEST_LENGTH_101)
    const error = new Error(message)

    const result = handler.formatErrorForUI(error)

    expect(result).toBe('x'.repeat(TRUNCATE_AT_LENGTH) + ELLIPSIS)
    expect(result.length).toBe(MAX_ERROR_LENGTH)
  })
})

describe('ErrorHandler - handleSaveErrorFailure - Basic success', () => {
  let handler
  let mockReviewRepository

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new ErrorHandler()
    mockReviewRepository = {
      updateReviewStatus: vi.fn()
    }
  })

  test('Should handle save error and update status successfully', async () => {
    const saveError = new Error('Database connection failed')
    saveError.stack = 'Error stack trace'
    mockReviewRepository.updateReviewStatus.mockResolvedValueOnce()

    await handler.handleSaveErrorFailure(
      TEST_REVIEW_ID_123,
      saveError,
      mockReviewRepository
    )

    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        reviewId: TEST_REVIEW_ID_123,
        saveError: 'Database connection failed',
        saveErrorStack: 'Error stack trace'
      },
      'CRITICAL: Failed to save review error - review will be stuck in processing state!'
    )
    expect(mockReviewRepository.updateReviewStatus).toHaveBeenCalledWith(
      TEST_REVIEW_ID_123,
      'failed',
      {
        error: {
          message: 'Processing failed - error details unavailable',
          code: 'SAVE_ERROR_FAILED'
        }
      }
    )
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { reviewId: TEST_REVIEW_ID_123 },
      'Successfully marked review as failed on retry'
    )
  })

  test('Should pass correct error structure to updateReviewStatus', async () => {
    const saveError = new Error('Save operation failed')
    mockReviewRepository.updateReviewStatus.mockResolvedValueOnce()

    await handler.handleSaveErrorFailure(
      TEST_REVIEW_ID_ERROR,
      saveError,
      mockReviewRepository
    )

    const callArgs = mockReviewRepository.updateReviewStatus.mock.calls[0]

    expect(callArgs[0]).toBe(TEST_REVIEW_ID_ERROR)
    expect(callArgs[1]).toBe('failed')
    expect(callArgs[2]).toEqual({
      error: {
        message: 'Processing failed - error details unavailable',
        code: 'SAVE_ERROR_FAILED'
      }
    })
  })
})

describe('ErrorHandler - handleSaveErrorFailure - Edge cases', () => {
  let handler
  let mockReviewRepository

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new ErrorHandler()
    mockReviewRepository = {
      updateReviewStatus: vi.fn()
    }
  })

  test('Should handle error without stack trace', async () => {
    const saveError = new Error('Error without stack')
    delete saveError.stack
    mockReviewRepository.updateReviewStatus.mockResolvedValueOnce()

    await handler.handleSaveErrorFailure(
      TEST_REVIEW_ID_789,
      saveError,
      mockReviewRepository
    )

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID_789,
        saveError: 'Error without stack'
      }),
      expect.any(String)
    )
  })

  test('Should handle very long error message in saveError', async () => {
    const longMessage = 'x'.repeat(VERY_LONG_MESSAGE_LENGTH)
    const saveError = new Error(longMessage)
    mockReviewRepository.updateReviewStatus.mockResolvedValueOnce()

    await handler.handleSaveErrorFailure(
      TEST_REVIEW_ID_LONG,
      saveError,
      mockReviewRepository
    )

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        saveError: longMessage
      }),
      expect.any(String)
    )
  })
})

describe('ErrorHandler - handleSaveErrorFailure - Failure cases', () => {
  let handler
  let mockReviewRepository

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new ErrorHandler()
    mockReviewRepository = {
      updateReviewStatus: vi.fn()
    }
  })

  test('Should handle retry failure when update status also fails', async () => {
    const saveError = new Error('Initial save failed')
    const retryError = new Error('Update status also failed')
    mockReviewRepository.updateReviewStatus.mockRejectedValueOnce(retryError)

    await handler.handleSaveErrorFailure(
      TEST_REVIEW_ID_456,
      saveError,
      mockReviewRepository
    )

    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        reviewId: TEST_REVIEW_ID_456,
        saveError: 'Initial save failed',
        saveErrorStack: expect.any(String)
      },
      'CRITICAL: Failed to save review error - review will be stuck in processing state!'
    )
    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        reviewId: TEST_REVIEW_ID_456,
        retryError: 'Update status also failed'
      },
      'CRITICAL: Review is permanently stuck - manual intervention required'
    )
    expect(mockLoggerWarn).not.toHaveBeenCalled()
  })

  test('Should handle retry error with message placeholder', async () => {
    const saveError = new Error('Save failed')
    const retryError = new Error(ERROR_PLACEHOLDER)
    mockReviewRepository.updateReviewStatus.mockRejectedValueOnce(retryError)

    await handler.handleSaveErrorFailure(
      TEST_REVIEW_ID_NO_MSG,
      saveError,
      mockReviewRepository
    )

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        retryError: ERROR_PLACEHOLDER
      }),
      'CRITICAL: Review is permanently stuck - manual intervention required'
    )
  })
})

describe('ErrorHandler - handleSaveErrorFailure - Multiple failures', () => {
  let handler
  let mockReviewRepository

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new ErrorHandler()
    mockReviewRepository = {
      updateReviewStatus: vi.fn()
    }
  })

  test('Should handle multiple sequential failures', async () => {
    const saveError1 = new Error('First failure')
    const saveError2 = new Error('Second failure')

    mockReviewRepository.updateReviewStatus.mockResolvedValueOnce()
    await handler.handleSaveErrorFailure(
      TEST_REVIEW_ID_1,
      saveError1,
      mockReviewRepository
    )

    mockReviewRepository.updateReviewStatus.mockResolvedValueOnce()
    await handler.handleSaveErrorFailure(
      TEST_REVIEW_ID_2,
      saveError2,
      mockReviewRepository
    )

    expect(mockLoggerError).toHaveBeenCalledTimes(2)
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2)
  })
})
