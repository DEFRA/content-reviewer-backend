import { describe, test, expect, beforeEach, vi } from 'vitest'

// Test constants
const TEST_QUEUE_URL = 'http://localhost:4566/000000000000/test-queue'
const TEST_REGION = 'us-east-1'
const TEST_ENDPOINT = 'http://localhost:4566'
const TEST_MAX_MESSAGES = 10
const TEST_WAIT_TIME_SECONDS = 20
const TEST_VISIBILITY_TIMEOUT = 30
const TEST_TRUNCATED_LENGTH = 23
const QUEUE_ERROR_MESSAGE = 'Queue does not exist'

// Test error messages
const ERROR_QUEUE_DOES_NOT_EXIST = 'Queue does not exist'
const ERROR_ACCESS_DENIED = 'Access denied'
const ERROR_ACCESS_DENIED_EXCEPTION = 'Access denied exception'
const ERROR_SOME_OTHER = 'Some other error'
const ERROR_THROTTLED = 'Request throttled'
const ERROR_TIMEOUT = 'Timeout'
const ERROR_ECONNRESET = 'Connection reset'
const ERROR_ETIMEDOUT = 'Connection timed out'
const ERROR_INVALID_RECEIPT = 'Invalid receipt handle'
const ERROR_INVALID_PARAMETER = 'Invalid parameter'
const ERROR_DELETE_FAILED = 'Delete failed'
const ERROR_SQS_GENERIC = 'Some SQS error'
const ERROR_THROTTLED_SHORT = 'Throttled'
const ERROR_SOME_ERROR = 'Some error'

// Test receipt handles
const LONG_RECEIPT_HANDLE =
  'AQEB1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SHORT_RECEIPT_HANDLE = 'ABC123'
const TEST_RECEIPT_HANDLE = 'AQEB1234567890ABCDEF'

const mockSend = vi.fn()
const mockLoggerError = vi.fn()
const mockLoggerWarn = vi.fn()
const mockLoggerDebug = vi.fn()

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(function () {
    return {
      send: mockSend
    }
  }),
  ReceiveMessageCommand: vi.fn(function (params) {
    return params
  }),
  DeleteMessageCommand: vi.fn(function (params) {
    return params
  })
}))

vi.mock('../../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const configValues = {
        'aws.region': TEST_REGION,
        'aws.endpoint': TEST_ENDPOINT,
        'sqs.queueUrl': TEST_QUEUE_URL,
        'sqs.maxMessages': TEST_MAX_MESSAGES,
        'sqs.waitTimeSeconds': TEST_WAIT_TIME_SECONDS,
        'sqs.visibilityTimeout': TEST_VISIBILITY_TIMEOUT
      }
      return configValues[key]
    })
  }
}))

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    error: (...args) => mockLoggerError(...args),
    warn: (...args) => mockLoggerWarn(...args),
    debug: (...args) => mockLoggerDebug(...args)
  })
}))

import { SQSMessageHandler, truncateReceiptHandle } from './message-handler.js'

describe('truncateReceiptHandle', () => {
  test('Should truncate long receipt handle', () => {
    const result = truncateReceiptHandle(LONG_RECEIPT_HANDLE)

    expect(result).toBe('AQEB1234567890ABCDEF...')
    expect(result.length).toBe(TEST_TRUNCATED_LENGTH)
  })

  test('Should return "undefined" for null receipt handle', () => {
    const result = truncateReceiptHandle(null)

    expect(result).toBe('undefined')
  })

  test('Should return "undefined" for undefined receipt handle', () => {
    const result = truncateReceiptHandle(undefined)

    expect(result).toBe('undefined')
  })

  test('Should handle short receipt handle', () => {
    const result = truncateReceiptHandle(SHORT_RECEIPT_HANDLE)

    expect(result).toBe('ABC123...')
  })
})

describe('SQSMessageHandler - constructor', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new SQSMessageHandler()
  })

  test('Should initialize with correct configuration', () => {
    expect(handler.queueUrl).toBe(TEST_QUEUE_URL)
    expect(handler.maxMessages).toBe(TEST_MAX_MESSAGES)
    expect(handler.waitTimeSeconds).toBe(TEST_WAIT_TIME_SECONDS)
    expect(handler.visibilityTimeout).toBe(TEST_VISIBILITY_TIMEOUT)
  })

  test('Should create SQS client with endpoint', () => {
    expect(handler.sqsClient).toBeDefined()
  })
})

