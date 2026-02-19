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
import { parseBedrockResponse } from './review-parser.js'

const logger = createLogger()

// Constants for configuration
const AWS_REGION = 'aws.region'
const AWS_ENDPOINT = 'aws.endpoint'
const MAX_BODY_PREVIEW_LENGTH = 200
const RECEIPT_HANDLE_PREVIEW_LENGTH = 20
const BASE_BACKOFF_MS = 5000
const MAX_BACKOFF_MS = 30000
const MAX_ERROR_MESSAGE_LENGTH = 100
const ERROR_MESSAGE_TRUNCATE_LENGTH = 97
const MAX_CONSECUTIVE_ERRORS = 10
const POLL_SLEEP_MS = 100

/**
 * Truncate receipt handle for logging
 * @param {string} receiptHandle - Receipt handle to truncate
 * @returns {string} Truncated receipt handle with ellipsis
 */
function truncateReceiptHandle(receiptHandle) {
  if (!receiptHandle) {
    return 'undefined'
  }
  return receiptHandle.substring(0, RECEIPT_HANDLE_PREVIEW_LENGTH) + '...'
}

/**
 * SQS Worker to process messages from content review queue
 */
class SQSWorker {
  constructor() {
    const sqsConfig = {
      region: config.get(AWS_REGION)
    }

    // Add endpoint for LocalStack if configured
    const awsEndpoint = config.get(AWS_ENDPOINT)
    if (awsEndpoint) {
      sqsConfig.endpoint = awsEndpoint
    }

    this.sqsClient = new SQSClient(sqsConfig)
    this.queueUrl = config.get('sqs.queueUrl')
    this.isRunning = false
    this.maxMessages = config.get('sqs.maxMessages')
    this.waitTimeSeconds = config.get('sqs.waitTimeSeconds')
    this.visibilityTimeout = config.get('sqs.visibilityTimeout')

    // Concurrency control to prevent rate limiting
    this.maxConcurrentRequests = config.get('sqs.maxConcurrentRequests')
    this.currentConcurrentRequests = 0
    this.processingQueue = []

    // Initialize S3 client for downloading files
    const s3Config = {
      region: config.get(AWS_REGION)
    }
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true
    }
    this.s3Client = new S3Client(s3Config)

