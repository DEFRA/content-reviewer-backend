import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  TokenRateLimiter,
  getTokenRateLimiter,
  _setTokenRateLimiterInstance
} from './token-rate-limiter.js'

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

// ─── Constants ────────────────────────────────────────────────────────────────

const WINDOW_MS = 60_000
const POLL_INTERVAL_MS = 500
const BUDGET_100 = 100
const BUDGET_1000 = 1000

// ─── _currentUsage ────────────────────────────────────────────────────────────

describe('TokenRateLimiter - _currentUsage', () => {
  let limiter

  beforeEach(() => {
    limiter = new TokenRateLimiter(BUDGET_100)
  })

  test('returns 0 when there are no entries', () => {
    expect(limiter._currentUsage()).toBe(0)
  })

  test('sums tokens from all fresh entries', () => {
    const now = Date.now()
    limiter._entries = [
      { tokens: 30, timestamp: now },
      { tokens: 40, timestamp: now - 1000 }
    ]
    expect(limiter._currentUsage()).toBe(70)
  })

  test('evicts entries older than the 60-second window', () => {
    const now = Date.now()
    limiter._entries = [
      { tokens: 50, timestamp: now - WINDOW_MS - 1 }, // expired
      { tokens: 20, timestamp: now - 1000 } // fresh
    ]
    expect(limiter._currentUsage()).toBe(20)
    expect(limiter._entries).toHaveLength(1)
  })

  test('returns 0 after all entries have expired', () => {
    const now = Date.now()
    limiter._entries = [{ tokens: 50, timestamp: now - WINDOW_MS - 1 }]
    expect(limiter._currentUsage()).toBe(0)
    expect(limiter._entries).toHaveLength(0)
  })
})

// ─── _calcWaitMs ─────────────────────────────────────────────────────────────

describe('TokenRateLimiter - _calcWaitMs', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('returns time until the oldest entry that frees sufficient budget expires', () => {
    vi.useFakeTimers({ now: 1000 })
    const limiter = new TokenRateLimiter(BUDGET_100)
    // Entry from 30s ago — expires in 30s
    limiter._entries = [{ tokens: 60, timestamp: -29_000 }]
    // usage=60, tokens=50: freed=60 → 60-60+50=50 ≤ 100 → that entry is enough
    // expiresIn = -29000 + 60000 - 1000 = 30000 → waitMs = 30100
    const waitMs = limiter._calcWaitMs(50, 60)
    expect(waitMs).toBe(30100)
  })

  test('adds 100ms buffer to the calculated expiry time', () => {
    vi.useFakeTimers({ now: 0 })
    const limiter = new TokenRateLimiter(BUDGET_100)
    // Entry expires in exactly WINDOW_MS (60s from now)
    limiter._entries = [{ tokens: 100, timestamp: 0 }]
    const waitMs = limiter._calcWaitMs(50, 100)
    // expiresIn = 0 + 60000 - 0 = 60000 → waitMs = 60100
    expect(waitMs).toBe(60100)
  })

  test('returns POLL_INTERVAL_MS when no single entry can free enough budget', () => {
    vi.useFakeTimers({ now: 0 })
    const limiter = new TokenRateLimiter(BUDGET_100)
    // Requesting more than the total budget: even freeing all entries won't help
    limiter._entries = [{ tokens: 100, timestamp: 0 }]
    // tokens=200 > budget=100: freed=100 → 100-100+200=200 > 100 → not freed
    const waitMs = limiter._calcWaitMs(200, 100)
    expect(waitMs).toBe(POLL_INTERVAL_MS)
  })
})

// ─── _enqueue priority ordering ──────────────────────────────────────────────

