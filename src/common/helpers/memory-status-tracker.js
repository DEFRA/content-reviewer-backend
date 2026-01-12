import { createLogger } from './logging/logger.js'
import { s3ResultsStorage } from './s3-results-storage.js'

const logger = createLogger()

/**
 * In-Memory Review Status Tracker (Development/Testing)
 * Stores review statuses in memory when MongoDB is not available
 * Keeps last 100 reviews to prevent memory overflow
 */
class MemoryStatusTracker {
  constructor() {
    this.statuses = new Map()
    this.maxEntries = 100 // Keep last 100 reviews
    this._s3Loaded = false // Track if we've loaded from S3
    logger.info('Using in-memory status tracker (no MongoDB) - keeps last 100 reviews')
  }

  /**
   * Clean up old entries if we exceed maxEntries
   * Keeps the most recent reviews based on createdAt timestamp
   */
  _cleanupOldEntries() {
    if (this.statuses.size <= this.maxEntries) {
      return
    }

    // Convert to array and sort by createdAt (oldest first)
    const entries = Array.from(this.statuses.entries())
    entries.sort((a, b) => {
      const dateA = a[1].createdAt || new Date(0)
      const dateB = b[1].createdAt || new Date(0)
      return dateA - dateB
    })

    // Remove oldest entries until we're at maxEntries
    const toRemove = entries.length - this.maxEntries
    for (let i = 0; i < toRemove; i++) {
      const [uploadId] = entries[i]
      this.statuses.delete(uploadId)
      logger.debug({ uploadId }, 'Removed old review from memory')
    }

    logger.info({ 
      removed: toRemove, 
      remaining: this.statuses.size 
    }, 'Cleaned up old reviews from memory')
  }

  /**
   * Create initial review status
   */
  async createStatus(uploadId, filename, userId, metadata = {}) {
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

    this.statuses.set(uploadId, status)
    this._cleanupOldEntries() // Clean up after adding new entry
    logger.debug({ uploadId, filename }, 'Created status in memory')
    return status
  }

  /**
   * Update status with new information
   */
  async updateStatus(uploadId, updates) {
    const status = this.statuses.get(uploadId)
    
    if (!status) {
      logger.warn({ uploadId }, 'Status not found in memory - may have been cleared or backend restarted')
      // Don't throw error - just log and return null
      return null
    }

    const historyEntry = {
      status: updates.status || status.status,
      timestamp: new Date(),
      message: updates.message || '',
      progress: updates.progress !== undefined ? updates.progress : status.progress,
      ...(updates.error && { error: updates.error })
    }

    Object.assign(status, {
      ...updates,
      statusHistory: [...status.statusHistory, historyEntry],
      updatedAt: new Date()
    })

    this.statuses.set(uploadId, status)
    logger.debug({ uploadId, updates }, 'Updated status in memory')
    return status
  }

  /**
   * Mark status as failed
   */
  async markFailed(uploadId, error, details = {}) {
    return this.updateStatus(uploadId, {
      status: 'failed',
      error: error.message || error,
      errorDetails: details,
      progress: 100,
      completedAt: new Date()
    })
  }

  /**
   * Mark status as completed
   */
  async markCompleted(uploadId, reviewResult, s3ResultLocation = null) {
    const status = this.statuses.get(uploadId)
    
    if (!status) {
      logger.warn({ uploadId }, 'Cannot mark as completed - status not found')
      return null
    }

    // Save result to S3 for persistence
    let s3Location = s3ResultLocation
    try {
      const s3Result = await s3ResultsStorage.saveResult(uploadId, reviewResult, {
        filename: status.filename,
        status: 'completed',
        createdAt: status.createdAt,
        completedAt: new Date()
      })
      if (s3Result) {
        s3Location = s3Result.location
        logger.info({ uploadId, s3Location }, 'Review result saved to S3')
      }
    } catch (error) {
      logger.warn({ uploadId, error: error.message }, 'Failed to save result to S3 - continuing with memory-only storage')
    }

    const updates = {
      status: 'completed',
      progress: 100,
      message: 'Review completed successfully',
      completedAt: new Date(),
      result: reviewResult,
      s3ResultLocation: s3Location
    }

    const historyEntry = {
      status: 'completed',
      timestamp: new Date(),
      message: 'Review completed successfully',
      progress: 100
    }

    Object.assign(status, {
      ...updates,
      statusHistory: [...status.statusHistory, historyEntry],
      updatedAt: new Date()
    })

    this.statuses.set(uploadId, status)
    logger.info({ uploadId, s3Saved: !!s3Location }, 'Marked status as completed with review result')
    return status
  }

