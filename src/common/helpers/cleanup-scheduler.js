import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'
import { reviewRepository } from './review-repository.js'

const logger = createLogger()

// Config keys
const CONFIG_KEY_ENABLED = 'cleanup.enabled'
const CONFIG_KEY_INTERVAL_HOURS = 'cleanup.intervalHours'
const CONFIG_KEY_RETENTION_DAYS = 'cleanup.retentionDays'

/**
 * Cleanup Scheduler - Automatically deletes reviews older than retention period
 * Runs at a configurable interval (default: every hour)
 */
class CleanupScheduler {
  intervalId = null
  isRunning = false
  lastRunTime = null
  lastDeletedCount = 0

  /**
   * Start the cleanup scheduler
   */
  start() {
    const enabled = config.get(CONFIG_KEY_ENABLED)
    const intervalHours = config.get(CONFIG_KEY_INTERVAL_HOURS)
    const retentionDays = config.get(CONFIG_KEY_RETENTION_DAYS)

    if (!enabled) {
      logger.info('Cleanup scheduler is disabled (CLEANUP_ENABLED=false)')
      return
    }

    if (this.isRunning) {
      logger.warn('Cleanup scheduler is already running')
      return
    }

    const intervalMs = intervalHours * 60 * 60 * 1000

    logger.info(
      {
        intervalHours,
        retentionDays,
        intervalMs
      },
      `Starting cleanup scheduler - will run every ${intervalHours} hour(s) to delete reviews older than ${retentionDays} days`
    )

    // Run cleanup immediately on startup
    this.runCleanup().catch((error) => {
      logger.error(
        { error: error.message },
        'Initial cleanup run failed (non-critical)'
      )
    })

    // Schedule periodic cleanup
    this.intervalId = setInterval(() => {
      this.runCleanup().catch((error) => {
        logger.error(
          { error: error.message },
          'Scheduled cleanup run failed (non-critical)'
        )
      })
    }, intervalMs)

    this.isRunning = true

    logger.info('Cleanup scheduler started successfully')
  }

  /**
   * Stop the cleanup scheduler
   */
  stop() {
    if (!this.isRunning) {
      logger.warn('Cleanup scheduler is not running')
      return
    }

    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    this.isRunning = false

    logger.info('Cleanup scheduler stopped')
  }

  /**
   * Run cleanup now
   */
  async runCleanup() {
    const retentionDays = config.get(CONFIG_KEY_RETENTION_DAYS)
    const startTime = new Date()

    logger.info(
      {
        retentionDays,
        timestamp: startTime.toISOString()
      },
      'Running scheduled cleanup'
    )

    try {
      const deletedCount =
        await reviewRepository.deleteOldReviews(retentionDays)

      const endTime = new Date()
      const durationMs = endTime.getTime() - startTime.getTime()

      this.lastRunTime = startTime
      this.lastDeletedCount = deletedCount

      logger.info(
        {
          deletedCount,
          retentionDays,
          durationMs,
          timestamp: endTime.toISOString()
        },
        `Scheduled cleanup completed - deleted ${deletedCount} review(s) in ${durationMs}ms`
      )

      return deletedCount
    } catch (error) {
      logger.error(
        {
          error: error.message,
          stack: error.stack,
          retentionDays
        },
        'Scheduled cleanup failed'
      )
      throw error
    }
  }

  /**
   * Get the current status of the scheduler
   */
  getStatus() {
    const enabled = config.get(CONFIG_KEY_ENABLED)
    const intervalHours = config.get(CONFIG_KEY_INTERVAL_HOURS)
    const retentionDays = config.get(CONFIG_KEY_RETENTION_DAYS)

    return {
      enabled,
      isRunning: this.isRunning,
      intervalHours,
      retentionDays,
      lastRunTime: this.lastRunTime ? this.lastRunTime.toISOString() : null,
      lastDeletedCount: this.lastDeletedCount
    }
  }
}

// Export singleton instance
export const cleanupScheduler = new CleanupScheduler()
