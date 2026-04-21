import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Constants ─────────────────────────────────────────────────────────────────
const S3_BUCKET = 'test-bucket'
const REVIEWS_PREFIX = 'reviews/'
const REVIEW_ID_1 = 'review_abc-123'
const REVIEW_ID_2 = 'review_def-456'
const REVIEW_KEY_1 = `${REVIEWS_PREFIX}${REVIEW_ID_1}.json`
const REVIEW_KEY_2 = `${REVIEWS_PREFIX}${REVIEW_ID_2}.json`
const CONTINUATION_TOKEN = 'token-xyz'
const DEFAULT_LIMIT = 20
const CUSTOM_LIMIT = 5
const STATUS_PENDING = 'pending'
const STATUS_COMPLETED = 'completed'
const LAST_MODIFIED_RECENT = new Date('2025-03-09T10:00:00Z')
const LAST_MODIFIED_OLDER = new Date('2025-03-08T10:00:00Z')
const KEY_COUNT_3 = 3
const KEY_COUNT_7 = 7
const YEAR_2025 = 2025
const MONTH_JAN = 0

const { MOCK_S3_SEND } = vi.hoisted(() => ({ MOCK_S3_SEND: vi.fn() }))

vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: vi.fn(function (input) {
    return input
  }),
  ListObjectsV2Command: vi.fn(function (input) {
    return { input }
  })
}))

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

import {
  getRecentReviews,
  getReviewCount
} from './review-repository-queries.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildReview(id, status = STATUS_PENDING, lastModified = new Date()) {
  return {
    reviewId: id,
    status,
    createdAt: new Date('2025-03-01T00:00:00Z').toISOString(),
    lastModified: lastModified.toISOString()
  }
}

function makeS3Body(review) {
  return {
    Body: {
      transformToString: vi.fn().mockResolvedValue(JSON.stringify(review))
    }
  }
}

function buildS3Object(key, lastModified) {
  return { Key: key, LastModified: lastModified }
}

// ── getRecentReviews() ────────────────────────────────────────────────────────

describe('getRecentReviews - empty bucket', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns empty reviews when Contents is empty', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({ Contents: [] })
    const result = await getRecentReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX
    )
    expect(result.reviews).toEqual([])
    expect(result.hasMore).toBe(false)
    expect(result.nextToken).toBeNull()
  })

  it('returns empty reviews when Contents is undefined', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})
    const result = await getRecentReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX
    )
    expect(result.reviews).toEqual([])
  })
})

describe('getRecentReviews - single review', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns one review from S3', async () => {
    const review = buildReview(REVIEW_ID_1)
    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: [buildS3Object(REVIEW_KEY_1, LAST_MODIFIED_RECENT)],
      IsTruncated: false
    })
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3Body(review))

    const result = await getRecentReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX
    )
    expect(result.reviews.length).toBe(1)
    expect(result.reviews[0].reviewId).toBe(REVIEW_ID_1)
  })

  it('sets lastModified from S3 object metadata', async () => {
    const review = buildReview(REVIEW_ID_1)
    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: [buildS3Object(REVIEW_KEY_1, LAST_MODIFIED_RECENT)],
      IsTruncated: false
    })
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3Body(review))

    const result = await getRecentReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX
    )
    expect(result.reviews[0].lastModified).toBe(
      LAST_MODIFIED_RECENT.toISOString()
    )
  })
})

describe('getRecentReviews - multiple reviews and sorting', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns reviews sorted most recent first', async () => {
    const reviewOld = buildReview(
      REVIEW_ID_2,
      STATUS_PENDING,
      LAST_MODIFIED_OLDER
    )
    const reviewNew = buildReview(
      REVIEW_ID_1,
      STATUS_COMPLETED,
      LAST_MODIFIED_RECENT
    )

    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: [
        buildS3Object(REVIEW_KEY_2, LAST_MODIFIED_OLDER),
        buildS3Object(REVIEW_KEY_1, LAST_MODIFIED_RECENT)
      ],
      IsTruncated: false
    })
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3Body(reviewNew))
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3Body(reviewOld))

    const result = await getRecentReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX
    )
    expect(result.reviews[0].reviewId).toBe(REVIEW_ID_1)
    expect(result.reviews[1].reviewId).toBe(REVIEW_ID_2)
  })

  it('respects custom limit option', async () => {
    const reviews = Array.from({ length: DEFAULT_LIMIT }, (_, i) =>
      buildReview(
        `review_${i}`,
        STATUS_PENDING,
        new Date(YEAR_2025, MONTH_JAN, i + 1)
      )
    )
    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: reviews.map((r, i) =>
        buildS3Object(
          `reviews/${r.reviewId}.json`,
          new Date(YEAR_2025, MONTH_JAN, i + 1)
        )
      ),
      IsTruncated: false
    })
    for (const r of reviews.slice(0, CUSTOM_LIMIT)) {
      MOCK_S3_SEND.mockResolvedValueOnce(makeS3Body(r))
    }

    const result = await getRecentReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX,
      { limit: CUSTOM_LIMIT }
    )
    expect(result.reviews.length).toBeLessThanOrEqual(CUSTOM_LIMIT)
  })
})

