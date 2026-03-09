import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Constants ─────────────────────────────────────────────────────────────────
const S3_BUCKET = 'test-bucket'
const REVIEWS_PREFIX = 'reviews/'
const REVIEW_ID = 'review_abc-123'
const S3_CONTENT_KEY = `uploads/${REVIEW_ID}/document.pdf`
const S3_REVIEW_KEY = `${REVIEWS_PREFIX}${REVIEW_ID}.json`
const MAX_AGE_DAYS = 30
const ZERO_DAYS = 0
const FILES_DELETED_COUNT = 2
const REVIEW_ID_OLD = 'review_old-001'
const REVIEW_ID_NO_ID = 'review_noid'
const OLD_REVIEW_DATE = new Date('2024-01-01').toISOString()
const VERY_OLD_DATE = new Date('2020-01-01').toISOString()
const YESTERDAY_DATE = new Date('2025-03-08').toISOString()

const { MOCK_S3_SEND } = vi.hoisted(() => ({ MOCK_S3_SEND: vi.fn() }))

vi.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: vi.fn(function (input) {
    return input
  }),
  ListObjectsV2Command: vi.fn(function (input) {
    return input
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
  deleteUploadedContent,
  deleteReviewMetadataFile,
  deleteSingleOldReview,
  deleteOldReviews
} from './review-repository-deletion.js'

// ── deleteUploadedContent() ───────────────────────────────────────────────────

describe('deleteUploadedContent - success', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls S3 send with DeleteObjectCommand', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})
    const deletedKeys = []
    await deleteUploadedContent(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEW_ID,
      S3_CONTENT_KEY,
      deletedKeys
    )
    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(1)
  })

  it('pushes s3Key to deletedKeys array on success', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})
    const deletedKeys = []
    await deleteUploadedContent(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEW_ID,
      S3_CONTENT_KEY,
      deletedKeys
    )
    expect(deletedKeys).toContain(S3_CONTENT_KEY)
  })
})

describe('deleteUploadedContent - failure', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not throw when S3 delete fails', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('S3 error'))
    const deletedKeys = []
    await expect(
      deleteUploadedContent(
        { send: MOCK_S3_SEND },
        S3_BUCKET,
        REVIEW_ID,
        S3_CONTENT_KEY,
        deletedKeys
      )
    ).resolves.not.toThrow()
  })

  it('does not push key to deletedKeys when delete fails', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('S3 error'))
    const deletedKeys = []
    await deleteUploadedContent(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEW_ID,
      S3_CONTENT_KEY,
      deletedKeys
    )
    expect(deletedKeys).not.toContain(S3_CONTENT_KEY)
  })
})

// ── deleteReviewMetadataFile() ────────────────────────────────────────────────

describe('deleteReviewMetadataFile', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls S3 send once', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})
    const deletedKeys = []
    await deleteReviewMetadataFile(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      S3_REVIEW_KEY,
      REVIEW_ID,
      deletedKeys
    )
    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(1)
  })

  it('pushes reviewKey to deletedKeys', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({})
    const deletedKeys = []
    await deleteReviewMetadataFile(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      S3_REVIEW_KEY,
      REVIEW_ID,
      deletedKeys
    )
    expect(deletedKeys).toContain(S3_REVIEW_KEY)
  })

  it('propagates errors from S3', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('Delete failed'))
    await expect(
      deleteReviewMetadataFile(
        { send: MOCK_S3_SEND },
        S3_BUCKET,
        S3_REVIEW_KEY,
        REVIEW_ID,
        []
      )
    ).rejects.toThrow('Delete failed')
  })
})

// ── deleteSingleOldReview() ───────────────────────────────────────────────────

describe('deleteSingleOldReview - success', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns true when review files are deleted', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: [
        { Key: `${REVIEWS_PREFIX}${REVIEW_ID_OLD}/file1.json` },
        { Key: `${REVIEWS_PREFIX}${REVIEW_ID_OLD}/file2.pdf` }
      ]
    })
    MOCK_S3_SEND.mockResolvedValue({})

    const review = {
      reviewId: REVIEW_ID_OLD,
      createdAt: OLD_REVIEW_DATE
    }
    const deleted = await deleteSingleOldReview(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX,
      review
    )
    expect(deleted).toBe(true)
    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(FILES_DELETED_COUNT + 1)
  })

  it('returns false when no Contents found in S3', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({ Contents: [] })
    const review = {
      reviewId: REVIEW_ID_OLD,
      createdAt: OLD_REVIEW_DATE
    }
    const deleted = await deleteSingleOldReview(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX,
      review
    )
    expect(deleted).toBe(false)
  })

  it('uses review.id when reviewId is absent', async () => {
    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: [{ Key: `${REVIEWS_PREFIX}${REVIEW_ID_OLD}/meta.json` }]
    })
    MOCK_S3_SEND.mockResolvedValueOnce({})

    const review = {
      id: REVIEW_ID_OLD,
      createdAt: OLD_REVIEW_DATE
    }
    const deleted = await deleteSingleOldReview(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX,
      review
    )
    expect(deleted).toBe(true)
  })
})

