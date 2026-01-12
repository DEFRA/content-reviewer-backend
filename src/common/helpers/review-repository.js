import { MongoClient } from 'mongodb'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * MongoDB repository for content reviews
 */
class ReviewRepository {
  constructor() {
    this.collectionName = 'content_reviews'
    this.client = null
    this.db = null
  }

  /**
   * Connect to MongoDB
   */
  async connect() {
    if (this.client && this.db) {
      return this.db
    }

    try {
      this.client = await MongoClient.connect(config.get('mongodb.uri'), {
        retryWrites: true,
        w: 'majority'
      })
      this.db = this.client.db(config.get('mongodb.databaseName'))
      logger.info('Review repository connected to MongoDB')
      return this.db
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to connect to MongoDB')
      throw error
    }
  }

  /**
   * Get MongoDB collection
   */
  async getCollection() {
    const db = await this.connect()
    return db.collection(this.collectionName)
  }

  /**
   * Create a new review record
   * @param {Object} reviewData - Review data
   * @returns {Promise<Object>} Created review
   */
  async createReview(reviewData) {
    const collection = await this.getCollection()
    const now = new Date()

    const review = {
      _id: reviewData.id, // Use timestamp-based ID from caller
      status: 'pending', // pending, processing, completed, failed
      createdAt: now,
      updatedAt: now,
      sourceType: reviewData.sourceType, // 'file' or 'text'
      fileName: reviewData.fileName || null,
      fileSize: reviewData.fileSize || null,
      mimeType: reviewData.mimeType || null,
      s3Key: reviewData.s3Key || null,
      textContent: reviewData.textContent || null,
      result: null,
      error: null,
      processingStartedAt: null,
      processingCompletedAt: null,
      bedrockUsage: null
    }

    await collection.insertOne(review)
    logger.info({ reviewId: review._id }, 'Review created')

    return review
  }

  /**
   * Get a review by ID
   * @param {string} reviewId - Review ID
   * @returns {Promise<Object|null>} Review or null if not found
   */
  async getReview(reviewId) {
    const collection = await this.getCollection()
    return await collection.findOne({ _id: reviewId })
  }

  /**
   * Update review status
   * @param {string} reviewId - Review ID
   * @param {string} status - New status
   * @param {Object} additionalData - Additional data to update
   * @returns {Promise<void>}
   */
  async updateReviewStatus(reviewId, status, additionalData = {}) {
    const collection = await this.getCollection()
    const now = new Date()

    const updateData = {
      status,
      updatedAt: now,
      ...additionalData
    }

    // Set processing timestamps based on status
    if (status === 'processing' && !additionalData.processingStartedAt) {
      updateData.processingStartedAt = now
    } else if (
      (status === 'completed' || status === 'failed') &&
      !additionalData.processingCompletedAt
    ) {
      updateData.processingCompletedAt = now
    }

    await collection.updateOne({ _id: reviewId }, { $set: updateData })

    logger.info({ reviewId, status }, 'Review status updated')
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
   * @param {string} error - Error message
   * @returns {Promise<void>}
   */
  async saveReviewError(reviewId, error) {
    await this.updateReviewStatus(reviewId, 'failed', {
      error
    })
  }

  /**
   * Get all reviews (most recent first)
   * @param {number} limit - Maximum number of reviews to return
   * @param {number} skip - Number of reviews to skip (for pagination)
   * @returns {Promise<Array>} Array of reviews
   */
  async getAllReviews(limit = 100, skip = 0) {
    const collection = await this.getCollection()
    return await collection
      .find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray()
  }

  /**
   * Get review count
   * @returns {Promise<number>} Total number of reviews
   */
  async getReviewCount() {
    const collection = await this.getCollection()
    return await collection.countDocuments()
  }

  /**
   * Delete old reviews (cleanup)
   * @param {number} daysOld - Delete reviews older than this many days
   * @returns {Promise<number>} Number of deleted reviews
   */
  async deleteOldReviews(daysOld = 90) {
    const collection = await this.getCollection()
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysOld)

    const result = await collection.deleteMany({
      createdAt: { $lt: cutoffDate }
    })

    logger.info(
      { deletedCount: result.deletedCount, daysOld },
      'Old reviews deleted'
    )

    return result.deletedCount
  }
}

// Export singleton instance
export const reviewRepository = new ReviewRepository()
