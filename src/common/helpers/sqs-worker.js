import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from '@aws-sdk/client-sqs'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * SQS Worker to process messages from content review queue
 */
class SQSWorker {
  constructor() {
    const sqsConfig = {
      region: config.get('sqs.region')
    }

    // Add endpoint for LocalStack if configured
    const awsEndpoint =
      process.env.AWS_ENDPOINT || process.env.LOCALSTACK_ENDPOINT
    if (awsEndpoint) {
      sqsConfig.endpoint = awsEndpoint
    }

    this.sqsClient = new SQSClient(sqsConfig)
    this.queueUrl = config.get('sqs.queueUrl')
    this.isRunning = false
    this.maxMessages = config.get('sqs.maxMessages')
    this.waitTimeSeconds = config.get('sqs.waitTimeSeconds')
    this.visibilityTimeout = config.get('sqs.visibilityTimeout')
  }

  /**
   * Start polling for messages
   */
  async start() {
    if (this.isRunning) {
      logger.warn('SQS Worker is already running')
      return
    }

    this.isRunning = true
    logger.info(
      {
        queueUrl: this.queueUrl,
        maxMessages: this.maxMessages,
        waitTimeSeconds: this.waitTimeSeconds
      },
      'SQS Worker started'
    )

    // Start polling loop
    this.poll()
  }

  /**
   * Stop polling for messages
   */
  stop() {
    this.isRunning = false
    logger.info('SQS Worker stopped')
  }

  /**
   * Get the current status of the worker
   * @returns {Object} Worker status information
   */
  getStatus() {
    return {
      running: this.isRunning,
      queueUrl: this.queueUrl,
      region: config.get('sqs.region'),
      maxMessages: this.maxMessages,
      waitTimeSeconds: this.waitTimeSeconds,
      visibilityTimeout: this.visibilityTimeout
    }
  }

  /**
   * Poll for messages from SQS queue
   */
  async poll() {
    while (this.isRunning) {
      try {
        const messages = await this.receiveMessages()

        if (messages && messages.length > 0) {
          logger.info(
            { messageCount: messages.length },
            'Received messages from SQS'
          )

          // Process messages in parallel
          await Promise.all(
            messages.map((message) => this.processMessage(message))
          )
        }
      } catch (error) {
        logger.error(
          { error: error.message, stack: error.stack },
          'Error polling SQS queue'
        )
        // Wait before retrying
        await this.sleep(5000)
      }
    }
  }

  /**
   * Receive messages from SQS queue
   * @returns {Promise<Array>} Array of messages
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
      logger.error(
        { error: error.message },
        'Failed to receive messages from SQS'
      )
      throw error
    }
  }

  /**
   * Process a single message
   * @param {Object} message - SQS message
   */
  async processMessage(message) {
    try {
      const body = JSON.parse(message.Body)

      logger.info(
        {
          messageId: message.MessageId,
          uploadId: body.uploadId,
          messageType: body.messageType
        },
        'Processing message'
      )

      // TODO: This is where your colleague will integrate the AI review logic
      // For now, we'll just log the message and simulate processing
      await this.processContentReview(body)

      // Delete message from queue after successful processing
      await this.deleteMessage(message.ReceiptHandle)

      logger.info(
        {
          messageId: message.MessageId,
          uploadId: body.uploadId
        },
        'Message processed successfully'
      )
    } catch (error) {
      logger.error(
        {
          messageId: message.MessageId,
          error: error.message,
          stack: error.stack
        },
        'Failed to process message'
      )
      // Message will become visible again after visibility timeout
      // and will be retried
    }
  }

  /**
   * Process content review (placeholder for AI integration)
   * @param {Object} messageBody - Message body from SQS
   */
  async processContentReview(messageBody) {
    logger.info(
      {
        uploadId: messageBody.uploadId,
        messageType: messageBody.messageType,
        filename: messageBody.filename,
        s3Location: messageBody.s3Location
      },
      'Content review requested'
    )

    // TODO: Your colleague will implement this
    // This is where the AI content review will happen:
    // 1. If file upload: Download file from S3
    // 2. Extract text content from file
    // 3. Send to AI prompt for review
    // 4. Get review results
    // 5. Store results (database/S3)
    // 6. Optionally notify user

    // Simulate processing time
    await this.sleep(1000)

    // Placeholder response
    const reviewResult = {
      uploadId: messageBody.uploadId,
      status: 'pending_ai_integration',
      message:
        'File received and queued. AI review integration will be implemented by your colleague.',
      s3Location: messageBody.s3Location,
      processedAt: new Date().toISOString()
    }

    logger.info(
      { uploadId: messageBody.uploadId, result: reviewResult },
      'Content review placeholder executed'
    )

    return reviewResult
  }

  /**
   * Delete message from queue
   * @param {string} receiptHandle - Message receipt handle
   */
  async deleteMessage(receiptHandle) {
    const command = new DeleteMessageCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: receiptHandle
    })

    try {
      await this.sqsClient.send(command)
    } catch (error) {
      logger.error(
        { error: error.message },
        'Failed to delete message from SQS'
      )
      throw error
    }
  }

  /**
   * Sleep helper
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// Create singleton instance
export const sqsWorker = new SQSWorker()

// Export class for testing
export { SQSWorker }