describe('deleteSingleOldReview - edge cases', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns false when review has no id or reviewId', async () => {
    const review = { createdAt: OLD_REVIEW_DATE }
    const deleted = await deleteSingleOldReview(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX,
      review
    )
    expect(deleted).toBe(false)
  })

  it('returns false when S3 throws during list', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('List error'))
    const review = {
      reviewId: REVIEW_ID_NO_ID,
      createdAt: OLD_REVIEW_DATE
    }
    const deleted = await deleteSingleOldReview(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX,
      review
    )
    expect(deleted).toBe(false)
  })
})

// ── deleteOldReviews() ────────────────────────────────────────────────────────

describe('deleteOldReviews - no cleanup needed', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 0 when no reviews are older than cutoff', async () => {
    const freshReview = {
      reviewId: REVIEW_ID,
      createdAt: new Date().toISOString()
    }
    const getRecentReviewsFn = vi.fn().mockResolvedValue({
      reviews: [freshReview]
    })
    const count = await deleteOldReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX,
      getRecentReviewsFn,
      MAX_AGE_DAYS
    )
    expect(count).toBe(0)
  })

  it('returns 0 when review list is empty', async () => {
    const getRecentReviewsFn = vi.fn().mockResolvedValue({ reviews: [] })
    const count = await deleteOldReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX,
      getRecentReviewsFn,
      MAX_AGE_DAYS
    )
    expect(count).toBe(0)
  })
})

describe('deleteOldReviews - with old reviews', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes reviews older than maxAgeInDays', async () => {
    const oldReview = {
      reviewId: REVIEW_ID_OLD,
      createdAt: VERY_OLD_DATE
    }
    const getRecentReviewsFn = vi.fn().mockResolvedValue({
      reviews: [oldReview]
    })
    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: [{ Key: `${REVIEWS_PREFIX}${REVIEW_ID_OLD}/meta.json` }]
    })
    MOCK_S3_SEND.mockResolvedValueOnce({})

    const count = await deleteOldReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX,
      getRecentReviewsFn,
      MAX_AGE_DAYS
    )
    expect(count).toBe(1)
  })

  it('uses uploadedAt when createdAt is absent', async () => {
    const oldReview = {
      reviewId: REVIEW_ID_OLD,
      uploadedAt: VERY_OLD_DATE
    }
    const getRecentReviewsFn = vi.fn().mockResolvedValue({
      reviews: [oldReview]
    })
    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: [{ Key: `${REVIEWS_PREFIX}${REVIEW_ID_OLD}/meta.json` }]
    })
    MOCK_S3_SEND.mockResolvedValueOnce({})

    const count = await deleteOldReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX,
      getRecentReviewsFn,
      MAX_AGE_DAYS
    )
    expect(count).toBe(1)
  })

  it('uses default maxAgeInDays of 30 when not provided', async () => {
    const getRecentReviewsFn = vi.fn().mockResolvedValue({ reviews: [] })
    const count = await deleteOldReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX,
      getRecentReviewsFn
    )
    expect(count).toBe(0)
  })

  it('deletes all reviews when maxAgeInDays is 0', async () => {
    const review = {
      reviewId: REVIEW_ID_OLD,
      createdAt: YESTERDAY_DATE
    }
    const getRecentReviewsFn = vi.fn().mockResolvedValue({ reviews: [review] })
    MOCK_S3_SEND.mockResolvedValueOnce({
      Contents: [{ Key: `${REVIEWS_PREFIX}${REVIEW_ID_OLD}/meta.json` }]
    })
    MOCK_S3_SEND.mockResolvedValueOnce({})

    const count = await deleteOldReviews(
      { send: MOCK_S3_SEND },
      S3_BUCKET,
      REVIEWS_PREFIX,
      getRecentReviewsFn,
      ZERO_DAYS
    )
    expect(count).toBe(1)
  })
})

describe('deleteOldReviews - error handling', () => {
  beforeEach(() => vi.clearAllMocks())

  it('throws when getRecentReviewsFn fails', async () => {
    const getRecentReviewsFn = vi
      .fn()
      .mockRejectedValue(new Error('Fetch failed'))
    await expect(
      deleteOldReviews(
        { send: MOCK_S3_SEND },
        S3_BUCKET,
        REVIEWS_PREFIX,
        getRecentReviewsFn,
        MAX_AGE_DAYS
      )
    ).rejects.toThrow('Fetch failed')
  })
})