    logger.info(
      {
        maxConcurrentRequests: this.maxConcurrentRequests,
        maxMessages: this.maxMessages
      },
      'SQS Worker initialized with concurrency control - system prompt will be loaded from S3 on demand'
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
      region: config.get(AWS_REGION),
      maxMessages: this.maxMessages,
      waitTimeSeconds: this.waitTimeSeconds,
      visibilityTimeout: this.visibilityTimeout,
      maxConcurrentRequests: this.maxConcurrentRequests,
      currentConcurrentRequests: this.currentConcurrentRequests,
      queuedMessages: this.processingQueue.length
    }
  }

  /**
   * Poll for messages from SQS queue
   */
  async poll() {
    let consecutiveErrors = 0

    while (this.isRunning) {
      try {
        await this.fetchAndEnqueueMessages()
        consecutiveErrors = 0

        // Process messages from queue with concurrency control
        await this.processQueuedMessages()

        // Short sleep between poll cycles
        await this.sleep(POLL_SLEEP_MS)
      } catch (error) {
        consecutiveErrors++
        const shouldStop = await this.handlePollingError(
          error,
          consecutiveErrors
        )
        if (shouldStop) {
          break
        }
      }
    }

    logger.info('SQS polling loop ended')
  }

  /**
   * Fetch messages from SQS and enqueue them for processing
   */
  async fetchAndEnqueueMessages() {
    const availableSlots =
      this.maxConcurrentRequests - this.currentConcurrentRequests

    if (availableSlots <= 0) {
      return
    }

    const messages = await this.receiveMessages()

    if (messages?.length > 0) {
      logger.info(
        {
          messageCount: messages.length,
          currentConcurrent: this.currentConcurrentRequests,
          maxConcurrent: this.maxConcurrentRequests,
          availableSlots
        },
        'Received messages from SQS'
      )

      for (const message of messages) {
        this.enqueueMessage(message)
      }
    }
  }

  /**
   * Handle polling errors with exponential backoff
   * @param {Error} error - The error that occurred
   * @param {number} consecutiveErrors - Number of consecutive errors
   * @returns {Promise<boolean>} True if worker should stop
   */
  async handlePollingError(error, consecutiveErrors) {
    logger.error(
      {
        error: error.message,
        errorName: error.name,
        stack: error.stack,
        consecutiveErrors,
        maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS
      },
      `Error polling SQS queue (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`
    )

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      logger.error(
        { consecutiveErrors, maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS },
        'CRITICAL: Too many consecutive SQS polling errors - stopping worker to prevent resource exhaustion'
      )
      this.stop()
      return true
    }

    const backoffTime = Math.min(
      BASE_BACKOFF_MS * Math.pow(2, consecutiveErrors - 1),
      MAX_BACKOFF_MS
    )
    logger.info(
      { backoffTime, consecutiveErrors },
      `Waiting ${backoffTime}ms before retry due to polling error`
    )
    await this.sleep(backoffTime)
    return false
  }

  /**
   * Add a message to the processing queue
   * @param {Object} message - SQS message
   */
  enqueueMessage(message) {
    this.processingQueue.push(message)
    logger.debug(
      {
        messageId: message.MessageId,
        queueLength: this.processingQueue.length
      },
      'Message added to processing queue'
    )
  }

  /**
   * Process messages from the queue with concurrency control
   */
  async processQueuedMessages() {
    while (
      this.processingQueue.length > 0 &&
      this.currentConcurrentRequests < this.maxConcurrentRequests
    ) {
      const message = this.processingQueue.shift()
      this.currentConcurrentRequests++

      logger.info(
        {
          messageId: message.MessageId,
          currentConcurrent: this.currentConcurrentRequests,
          maxConcurrent: this.maxConcurrentRequests,
          queueLength: this.processingQueue.length
        },
        'Starting message processing'
      )

      // Process message asynchronously (don't await)
      this.processMessage(message)
        .then(() => {
          this.currentConcurrentRequests--
          logger.debug(
            {
              messageId: message.MessageId,
              currentConcurrent: this.currentConcurrentRequests,
              queueLength: this.processingQueue.length
            },
            'Message processing completed, slot freed'
          )
        })
        .catch((error) => {
          this.currentConcurrentRequests--
          logger.error(
            {
              messageId: message.MessageId,
              error: error.message,
              currentConcurrent: this.currentConcurrentRequests,
              queueLength: this.processingQueue.length
            },
            'Message processing failed, slot freed'
          )
        })
    }
  }

  /**
   * Check if error is a critical queue error that should stop the worker
   * @param {Error} error - The error object
   * @param {string} errorCode - The error code
   * @returns {boolean} True if critical error requiring worker stop
   */
  isCriticalQueueError(error, errorCode) {
    // Non-existent queue
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

    // Access denied
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
   * @param {Error} error - The error object
   * @param {string} errorCode - The error code
   * @returns {boolean} True if error is retryable
   */
  isRetryableError(error, errorCode) {
    // Throttling errors
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

    // Network/timeout errors
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
      const errorCode = error.Code || error.name

      // Check for critical errors
      if (this.isCriticalQueueError(error, errorCode)) {
        this.stop()
        throw error
      }

      // Check for retryable errors
      if (this.isRetryableError(error, errorCode)) {
        return []
      }

      // Generic error - log and retry
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
   * Validate and parse message body
   * @param {Object} message - SQS message
   * @returns {Promise<Object|null>} Parsed body or null if invalid
   */
  async validateAndParseMessage(message) {
    // Validate message structure
    if (!message?.Body) {
      logger.error(
        { messageId: message?.MessageId },
        'Invalid SQS message: missing Body'
      )
      if (message?.ReceiptHandle) {
        await this.deleteMessage(message.ReceiptHandle)
      }
      return null
    }

    // Parse message body
    try {
      const body = JSON.parse(message.Body)

      // Validate required fields
      if (!body.uploadId && !body.reviewId) {
        logger.error(
          {
            messageId: message.MessageId,
            body
          },
          'SQS message missing both uploadId and reviewId - deleting invalid message'
        )
        await this.deleteMessage(message.ReceiptHandle)
        return null
      }

      return body
    } catch (parseError) {
      logger.error(
        {
          messageId: message.MessageId,
          parseError: parseError.message,
          bodyPreview: message.Body?.substring(0, MAX_BODY_PREVIEW_LENGTH)
        },
        'Failed to parse SQS message body as JSON - deleting invalid message'
      )
      await this.deleteMessage(message.ReceiptHandle)
      return null
    }
  }

  /**
   * Log message processing start
   * @param {Object} message - SQS message
   * @param {Object} body - Parsed message body
   */
  logMessageProcessingStart(message, body) {
    logger.info({
      messageId: message.MessageId,
      uploadId: body.uploadId,
      reviewId: body.reviewId,
      messageType: body.messageType,
      s3Key: body.s3Key,
      receiptHandle: truncateReceiptHandle(message.ReceiptHandle)
    })
  }

  /**
   * Process a single message
   * @param {Object} message - SQS message
   */
  async processMessage(message) {
    const startTime = performance.now()

    try {
      const body = await this.validateAndParseMessage(message)
      if (!body) {
        return
      }

      this.logMessageProcessingStart(message, body)

      await this.processContentReview(body)
      await this.deleteMessage(message.ReceiptHandle)

      const duration = Math.round(performance.now() - startTime)
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
      const duration = Math.round(performance.now() - startTime)
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
    }
  }

  /**
   * Process content review with Bedrock AI
   * @param {Object} messageBody - Message body from SQS
   */
  async processContentReview(messageBody) {
    const reviewId = messageBody.reviewId || messageBody.uploadId
    const uploadId = messageBody.uploadId || messageBody.reviewId

    if (!reviewId) {
      throw new Error('Missing reviewId in message body')
    }

    const processingStartTime = performance.now()
    this.logReviewStart(reviewId, uploadId, messageBody)

    try {
      await this.updateReviewStatusToProcessing(reviewId)
      const textContent = await this.extractTextContent(reviewId, messageBody)
      const bedrockResult = await this.performBedrockReview(
        reviewId,
        textContent
      )
      const parseResult = await this.parseBedrockResponseData(
        reviewId,
        bedrockResult
      )
      await this.saveReviewToRepository(reviewId, parseResult, bedrockResult)

      this.logReviewCompletion(
        reviewId,
        processingStartTime,
        bedrockResult,
        parseResult
      )

      return {
        reviewId,
        status: 'completed',
        message: 'Review completed successfully'
      }
    } catch (error) {
      await this.handleReviewProcessingError(
        reviewId,
        error,
        processingStartTime
      )
      throw error
    }
  }

  /**
   * Log review start information
   */
  logReviewStart(reviewId, uploadId, messageBody) {
    logger.info(
      {
        reviewId,
        uploadId,
        messageType: messageBody.messageType,
        filename: messageBody.filename,
        s3Key: messageBody.s3Key,
        fileSize: messageBody.fileSize
      },
      '[STEP 5/6] Content review processing started by SQS worker - START'
    )
  }

  /**
   * Update review status to processing
   */
  async updateReviewStatusToProcessing(reviewId) {
    try {
      const statusUpdateStart = performance.now()
      await reviewRepository.updateReviewStatus(reviewId, 'processing')
      const statusUpdateDuration = Math.round(
        performance.now() - statusUpdateStart
      )

      logger.info(
        { reviewId, durationMs: statusUpdateDuration },
        `Review status updated to processing in ${statusUpdateDuration}ms`
      )
    } catch (statusError) {
      logger.error(
        {
          reviewId,
          error: statusError.message,
          stack: statusError.stack
        },
        'CRITICAL: Failed to update review status to processing - attempting to continue'
      )
    }
  }

  /**
   * Extract text content based on message type
   */
  async extractTextContent(reviewId, messageBody) {
    if (messageBody.messageType === 'file_review') {
      return this.extractTextFromFile(reviewId, messageBody)
    }

    if (messageBody.messageType === 'text_review') {
      return this.extractTextFromS3(reviewId, messageBody)
    }

    throw new Error(`Unknown message type: ${messageBody.messageType}`)
  }

  /**
   * Extract text from uploaded file
   */
  async extractTextFromFile(reviewId, messageBody) {
    logger.info(
      {
        reviewId,
        s3Bucket: messageBody.s3Bucket,
        s3Key: messageBody.s3Key
      },
      'S3 file download started'
    )

    const s3StartTime = performance.now()
    const buffer = await this.downloadFromS3(
      messageBody.s3Bucket,
      messageBody.s3Key
    )
    const s3Duration = Math.round(performance.now() - s3StartTime)

    logger.info(
      {
        reviewId,
        s3Key: messageBody.s3Key,
        downloadedBytes: buffer.length,
        durationMs: s3Duration
      },
      `S3 file downloaded in ${s3Duration}ms`
    )

    logger.info(
      {
        reviewId,
        mimeType: messageBody.contentType,
        fileSize: buffer.length
      },
      'Text extraction started'
    )

    const extractStartTime = performance.now()
    const textContent = await textExtractor.extractText(
      buffer,
      messageBody.contentType,
      messageBody.filename
    )
    const extractDuration = Math.round(performance.now() - extractStartTime)

    logger.info(
      {
        reviewId,
        extractedLength: textContent.length,
        wordCount: textExtractor.countWords(textContent),
        durationMs: extractDuration
      },
      `Text extracted successfully in ${extractDuration}ms`
    )

    return textContent
  }

  /**
   * Extract text content from S3
   */
  async extractTextFromS3(reviewId, messageBody) {
    logger.info(
      {
        reviewId,
        s3Bucket: messageBody.s3Bucket,
        s3Key: messageBody.s3Key
      },
      'S3 text content download started'
    )

    const s3StartTime = performance.now()
    const buffer = await this.downloadFromS3(
      messageBody.s3Bucket,
      messageBody.s3Key
    )
    const textContent = buffer.toString('utf-8')
    const s3Duration = Math.round(performance.now() - s3StartTime)

    logger.info(
      {
        reviewId,
        contentLength: textContent.length,
        durationMs: s3Duration
      },
      `S3 text content downloaded in ${s3Duration}ms`
    )

    return textContent
  }

  /**
   * Download file from S3 and return as buffer
   */
  async downloadFromS3(bucket, key) {
    const s3Response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key
      })
    )

    const chunks = []
    for await (const chunk of s3Response.Body) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  /**
   * Load system prompt from S3
   */
  async loadSystemPrompt(reviewId) {
    const promptLoadStartTime = performance.now()
    const systemPrompt = await promptManager.getSystemPrompt()
    const promptLoadDuration = Math.round(
      performance.now() - promptLoadStartTime
    )

    logger.info(
      {
        reviewId,
        systemPromptLength: systemPrompt.length,
        durationMs: promptLoadDuration
      },
      `System prompt loaded from S3 in ${promptLoadDuration}ms | ReviewId: ${reviewId} | Length: ${systemPrompt.length} chars`
    )

    return { systemPrompt, promptLoadDuration }
  }

  /**
   * Send request to Bedrock AI
   */
  async sendBedrockRequest(reviewId, userPrompt, systemPrompt) {
    const bedrockStartTime = performance.now()

    logger.info(
      {
        reviewId,
        userPromptLength: userPrompt.length,
        systemPromptLength: systemPrompt.length
      },
      '[BEDROCK] Sending request to Bedrock AI - START'
    )

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

    const bedrockDuration = Math.round(performance.now() - bedrockStartTime)

    if (!bedrockResponse.success) {
      logger.error(
        {
          reviewId,
          blocked: bedrockResponse.blocked,
          reason: bedrockResponse.reason,
          durationMs: bedrockDuration
        },
        `[BEDROCK] AI review FAILED after ${bedrockDuration}ms`
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
      `[BEDROCK] AI review COMPLETED successfully in ${bedrockDuration}ms (Tokens: ${bedrockResponse.usage?.inputTokens}→${bedrockResponse.usage?.outputTokens})`
    )

    return { bedrockResponse, bedrockDuration }
  }

  /**
   * Perform Bedrock AI review
   */
  async performBedrockReview(reviewId, textContent) {
    const userPrompt = `Please review the following content:\n\n---\n${textContent}\n---\n\nProvide a comprehensive content review following the guidelines in your system prompt.`

    logger.info(
      {
        reviewId,
        promptLength: userPrompt.length,
        textContentLength: textContent.length
      },
      `User prompt prepared for Bedrock AI review | ReviewId: ${reviewId} | Length: ${userPrompt.length} chars`
    )

    const { systemPrompt } = await this.loadSystemPrompt(reviewId)
    return this.sendBedrockRequest(reviewId, userPrompt, systemPrompt)
  }

  /**
   * Parse Bedrock response data
   */
  async parseBedrockResponseData(reviewId, bedrockResult) {
    const parseStart = performance.now()
    const finalReviewContent = bedrockResult.bedrockResponse.content

    const parsedReview = parseBedrockResponse(finalReviewContent)
    const parseDuration = Math.round(performance.now() - parseStart)

    logger.info(
      {
        reviewId,
        parsedScoreCount: Object.keys(parsedReview.scores || {}).length,
        parsedIssueCount: parsedReview.reviewedContent?.issues?.length || 0,
        parsedImprovementCount: parsedReview.improvements?.length || 0,
        hasParseError: !!parsedReview.parseError,
        durationMs: parseDuration
      },
      `Bedrock response parsed in ${parseDuration}ms`
    )

    return { parsedReview, parseDuration, finalReviewContent }
  }

  /**
   * Save review to repository
   */
  async saveReviewToRepository(reviewId, parseResult, bedrockResult) {
    const saveStart = performance.now()
    await reviewRepository.saveReviewResult(
      reviewId,
      {
        reviewData: parseResult.parsedReview,
        rawResponse: parseResult.finalReviewContent,
        guardrailAssessment: bedrockResult.bedrockResponse.guardrailAssessment,
        stopReason: bedrockResult.bedrockResponse.stopReason,
        completedAt: new Date()
      },
      bedrockResult.bedrockResponse.usage
    )
    const saveDuration = Math.round(performance.now() - saveStart)

    logger.info(
      { reviewId, durationMs: saveDuration },
      `Review result saved to S3 in ${saveDuration}ms`
    )
  }

  /**
   * Log review completion
   */
  logReviewCompletion(
    reviewId,
    processingStartTime,
    bedrockResult,
    parseResult
  ) {
    const totalProcessingDuration = Math.round(
      performance.now() - processingStartTime
    )

    logger.info(
      {
        reviewId,
        totalDurationMs: totalProcessingDuration,
        bedrockDurationMs: bedrockResult.bedrockDuration,
        parseDurationMs: parseResult.parseDuration
      },
      `[STEP 6/6] Content review processing COMPLETED - TOTAL: ${totalProcessingDuration}ms (Bedrock: ${bedrockResult.bedrockDuration}ms, Parse: ${parseResult.parseDuration}ms)`
    )
  }

  /**
   * Handle review processing error
   */
  async handleReviewProcessingError(reviewId, error, processingStartTime) {
    const totalProcessingDuration = Math.round(
      performance.now() - processingStartTime
    )

    logger.error(
      {
        reviewId,
        error: error.message,
        errorName: error.name,
        stack: error.stack,
        totalDurationMs: totalProcessingDuration
      },
      `Review processing failed after ${totalProcessingDuration}ms`
    )

    const errorMessage = this.formatErrorForUI(error)

    try {
      await reviewRepository.saveReviewError(reviewId, errorMessage)
      logger.info(
        {
          reviewId,
          errorMessage,
          originalError: error.message
        },
        'Review error saved to database - status updated to failed'
      )
    } catch (saveError) {
      await this.handleSaveErrorFailure(reviewId, saveError)
    }
  }

  /**
   * Format error message for UI display
   */
  formatErrorForUI(error) {
    const errorPatterns = [
      {
        check: () =>
          error.name === 'TimeoutError' ||
          error.message.includes('timed out') ||
          error.message.includes('timeout') ||
          error.message.includes('ETIMEDOUT'),
        message: 'TIMEOUT'
      },
      {
        check: () =>
          error.message.includes('token quota') ||
          error.message.includes('tokens per minute'),
        message: 'Token Quota Exceeded'
      },
      {
        check: () => error.message.includes('rate limit'),
        message: 'Rate Limit Exceeded'
      },
      {
        check: () => error.message.includes('temporarily unavailable'),
        message: 'Service Temporarily Unavailable'
      },
      {
        check: () => error.message.includes('Access denied'),
        message: 'Access Denied'
      },
      {
        check: () => error.message.includes('not found'),
        message: 'Resource Not Found'
      },
      {
        check: () => error.message.includes('credentials'),
        message: 'Authentication Error'
      },
      {
        check: () => error.message.includes('validation error'),
        message: 'Invalid Request'
      }
    ]

    for (const pattern of errorPatterns) {
      if (pattern.check()) {
        return pattern.message
      }
    }

    if (error.message.includes('Bedrock')) {
      return error.message
        .replace('Bedrock API error: ', '')
        .substring(0, MAX_ERROR_MESSAGE_LENGTH)
    }

    if (error.message.length > MAX_ERROR_MESSAGE_LENGTH) {
      return error.message.substring(0, ERROR_MESSAGE_TRUNCATE_LENGTH) + '...'
    }

    return error.message
  }

  /**
   * Handle failure to save error to database
   */
  async handleSaveErrorFailure(reviewId, saveError) {
    logger.error(
      {
        reviewId,
        saveError: saveError.message,
        saveErrorStack: saveError.stack
      },
      'CRITICAL: Failed to save review error - review will be stuck in processing state!'
    )

    try {
      await reviewRepository.updateReviewStatus(reviewId, 'failed', {
        error: {
          message: 'Processing failed - error details unavailable',
          code: 'SAVE_ERROR_FAILED'
        }
      })
      logger.warn({ reviewId }, 'Successfully marked review as failed on retry')
    } catch (retryError) {
      logger.error(
        { reviewId, retryError: retryError.message },
        'CRITICAL: Review is permanently stuck - manual intervention required'
      )
    }
  }

  /**
   * Delete message from queue
   * @param {string} receiptHandle - Message receipt handle
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
      // Handle specific delete errors
      const errorCode = error.Code || error.name

      // Message already deleted or doesn't exist - not a critical error
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
        return // Don't throw, this is expected in some cases
      }

      logger.error(
        {
          error: error.message,
          errorCode,
          receiptHandle: truncateReceiptHandle(receiptHandle)
        },
        'Failed to delete message from SQS - message will be reprocessed after visibility timeout'
      )
      // Don't throw - allow processing to continue even if delete fails
      // The message will become visible again and be reprocessed
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
