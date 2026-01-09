import { createLogger } from './logging/logger.js'
import { s3Uploader } from './s3-uploader.js'
import { mongodb } from './mongodb-client.js'

const logger = createLogger()

/**
 * Review Status Tracker
 * Manages status updates for content review workflow
 */
class ReviewStatusTracker {
  constructor() {
    this.collectionName = 'review_statuses'
  }

  /**
   * Get MongoDB collection
   */
  async getCollection() {
    const db = await mongodb.getDb()
    return db.collection(this.collectionName)
  }

  /**
   * Create initial review status
   * @param {string} uploadId - Unique upload identifier
   * @param {string} filename - Original filename
   * @param {string} userId - User identifier
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} Created status document
   */
  async createStatus(uploadId, filename, userId, metadata = {}) {
    const collection = await this.getCollection()

    const status = {
      uploadId,
      filename,
      status: 'uploading',
      statusHistory: [
        {
          status: 'uploading',
          timestamp: new Date(),
          message: 'Starting file upload',
          progress: 0
        }
      ],
      userId,
      progress: 0,
      metadata,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    await collection.insertOne(status)
    logger.info({ uploadId, filename }, 'Review status created')
    return status
  }

  /**
   * Update status with progress
   * @param {string} uploadId - Upload identifier
   * @param {string} newStatus - New status value
   * @param {string} message - Status message
   * @param {number} progress - Progress percentage (0-100)
   * @returns {Promise<Object>} Update result
   */
  async updateStatus(uploadId, newStatus, message = '', progress = null) {
    const collection = await this.getCollection()

    const statusUpdate = {
      status: newStatus,
      timestamp: new Date(),
      message,
      ...(progress !== null && { progress })
    }

    const update = {
      $set: {
        status: newStatus,
        updatedAt: new Date()
      },
      $push: {
        statusHistory: statusUpdate
      }
    }

    if (progress !== null) {
      update.$set.progress = progress
    }

    const result = await collection.updateOne({ uploadId }, update)

    logger.info(
      { uploadId, status: newStatus, progress, message },
      'Status updated'
    )
    return result
  }

  /**
   * Get current status for an upload
   * @param {string} uploadId - Upload identifier
   * @returns {Promise<Object>} Status document
   */
  async getStatus(uploadId) {
    const collection = await this.getCollection()
    return await collection.findOne({ uploadId })
  }

  /**
   * Get status history for an upload
   * @param {string} uploadId - Upload identifier
   * @returns {Promise<Array>} Status history array
   */
  async getStatusHistory(uploadId) {
    const status = await this.getStatus(uploadId)
    return status?.statusHistory || []
  }

  /**
   * Get all statuses for a user
   * @param {string} userId - User identifier
   * @param {number} limit - Maximum number of results
   * @returns {Promise<Array>} Array of status documents
   */
  async getUserStatuses(userId, limit = 50) {
    const collection = await this.getCollection()
    return await collection
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
  }

  /**
   * Get all review statuses (for admin/history view)
   * @param {number} limit - Maximum number of results
   * @param {string} statusFilter - Optional status filter
   * @returns {Promise<Array>} Array of status documents
   */
  async getAllStatuses(limit = 50, statusFilter = null) {
    const collection = await this.getCollection()
    const query = statusFilter ? { status: statusFilter } : {}

    return await collection
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
  }

  /**
   * Mark upload as failed
   * @param {string} uploadId - Upload identifier
   * @param {string} errorMessage - Error description
   * @returns {Promise<Object>} Update result
   */
  async markFailed(uploadId, errorMessage) {
    const collection = await this.getCollection()

    const result = await collection.updateOne(
      { uploadId },
      {
        $set: {
          status: 'failed',
          error: errorMessage,
          failedAt: new Date(),
          updatedAt: new Date()
        },
        $push: {
          statusHistory: {
            status: 'failed',
            timestamp: new Date(),
            message: errorMessage
          }
        }
      }
    )

    logger.error({ uploadId, error: errorMessage }, 'Review marked as failed')
    return result
  }

  /**
   * Mark upload as completed and save results to both MongoDB and S3
   * @param {string} uploadId - Upload identifier
   * @param {Object} resultData - Review results data
   * @returns {Promise<Object>} Update result
   */
  async markCompleted(uploadId, resultData = {}) {
    const collection = await this.getCollection()

    // Step 1: Save results to S3 for long-term storage
    let s3ResultLocation = null
    try {
      const resultFileName = `${uploadId}-review-result.json`
      const resultBuffer = Buffer.from(JSON.stringify(resultData, null, 2))

      const s3Result = await s3Uploader.uploadBuffer({
        buffer: resultBuffer,
        filename: resultFileName,
        mimetype: 'application/json',
        folder: 'review-results'
      })

      s3ResultLocation = s3Result.location

      logger.info(
        { uploadId, s3Location: s3ResultLocation },
        'Review results saved to S3'
      )
    } catch (error) {
      logger.error(
        { uploadId, error: error.message },
        'Failed to save results to S3, continuing with MongoDB only'
      )
    }

    // Step 2: Update MongoDB with results and S3 location
    const result = await collection.updateOne(
      { uploadId },
      {
        $set: {
          status: 'completed',
          progress: 100,
          result: resultData,
          s3ResultLocation, // Store S3 location of results
          completedAt: new Date(),
          updatedAt: new Date()
        },
        $push: {
          statusHistory: {
            status: 'completed',
            timestamp: new Date(),
            message: 'Review completed successfully',
            progress: 100,
            s3ResultLocation
          }
        }
      }
    )

    logger.info({ uploadId, s3ResultLocation }, 'Review completed successfully')
    return result
  }

  /**
   * Delete status (for cleanup/testing)
   * @param {string} uploadId - Upload identifier
   * @returns {Promise<Object>} Delete result
   */
  async deleteStatus(uploadId) {
    const collection = await this.getCollection()
    return await collection.deleteOne({ uploadId })
  }

  /**
   * Get statistics
   * @param {string} userId - Optional user filter
   * @returns {Promise<Object>} Statistics object
   */
  async getStatistics(userId = null) {
    const collection = await this.getCollection()
    const query = userId ? { userId } : {}

    const stats = await collection
      .aggregate([
        { $match: query },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ])
      .toArray()

    const result = {
      total: 0,
      uploading: 0,
      uploaded: 0,
      queued: 0,
      processing: 0,
      downloading: 0,
      analyzing: 0,
      reviewing: 0,
      finalizing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    }

    stats.forEach((stat) => {
      result[stat._id] = stat.count
      result.total += stat.count
    })

    return result
  }
}

// Create singleton instance
export const reviewStatusTracker = new ReviewStatusTracker()

// Export class for testing
export { ReviewStatusTracker }

// Export status constants
export const ReviewStatus = {
  UPLOADING: 'uploading', // 0%  - Frontend uploading file
  UPLOADED: 'uploaded', // 10% - File uploaded to S3
  QUEUED: 'queued', // 20% - Message in SQS queue
  PROCESSING: 'processing', // 30% - Worker picked up message
  DOWNLOADING: 'downloading', // 40% - Downloading from S3
  ANALYZING: 'analyzing', // 50% - Extracting content
  REVIEWING: 'reviewing', // 70% - AI review in progress
  FINALIZING: 'finalizing', // 90% - Saving results
  COMPLETED: 'completed', // 100% - Review complete
  FAILED: 'failed', // Error occurred
  CANCELLED: 'cancelled' // User cancelled
}

// Export progress percentages
export const StatusProgress = {
  uploading: 5,
  uploaded: 15,
  queued: 25,
  processing: 35,
  downloading: 45,
  analyzing: 55,
  reviewing: 75,
  finalizing: 90,
  completed: 100,
  failed: 0,
  cancelled: 0
}
