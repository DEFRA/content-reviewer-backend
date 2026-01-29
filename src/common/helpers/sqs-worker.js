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
import { promptManager } from './prompt-manager.js'

const logger = createLogger()

/**
 * SQS Worker to process messages from content review queue
 */
class SQSWorker {
  constructor() {
    const sqsConfig = {
      region: config.get('aws.region')
    }

    // Add endpoint for LocalStack if configured
    const awsEndpoint = config.get('aws.endpoint')
    if (awsEndpoint) {
      sqsConfig.endpoint = awsEndpoint
    }

    this.sqsClient = new SQSClient(sqsConfig)
    this.queueUrl = config.get('sqs.queueUrl')
    this.isRunning = false
    this.maxMessages = config.get('sqs.maxMessages')
    this.waitTimeSeconds = config.get('sqs.waitTimeSeconds')
    this.visibilityTimeout = config.get('sqs.visibilityTimeout')

    /*
     * Convert a readable stream to a string
     * @param {ReadableStream} stream - The stream to convert
     * @returns {Promise<string>} The stream content as a string
     */
    /*async function streamToString(stream) {
      const chunks = []
      for await (const chunk of stream) {
        chunks.push(chunk)
      }
      return Buffer.concat(chunks).toString('utf-8')
    }*/

    // Initialize S3 client for downloading files
    const s3Config = {
      region: config.get('aws.region')
    }
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true
    }
    this.s3Client = new S3Client(s3Config)

    logger.info(
      'SQS Worker initialized - system prompt will be loaded from S3 on demand'
    )
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
    const startTime = performance.now()

