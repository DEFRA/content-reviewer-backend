import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from '@aws-sdk/client-sqs'
import { config } from '../../../config.js'
import { createLogger } from '../logging/logger.js'

const logger = createLogger()

const AWS_REGION = 'aws.region'
const AWS_ENDPOINT = 'aws.endpoint'
const RECEIPT_HANDLE_PREVIEW_LENGTH = 20

/**
 * Truncate receipt handle for logging
 * @param {string} receiptHandle - Receipt handle to truncate
 * @returns {string} Truncated receipt handle with ellipsis
 */
export function truncateReceiptHandle(receiptHandle) {
  if (!receiptHandle) {
    return 'undefined'
  }
  return receiptHandle.substring(0, RECEIPT_HANDLE_PREVIEW_LENGTH) + '...'
}

/**
 * SQS Message Handler - handles low-level SQS operations
 */
export class SQSMessageHandler {
  constructor() {
    const sqsConfig = {
      region: config.get(AWS_REGION)
    }

    const awsEndpoint = config.get(AWS_ENDPOINT)
    if (awsEndpoint) {
      sqsConfig.endpoint = awsEndpoint
    }

    this.sqsClient = new SQSClient(sqsConfig)
    this.queueUrl = config.get('sqs.queueUrl')
    this.maxMessages = config.get('sqs.maxMessages')
    this.waitTimeSeconds = config.get('sqs.waitTimeSeconds')
    this.visibilityTimeout = config.get('sqs.visibilityTimeout')
  }

  /**
   * Check if error is a critical queue error that should stop the worker
   */
  isCriticalQueueError(error, errorCode) {
    if (
      errorCode === 'AWS.SimpleQueueService.NonExistentQueue' ||
      errorCode === 'QueueDoesNotExist'
    ) {
      logger.error(
        { error: error.message, queueUrl: this.queueUrl, errorCode },
        'CRITICAL: SQS queue does not exist - stopping worker'
      )
      return true
    }

    if (errorCode === 'AccessDenied' || errorCode === 'AccessDeniedException') {
      logger.error(
        { error: error.message, queueUrl: this.queueUrl, errorCode },
        'CRITICAL: Access denied to SQS queue - check IAM permissions - stopping worker'
      )
      return true
    }

    return false
  }

  /**
   * Check if error is a retryable error (throttling or network)
   */
  isRetryableError(error, errorCode) {
    if (
      errorCode === 'ThrottlingException' ||
      errorCode === 'RequestThrottled'
    ) {
      logger.warn(
        { error: error.message, errorCode },
        'SQS request throttled - will retry after delay'
      )
      return true
    }

    if (
      error.name === 'TimeoutError' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ECONNRESET'
    ) {
      logger.warn(
        { error: error.message, errorCode: error.code || error.name },
        'SQS network error - will retry after delay'
      )
      return true
    }

    return false
  }

  /**
   * Receive messages from SQS queue
   */
  async receiveMessages() {
    const command = new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: this.maxMessages,
      WaitTimeSeconds: this.waitTimeSeconds,
      VisibilityTimeout: this.visibilityTimeout,
      MessageAttributeNames: ['All'],
      AttributeNames: ['All']
    })

    try {
      const result = await this.sqsClient.send(command)
      return result.Messages || []
    } catch (error) {
      const errorCode = error.Code || error.name

      if (this.isCriticalQueueError(error, errorCode)) {
        throw error
      }

      if (this.isRetryableError(error, errorCode)) {
        return []
      }

      logger.error(
        {
          error: error.message,
          errorName: error.name,
          errorCode,
          queueUrl: this.queueUrl
        },
        'Failed to receive messages from SQS - will retry'
      )

      return []
    }
  }

  /**
   * Delete message from queue
   */
  async deleteMessage(receiptHandle) {
    if (!receiptHandle) {
      logger.warn('Cannot delete message: missing receipt handle')
      return
    }

    const command = new DeleteMessageCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: receiptHandle
    })

    try {
      await this.sqsClient.send(command)
      logger.debug(
        { receiptHandle: truncateReceiptHandle(receiptHandle) },
        'Message deleted from SQS queue'
      )
    } catch (error) {
      const errorCode = error.Code || error.name

      if (
        errorCode === 'ReceiptHandleIsInvalid' ||
        errorCode === 'InvalidParameterValue'
      ) {
        logger.warn(
          {
            error: error.message,
            errorCode,
            receiptHandle: truncateReceiptHandle(receiptHandle)
          },
          'Message receipt handle is invalid (message may have already been deleted or expired)'
        )
        return
      }

      logger.error(
        {
          error: error.message,
          errorCode,
          receiptHandle: truncateReceiptHandle(receiptHandle)
        },
        'Failed to delete message from SQS - message will be reprocessed after visibility timeout'
      )
    }
  }
}
