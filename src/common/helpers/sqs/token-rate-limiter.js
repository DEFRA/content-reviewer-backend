import { createLogger } from '../logging/logger.js'

const logger = createLogger()

const WINDOW_MS = 60_000 // 1-minute sliding window
const POLL_INTERVAL_MS = 500 // how often to re-check when waiting

/**
 * Sliding-window token rate limiter.
 *
 * Tracks estimated Bedrock token usage across all concurrent reviews and
 * enforces a hard cap of `maxTokensPerMinute` within any rolling 60-second
 * window.  This prevents the CDP shared Bedrock quota from being exhausted
 * when multiple chunked reviews run concurrently.
 *
 * Usage:
 *   const limiter = getTokenRateLimiter()
 *   await limiter.acquire(estimatedTokens, 'review_xxx_chunk_1')
 *   // ... call Bedrock ...
 */
export class TokenRateLimiter {
  /**
   * @param {number} maxTokensPerMinute
   */
  constructor(maxTokensPerMinute) {
    this.maxTokensPerMinute = maxTokensPerMinute
    // Each entry: { tokens: number, timestamp: number }
    this._entries = []
  }

  /** Evict expired entries and return current window token total. */
  _currentUsage() {
    const cutoff = Date.now() - WINDOW_MS
    this._entries = this._entries.filter((e) => e.timestamp > cutoff)
    return this._entries.reduce((sum, e) => sum + e.tokens, 0)
  }

  /**
   * Block until `tokens` can be consumed without exceeding the per-minute cap.
   * Records the reservation immediately on return so subsequent callers see it.
   *
   * @param {number} tokens - Estimated tokens for the upcoming Bedrock request
   * @param {string} [label] - Optional label for log messages (e.g. reviewId)
   */
  async acquire(tokens, label = 'request') {
    while (true) {
      const usage = this._currentUsage()
      const wouldUse = usage + tokens

      if (wouldUse <= this.maxTokensPerMinute) {
        this._entries.push({ tokens, timestamp: Date.now() })
        logger.info(
          {
            label,
            requestedTokens: tokens,
            windowUsedTokens: usage,
            afterAcquireTokens: wouldUse,
            limitTokens: this.maxTokensPerMinute
          },
          `[RATE-LIMITER] Acquired ${tokens} tokens for ${label} (${wouldUse}/${this.maxTokensPerMinute} TPM)`
        )
        return
      }

      // Calculate the minimum wait: find the oldest entry whose expiry
      // would free enough budget, then sleep until it expires.
      const sorted = [...this._entries].sort(
        (a, b) => a.timestamp - b.timestamp
      )
      let freed = 0
      let waitMs = POLL_INTERVAL_MS

      for (const entry of sorted) {
        freed += entry.tokens
        if (usage - freed + tokens <= this.maxTokensPerMinute) {
          const expiresIn = entry.timestamp + WINDOW_MS - Date.now()
          waitMs = Math.max(expiresIn + 100, POLL_INTERVAL_MS) // +100 ms buffer
          break
        }
      }

      logger.warn(
        {
          label,
          requestedTokens: tokens,
          windowUsedTokens: usage,
          limitTokens: this.maxTokensPerMinute,
          waitMs
        },
        `[RATE-LIMITER] TPM quota near limit — throttling ${label}, waiting ${waitMs}ms`
      )

      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }

  /** Current snapshot for status/monitoring endpoints. */
  getStatus() {
    const usage = this._currentUsage()
    return {
      usedTokens: usage,
      maxTokensPerMinute: this.maxTokensPerMinute,
      remainingTokens: Math.max(0, this.maxTokensPerMinute - usage),
      windowMs: WINDOW_MS,
      entryCount: this._entries.length
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
