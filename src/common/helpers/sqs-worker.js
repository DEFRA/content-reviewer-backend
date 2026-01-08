import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from '@aws-sdk/client-sqs'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'
import { reviewStatusTracker } from './review-status-tracker.js'
import { bedrockAIService } from './bedrock-ai-service.js'
import { documentExtractor } from './document-extractor.js'

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
   * Handles both S3 event notifications and application messages
   * @param {Object} message - SQS message
   */
  async processMessage(message) {
    let uploadId = null

    try {
      const body = JSON.parse(message.Body)

      // Determine message type
      let messageData
      let messageType

      if (body.Records && body.Records[0] && body.Records[0].s3) {
        // S3 Event Notification format
        messageType = 's3_event'
        const s3Event = body.Records[0]

        messageData = {
          messageType: 's3_event',
          eventName: s3Event.eventName,
          eventTime: s3Event.eventTime,
          s3Bucket: s3Event.s3.bucket.name,
          s3Key: s3Event.s3.object.key,
          fileSize: s3Event.s3.object.size,
          eTag: s3Event.s3.object.eTag,
          // Generate uploadId from the S3 key if not present
          uploadId: s3Event.s3.object.key.split('/').pop().split('.')[0],
          filename: s3Event.s3.object.key.split('/').pop(),
          s3Location: `https://${s3Event.s3.bucket.name}.s3.${s3Event.awsRegion}.amazonaws.com/${s3Event.s3.object.key}`
        }

        uploadId = messageData.uploadId

        logger.info(
          {
            messageId: message.MessageId,
            eventName: s3Event.eventName,
            s3Bucket: messageData.s3Bucket,
            s3Key: messageData.s3Key,
            fileSize: messageData.fileSize,
            uploadId
          },
          'Processing S3 event notification'
        )
      } else {
        // Application message format (sent from upload route)
        messageType = 'application'
        messageData = body
        uploadId = body.uploadId

        logger.info(
          {
            messageId: message.MessageId,
            uploadId: body.uploadId,
            messageType: body.messageType || 'application'
          },
          'Processing application message'
        )
      }

      // Update status: processing started
      if (uploadId) {
        await reviewStatusTracker.updateStatus(
          uploadId,
          'processing',
          'Worker started processing',
          35
        )
      }

      // Process the content review
      await this.processContentReview(messageData)

      // Delete message from queue after successful processing
      await this.deleteMessage(message.ReceiptHandle)

      logger.info(
        {
          messageId: message.MessageId,
          uploadId: messageData.uploadId,
          type: messageType
        },
        'Message processed successfully'
      )
    } catch (error) {
      logger.error(
        {
          messageId: message.MessageId,
          uploadId,
          error: error.message,
          stack: error.stack
        },
        'Failed to process message'
      )

      // Mark as failed if we have uploadId
      if (uploadId) {
        await reviewStatusTracker.markFailed(
          uploadId,
          `Processing failed: ${error.message}`
        )
      }

      // Message will become visible again after visibility timeout
      // and will be retried
    }
  }

  /**
   * Process content review (placeholder for AI integration)
   * @param {Object} messageBody - Message body from SQS
   */
  async processContentReview(messageBody) {
    const uploadId = messageBody.uploadId

    try {
      logger.info(
        {
          uploadId: messageBody.uploadId,
          messageType: messageBody.messageType,
          filename: messageBody.filename,
          s3Location: messageBody.s3Location
        },
        'Content review requested'
      )

      // Step 1: Downloading and extracting from S3
      await reviewStatusTracker.updateStatus(
        uploadId,
        'downloading',
        'Downloading file from S3',
        45
      )

      // Extract text content from document
      const extractionResult = await documentExtractor.extractText(
        messageBody.s3Bucket,
        messageBody.s3Key,
        messageBody.contentType
      )

      const extractedContent = extractionResult.text
      const extractionMetadata = extractionResult.metadata

      logger.info(
        {
          uploadId,
          extractionMethod: extractionResult.extractionMethod,
          contentLength: extractedContent.length,
          wordCount: extractionMetadata.wordCount
        },
        'File downloaded and text extracted from S3'
      )

      // Step 2: Analyzing content
      await reviewStatusTracker.updateStatus(
        uploadId,
        'analyzing',
        'Analyzing document structure and content',
        60
      )

      // Content is already extracted, this step can include additional analysis
      // For now, we'll proceed directly to AI review
      await this.sleep(500)

      logger.info({ uploadId }, 'Content analyzed, preparing for AI review')

      // Step 3: AI Review with GOV.UK rules
      await reviewStatusTracker.updateStatus(
        uploadId,
        'reviewing',
        'AI content review in progress against GOV.UK standards',
        70
      )

      // Call Bedrock AI for comprehensive review
      const reviewResult = await bedrockAIService.reviewContent(
        extractedContent,
        messageBody.filename,
        {
          uploadId: messageBody.uploadId,
          s3Location: messageBody.s3Location,
          extractionMetadata
        }
      )

      logger.info(
        {
          uploadId,
          inputTokens: reviewResult.aiMetadata?.inputTokens,
          outputTokens: reviewResult.aiMetadata?.outputTokens,
          totalIssues: reviewResult.metrics?.totalIssues
        },
        'AI review completed against GOV.UK standards'
      )

      // Step 4: Finalizing
      await reviewStatusTracker.updateStatus(
        uploadId,
        'finalizing',
        'Saving review results',
        90
      )

      // Save review results to status tracker
      await this.sleep(500)

      // Step 5: Mark as completed with AI review results
      await reviewStatusTracker.markCompleted(uploadId, reviewResult)

      logger.info(
        {
          uploadId,
          totalIssues: reviewResult.metrics?.totalIssues,
          readyForPublication: reviewResult.overallStatus?.readyForPublication
        },
        'Content review completed successfully'
      )

      return reviewResult
    } catch (error) {
      logger.error(
        { uploadId, error: error.message, stack: error.stack },
        'Content review failed'
      )

      // Mark as failed
      await reviewStatusTracker.markFailed(
        uploadId,
        `Review failed: ${error.message}`
      )

      throw error
    }
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