describe('TokenRateLimiter - _enqueue priority ordering', () => {
  let limiter
  const noop = () => {}

  beforeEach(() => {
    limiter = new TokenRateLimiter(BUDGET_1000)
  })

  test('appends a high-priority item to an empty queue', () => {
    limiter._enqueue({
      tokens: 50,
      label: 'h1',
      priority: 'high',
      resolve: noop
    })
    expect(limiter._queue).toHaveLength(1)
    expect(limiter._queue[0].label).toBe('h1')
  })

  test('appends a normal-priority item to an empty queue', () => {
    limiter._enqueue({
      tokens: 50,
      label: 'n1',
      priority: 'normal',
      resolve: noop
    })
    expect(limiter._queue).toHaveLength(1)
    expect(limiter._queue[0].label).toBe('n1')
  })

  test('inserts high item before all normal items', () => {
    limiter._queue = [
      { tokens: 50, label: 'n1', priority: 'normal', resolve: noop },
      { tokens: 50, label: 'n2', priority: 'normal', resolve: noop }
    ]
    limiter._enqueue({
      tokens: 50,
      label: 'h1',
      priority: 'high',
      resolve: noop
    })
    expect(limiter._queue.map((q) => q.label)).toEqual(['h1', 'n1', 'n2'])
  })

  test('appends high item after existing high items when no normals are queued', () => {
    limiter._queue = [
      { tokens: 50, label: 'h1', priority: 'high', resolve: noop },
      { tokens: 50, label: 'h2', priority: 'high', resolve: noop }
    ]
    limiter._enqueue({
      tokens: 50,
      label: 'h3',
      priority: 'high',
      resolve: noop
    })
    expect(limiter._queue.map((q) => q.label)).toEqual(['h1', 'h2', 'h3'])
  })

  test('inserts high item after existing high items but before normals (mixed queue)', () => {
    limiter._queue = [
      { tokens: 50, label: 'h1', priority: 'high', resolve: noop },
      { tokens: 50, label: 'n1', priority: 'normal', resolve: noop },
      { tokens: 50, label: 'n2', priority: 'normal', resolve: noop }
    ]
    limiter._enqueue({
      tokens: 50,
      label: 'h2',
      priority: 'high',
      resolve: noop
    })
    expect(limiter._queue.map((q) => q.label)).toEqual(['h1', 'h2', 'n1', 'n2'])
  })

  test('appends a normal item to the end of a mixed queue', () => {
    limiter._queue = [
      { tokens: 50, label: 'h1', priority: 'high', resolve: noop },
      { tokens: 50, label: 'n1', priority: 'normal', resolve: noop }
    ]
    limiter._enqueue({
      tokens: 50,
      label: 'n2',
      priority: 'normal',
      resolve: noop
    })
    expect(limiter._queue.map((q) => q.label)).toEqual(['h1', 'n1', 'n2'])
  })
})

// ─── acquire — immediate resolution ─────────────────────────────────────────

describe('TokenRateLimiter - acquire - immediate resolution', () => {
  let limiter

  beforeEach(() => {
    limiter = new TokenRateLimiter(BUDGET_100)
  })

  test('resolves immediately when there is sufficient budget', async () => {
    await expect(limiter.acquire(50, 'req1')).resolves.toBeUndefined()
  })

  test('records entry in _entries after acquiring', async () => {
    await limiter.acquire(50, 'req1')
    expect(limiter._entries).toHaveLength(1)
    expect(limiter._entries[0].tokens).toBe(50)
    expect(limiter._entries[0].timestamp).toBeGreaterThan(0)
  })

  test('two concurrent acquires both resolve when combined tokens fit within budget', async () => {
    await Promise.all([
      limiter.acquire(40, 'req1'),
      limiter.acquire(40, 'req2')
    ])
    expect(limiter._entries).toHaveLength(2)
    expect(limiter.getStatus().usedTokens).toBe(80)
  })

  test('uses normal priority by default when no priority argument is passed', async () => {
    // acquire with default priority must resolve — just verify it does not throw
    await expect(limiter.acquire(10, 'req-default')).resolves.toBeUndefined()
  })
})

// ─── acquire — throttling behaviour (fake timers) ────────────────────────────

