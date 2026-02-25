import { createLogger } from '../logging/logger.js'
import { reviewRepository } from '../review-repository.js'
import { ContentExtractor } from './content-extractor.js'
import { BedrockReviewProcessor } from './bedrock-processor.js'
import { ErrorHandler } from './error-handler.js'
import { truncateReceiptHandle } from './message-handler.js'

const logger = createLogger()

const MAX_BODY_PREVIEW_LENGTH = 200

/**
 * Review Processor - orchestrates the review processing workflow
 */
export class ReviewProcessor {
  constructor() {
    this.contentExtractor = new ContentExtractor()
    this.bedrockProcessor = new BedrockReviewProcessor()
    this.errorHandler = new ErrorHandler()
  }

  /**
   * Validate and parse message body
   */
  async validateAndParseMessage(message, messageHandler) {
    if (!message?.Body) {
      logger.error(
        { messageId: message?.MessageId },
        'Invalid SQS message: missing Body'
      )
      if (message?.ReceiptHandle) {
        await messageHandler.deleteMessage(message.ReceiptHandle)
      }
      return null
    }

    try {
      const body = JSON.parse(message.Body)

      if (!body.uploadId && !body.reviewId) {
        logger.error(
          {
            messageId: message.MessageId,
            body
          },
          'SQS message missing both uploadId and reviewId - deleting invalid message'
        )
        await messageHandler.deleteMessage(message.ReceiptHandle)
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
      await messageHandler.deleteMessage(message.ReceiptHandle)
      return null
    }
  }

  /**
   * Log message processing start
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
   */
  async processMessage(message, messageHandler) {
    const startTime = performance.now()

    try {
      const body = await this.validateAndParseMessage(message, messageHandler)
      if (!body) {
        return
      }

      this.logMessageProcessingStart(message, body)

      await this.processContentReview(body)
      await messageHandler.deleteMessage(message.ReceiptHandle)

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
      const textContent = await this.contentExtractor.extractTextContent(
        reviewId,
        messageBody
      )
      const bedrockResult = await this.bedrockProcessor.performBedrockReview(
        reviewId,
        textContent
      )
      const parseResult = await this.bedrockProcessor.parseBedrockResponseData(
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

    const errorMessage = this.errorHandler.formatErrorForUI(error)

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
      await this.errorHandler.handleSaveErrorFailure(
        reviewId,
        saveError,
        reviewRepository
      )
    }
  }
}
