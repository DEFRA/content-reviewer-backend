import { createLogger } from '../logging/logger.js'

const logger = createLogger()

const WINDOW_MS = 60_000 // 1-minute sliding window
const POLL_INTERVAL_MS = 500 // minimum re-check interval when budget is exhausted

/**
 * Sliding-window token rate limiter with priority queuing.
 *
 * Enforces a hard cap of `maxTokensPerMinute` across all concurrent Bedrock
 * calls within any rolling 60-second window.
 *
 * Priority lanes ensure that continuation chunks of an in-progress review
 * are never blocked by the first chunk of a new review:
 *
 *   'high'   — chunks 2+ of a review already in flight (continuation)
 *   'normal' — chunk 1 of a new review (start)
 *
 * A single serialized drain loop processes the queue so that 'high' items
 * always drain before 'normal' items and there are no concurrent-poll races.
 *
 * Usage:
 *   await limiter.acquire(tokens, label, 'high')   // continuation chunk
 *   await limiter.acquire(tokens, label, 'normal') // first chunk of new review
 */
export class TokenRateLimiter {
  /** @param {number} maxTokensPerMinute */
  constructor(maxTokensPerMinute) {
    this.maxTokensPerMinute = maxTokensPerMinute
    // Sliding-window entries: { tokens: number, timestamp: number }[]
    this._entries = []
    // Pending requests: { tokens, label, priority, resolve }[]
    this._queue = []
    // Whether the drain loop is currently running
    this._draining = false
  }

  /** Evict expired entries and return current window token total. */
  _currentUsage() {
    const cutoff = Date.now() - WINDOW_MS
    this._entries = this._entries.filter((e) => e.timestamp > cutoff)
    return this._entries.reduce((sum, e) => sum + e.tokens, 0)
  }

  /**
   * Calculate how long to wait until `tokens` fit within the budget.
   * Walks the oldest entries in the window to find the minimum expiry
   * that frees enough capacity.
   * @param {number} tokens
   * @param {number} currentUsage
   * @returns {number} milliseconds to wait
   */
  _calcWaitMs(tokens, currentUsage) {
    const sorted = [...this._entries].sort((a, b) => a.timestamp - b.timestamp)
    let freed = 0
    for (const entry of sorted) {
      freed += entry.tokens
      if (currentUsage - freed + tokens <= this.maxTokensPerMinute) {
        const expiresIn = entry.timestamp + WINDOW_MS - Date.now()
        return Math.max(expiresIn + 100, POLL_INTERVAL_MS) // +100 ms buffer
      }
    }
    return POLL_INTERVAL_MS
  }

  /**
   * Enqueue `item` respecting priority.
   * 'high' items are inserted after all existing 'high' items but before
   * any 'normal' items, preserving FIFO within each priority lane.
   * @param {{ tokens, label, priority, resolve }} item
   */
  _enqueue(item) {
    if (item.priority === 'high') {
      // Find insertion point: after the last 'high' item (before first 'normal')
      const firstNormal = this._queue.findIndex((q) => q.priority === 'normal')
      if (firstNormal === -1) {
        this._queue.push(item)
      } else {
        this._queue.splice(firstNormal, 0, item)
      }
    } else {
      this._queue.push(item)
    }
  }

