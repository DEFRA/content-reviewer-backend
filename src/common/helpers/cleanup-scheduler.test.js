import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { config } from '../../config.js'

// Test constants
const DELETED_COUNT_THREE = 3
const DELETED_COUNT_SEVEN = 7
const S3_CONNECTION_ERROR = 'S3 connection failed'

const mockDeleteOldReviews = vi.fn()
const mockLoggerInfo = vi.fn()
const mockLoggerWarn = vi.fn()
const mockLoggerError = vi.fn()

vi.mock('./review-repository.js', () => ({
  reviewRepository: {
    deleteOldReviews: mockDeleteOldReviews
  }
}))

vi.mock('./logging/logger.js', () => ({
  createLogger: () => ({
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError
  })
}))

// Config key constants matching the implementation
const CONFIG_ENABLED = 'cleanup.enabled'
const CONFIG_INTERVAL_HOURS = 'cleanup.intervalHours'
const CONFIG_RETENTION_DAYS = 'cleanup.retentionDays'

const DEFAULT_RETENTION_DAYS = 5
const DEFAULT_INTERVAL_HOURS = 1

// ============ cleanupScheduler.start ============

describe('cleanupScheduler.start - when disabled', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    config.set(CONFIG_ENABLED, false)
    config.set(CONFIG_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS)
    config.set(CONFIG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)
  })

  afterEach(() => {
    vi.useRealTimers()
    config.set(CONFIG_ENABLED, true)
  })

  test('should not start when disabled', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'Cleanup scheduler is disabled (CLEANUP_ENABLED=false)'
    )
    expect(mockDeleteOldReviews).not.toHaveBeenCalled()
    expect(cleanupScheduler.isRunning).toBe(false)
  })
})

describe('cleanupScheduler.start - when enabled', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    config.set(CONFIG_ENABLED, true)
    config.set(CONFIG_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS)
    config.set(CONFIG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)
    mockDeleteOldReviews.mockResolvedValue(0)
  })

  afterEach(async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.stop()
    vi.useRealTimers()
  })

  test('should set isRunning to true', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    expect(cleanupScheduler.isRunning).toBe(true)
  })

  test('should run cleanup immediately on startup', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockDeleteOldReviews).toHaveBeenCalledWith(DEFAULT_RETENTION_DAYS)
  })

  test('should log startup message with correct config', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        intervalHours: DEFAULT_INTERVAL_HOURS,
        retentionDays: DEFAULT_RETENTION_DAYS
      }),
      expect.stringContaining('Starting cleanup scheduler')
    )
  })

  test('should log success message after starting', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'Cleanup scheduler started successfully'
    )
  })

  test('should trigger cleanup again after interval elapses', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    const callsAfterStart = mockDeleteOldReviews.mock.calls.length

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_HOURS * 60 * 60 * 1000)
    expect(mockDeleteOldReviews.mock.calls.length).toBeGreaterThan(
      callsAfterStart
    )
  })

  test('should warn and not restart if already running', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    cleanupScheduler.start()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Cleanup scheduler is already running'
    )
  })
})

describe('cleanupScheduler.start - error handling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    config.set(CONFIG_ENABLED, true)
    config.set(CONFIG_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS)
    config.set(CONFIG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)
  })

  afterEach(async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.stop()
    vi.useRealTimers()
  })

  test('should log error but not throw if initial cleanup fails', async () => {
    const mockError = new Error('S3 unavailable')
    mockDeleteOldReviews.mockRejectedValueOnce(mockError)
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockLoggerError).toHaveBeenCalledWith(
      { error: mockError.message },
      'Initial cleanup run failed (non-critical)'
    )
  })

  test('should log error but not throw if interval cleanup fails', async () => {
    mockDeleteOldReviews.mockResolvedValueOnce(0)
    mockDeleteOldReviews.mockRejectedValueOnce(new Error('timeout'))
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_HOURS * 60 * 60 * 1000)
    expect(mockLoggerError).toHaveBeenCalledWith(
      { error: 'timeout' },
      'Scheduled cleanup run failed (non-critical)'
    )
  })
})

// ============ cleanupScheduler.stop ============

describe('cleanupScheduler.stop - when running', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    config.set(CONFIG_ENABLED, true)
    config.set(CONFIG_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS)
    config.set(CONFIG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)
    mockDeleteOldReviews.mockResolvedValue(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('should set isRunning to false', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    cleanupScheduler.stop()
    expect(cleanupScheduler.isRunning).toBe(false)
  })

  test('should clear the interval', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    cleanupScheduler.stop()
    expect(cleanupScheduler.intervalId).toBeNull()
  })

  test('should log stopped message', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    cleanupScheduler.stop()
    expect(mockLoggerInfo).toHaveBeenCalledWith('Cleanup scheduler stopped')
  })

  test('should not run cleanup after being stopped', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    cleanupScheduler.stop()
    const callsAfterStop = mockDeleteOldReviews.mock.calls.length

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_HOURS * 60 * 60 * 1000)
    expect(mockDeleteOldReviews.mock.calls.length).toBe(callsAfterStop)
  })

  test('should stop correctly when isRunning is true but intervalId is null', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.isRunning = true
    cleanupScheduler.intervalId = null
    cleanupScheduler.stop()
    expect(cleanupScheduler.isRunning).toBe(false)
    expect(mockLoggerInfo).toHaveBeenCalledWith('Cleanup scheduler stopped')
  })
})

