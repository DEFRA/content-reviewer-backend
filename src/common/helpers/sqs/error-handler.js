import { createLogger } from '../logging/logger.js'

const logger = createLogger()

const MAX_ERROR_MESSAGE_LENGTH = 100
const ERROR_MESSAGE_TRUNCATE_LENGTH = 97

/**
 * Error Handler - formats and handles errors
 */
export class ErrorHandler {
  /**
   * Format error message for UI display
   */
  formatErrorForUI(error) {
    if (
      error.name === 'TimeoutError' ||
      error.message.includes('timed out') ||
      error.message.includes('timeout') ||
      error.message.includes('ETIMEDOUT')
    ) {
      return 'TIMEOUT'
    }

    const errorPatterns = [
      {
        keywords: ['token quota', 'tokens per minute'],
        message: 'Token Quota Exceeded'
      },
      { keywords: ['rate limit'], message: 'Rate Limit Exceeded' },
      {
        keywords: ['temporarily unavailable'],
        message: 'Service Temporarily Unavailable'
      },
      { keywords: ['Access denied'], message: 'Access Denied' },
      { keywords: ['not found'], message: 'Resource Not Found' },
      { keywords: ['credentials'], message: 'Authentication Error' },
      { keywords: ['validation error'], message: 'Invalid Request' }
    ]

    for (const pattern of errorPatterns) {
      if (pattern.keywords.some((keyword) => error.message.includes(keyword))) {
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
  async handleSaveErrorFailure(reviewId, saveError, reviewRepository) {
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
}
