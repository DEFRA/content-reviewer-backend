import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'
import { SQSMessageHandler } from './sqs/message-handler.js'
import { ReviewProcessor } from './sqs/review-processor.js'

const logger = createLogger()

const AWS_REGION = 'aws.region'
const BASE_BACKOFF_MS = 5000
const MAX_BACKOFF_MS = 30000
const MAX_CONSECUTIVE_ERRORS = 10
const POLL_SLEEP_MS = 100

/**
 * SQS Worker to process messages from content review queue
 */
class SQSWorker {
  constructor() {
    this.messageHandler = new SQSMessageHandler()
    this.reviewProcessor = new ReviewProcessor()

    this.queueUrl = config.get('sqs.queueUrl')
    this.isRunning = false
    this.maxMessages = config.get('sqs.maxMessages')
    this.waitTimeSeconds = config.get('sqs.waitTimeSeconds')

    this.maxConcurrentRequests = config.get('sqs.maxConcurrentRequests')
    this.currentConcurrentRequests = 0
    this.processingQueue = []

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
   */
  getStatus() {
    return {
      running: this.isRunning,
      queueUrl: this.queueUrl,
      region: config.get(AWS_REGION),
      maxMessages: this.maxMessages,
      waitTimeSeconds: this.waitTimeSeconds,
      visibilityTimeout: config.get('sqs.visibilityTimeout'),
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

        await this.processQueuedMessages()

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

    const messages = await this.messageHandler.receiveMessages()

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

      this.reviewProcessor
        .processMessage(message, this.messageHandler)
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
   * Sleep helper
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export const sqsWorker = new SQSWorker()
export { SQSWorker }