  /**
   * Single serialized drain loop.  Processes the queue one item at a time so
   * there are no concurrent-poll races and priority order is strictly honoured.
   * Sleeps intelligently when the budget is exhausted.
   */
  async _drainLoop() {
    this._draining = true

    while (this._queue.length > 0) {
      const next = this._queue[0]
      const usage = this._currentUsage()

      if (usage + next.tokens <= this.maxTokensPerMinute) {
        this._queue.shift()
        this._entries.push({
          tokens: next.tokens,
          timestamp: Date.now(),
          label: next.label
        })

        logger.info(
          {
            label: next.label,
            priority: next.priority,
            requestedTokens: next.tokens,
            windowUsedTokens: usage,
            afterAcquireTokens: usage + next.tokens,
            limitTokens: this.maxTokensPerMinute,
            queueRemaining: this._queue.length
          },
          `[RATE-LIMITER] Acquired ${next.tokens} tokens for ${next.label} [${next.priority}] (${usage + next.tokens}/${this.maxTokensPerMinute} TPM)`
        )

        next.resolve()
      } else {
        const waitMs = this._calcWaitMs(next.tokens, usage)

        logger.warn(
          {
            label: next.label,
            priority: next.priority,
            requestedTokens: next.tokens,
            windowUsedTokens: usage,
            limitTokens: this.maxTokensPerMinute,
            queueLength: this._queue.length,
            waitMs
          },
          `[RATE-LIMITER] TPM quota near limit — throttling ${next.label} [${next.priority}], waiting ${waitMs}ms`
        )

        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
    }

    this._draining = false
  }

  /**
   * Block until `tokens` can be consumed without exceeding the per-minute cap.
   * Records the reservation immediately before returning.
   *
   * @param {number} tokens    - Estimated tokens for the upcoming Bedrock request
   * @param {string} [label]   - Label for log messages (e.g. reviewId_chunk_2)
   * @param {'high'|'normal'} [priority]
   *   'high'   = continuation chunk of an in-progress review (default for chunks 2+)
   *   'normal' = first chunk of a new review
   */
  async acquire(tokens, label = 'request', priority = 'normal') {
    return new Promise((resolve) => {
      this._enqueue({ tokens, label, priority, resolve })
      if (!this._draining) {
        this._drainLoop()
      }
    })
  }

  /**
   * Update the recorded reservation for a completed request with its actual
   * token usage, freeing any over-reserved tokens back into the window budget.
   *
   * Call this immediately after a successful Bedrock response so that the
   * next queued chunk can use the freed capacity without waiting for the
   * 60-second window to expire.
   *
   * @param {string} label       - Same label used in the acquire() call
   * @param {number} actualTokens - Actual total tokens reported by Bedrock usage
   */
  release(label, actualTokens) {
    if (actualTokens == null || !label) return
    const entry = this._entries.find((e) => e.label === label)
    if (!entry || actualTokens >= entry.tokens) return

    const freed = entry.tokens - actualTokens
    logger.info(
      {
        label,
        reservedTokens: entry.tokens,
        actualTokens,
        freedTokens: freed
      },
      `[RATE-LIMITER] Released ${freed} tokens for ${label} (reserved: ${entry.tokens}, actual: ${actualTokens})`
    )
    entry.tokens = actualTokens
  }

  /** Current snapshot for status/monitoring endpoints. */
  getStatus() {
    const usage = this._currentUsage()
    return {
      usedTokens: usage,
      maxTokensPerMinute: this.maxTokensPerMinute,
      remainingTokens: Math.max(0, this.maxTokensPerMinute - usage),
      windowMs: WINDOW_MS,
      entryCount: this._entries.length,
      queueLength: this._queue.length,
      queuedHigh: this._queue.filter((q) => q.priority === 'high').length,
      queuedNormal: this._queue.filter((q) => q.priority === 'normal').length
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────
// One shared limiter per worker process so all concurrent reviews
// draw from the same token budget.

let _instance = null

/**
 * Return (or lazily create) the singleton rate limiter.
 * @param {number} maxTokensPerMinute
 */
export function getTokenRateLimiter(maxTokensPerMinute = 45_000) {
  if (!_instance) {
    _instance = new TokenRateLimiter(maxTokensPerMinute)
    logger.info(
      { maxTokensPerMinute },
      '[RATE-LIMITER] Token rate limiter initialised'
    )
  }
  return _instance
}

/**
 * Replace the singleton — for unit tests only.
 * @param {TokenRateLimiter|null} instance
 */
export function _setTokenRateLimiterInstance(instance) {
  _instance = instance
}