describe('TokenRateLimiter - acquire - throttling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('blocks when the budget is exhausted and resolves once entries expire', async () => {
    vi.useFakeTimers({ now: 0 })
    const limiter = new TokenRateLimiter(BUDGET_100)
    // Exhaust the budget manually
    limiter._entries.push({ tokens: BUDGET_100, timestamp: 0 })

    let resolved = false
    const done = limiter.acquire(50, 'throttled').then(() => {
      resolved = true
    })

    // Not yet resolved — budget is full
    expect(resolved).toBe(false)

    // Advance past window expiry + buffer (60s + 100ms + small slack)
    await vi.advanceTimersByTimeAsync(61_000)
    await done

    expect(resolved).toBe(true)
  })

  test('high-priority request resolves before normal when both are waiting for budget', async () => {
    vi.useFakeTimers({ now: 0 })
    const limiter = new TokenRateLimiter(BUDGET_100)
    // Exhaust the budget
    limiter._entries.push({ tokens: BUDGET_100, timestamp: 0 })

    const resolved = []

    // Queue normal first — drain loop starts and waits on its timer
    const normalDone = limiter
      .acquire(50, 'new_review_chunk_1', 'normal')
      .then(() => resolved.push('normal'))

    // Queue high second — inserted before normal in the queue by _enqueue
    const highDone = limiter
      .acquire(50, 'existing_review_chunk_2', 'high')
      .then(() => resolved.push('high'))

    // Advance past window expiry so the drain loop wakes and drains the queue
    await vi.advanceTimersByTimeAsync(61_000)
    await Promise.all([normalDone, highDone])

    // High must have been resolved first
    expect(resolved).toEqual(['high', 'normal'])
  })
})

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('TokenRateLimiter - getStatus', () => {
  let limiter

  beforeEach(() => {
    limiter = new TokenRateLimiter(BUDGET_100)
  })

  test('returns correct snapshot when no tokens have been acquired', () => {
    const status = limiter.getStatus()
    expect(status.usedTokens).toBe(0)
    expect(status.maxTokensPerMinute).toBe(BUDGET_100)
    expect(status.remainingTokens).toBe(BUDGET_100)
    expect(status.windowMs).toBe(WINDOW_MS)
    expect(status.entryCount).toBe(0)
    expect(status.queueLength).toBe(0)
    expect(status.queuedHigh).toBe(0)
    expect(status.queuedNormal).toBe(0)
  })

  test('reflects tokens used and pending queue items correctly', async () => {
    // Acquire some tokens first
    await limiter.acquire(30, 'a')

    // Manually add a queued item to inspect queue stats
    const noop = () => {}
    limiter._queue.push({
      tokens: 20,
      label: 'h',
      priority: 'high',
      resolve: noop
    })
    limiter._queue.push({
      tokens: 20,
      label: 'n',
      priority: 'normal',
      resolve: noop
    })

    const status = limiter.getStatus()
    expect(status.usedTokens).toBe(30)
    expect(status.remainingTokens).toBe(70)
    expect(status.queueLength).toBe(2)
    expect(status.queuedHigh).toBe(1)
    expect(status.queuedNormal).toBe(1)
  })
})

// ─── Singleton ────────────────────────────────────────────────────────────────

describe('getTokenRateLimiter singleton', () => {
  beforeEach(() => {
    // Reset singleton so each test starts fresh
    _setTokenRateLimiterInstance(null)
  })

  afterEach(() => {
    _setTokenRateLimiterInstance(null)
  })

  test('creates a new TokenRateLimiter instance on first call', () => {
    const instance = getTokenRateLimiter(45_000)
    expect(instance).toBeInstanceOf(TokenRateLimiter)
    expect(instance.maxTokensPerMinute).toBe(45_000)
  })

  test('returns the same instance on subsequent calls', () => {
    const first = getTokenRateLimiter(45_000)
    const second = getTokenRateLimiter(45_000)
    expect(first).toBe(second)
  })

  test('ignores maxTokensPerMinute argument if instance already exists', () => {
    const first = getTokenRateLimiter(45_000)
    const second = getTokenRateLimiter(99_999)
    expect(second).toBe(first)
    expect(second.maxTokensPerMinute).toBe(45_000)
  })

  test('_setTokenRateLimiterInstance replaces the singleton so next call creates a fresh one', () => {
    const original = getTokenRateLimiter(45_000)
    _setTokenRateLimiterInstance(null)
    const replacement = getTokenRateLimiter(30_000)
    expect(replacement).not.toBe(original)
    expect(replacement.maxTokensPerMinute).toBe(30_000)
  })
})