describe('SQSMessageHandler - isCriticalQueueError', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new SQSMessageHandler()
  })

  test('Should return true for NonExistentQueue error', () => {
    const error = { message: ERROR_QUEUE_DOES_NOT_EXIST }
    const result = handler.isCriticalQueueError(
      error,
      'AWS.SimpleQueueService.NonExistentQueue'
    )

    expect(result).toBe(true)
    expect(mockLoggerError).toHaveBeenCalled()
  })

  test('Should return true for QueueDoesNotExist error', () => {
    const error = { message: ERROR_QUEUE_DOES_NOT_EXIST }
    const result = handler.isCriticalQueueError(error, 'QueueDoesNotExist')

    expect(result).toBe(true)
    expect(mockLoggerError).toHaveBeenCalled()
  })

  test('Should return true for AccessDenied error', () => {
    const error = { message: ERROR_ACCESS_DENIED }
    const result = handler.isCriticalQueueError(error, 'AccessDenied')

    expect(result).toBe(true)
    expect(mockLoggerError).toHaveBeenCalled()
  })

  test('Should return true for AccessDeniedException error', () => {
    const error = { message: ERROR_ACCESS_DENIED_EXCEPTION }
    const result = handler.isCriticalQueueError(error, 'AccessDeniedException')

    expect(result).toBe(true)
    expect(mockLoggerError).toHaveBeenCalled()
  })

  test('Should return false for non-critical errors', () => {
    const error = { message: ERROR_SOME_OTHER }
    const result = handler.isCriticalQueueError(error, 'SomeOtherError')

    expect(result).toBe(false)
    expect(mockLoggerError).not.toHaveBeenCalled()
  })
})

describe('SQSMessageHandler - isRetryableError', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new SQSMessageHandler()
  })

  test('Should return true for ThrottlingException', () => {
    const error = { message: ERROR_THROTTLED }
    const result = handler.isRetryableError(error, 'ThrottlingException')

    expect(result).toBe(true)
    expect(mockLoggerWarn).toHaveBeenCalled()
  })

  test('Should return true for RequestThrottled', () => {
    const error = { message: ERROR_THROTTLED }
    const result = handler.isRetryableError(error, 'RequestThrottled')

    expect(result).toBe(true)
    expect(mockLoggerWarn).toHaveBeenCalled()
  })

  test('Should return true for TimeoutError', () => {
    const error = { message: ERROR_TIMEOUT, name: 'TimeoutError' }
    const result = handler.isRetryableError(error, 'TimeoutError')

    expect(result).toBe(true)
    expect(mockLoggerWarn).toHaveBeenCalled()
  })

  test('Should return true for ETIMEDOUT error', () => {
    const error = { message: ERROR_ETIMEDOUT, code: 'ETIMEDOUT' }
    const result = handler.isRetryableError(error, null)

    expect(result).toBe(true)
    expect(mockLoggerWarn).toHaveBeenCalled()
  })

  test('Should return true for ECONNRESET error', () => {
    const error = { message: ERROR_ECONNRESET, code: 'ECONNRESET' }
    const result = handler.isRetryableError(error, null)

    expect(result).toBe(true)
    expect(mockLoggerWarn).toHaveBeenCalled()
  })

  test('Should return false for non-retryable errors', () => {
    const error = { message: ERROR_SOME_ERROR }
    const result = handler.isRetryableError(error, 'SomeError')

    expect(result).toBe(false)
    expect(mockLoggerWarn).not.toHaveBeenCalled()
  })
})