describe('cleanupScheduler.stop - when not running', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    config.set(CONFIG_ENABLED, true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('should warn if not running', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.isRunning = false
    cleanupScheduler.stop()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Cleanup scheduler is not running'
    )
  })
})

// ============ cleanupScheduler.runCleanup ============

describe('cleanupScheduler.runCleanup - success', () => {
  beforeEach(() => {
    config.set(CONFIG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)
  })

  test('should call deleteOldReviews with retention days from config', async () => {
    mockDeleteOldReviews.mockResolvedValueOnce(DELETED_COUNT_THREE)
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    await cleanupScheduler.runCleanup()
    expect(mockDeleteOldReviews).toHaveBeenCalledWith(DEFAULT_RETENTION_DAYS)
  })

  test('should return the number of deleted reviews', async () => {
    mockDeleteOldReviews.mockResolvedValueOnce(DELETED_COUNT_THREE)
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    const result = await cleanupScheduler.runCleanup()
    expect(result).toBe(DELETED_COUNT_THREE)
  })

  test('should update lastDeletedCount after successful run', async () => {
    mockDeleteOldReviews.mockResolvedValueOnce(DELETED_COUNT_SEVEN)
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    await cleanupScheduler.runCleanup()
    expect(cleanupScheduler.lastDeletedCount).toBe(DELETED_COUNT_SEVEN)
  })

  test('should update lastRunTime after successful run', async () => {
    mockDeleteOldReviews.mockResolvedValueOnce(0)
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    const before = new Date()
    await cleanupScheduler.runCleanup()
    expect(cleanupScheduler.lastRunTime).toBeInstanceOf(Date)
    expect(cleanupScheduler.lastRunTime.getTime()).toBeGreaterThanOrEqual(
      before.getTime()
    )
  })

  test('should log completion with deleted count and duration', async () => {
    mockDeleteOldReviews.mockResolvedValueOnce(2)
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    await cleanupScheduler.runCleanup()
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedCount: 2,
        retentionDays: DEFAULT_RETENTION_DAYS
      }),
      expect.stringContaining('Scheduled cleanup completed')
    )
  })

  test('should return 0 when no reviews are deleted', async () => {
    mockDeleteOldReviews.mockResolvedValueOnce(0)
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    const result = await cleanupScheduler.runCleanup()
    expect(result).toBe(0)
  })
})

describe('cleanupScheduler.runCleanup - failure', () => {
  beforeEach(() => {
    config.set(CONFIG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)
  })

  test('should throw when deleteOldReviews fails', async () => {
    const mockError = new Error(S3_CONNECTION_ERROR)
    mockDeleteOldReviews.mockRejectedValueOnce(mockError)
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    await expect(cleanupScheduler.runCleanup()).rejects.toThrow(
      S3_CONNECTION_ERROR
    )
  })

  test('should log error details when deleteOldReviews fails', async () => {
    const mockError = new Error(S3_CONNECTION_ERROR)
    mockDeleteOldReviews.mockRejectedValueOnce(mockError)
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    await cleanupScheduler.runCleanup().catch(() => {})
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: mockError.message,
        retentionDays: DEFAULT_RETENTION_DAYS
      }),
      'Scheduled cleanup failed'
    )
  })

  test('should not update lastRunTime on failure', async () => {
    mockDeleteOldReviews.mockRejectedValueOnce(new Error('fail'))
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    const previousRunTime = cleanupScheduler.lastRunTime
    await cleanupScheduler.runCleanup().catch(() => {})
    expect(cleanupScheduler.lastRunTime).toBe(previousRunTime)
  })
})

// ============ cleanupScheduler.getStatus ============

describe('cleanupScheduler.getStatus', () => {
  beforeEach(() => {
    config.set(CONFIG_ENABLED, true)
    config.set(CONFIG_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS)
    config.set(CONFIG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)
  })

  test('should return correct status when not running', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.isRunning = false
    cleanupScheduler.lastRunTime = null
    cleanupScheduler.lastDeletedCount = 0
    const status = cleanupScheduler.getStatus()
    expect(status).toEqual({
      enabled: true,
      isRunning: false,
      intervalHours: DEFAULT_INTERVAL_HOURS,
      retentionDays: DEFAULT_RETENTION_DAYS,
      lastRunTime: null,
      lastDeletedCount: 0
    })
  })

  test('should return lastRunTime as ISO string when set', async () => {
    mockDeleteOldReviews.mockResolvedValueOnce(1)
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    await cleanupScheduler.runCleanup()
    const status = cleanupScheduler.getStatus()
    expect(typeof status.lastRunTime).toBe('string')
    expect(() => new Date(status.lastRunTime)).not.toThrow()
  })

  test('should return lastRunTime as null when never run', async () => {
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    cleanupScheduler.lastRunTime = null
    const status = cleanupScheduler.getStatus()
    expect(status.lastRunTime).toBeNull()
  })

  test('should reflect updated lastDeletedCount after cleanup', async () => {
    mockDeleteOldReviews.mockResolvedValueOnce(4)
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    await cleanupScheduler.runCleanup()
    const status = cleanupScheduler.getStatus()
    expect(status.lastDeletedCount).toBe(4)
  })

  test('should reflect config when disabled', async () => {
    config.set(CONFIG_ENABLED, false)
    const { cleanupScheduler } = await import('./cleanup-scheduler.js')
    const status = cleanupScheduler.getStatus()
    expect(status.enabled).toBe(false)
  })
})
