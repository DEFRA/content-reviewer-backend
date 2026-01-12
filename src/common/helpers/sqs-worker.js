import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from '@aws-sdk/client-sqs'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'
import { bedrockClient } from './bedrock-client.js'
import { reviewRepository } from './review-repository.js'
import { textExtractor } from './text-extractor.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const logger = createLogger()
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

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

    // Initialize S3 client for downloading files
    const s3Config = {
      region: config.get('upload.region')
    }
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true
    }
    this.s3Client = new S3Client(s3Config)

    // Load system prompt
    try {
      const promptPath = join(__dirname, '../../..', 'docs', 'system-prompt.md')
      this.systemPrompt = readFileSync(promptPath, 'utf-8')
      logger.info('System prompt loaded successfully')
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to load system prompt')
      this.systemPrompt = 'You are a helpful content reviewer assistant.'
    }
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
    const reviewId = messageBody.uploadId

    logger.info(
      {
        reviewId,
        messageType: messageBody.messageType,
        filename: messageBody.filename
      },
      'Starting content review'
    )

    try {
      // Update review status to processing
      await reviewRepository.updateReviewStatus(reviewId, 'processing')

      let textContent = ''

      // Extract text based on message type
      if (messageBody.messageType === 'file_review') {
        // Download file from S3
        logger.info(
          { reviewId, s3Key: messageBody.s3Key },
          'Downloading file from S3'
        )

        const s3Response = await this.s3Client.send(
          new GetObjectCommand({
            Bucket: messageBody.s3Bucket,
            Key: messageBody.s3Key
          })
        )

        // Convert stream to buffer
        const chunks = []
        for await (const chunk of s3Response.Body) {
          chunks.push(chunk)
        }
        const buffer = Buffer.concat(chunks)

        // Extract text from file
        logger.info(
          { reviewId, mimeType: messageBody.contentType },
          'Extracting text from file'
        )

        textContent = await textExtractor.extractText(
          buffer,
          messageBody.contentType,
          messageBody.filename
        )

        logger.info(
          {
            reviewId,
            extractedLength: textContent.length,
            wordCount: textExtractor.countWords(textContent)
          },
          'Text extracted successfully'
        )
      } else if (messageBody.messageType === 'text_review') {
        // Use text content directly
        textContent = messageBody.textContent
        logger.info(
          { reviewId, contentLength: textContent.length },
          'Using direct text content'
        )
      } else {
        throw new Error(`Unknown message type: ${messageBody.messageType}`)
      }

      // Prepare prompt for Bedrock
      const userPrompt = `Please review the following content:\n\n---\n${textContent}\n---\n\nProvide a comprehensive content review following the guidelines in your system prompt.`

      logger.info(
        { reviewId, promptLength: userPrompt.length },
        'Sending to Bedrock for review'
      )

      // Send to Bedrock with system prompt
      const bedrockResponse = await bedrockClient.sendMessage(userPrompt, [
        {
          role: 'user',
          content: [{ text: this.systemPrompt }]
        },
        {
          role: 'assistant',
          content: [
            {
              text: 'I understand. I will review content according to GOV.UK standards and provide structured feedback as specified.'
            }
          ]
        }
      ])

      if (!bedrockResponse.success) {
        throw new Error(
          bedrockResponse.blocked
            ? 'Content blocked by guardrails'
            : 'Bedrock review failed'
        )
      }

      logger.info(
        {
          reviewId,
          responseLength: bedrockResponse.content.length,
          usage: bedrockResponse.usage
        },
        'Review completed successfully'
      )

      // Save review result
      await reviewRepository.saveReviewResult(
        reviewId,
        {
          reviewContent: bedrockResponse.content,
          guardrailAssessment: bedrockResponse.guardrailAssessment,
          stopReason: bedrockResponse.stopReason,
          completedAt: new Date()
        },
        bedrockResponse.usage
      )

      logger.info({ reviewId }, 'Review saved to database')

      return {
        reviewId,
        status: 'completed',
        message: 'Review completed successfully'
      }
    } catch (error) {
      logger.error(
        {
          reviewId,
          error: error.message,
          stack: error.stack
        },
        'Review processing failed'
      )

      // Save error to database
      await reviewRepository.saveReviewError(reviewId, error.message)

      // Re-throw to mark message as failed (will retry)
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
