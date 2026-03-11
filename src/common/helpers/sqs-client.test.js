import { describe, test, expect, beforeEach, vi } from 'vitest'

const mockSend = vi.hoisted(() => vi.fn())
const mockLoggerFns = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(function () {
    this.send = mockSend
  }),
  SendMessageCommand: vi.fn(function (params) {
    Object.assign(this, params)
    return this
  })
}))

vi.mock('../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const configMap = {
        'aws.region': 'eu-west-2',
        'aws.endpoint': null,
        'sqs.queueUrl':
          'https://sqs.eu-west-2.amazonaws.com/123456789/test-queue',
        'sqs.queueName': 'test-queue'
      }
      return configMap[key]
    })
  }
}))

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => mockLoggerFns)
}))

import { sqsClient } from './sqs-client.js'

const TEST_CONSTANTS = {
  UPLOAD_ID: 'test-upload-123',
  REVIEW_ID: 'test-review-456',
  FILENAME: 'test-document.pdf',
  S3_BUCKET: 'test-bucket',
  S3_KEY: 'uploads/test-document.pdf',
  S3_LOCATION: 's3://test-bucket/uploads/test-document.pdf',
  CONTENT_TYPE: 'application/pdf',
  FILE_SIZE: 1024,
  MESSAGE_ID: 'msg-123456',
  QUEUE_URL: 'https://sqs.eu-west-2.amazonaws.com/123456789/test-queue',
  USER_ID: 'user-123',
  SESSION_ID: 'session-456',
  TEXT_CONTENT: 'Test content for review',
  ZERO: 0,
  ONE: 1
}

describe('SQSClientHelper - Initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should initialize with correct SQS configuration', () => {
    expect(sqsClient.queueUrl).toBe(TEST_CONSTANTS.QUEUE_URL)
    expect(sqsClient.queueName).toBe('test-queue')
  })
  test('Should initialize SQS client', () => {
    expect(sqsClient.sqsClient).toBeDefined()
  })
})

describe('SQSClientHelper - Build Message Body', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should build message body with all fields and defaults', () => {
    const completeData = {
      uploadId: TEST_CONSTANTS.UPLOAD_ID,
      reviewId: TEST_CONSTANTS.REVIEW_ID,
      filename: TEST_CONSTANTS.FILENAME,
      s3Bucket: TEST_CONSTANTS.S3_BUCKET,
      s3Key: TEST_CONSTANTS.S3_KEY,
      s3Location: TEST_CONSTANTS.S3_LOCATION,
      contentType: TEST_CONSTANTS.CONTENT_TYPE,
      fileSize: TEST_CONSTANTS.FILE_SIZE,
      messageType: 'file_upload',
      userId: TEST_CONSTANTS.USER_ID,
      sessionId: TEST_CONSTANTS.SESSION_ID
    }
    const result = sqsClient._buildMessageBody(completeData)
    expect(result.uploadId).toBe(TEST_CONSTANTS.UPLOAD_ID)
    expect(result.reviewId).toBe(TEST_CONSTANTS.REVIEW_ID)
    expect(result.filename).toBe(TEST_CONSTANTS.FILENAME)
    expect(result.uploadedAt).toBeDefined()
    const minimalData = {
      uploadId: TEST_CONSTANTS.UPLOAD_ID,
      filename: TEST_CONSTANTS.FILENAME,
      s3Bucket: TEST_CONSTANTS.S3_BUCKET,
      s3Key: TEST_CONSTANTS.S3_KEY,
      s3Location: TEST_CONSTANTS.S3_LOCATION,
      contentType: TEST_CONSTANTS.CONTENT_TYPE,
      fileSize: TEST_CONSTANTS.FILE_SIZE
    }
    const result2 = sqsClient._buildMessageBody(minimalData)
    expect(result2.reviewId).toBe(TEST_CONSTANTS.UPLOAD_ID)
    expect(result2.messageType).toBe('file_upload')
    expect(result2.userId).toBe('anonymous')
    expect(result2.sessionId).toBeNull()
  })
})

describe('SQSClientHelper - Create Send Command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should create command with parameters and attributes', () => {
    const messageData = {
      uploadId: TEST_CONSTANTS.UPLOAD_ID,
      messageType: 'file_upload',
      contentType: TEST_CONSTANTS.CONTENT_TYPE
    }
    const messageBody = { uploadId: TEST_CONSTANTS.UPLOAD_ID }
    const command = sqsClient._createSendCommand(messageData, messageBody)
    expect(command.QueueUrl).toBe(TEST_CONSTANTS.QUEUE_URL)
    expect(command.MessageBody).toBe(JSON.stringify(messageBody))
    expect(command.MessageAttributes.UploadId.StringValue).toBe(
      TEST_CONSTANTS.UPLOAD_ID
    )
    expect(command.MessageAttributes.MessageType.StringValue).toBe(
      'file_upload'
    )
    const minimalData = { uploadId: TEST_CONSTANTS.UPLOAD_ID }
    const cmd2 = sqsClient._createSendCommand(minimalData, messageBody)
    expect(cmd2.MessageAttributes.MessageType.StringValue).toBe('file_upload')
    expect(cmd2.MessageAttributes.ContentType.StringValue).toBe('text/plain')
  })
})

