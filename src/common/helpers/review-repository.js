import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} from '@aws-sdk/client-s3'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'
import { redactPIIFromReview } from './review-repository-pii.js'
import {
  deleteUploadedContent,
  deleteReviewMetadataFile,
  deleteOldReviews as deleteOldReviewsHelper
} from './review-repository-deletion.js'
import {
  preserveImmutableFields,
  sanitizeAdditionalData,
  restoreImmutableFields,
  updateProcessingTimestamps
} from './review-repository-helpers.js'
import {
  getRecentReviews as getRecentReviewsHelper,
  getReviewCount as getReviewCountHelper
} from './review-repository-queries.js'
import { searchReview as searchReviewHelper } from './review-repository-search.js'

const logger = createLogger()

/**
 * S3-based repository for content reviews
 * Stores review data as JSON files in S3
 */
class ReviewRepositoryS3 {
  constructor() {
    const s3Config = {
      region: config.get('aws.region')
    }

    // Add endpoint for LocalStack if configured
    const awsEndpoint = config.get('aws.endpoint')
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true // Required for LocalStack
      logger.info(
        { endpoint: awsEndpoint },
        'Using custom AWS endpoint (LocalStack)'
      )
    }

    this.s3Client = new S3Client(s3Config)

    this.bucket = config.get('s3.bucket')
    this.prefix = 'reviews/'