describe('getRecentReviews - pagination and errors', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns hasMore true when S3 list is truncated', async () => {
    const review = buildReview(REVIEW_ID_1)
    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: [buildS3Object(REVIEW_KEY_1, LAST_MODIFIED_RECENT)],
      IsTruncated: true,
      NextContinuationToken: CONTINUATION_TOKEN
    })
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3Body(review))

    const result = await getRecentReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX
    )
    expect(result.hasMore).toBe(true)
    expect(result.nextToken).toBe(CONTINUATION_TOKEN)
  })

  it('skips reviews that fail to load (returns null)', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: [buildS3Object(REVIEW_KEY_1, LAST_MODIFIED_RECENT)],
      IsTruncated: false
    })
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('S3 read error'))

    const result = await getRecentReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX
    )
    expect(result.reviews).toEqual([])
  })

  it('throws when listObjects call fails', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('List failed'))
    await expect(
      getRecentReviews({ send: MOCK_S3_SEND }, S3_BUCKET, REVIEWS_PREFIX)
    ).rejects.toThrow('List failed')
  })

  it('passes continuationToken to ListObjectsV2Command', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({ Contents: [] })
    await getRecentReviews({ send: MOCK_S3_SEND }, S3_BUCKET, REVIEWS_PREFIX, {
      continuationToken: CONTINUATION_TOKEN
    })
    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(1)
  })
})

// ── getReviewCount() ──────────────────────────────────────────────────────────

describe('getReviewCount - basic counts', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns count from a single page', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({
      KeyCount: KEY_COUNT_3,
      NextContinuationToken: null
    })
    const count = await getReviewCount(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX
    )
    expect(count).toBe(KEY_COUNT_3)
  })

  it('returns 0 when KeyCount is undefined', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})
    const count = await getReviewCount(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX
    )
    expect(count).toBe(0)
  })

  it('accumulates count across multiple pages', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({
      KeyCount: KEY_COUNT_3,
      NextContinuationToken: CONTINUATION_TOKEN
    })
    MOCK_S3_SEND.mockResolvedValueOnce({
      KeyCount: KEY_COUNT_7,
      NextContinuationToken: null
    })
    const count = await getReviewCount(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX
    )
    expect(count).toBe(KEY_COUNT_3 + KEY_COUNT_7)
  })

  it('throws when S3 call fails', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('S3 error'))
    await expect(
      getReviewCount({ send: MOCK_S3_SEND }, S3_BUCKET, REVIEWS_PREFIX)
    ).rejects.toThrow('S3 error')
  })
})

// ── sortReviewsByLastModified - fallback branches ─────────────────────────────
// These tests exercise the `a.updatedAt` and `a.createdAt` fallbacks inside
// sortReviewsByLastModified. When the S3 object has no LastModified,
// fetchSingleReview sets review.lastModified = undefined, causing the sort to
// fall through to updatedAt then createdAt.

describe('getRecentReviews - sortReviewsByLastModified fallback timestamps', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sorts by updatedAt when lastModified is absent from S3 object', async () => {
    const reviewOld = {
      reviewId: REVIEW_ID_2,
      status: STATUS_PENDING,
      updatedAt: LAST_MODIFIED_OLDER.toISOString()
    }
    const reviewNew = {
      reviewId: REVIEW_ID_1,
      status: STATUS_PENDING,
      updatedAt: LAST_MODIFIED_RECENT.toISOString()
    }

    // S3 objects without LastModified → review.lastModified will be set to undefined
    // Provide older review first so stable sort preserves that order, then
    // sortReviewsByLastModified re-sorts by updatedAt putting newer first
    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: [
        { Key: REVIEW_KEY_2 }, // no LastModified
        { Key: REVIEW_KEY_1 } // no LastModified
      ],
      IsTruncated: false
    })
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3Body(reviewOld))
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3Body(reviewNew))

    const result = await getRecentReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX
    )

    expect(result.reviews.length).toBe(2)
    expect(result.reviews[0].reviewId).toBe(REVIEW_ID_1)
    expect(result.reviews[1].reviewId).toBe(REVIEW_ID_2)
  })

  it('sorts by createdAt when both lastModified and updatedAt are absent', async () => {
    const reviewOld = {
      reviewId: REVIEW_ID_2,
      status: STATUS_PENDING,
      createdAt: LAST_MODIFIED_OLDER.toISOString()
    }
    const reviewNew = {
      reviewId: REVIEW_ID_1,
      status: STATUS_PENDING,
      createdAt: LAST_MODIFIED_RECENT.toISOString()
    }

    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: [
        { Key: REVIEW_KEY_2 }, // no LastModified
        { Key: REVIEW_KEY_1 } // no LastModified
      ],
      IsTruncated: false
    })
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3Body(reviewOld))
    MOCK_S3_SEND.mockResolvedValueOnce(makeS3Body(reviewNew))

    const result = await getRecentReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX
    )

    expect(result.reviews.length).toBe(2)
    expect(result.reviews[0].reviewId).toBe(REVIEW_ID_1)
    expect(result.reviews[1].reviewId).toBe(REVIEW_ID_2)
  })
})