describe('SQSClientHelper - Send Message Success', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  const messageData = {
    uploadId: TEST_CONSTANTS.UPLOAD_ID,
    reviewId: TEST_CONSTANTS.REVIEW_ID,
    filename: TEST_CONSTANTS.FILENAME,
    s3Bucket: TEST_CONSTANTS.S3_BUCKET,
    s3Key: TEST_CONSTANTS.S3_KEY,
    s3Location: TEST_CONSTANTS.S3_LOCATION,
    contentType: TEST_CONSTANTS.CONTENT_TYPE,
    fileSize: TEST_CONSTANTS.FILE_SIZE
  }
  test('Should send message and log info', async () => {
    mockSend.mockResolvedValueOnce({ MessageId: TEST_CONSTANTS.MESSAGE_ID })
    const result = await sqsClient.sendMessage(messageData)
    expect(result.success).toBe(true)
    expect(result.messageId).toBe(TEST_CONSTANTS.MESSAGE_ID)
    expect(mockSend).toHaveBeenCalledTimes(TEST_CONSTANTS.ONE)
    expect(mockLoggerFns.info).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId: TEST_CONSTANTS.UPLOAD_ID,
        reviewId: TEST_CONSTANTS.REVIEW_ID
      }),
      'Sending message to SQS queue'
    )
  })
})

describe('SQSClientHelper - Send Message Errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should handle and log errors', async () => {
    const error = new Error('SQS error')
    error.name = 'SQSException'
    error.Code = 'ServiceUnavailable'
    mockSend.mockRejectedValueOnce(error)
    const messageData = {
      uploadId: TEST_CONSTANTS.UPLOAD_ID,
      reviewId: TEST_CONSTANTS.REVIEW_ID,
      filename: TEST_CONSTANTS.FILENAME,
      s3Bucket: TEST_CONSTANTS.S3_BUCKET,
      s3Key: TEST_CONSTANTS.S3_KEY,
      s3Location: TEST_CONSTANTS.S3_LOCATION,
      contentType: TEST_CONSTANTS.CONTENT_TYPE,
      fileSize: TEST_CONSTANTS.FILE_SIZE
    }
    await expect(sqsClient.sendMessage(messageData)).rejects.toThrow(
      'SQS send failed'
    )
    expect(mockLoggerFns.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'SQS error',
        errorName: 'SQSException',
        uploadId: TEST_CONSTANTS.UPLOAD_ID
      }),
      expect.stringContaining('SQS message send failed')
    )
  })
})

describe('SQSClientHelper - Send Text Content', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should send text and handle uploadId generation', async () => {
    mockSend.mockResolvedValue({ MessageId: TEST_CONSTANTS.MESSAGE_ID })
    const result = await sqsClient.sendTextContent({
      textContent: TEST_CONSTANTS.TEXT_CONTENT,
      userId: TEST_CONSTANTS.USER_ID
    })
    expect(result.success).toBe(true)
    let cmd = mockSend.mock.calls[TEST_CONSTANTS.ZERO][TEST_CONSTANTS.ZERO]
    let body = JSON.parse(cmd.MessageBody)
    expect(body.uploadId).toMatch(/^text-\d+$/)
    expect(body.messageType).toBe('text_content')
    expect(body.fileSize).toBe(TEST_CONSTANTS.TEXT_CONTENT.length)
    await sqsClient.sendTextContent({
      uploadId: TEST_CONSTANTS.UPLOAD_ID,
      textContent: TEST_CONSTANTS.TEXT_CONTENT,
      userId: TEST_CONSTANTS.USER_ID
    })
    cmd = mockSend.mock.calls[TEST_CONSTANTS.ONE][TEST_CONSTANTS.ZERO]
    body = JSON.parse(cmd.MessageBody)
    expect(body.uploadId).toBe(TEST_CONSTANTS.UPLOAD_ID)
  })
  test('Should set null for file fields and handle empty text', async () => {
    mockSend.mockResolvedValue({ MessageId: TEST_CONSTANTS.MESSAGE_ID })
    await sqsClient.sendTextContent({
      textContent: TEST_CONSTANTS.TEXT_CONTENT,
      userId: TEST_CONSTANTS.USER_ID
    })
    let cmd = mockSend.mock.calls[TEST_CONSTANTS.ZERO][TEST_CONSTANTS.ZERO]
    let body = JSON.parse(cmd.MessageBody)
    expect(body.filename).toBeNull()
    expect(body.s3Bucket).toBeNull()
    await sqsClient.sendTextContent({ textContent: '', userId: 'user' })
    cmd = mockSend.mock.calls[TEST_CONSTANTS.ONE][TEST_CONSTANTS.ZERO]
    body = JSON.parse(cmd.MessageBody)
    expect(body.fileSize).toBe(TEST_CONSTANTS.ZERO)
  })
})

describe('SQSClientHelper - Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should handle various error types', async () => {
    mockSend.mockRejectedValueOnce(new Error('Network error'))
    await expect(
      sqsClient.sendMessage({
        uploadId: TEST_CONSTANTS.UPLOAD_ID,
        filename: TEST_CONSTANTS.FILENAME,
        s3Bucket: TEST_CONSTANTS.S3_BUCKET,
        s3Key: TEST_CONSTANTS.S3_KEY,
        s3Location: TEST_CONSTANTS.S3_LOCATION,
        contentType: TEST_CONSTANTS.CONTENT_TYPE,
        fileSize: TEST_CONSTANTS.FILE_SIZE
      })
    ).rejects.toThrow('SQS send failed')
    const throttleError = new Error('Throttling')
    throttleError.name = 'ThrottlingException'
    mockSend.mockRejectedValueOnce(throttleError)
    await expect(
      sqsClient.sendMessage({
        uploadId: TEST_CONSTANTS.UPLOAD_ID,
        filename: TEST_CONSTANTS.FILENAME,
        s3Bucket: TEST_CONSTANTS.S3_BUCKET,
        s3Key: TEST_CONSTANTS.S3_KEY,
        s3Location: TEST_CONSTANTS.S3_LOCATION,
        contentType: TEST_CONSTANTS.CONTENT_TYPE,
        fileSize: TEST_CONSTANTS.FILE_SIZE
      })
    ).rejects.toThrow('SQS send failed: Throttling')
  })
})
