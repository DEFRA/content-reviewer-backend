import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command
} from '@aws-sdk/client-s3'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'

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
    const awsEndpoint = process.env.AWS_ENDPOINT
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true // Required for LocalStack
      logger.info(
        { endpoint: awsEndpoint },
        'Using custom AWS endpoint (LocalStack)'
      )
    }

    this.s3Client = new S3Client(s3Config)

    // Use the provided S3 bucket, with fallback to config
    this.bucket =
      process.env.S3_BUCKET ||
      process.env.UPLOAD_S3_BUCKET ||
      config.get('s3.bucket') ||
      'dev-service-optimisation-c63f2'
    this.prefix = 'reviews/' // Store reviews in a subfolder

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
    const date = new Date()
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${this.prefix}${year}/${month}/${day}/${reviewId}.json`
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

    await this.saveReview(review)
    logger.info(
      { reviewId: review.id, s3Key: this.getReviewKey(review.id) },
      'Review created in S3'
    )

    return review
  }

  /**
   * Save review to S3
   * @param {Object} review - Review object
   * @returns {Promise<void>}
   */
  async saveReview(review) {
    const key = this.getReviewKey(review.id)

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: JSON.stringify(review, null, 2),
      ContentType: 'application/json',
      Metadata: {
        reviewId: review.id,
        status: review.status,
        sourceType: review.sourceType
      }
    })

    try {
      await this.s3Client.send(command)
      logger.debug({ reviewId: review.id, key }, 'Review saved to S3')
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
        return await this.searchReview(reviewId)
      }
      logger.error(
        { error: error.message, reviewId },
        'Failed to get review from S3'
      )
      throw error
    }
  }

  /**
   * Search for a review across multiple days
   * @param {string} reviewId - Review ID
   * @returns {Promise<Object|null>} Review or null if not found
   */
  async searchReview(reviewId) {
    try {
      // Search in the last 7 days
      for (let daysAgo = 0; daysAgo < 7; daysAgo++) {
        const date = new Date()
        date.setDate(date.getDate() - daysAgo)
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        const prefix = `${this.prefix}${year}/${month}/${day}/`

        const listCommand = new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: 1000
        })

        const listResponse = await this.s3Client.send(listCommand)

        if (listResponse.Contents) {
          const matchingKey = listResponse.Contents.find((obj) =>
            obj.Key.includes(reviewId)
          )

          if (matchingKey) {
            const getCommand = new GetObjectCommand({
              Bucket: this.bucket,
              Key: matchingKey.Key
            })

            const response = await this.s3Client.send(getCommand)
            const body = await response.Body.transformToString()
            return JSON.parse(body)
          }
        }
      }

      logger.warn({ reviewId }, 'Review not found in S3 (searched last 7 days)')
      return null
    } catch (error) {
      logger.error(
        { error: error.message, reviewId },
        'Failed to search for review'
      )
      throw error
    }
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

    const now = new Date().toISOString()
    review.status = status
    review.updatedAt = now

    // Merge additional data
    Object.assign(review, additionalData)

    // Set processing timestamps based on status
    if (status === 'processing' && !review.processingStartedAt) {
      review.processingStartedAt = now
    } else if (
      (status === 'completed' || status === 'failed') &&
      !review.processingCompletedAt
    ) {
      review.processingCompletedAt = now
    }

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
    await this.updateReviewStatus(reviewId, 'completed', {
      result,
      bedrockUsage: usage
    })
  }

  /**
   * Save review error
   * @param {string} reviewId - Review ID
   * @param {Error} error - Error object
   * @returns {Promise<void>}
   */
  async saveReviewError(reviewId, error) {
    await this.updateReviewStatus(reviewId, 'failed', {
      error: {
        message: error.message,
        stack: error.stack
      }
    })
  }

  /**
   * Get recent reviews (paginated)
   * @param {Object} options - Query options
   * @param {number} options.limit - Maximum number of reviews to return
   * @param {string} options.continuationToken - Token for pagination
   * @returns {Promise<Object>} Reviews and pagination info
   */
  async getRecentReviews({ limit = 20, continuationToken = null } = {}) {
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.prefix,
        MaxKeys: limit,
        ContinuationToken: continuationToken || undefined
      })

      const response = await this.s3Client.send(listCommand)

      if (!response.Contents || response.Contents.length === 0) {
        return {
          reviews: [],
          hasMore: false,
          nextToken: null
        }
      }

      // Fetch the actual review data for each object
      const reviewPromises = response.Contents.sort(
        (a, b) => b.LastModified - a.LastModified
      ) // Most recent first
        .slice(0, limit)
        .map(async (obj) => {
          try {
            const getCommand = new GetObjectCommand({
              Bucket: this.bucket,
              Key: obj.Key
            })
            const reviewResponse = await this.s3Client.send(getCommand)
            const body = await reviewResponse.Body.transformToString()
            return JSON.parse(body)
          } catch (error) {
            logger.warn(
              { key: obj.Key, error: error.message },
              'Failed to load review'
            )
            return null
          }
        })

      const reviews = (await Promise.all(reviewPromises)).filter(
        (r) => r !== null
      )

      return {
        reviews,
        hasMore: response.IsTruncated || false,
        nextToken: response.NextContinuationToken || null
      }
    } catch (error) {
      logger.error(
        { error: error.message },
        'Failed to get recent reviews from S3'
      )
      throw error
    }
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
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.prefix
      })

      let count = 0
      let continuationToken = null

      do {
        listCommand.input.ContinuationToken = continuationToken
        const response = await this.s3Client.send(listCommand)
        count += response.KeyCount || 0
        continuationToken = response.NextContinuationToken
      } while (continuationToken)

      return count
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get review count')
      throw error
    }
  }

  /**
   * Delete old reviews (cleanup)
   * @param {number} daysOld - Delete reviews older than this many days
   * @returns {Promise<number>} Number of reviews deleted
   */
  async deleteOldReviews(daysOld = 30) {
    // Implementation for cleanup - can be added later if needed
    logger.info({ daysOld }, 'Delete old reviews not yet implemented')
    return 0
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