describe('SQSMessageHandler - receiveMessages', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new SQSMessageHandler()
  })

  test('Should receive messages successfully', async () => {
    const mockMessages = [
      { MessageId: '1', Body: 'Message 1' },
      { MessageId: '2', Body: 'Message 2' }
    ]
    mockSend.mockResolvedValueOnce({ Messages: mockMessages })

    const result = await handler.receiveMessages()

    expect(result).toEqual(mockMessages)
    expect(mockSend).toHaveBeenCalledWith({
      QueueUrl: TEST_QUEUE_URL,
      MaxNumberOfMessages: TEST_MAX_MESSAGES,
      WaitTimeSeconds: TEST_WAIT_TIME_SECONDS,
      VisibilityTimeout: TEST_VISIBILITY_TIMEOUT,
      MessageAttributeNames: ['All'],
      AttributeNames: ['All']
    })
  })

  test('Should return empty array when no messages', async () => {
    mockSend.mockResolvedValueOnce({})

    const result = await handler.receiveMessages()

    expect(result).toEqual([])
  })

  test('Should throw error for critical queue errors', async () => {
    const error = new Error(QUEUE_ERROR_MESSAGE)
    error.Code = 'QueueDoesNotExist'
    mockSend.mockRejectedValueOnce(error)

    await expect(handler.receiveMessages()).rejects.toThrow(QUEUE_ERROR_MESSAGE)
    expect(mockLoggerError).toHaveBeenCalled()
  })

  test('Should return empty array for retryable errors', async () => {
    const error = new Error(ERROR_THROTTLED_SHORT)
    error.Code = 'ThrottlingException'
    mockSend.mockRejectedValueOnce(error)

    const result = await handler.receiveMessages()

    expect(result).toEqual([])
    expect(mockLoggerWarn).toHaveBeenCalled()
  })

  test('Should return empty array and log error for other errors', async () => {
    const error = new Error(ERROR_SQS_GENERIC)
    error.name = 'SomeError'
    mockSend.mockRejectedValueOnce(error)

    const result = await handler.receiveMessages()

    expect(result).toEqual([])
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: ERROR_SQS_GENERIC,
        errorName: 'SomeError'
      }),
      'Failed to receive messages from SQS - will retry'
    )
  })
})

describe('SQSMessageHandler - deleteMessage', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new SQSMessageHandler()
  })

  test('Should delete message successfully', async () => {
    mockSend.mockResolvedValueOnce({})

    await handler.deleteMessage(TEST_RECEIPT_HANDLE)

    expect(mockSend).toHaveBeenCalledWith({
      QueueUrl: TEST_QUEUE_URL,
      ReceiptHandle: TEST_RECEIPT_HANDLE
    })
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptHandle: 'AQEB1234567890ABCDEF...'
      }),
      'Message deleted from SQS queue'
    )
  })

  test('Should warn when receipt handle is missing', async () => {
    await handler.deleteMessage(null)

    expect(mockSend).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Cannot delete message: missing receipt handle'
    )
  })

  test('Should warn when receipt handle is undefined', async () => {
    await handler.deleteMessage(undefined)

    expect(mockSend).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Cannot delete message: missing receipt handle'
    )
  })

  test('Should handle invalid receipt handle error gracefully', async () => {
    const error = new Error(ERROR_INVALID_RECEIPT)
    error.Code = 'ReceiptHandleIsInvalid'
    mockSend.mockRejectedValueOnce(error)

    await handler.deleteMessage(TEST_RECEIPT_HANDLE)

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: ERROR_INVALID_RECEIPT,
        errorCode: 'ReceiptHandleIsInvalid'
      }),
      'Message receipt handle is invalid (message may have already been deleted or expired)'
    )
  })

  test('Should handle InvalidParameterValue error gracefully', async () => {
    const error = new Error(ERROR_INVALID_PARAMETER)
    error.Code = 'InvalidParameterValue'
    mockSend.mockRejectedValueOnce(error)

    await handler.deleteMessage(TEST_RECEIPT_HANDLE)

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: ERROR_INVALID_PARAMETER,
        errorCode: 'InvalidParameterValue'
      }),
      'Message receipt handle is invalid (message may have already been deleted or expired)'
    )
  })

  test('Should log error for other delete failures', async () => {
    const error = new Error(ERROR_DELETE_FAILED)
    error.name = 'DeleteError'
    mockSend.mockRejectedValueOnce(error)

    await handler.deleteMessage(TEST_RECEIPT_HANDLE)

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: ERROR_DELETE_FAILED,
        errorCode: 'DeleteError'
      }),
      'Failed to delete message from SQS - message will be reprocessed after visibility timeout'
    )
  })
})