  /**
   * Get status by upload ID
   * Checks memory first, then falls back to S3 if not found
   */
  async getStatus(uploadId) {
    // First check memory
    let status = this.statuses.get(uploadId)
    if (status) {
      return status
    }

    // If not in memory, try to load from S3
    try {
      const s3Result = await s3ResultsStorage.getResult(uploadId)
      if (s3Result) {
        logger.info({ uploadId }, 'Loaded review result from S3 (not in memory)')
        
        // Reconstruct status object from S3 data
        status = {
          uploadId: s3Result.uploadId,
          filename: s3Result.filename,
          status: s3Result.status,
          progress: 100,
          message: 'Review completed',
          createdAt: s3Result.createdAt,
          completedAt: s3Result.completedAt,
          updatedAt: s3Result.completedAt,
          result: s3Result.reviewResult,
          s3ResultLocation: `s3://${s3ResultsStorage.bucket}/${s3ResultsStorage.resultsPrefix}/${uploadId}.json`,
          statusHistory: [
            {
              status: 'completed',
              timestamp: s3Result.completedAt,
              message: 'Review completed (loaded from S3)',
              progress: 100
            }
          ],
          metadata: {}
        }
        
        // Optionally cache in memory
        this.statuses.set(uploadId, status)
        this._cleanupOldEntries()
        
        return status
      }
    } catch (error) {
      logger.warn({ uploadId, error: error.message }, 'Failed to load result from S3')
    }

    return null
  }

  /**
   * Get statuses for a user
   */
  async getUserStatuses(userId, limit = 100) {
    const userStatuses = Array.from(this.statuses.values())
      .filter(s => s.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
    
    return userStatuses
  }

  /**
   * Get all statuses (with optional status filter)
   * Loads from S3 on first call if memory is empty
   */
  async getAllStatuses(limit = 100, statusFilter = null) {
    // If memory is empty or has very few entries, try to load from S3
    if (this.statuses.size < 10 && s3ResultsStorage.isEnabled()) {
      await this.loadFromS3()
    }

    let allStatuses = Array.from(this.statuses.values())
    
    if (statusFilter) {
      allStatuses = allStatuses.filter(s => s.status === statusFilter)
    }
    
    return allStatuses
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  /**
   * Load recent results from S3 into memory
   */
  async loadFromS3() {
    if (this._s3Loaded) {
      return // Already loaded
    }

    try {
      logger.info('Loading review history from S3...')
      const s3Results = await s3ResultsStorage.loadRecentResults(this.maxEntries)
      
      for (const s3Result of s3Results) {
        // Only add to memory if not already present
        if (!this.statuses.has(s3Result.uploadId)) {
          const status = {
            uploadId: s3Result.uploadId,
            filename: s3Result.filename,
            status: s3Result.status,
            progress: 100,
            message: 'Review completed',
            createdAt: s3Result.createdAt,
            completedAt: s3Result.completedAt,
            updatedAt: s3Result.completedAt,
            result: s3Result.reviewResult,
            s3ResultLocation: `s3://${s3ResultsStorage.bucket}/${s3ResultsStorage.resultsPrefix}/${s3Result.uploadId}.json`,
            statusHistory: [
              {
                status: 'completed',
                timestamp: s3Result.completedAt,
                message: 'Review completed (loaded from S3)',
                progress: 100
              }
            ],
            metadata: {}
          }
          this.statuses.set(s3Result.uploadId, status)
        }
      }
      
      this._s3Loaded = true
      logger.info({ count: s3Results.length }, 'Loaded review history from S3 into memory')
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to load history from S3 - continuing with empty memory')
    }
  }

  /**
   * Get status history
   */
  async getStatusHistory(uploadId) {
    const status = await this.getStatus(uploadId)
    return status ? status.statusHistory : []
  }

  /**
   * Mark upload as failed
   */
  async markFailed(uploadId, errorMessage) {
    const status = this.statuses.get(uploadId)
    
    if (!status) {
      logger.warn({ uploadId }, 'Cannot mark as failed - status not found')
      return null
    }

    const updates = {
      status: 'failed',
      message: errorMessage,
      error: errorMessage,
      failedAt: new Date()
    }

    const historyEntry = {
      status: 'failed',
      timestamp: new Date(),
      message: errorMessage,
      error: errorMessage
    }

    Object.assign(status, {
      ...updates,
      statusHistory: [...status.statusHistory, historyEntry],
      updatedAt: new Date()
    })

    this.statuses.set(uploadId, status)
    logger.error({ uploadId, error: errorMessage }, 'Marked status as failed')
    return status
  }

  /**
   * Get statistics for a user
   */
  async getStatistics(userId = null) {
    const statuses = userId 
      ? Array.from(this.statuses.values()).filter(s => s.userId === userId)
      : Array.from(this.statuses.values())

    const stats = {
      total: statuses.length,
      completed: statuses.filter(s => s.status === 'completed').length,
      failed: statuses.filter(s => s.status === 'failed').length,
      inProgress: statuses.filter(s => 
        !['completed', 'failed'].includes(s.status)
      ).length
    }

    return stats
  }

  /**
   * Delete status
   */
  async deleteStatus(uploadId) {
    const existed = this.statuses.has(uploadId)
    this.statuses.delete(uploadId)
    return { deleted: existed }
  }

  /**
   * Clear all statuses (for testing)
   */
  async clearAll() {
    this.statuses.clear()
    logger.info('Cleared all in-memory statuses')
  }
}

export const memoryStatusTracker = new MemoryStatusTracker()
export { MemoryStatusTracker }
