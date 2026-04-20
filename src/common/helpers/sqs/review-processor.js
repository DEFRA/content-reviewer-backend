import { createLogger } from '../logging/logger.js'
import { config } from '../../../config.js'
import { reviewRepository } from '../review-repository.js'
import { resultEnvelopeStore } from '../result-envelope.js'
import { ContentExtractor } from './content-extractor.js'
// resultEnvelopeStore is used only for building envelopes (no S3 writes)
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
   * Check whether a message has exceeded the maximum receive count and, if so,
   * mark the review as permanently failed and delete the message.
   * Returns true when the message should be skipped (dead-lettered by the app).
   * @param {Object} message - Raw SQS message
   * @param {Object} messageHandler - SQSMessageHandler instance
   * @param {Object} body - Parsed message body
   * @returns {Promise<boolean>}
   */
  async isDeadLettered(message, messageHandler, body) {
    const receiveCount = messageHandler.getReceiveCount(message)
    const maxReceiveCount = config.get('sqs.maxReceiveCount')

    if (receiveCount <= maxReceiveCount) {
      return false
    }

    const reviewId = body.reviewId || body.uploadId

    logger.error(
      {
        messageId: message.MessageId,
        reviewId,
        receiveCount,
        maxReceiveCount,
        receiptHandle: truncateReceiptHandle(message.ReceiptHandle)
      },
      `Message exceeded max receive count (${receiveCount}/${maxReceiveCount}) - dead-lettering: deleting and marking review as failed`
    )

    await this.markDeadLetteredReviewAsFailed(
      reviewId,
      receiveCount,
      maxReceiveCount
    )
    await messageHandler.deleteMessage(message.ReceiptHandle)
    return true
  }

  /**
   * Mark a dead-lettered review as permanently failed in the repository and
   * write the failed envelope so the UI reflects the correct state.
   * @param {string|undefined} reviewId
   * @param {number} receiveCount
   * @param {number} maxReceiveCount
   */
  async markDeadLetteredReviewAsFailed(
    reviewId,
    receiveCount,
    maxReceiveCount
  ) {
    if (!reviewId) {
      return
    }

    try {
      await reviewRepository.saveReviewError(
        reviewId,
        `Exceeded maximum retry attempts (${maxReceiveCount}). The review could not be completed after ${receiveCount} delivery attempts.`
      )
    } catch (saveErr) {
      logger.error(
        { reviewId, error: saveErr.message },
        'Failed to save dead-letter error to repository'
      )
    }
  }

  /**
   * Process a single message.
   * Runs a visibility-timeout heartbeat every 4 minutes so a long-running
   * Bedrock call (100k-char documents can take 3-5 min) cannot cause the
   * message to become visible again and trigger duplicate processing.
   */
  async processMessage(message, messageHandler) {
    const startTime = performance.now()

    // Heartbeat: extend visibility every 4 minutes while processing.
    const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000
    const HEARTBEAT_VISIBILITY_SECONDS = 900
    const heartbeat = setInterval(() => {
      messageHandler
        .extendVisibility(message.ReceiptHandle, HEARTBEAT_VISIBILITY_SECONDS)
        .catch(
          () => {} // extendVisibility already logs warnings internally
        )
    }, HEARTBEAT_INTERVAL_MS)

    try {
      const body = await this.validateAndParseMessage(message, messageHandler)
      if (!body) {
        clearInterval(heartbeat)
        return
      }

      // Application-level dead-letter guard: stop processing if the message
      // has been delivered more times than maxReceiveCount.
      if (await this.isDeadLettered(message, messageHandler, body)) {
        clearInterval(heartbeat)
        return
      }

      this.logMessageProcessingStart(message, body)

      await this.processContentReview(body)
      clearInterval(heartbeat)
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
      clearInterval(heartbeat)
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
   * Validate that extracted content is reviewable — not an access-blocked or
   * empty response from the source URL/file.
   *
   * Throws an error (which the caller catches and saves as a failed review)
   * when the text looks like an access-denied page or is too short to review.
   *
   * @param {string} reviewId
   * @param {string} canonicalText
   * @param {Object} messageBody
   */
  validateExtractedContent(reviewId, canonicalText, messageBody) {
    const MIN_CONTENT_LENGTH = 200

    const BLOCKED_PATTERNS = [
      'blocked due to content policy',
      'your request has been blocked',
      'request has been blocked',
      'has been blocked',
      'access denied',
      '403 forbidden',
      'forbidden access'
    ]

    const lowerText = canonicalText.trim().toLowerCase()

    if (BLOCKED_PATTERNS.some((pattern) => lowerText.includes(pattern))) {
      logger.warn(
        { reviewId, contentPreview: canonicalText.substring(0, 100) },
        '[VALIDATION] Extracted content appears to be an access-blocked response'
      )
      throw new Error(
        'Content access blocked: the website blocked access to this URL. Please upload the document directly.'
      )
    }

    if (
      messageBody.messageType === 'text_review' &&
      lowerText.length < MIN_CONTENT_LENGTH
    ) {
      logger.warn(
        {
          reviewId,
          contentLength: lowerText.length,
          minLength: MIN_CONTENT_LENGTH
        },
        '[VALIDATION] Extracted content is too short to review'
      )
      throw new Error(
        `Content too short: only ${lowerText.length} characters were extracted from the URL. The page may be inaccessible or require authentication.`
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
      const { canonicalText, linkMap } =
        await this.contentExtractor.extractTextContent(reviewId, messageBody)
      this.validateExtractedContent(reviewId, canonicalText, messageBody)
      const bedrockResult = await this.bedrockProcessor.performBedrockReview(
        reviewId,
        canonicalText
      )
      const parseResult = await this.bedrockProcessor.parseBedrockResponseData(
        reviewId,
        bedrockResult,
        canonicalText
      )
      // Pass canonicalText (clean prose) and linkMap (offset-based link entries)
      // so the result envelope can build accurate annotated sections and also
      // restore clickable links in plain (non-highlighted) sections.
      await this.saveReviewToRepository(
        reviewId,
        parseResult,
        bedrockResult,
        canonicalText,
        linkMap
      )

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

      // Status is tracked in reviews/{reviewId}.json via updateReviewStatus above
      // Status is tracked in reviews/{reviewId}.json via updateReviewStatus above
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
   * @param {string} reviewId
   * @param {Object} parseResult       - { parsedReview, parseDuration, finalReviewContent }
   * @param {Object} bedrockResult     - { bedrockResponse, bedrockDuration }
   * @param {string} canonicalText     - the normalised text from the canonical document;
   *                                     used to derive annotated sections in result envelope
   * @param {Array|null} linkMap       - offset-based link entries for URL sources;
   *                                     used to restore clickable links in plain sections
   *                                     (null for file/text sources)
   */
  async saveReviewToRepository(
    reviewId,
    parseResult,
    bedrockResult,
    canonicalText = '',
    linkMap = null
  ) {
    // Build the spec-compliant envelope (annotatedSections, scores, improvements, etc.)
    // and embed it directly into reviews/{reviewId}.json — no separate S3 file needed.
    const envelope = resultEnvelopeStore.buildEnvelope(
      reviewId,
      parseResult.parsedReview,
      bedrockResult.bedrockResponse.usage,
      canonicalText,
      'completed',
      linkMap
    )

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
      bedrockResult.bedrockResponse.usage,
      envelope
    )
    const saveDuration = Math.round(performance.now() - saveStart)

    logger.info(
      { reviewId, durationMs: saveDuration },
      `Review result saved to S3 in ${saveDuration}ms`
    )

    // Save raw position data (character offsets from Bedrock) as a separate debug
    // artefact at reviews/positions/{reviewId}.json.  Non-critical — never blocks
    // the main result.
    const reviewedContent = parseResult.parsedReview?.reviewedContent
    if (reviewedContent) {
      reviewRepository.savePositions(reviewId, reviewedContent).catch((err) => {
        logger.error(
          { reviewId, error: err.message },
          'Failed to save positions file - review result still saved successfully'
        )
      })
    }
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