    logger.info(
      {
        bucket: this.bucket,
        prefix: this.prefix,
        endpoint: awsEndpoint || 'AWS'
      },
      'Review repository initialized with S3'
    )
  }

  /**
   * Generate S3 key for a review
   * @param {string} reviewId - Review ID
   * @returns {string} S3 key
   */
  getReviewKey(reviewId) {
    // Organize by date for easier browsing: reviews/2026/01/13/review_123.json
    return `${this.prefix}${reviewId}.json`
  }

  /**
   * Connect to S3 (no-op, kept for interface compatibility)
   */
  async connect() {
    // S3 doesn't need explicit connection
    logger.info('S3 client ready')
    return true
  }

  /**
   * Create a new review record
   * @param {Object} reviewData - Review data
   * @returns {Promise<Object>} Created review
   */
  async createReview(reviewData) {
    const now = new Date().toISOString()

    logger.info(
      {
        reviewId: reviewData.id,
        sourceType: reviewData.sourceType,
        fileName: reviewData.fileName,
        fileSize: reviewData.fileSize,
        hasS3Key: !!reviewData.s3Key
      },
      'Creating review in repository'
    )

    const review = {
      id: reviewData.id,
      status: 'pending', // pending, processing, completed, failed
      createdAt: now,
      updatedAt: now,
      sourceType: reviewData.sourceType, // 'file' or 'text'
      fileName: reviewData.fileName || null,
      fileSize: reviewData.fileSize || null,
      mimeType: reviewData.mimeType || null,
      s3Key: reviewData.s3Key || null, // S3 reference for both files AND text content
      result: null,
      error: null,
      processingStartedAt: null,
      processingCompletedAt: null,
      bedrockUsage: null
    }

    logger.info(
      {
        reviewId: review.id,
        fileName: review.fileName,
        createdAt: review.createdAt,
        s3Key: review.s3Key,
        sourceType: review.sourceType
      },
      'Creating review'
    )

    await this.saveReview(review)

    // Trigger async cleanup to keep only recent 100 reviews (don't wait for it)
    this.deleteOldReviews(100).catch((error) => {
      logger.error(
        { error: error.message },
        'Background cleanup failed (non-critical)'
      )
    })

    return review
  }

  /**
   * Save review to S3
   * @param {Object} review - Review object
   * @returns {Promise<void>}
   */
  async saveReview(review) {
    const key = this.getReviewKey(review.id)

    // Redact PII from review results before saving to S3
    const piiRedactionInfo = redactPIIFromReview(review)

    logger.info(
      {
        reviewId: review.id,
        fileName: review.fileName,
        createdAt: review.createdAt,
        status: review.status,
        hasResult: !!review.result,
        s3Key: review.s3Key,
        piiRedacted: piiRedactionInfo.hasPII,
        piiRedactionCount: piiRedactionInfo.redactionCount
      },
      piiRedactionInfo.hasPII
        ? `Saving review to S3 - PII REDACTED (${piiRedactionInfo.redactionCount} instances)`
        : 'Saving review to S3'
    )

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: JSON.stringify(review, null, 2),
      ContentType: 'application/json',
      Metadata: {
        reviewId: review.id,
        status: review.status,
        sourceType: review.sourceType,
        piiRedacted: piiRedactionInfo.hasPII ? 'true' : 'false'
      }
    })

    try {
      await this.s3Client.send(command)
      logger.info({
        reviewId: review.id,
        key,
        fileName: review.fileName,
        createdAt: review.createdAt
      })
    } catch (error) {
      logger.error(
        { error: error.message, reviewId: review.id },
        'Failed to save review to S3'
      )
      throw error
    }
  }

  /**
   * Get a review by ID
   * @param {string} reviewId - Review ID
   * @returns {Promise<Object|null>} Review or null if not found
   */
  async getReview(reviewId) {
    // Try to find the review by searching with the prefix pattern
    // Since we don't know the exact date, we'll try recent dates or search

    try {
      // Strategy 1: Try today first
      const key = this.getReviewKey(reviewId)

      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      })

      const response = await this.s3Client.send(command)
      const body = await response.Body.transformToString()
      return JSON.parse(body)
    } catch (error) {
      if (error.name === 'NoSuchKey') {
        // Strategy 2: Search for the review in recent days
        return searchReviewHelper(
          this.s3Client,
          this.bucket,
          this.prefix,
          reviewId
        )
      }
      logger.error(
        { error: error.message, reviewId },
        'Failed to get review from S3'
      )
      throw error
    }
  }

  /**
   * Update review metadata (tags, custom fields, etc.)
   * @param {string} reviewId - Review ID
   * @param {Object} metadata - Metadata to add/update
   * @returns {Promise<void>}
   */
  async updateReviewMetadata(reviewId, metadata) {
    const review = await this.getReview(reviewId)

    if (!review) {
      throw new Error(`Review not found: ${reviewId}`)
    }

    logger.info(
      {
        reviewId,
        metadataKeys: Object.keys(metadata)
      },
      'Updating review metadata'
    )

    // Initialize metadata object if it doesn't exist
    if (!review.metadata) {
      review.metadata = {}
    }

    // Merge metadata
    review.metadata = {
      ...review.metadata,
      ...metadata
    }

    review.updatedAt = new Date().toISOString()

    await this.saveReview(review)
    logger.info({ reviewId }, 'Review metadata updated in S3')
  }

  /**
   * Update review status
   * @param {string} reviewId - Review ID
   * @param {string} status - New status
   * @param {Object} additionalData - Additional data to update
   * @returns {Promise<void>}
   */
  async updateReviewStatus(reviewId, status, additionalData = {}) {
    const review = await this.getReview(reviewId)

    if (!review) {
      throw new Error(`Review not found: ${reviewId}`)
    }

    logger.info(
      {
        reviewId,
        statusBefore: review.status,
        statusAfter: status,
        fileNameBefore: review.fileName,
        createdAtBefore: review.createdAt
      },
      'Updating review status'
    )

    const now = new Date().toISOString()
    const preservedFields = preserveImmutableFields(review)

    // Update mutable fields
    review.status = status
    review.updatedAt = now

    // Sanitize and merge additional data
    const safeAdditionalData = sanitizeAdditionalData(
      additionalData,
      reviewId,
      preservedFields
    )
    Object.assign(review, safeAdditionalData)

    // Restore immutable fields
    restoreImmutableFields(review, preservedFields, reviewId)

    // Update processing timestamps
    updateProcessingTimestamps(review, status, now)

    logger.info(
      {
        reviewId,
        status: review.status,
        fileNameAfter: review.fileName,
        createdAtAfter: review.createdAt,
        updatedAt: review.updatedAt
      },
      'Updating review status'
    )

    await this.saveReview(review)
    logger.info({ reviewId, status }, 'Review status updated in S3')
  }

  /**
   * Save review result
   * @param {string} reviewId - Review ID
   * @param {Object} result - Review result from Bedrock
   * @param {Object} usage - Bedrock usage statistics
   * @returns {Promise<void>}
   */
  async saveReviewResult(reviewId, result, usage) {
    // Update review status to 'completed' and add result + usage
    // This saves the COMPLETE review object with fileName, createdAt, etc.
    await this.updateReviewStatus(reviewId, 'completed', {
      result,
      bedrockUsage: usage
    })

    logger.info({ reviewId, hasResult: !!result, hasUsage: !!usage })
  }

  /**
   * Save review error
   * @param {string} reviewId - Review ID
   * @param {string|Error} error - Error message or Error object
   * @returns {Promise<void>}
   */
  async saveReviewError(reviewId, error) {
    const errorMessage = typeof error === 'string' ? error : error.message
    const errorStack = typeof error === 'string' ? null : error.stack

    logger.info(
      {
        reviewId,
        errorMessage,
        hasStack: !!errorStack
      },
      'Saving review error to S3'
    )

    try {
      await this.updateReviewStatus(reviewId, 'failed', {
        error: {
          message: errorMessage,
          stack: errorStack
        }
      })

      logger.info(
        {
          reviewId,
          errorMessage
        },
        'Review error saved successfully to S3'
      )
    } catch (updateError) {
      logger.error(
        {
          reviewId,
          errorMessage,
          updateError: updateError.message,
          updateErrorStack: updateError.stack
        },
        'Failed to update review status to failed in S3'
      )
      throw updateError
    }
  }

  /**
   * Get recent reviews (paginated)
   * @param {Object} options - Query options
   * @param {number} options.limit - Maximum number of reviews to return
   * @param {string} options.continuationToken - Token for pagination
   * @returns {Promise<Object>} Reviews and pagination info
   */
  async getRecentReviews({ limit = 20, continuationToken = null } = {}) {
    return getRecentReviewsHelper(this.s3Client, this.bucket, this.prefix, {
      limit,
      continuationToken
    })
  }

  /**
   * Get reviews by status
   * @param {string} status - Status to filter by
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Array of reviews
   */
  async getReviewsByStatus(status, options = {}) {
    const { reviews } = await this.getRecentReviews(options)
    return reviews.filter((review) => review.status === status)
  }

  /**
   * Get all reviews (paginated)
   * @param {number} limit - Maximum number of reviews to return
   * @param {number} skip - Number of reviews to skip (for pagination)
   * @returns {Promise<Array>} Array of reviews
   */
  async getAllReviews(limit = 50, skip = 0) {
    try {
      // Get more than needed to handle skip
      const fetchLimit = limit + skip
      const { reviews } = await this.getRecentReviews({ limit: fetchLimit })
      logger.info(
        {
          count: reviews.length,
          reviewIds: reviews.map((r) => r.id),
          statuses: reviews.map((r) => r.status)
        },
        'Retrieved reviews from S3'
      )
      // Apply skip and limit
      return reviews.slice(skip, skip + limit)
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get all reviews')
      throw error
    }
  }

  /**
   * Get total count of reviews
   * @returns {Promise<number>} Total number of reviews
   */
  async getReviewCount() {
    return getReviewCountHelper(this.s3Client, this.bucket, this.prefix)
  }

  /**
   * Delete a review and its associated content from S3
   * @param {string} reviewId - Review ID to delete
   * @returns {Promise<Object>} Deletion result with details
   */
  async deleteReview(reviewId) {
    try {
      logger.info({ reviewId }, 'Deleting review and associated content')

      const review = await this.getReview(reviewId)

      if (!review) {
        logger.warn({ reviewId }, 'Review not found for deletion')
        throw new Error(`Review not found: ${reviewId}`)
      }

      const deletedKeys = []

      // Delete the uploaded content file if it exists
      if (review.s3Key) {
        await deleteUploadedContent(
          this.s3Client,
          this.bucket,
          reviewId,
          review.s3Key,
          deletedKeys
        )
      }

      // Delete the review metadata file
      const reviewKey = this.getReviewKey(reviewId)
      await deleteReviewMetadataFile(
        this.s3Client,
        this.bucket,
        reviewKey,
        reviewId,
        deletedKeys
      )

      logger.info(
        {
          reviewId,
          deletedKeys,
          deletedCount: deletedKeys.length
        },
        'Review and associated content deleted successfully'
      )

      return {
        success: true,
        reviewId,
        deletedKeys,
        deletedCount: deletedKeys.length,
        fileName: review.fileName,
        status: review.status
      }
    } catch (error) {
      logger.error(
        {
          reviewId,
          error: error.message,
          stack: error.stack
        },
        'Failed to delete review'
      )
      throw error
    }
  }

  /**
   * Delete old reviews to maintain storage limits
   * @param {number} keepCount - Number of most recent reviews to keep
   * @returns {Promise<number>} Number of reviews deleted
   */
  async deleteOldReviews(keepCount = 100) {
    return deleteOldReviewsHelper(
      this.s3Client,
      this.bucket,
      this.prefix,
      this.getRecentReviews.bind(this),
      keepCount
    )
  }

  /**
   * Disconnect (no-op for S3)
   */
  async disconnect() {
    logger.info('S3 client disconnected (no-op)')
  }
}

// Export singleton instance
export const reviewRepository = new ReviewRepositoryS3()