    try {
      const body = JSON.parse(message.Body)

      logger.info(
        {
          messageId: message.MessageId,
          uploadId: body.uploadId,
          reviewId: body.reviewId,
          messageType: body.messageType,
          s3Key: body.s3Key,
          receiptHandle: message.ReceiptHandle?.substring(0, 20) + '...'
        },
        'Processing SQS message started'
      )

      // TODO: This is where your colleague will integrate the AI review logic
      // For now, we'll just log the message and simulate processing
      await this.processContentReview(body)

      // Delete message from queue after successful processing
      await this.deleteMessage(message.ReceiptHandle)

      const endTime = performance.now()
      const duration = Math.round(endTime - startTime)

      logger.info(
        {
          messageId: message.MessageId,
          uploadId: body.uploadId,
          reviewId: body.reviewId,
          durationMs: duration
        },
        `SQS message processed successfully in ${duration}ms`
      )
    } catch (error) {
      const endTime = performance.now()
      const duration = Math.round(endTime - startTime)

      logger.error(
        {
          messageId: message.MessageId,
          error: error.message,
          errorName: error.name,
          stack: error.stack,
          durationMs: duration
        },
        `Failed to process SQS message after ${duration}ms: ${error.message}`
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
    // Use the reviewId as the canonical identifier; fall back to uploadId for older messages
    const reviewId = messageBody.reviewId || messageBody.uploadId
    const uploadId = messageBody.uploadId || messageBody.reviewId

    if (!reviewId) {
      throw new Error('Missing reviewId in message body')
    }

    const processingStartTime = performance.now()

    logger.info(
      {
        reviewId,
        uploadId,
        messageType: messageBody.messageType,
        filename: messageBody.filename,
        s3Key: messageBody.s3Key,
        fileSize: messageBody.fileSize
      },
      'Content review processing started'
    )

    try {
      // Update review status to processing
      await reviewRepository.updateReviewStatus(reviewId, 'processing')

      let textContent = ''

      // Extract text based on message type
      if (messageBody.messageType === 'file_review') {
        // Download file from S3
        logger.info(
          {
            reviewId,
            s3Bucket: messageBody.s3Bucket,
            s3Key: messageBody.s3Key
          },
          'S3 file download started'
        )

        const s3StartTime = performance.now()

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

        const s3EndTime = performance.now()
        const s3Duration = Math.round(s3EndTime - s3StartTime)

        logger.info(
          {
            reviewId,
            s3Key: messageBody.s3Key,
            downloadedBytes: buffer.length,
            durationMs: s3Duration
          },
          `S3 file downloaded in ${s3Duration}ms`
        )

        // Extract text from file
        logger.info(
          {
            reviewId,
            mimeType: messageBody.contentType,
            fileSize: buffer.length
          },
          'Text extraction started'
        )

        const extractStartTime = performance.now()

        textContent = await textExtractor.extractText(
          buffer,
          messageBody.contentType,
          messageBody.filename
        )

        const extractEndTime = performance.now()
        const extractDuration = Math.round(extractEndTime - extractStartTime)

        logger.info(
          {
            reviewId,
            extractedLength: textContent.length,
            wordCount: textExtractor.countWords(textContent),
            durationMs: extractDuration
          },
          `Text extracted successfully in ${extractDuration}ms`
        )
      } else if (messageBody.messageType === 'text_review') {
        // Download text content from S3 (following reference architecture)
        logger.info(
          {
            reviewId,
            s3Bucket: messageBody.s3Bucket,
            s3Key: messageBody.s3Key
          },
          'S3 text content download started'
        )

        const s3StartTime = performance.now()

        const s3Response = await this.s3Client.send(
          new GetObjectCommand({
            Bucket: messageBody.s3Bucket,
            Key: messageBody.s3Key
          })
        )

        // Convert stream to string
        const chunks = []
        for await (const chunk of s3Response.Body) {
          chunks.push(chunk)
        }
        const buffer = Buffer.concat(chunks)

        textContent = buffer.toString('utf-8')

        const s3EndTime = performance.now()
        const s3Duration = Math.round(s3EndTime - s3StartTime)

        logger.info(
          {
            reviewId,
            textContent,
            textLength: textContent.length,
            wordCount: textExtractor.countWords(textContent),
            durationMs: s3Duration
          },
          `Text content retrieved from S3 in ${s3Duration}ms`
        )
      } else {
        throw new Error(`Unknown message type: ${messageBody.messageType}`)
      }

      // Prepare prompt for Bedrock
      const userPrompt = `Please review the following content:\n\n---\n${textContent}\n---\n\nProvide a comprehensive content review following the guidelines in your system prompt.`

      logger.info(
        {
          reviewId,
          promptLength: userPrompt.length,
          textContentLength: textContent.length
        },
        'Bedrock AI review started'
      )

      logger.info(
        {
          reviewId,
          userPrompt,
          promptLength: userPrompt.length,
          textContentLength: textContent.length
        },
        'User prompt prepared for Bedrock AI review'
      )

      // Load system prompt from S3
      const promptLoadStartTime = performance.now()
      const systemPrompt = await promptManager.getSystemPrompt()
      const promptLoadEndTime = performance.now()
      const promptLoadDuration = Math.round(
        promptLoadEndTime - promptLoadStartTime
      )

      logger.info(
        {
          reviewId,
          systemPromptLength: systemPrompt.length,
          durationMs: promptLoadDuration
        },
        `System prompt loaded from S3 in ${promptLoadDuration}ms`
      )

      // Send to Bedrock with system prompt
      const bedrockStartTime = performance.now()

      const bedrockResponse = await bedrockClient.sendMessage(userPrompt, [
        {
          role: 'user',
          content: [{ text: systemPrompt }]
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

      const bedrockEndTime = performance.now()
      const bedrockDuration = Math.round(bedrockEndTime - bedrockStartTime)

      if (!bedrockResponse.success) {
        logger.error(
          {
            reviewId,
            blocked: bedrockResponse.blocked,
            reason: bedrockResponse.reason,
            durationMs: bedrockDuration
          },
          `Bedrock AI review failed after ${bedrockDuration}ms`
        )

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
          inputTokens: bedrockResponse.usage?.inputTokens,
          outputTokens: bedrockResponse.usage?.outputTokens,
          totalTokens: bedrockResponse.usage?.totalTokens,
          durationMs: bedrockDuration
        },
        `Bedrock AI review completed successfully in ${bedrockDuration}ms`
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

      // Log with preview in message for visibility in OpenSearch
      const responsePreview = bedrockResponse.content.substring(0, 500)
      logger.info(
        {
          reviewId,
          responseLength: bedrockResponse.content.length,
          inputTokens: bedrockResponse.usage?.inputTokens,
          outputTokens: bedrockResponse.usage?.outputTokens,
          stopReason: bedrockResponse.stopReason
        },
        `Bedrock AI response received | ReviewId: ${reviewId} | Length: ${bedrockResponse.content.length} chars | Tokens: ${bedrockResponse.usage?.inputTokens}→${bedrockResponse.usage?.outputTokens} | StopReason: ${bedrockResponse.stopReason} | Full Response:\n\n${bedrockResponse.content}`
      )

      logger.info({ reviewId }, 'Review saved to database')

      const processingEndTime = performance.now()
      const totalProcessingDuration = Math.round(
        processingEndTime - processingStartTime
      )

      logger.info(
        {
          reviewId,
          totalDurationMs: totalProcessingDuration
        },
        `Content review processing completed in ${totalProcessingDuration}ms`
      )

      return {
        reviewId,
        status: 'completed',
        message: 'Review completed successfully'
      }
    } catch (error) {
      const processingEndTime = performance.now()
      const totalProcessingDuration = Math.round(
        processingEndTime - processingStartTime
      )

      logger.error(
        {
          reviewId,
          error: error.message,
          stack: error.stack,
          totalDurationMs: totalProcessingDuration
        },
        `Review processing failed after ${totalProcessingDuration}ms`
      )

      // Detect timeout errors and provide user-friendly message
      let errorMessage = error.message
      if (
        error.message.includes('timed out') ||
        error.message.includes('timeout') ||
        error.message.includes('ETIMEDOUT') ||
        error.name === 'TimeoutError'
      ) {
        errorMessage = 'TIMEOUT'
      }

      // Save error to database with user-friendly message
      await reviewRepository.saveReviewError(reviewId, errorMessage)

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
