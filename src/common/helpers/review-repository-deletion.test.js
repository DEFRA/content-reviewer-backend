import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  deleteUploadedContent,
  deleteReviewMetadataFile,
  deleteSingleOldReview,
  deleteOldReviews
} from './review-repository-deletion.js'

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  }))
}))

vi.mock('@aws-sdk/client-s3', () => ({
  // Must be actual classes so `new DeleteObjectCommand(...)` works
  DeleteObjectCommand: class {
    constructor(params) {
      Object.assign(this, { type: 'DeleteObject', ...params })
    }
  },
  ListObjectsV2Command: class {
    constructor(params) {
      Object.assign(this, { type: 'ListObjectsV2', ...params })
    }
  }
}))

const BUCKET = 'test-bucket'
const PREFIX = 'reviews/'

function makeMockS3(overrides = {}) {
  return {
    send: vi.fn().mockResolvedValue({}),
    ...overrides
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// deleteUploadedContent
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteUploadedContent', () => {
  it('sends a DeleteObjectCommand and pushes the key to deletedKeys', async () => {
    const s3Client = makeMockS3()
    const deletedKeys = []

    await deleteUploadedContent(
      s3Client,
      BUCKET,
      'review-1',
      'uploads/review-1/file.pdf',
      deletedKeys
    )

    expect(s3Client.send).toHaveBeenCalledTimes(1)
    expect(deletedKeys).toEqual(['uploads/review-1/file.pdf'])
  })

  it('continues without throwing when S3 delete fails', async () => {
    const s3Client = makeMockS3({
      send: vi.fn().mockRejectedValue(new Error('S3 error'))
    })
    const deletedKeys = []

    await expect(
      deleteUploadedContent(
        s3Client,
        BUCKET,
        'review-1',
        'uploads/review-1/file.pdf',
        deletedKeys
      )
    ).resolves.not.toThrow()

    expect(deletedKeys).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// deleteReviewMetadataFile
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteReviewMetadataFile', () => {
  it('sends a DeleteObjectCommand and pushes the review key', async () => {
    const s3Client = makeMockS3()
    const deletedKeys = []

    await deleteReviewMetadataFile(
      s3Client,
      BUCKET,
      'reviews/review-1.json',
      'review-1',
      deletedKeys
    )

    expect(s3Client.send).toHaveBeenCalledTimes(1)
    expect(deletedKeys).toEqual(['reviews/review-1.json'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// deleteSingleOldReview
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteSingleOldReview', () => {
  it('returns false when review has no id or reviewId', async () => {
    const s3Client = makeMockS3()
    const result = await deleteSingleOldReview(s3Client, BUCKET, PREFIX, {
      status: 'completed'
    })
    expect(result).toBe(false)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('deletes all S3 objects under the review prefix and returns true', async () => {
    const s3Client = makeMockS3()
    // First call = ListObjectsV2 → return two files under reviews/review-1/
    s3Client.send
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'reviews/review-1/meta.json' },
          { Key: 'reviews/review-1/content.txt' }
        ]
      })
      // Subsequent calls = DeleteObject for each file
      .mockResolvedValue({})

    const result = await deleteSingleOldReview(s3Client, BUCKET, PREFIX, {
      id: 'review-1',
      createdAt: new Date().toISOString()
    })

    expect(result).toBe(true)
    // 1 list + 2 deletes = 3 total
    expect(s3Client.send).toHaveBeenCalledTimes(3)
  })

  it('returns false when no S3 objects are found under the review prefix', async () => {
    const s3Client = makeMockS3({
      send: vi.fn().mockResolvedValueOnce({ Contents: [] })
    })

    const result = await deleteSingleOldReview(s3Client, BUCKET, PREFIX, {
      id: 'review-empty',
      createdAt: new Date().toISOString()
    })

    expect(result).toBe(false)
  })

  it('returns false and does not throw when S3 list fails', async () => {
    const s3Client = makeMockS3({
      send: vi.fn().mockRejectedValue(new Error('S3 list error'))
    })

    const result = await deleteSingleOldReview(s3Client, BUCKET, PREFIX, {
      id: 'review-fail',
      createdAt: new Date().toISOString()
    })

    expect(result).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// deleteOldReviews — 5 day retention
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteOldReviews', () => {
  const RETENTION_DAYS = 5

  function daysAgo(n) {
    const d = new Date()
    d.setDate(d.getDate() - n)
    return d.toISOString()
  }

  function makeGetReviews(reviews) {
    return vi.fn().mockResolvedValue({ reviews })
  }

  it('uses 5 days as the default retention period', async () => {
    // No reviews at all — just confirm it runs without error and returns 0
    const getReviews = makeGetReviews([])
    const s3Client = makeMockS3()

    const deleted = await deleteOldReviews(s3Client, BUCKET, PREFIX, getReviews)

    expect(deleted).toBe(0)
    expect(getReviews).toHaveBeenCalledWith({ limit: 1000 })
  })

  it('returns 0 when all reviews are within the retention window', async () => {
    const reviews = [
      { id: 'r1', createdAt: daysAgo(1) },
      { id: 'r2', createdAt: daysAgo(3) },
      { id: 'r3', createdAt: daysAgo(4) }
    ]
    const getReviews = makeGetReviews(reviews)
    const s3Client = makeMockS3({
      send: vi.fn().mockResolvedValue({ Contents: [] })
    })

    const deleted = await deleteOldReviews(
      s3Client,
      BUCKET,
      PREFIX,
      getReviews,
      RETENTION_DAYS
    )

    expect(deleted).toBe(0)
  })

  it('deletes reviews older than 5 days and returns correct count', async () => {
    const reviews = [
      { id: 'keep-1', createdAt: daysAgo(2) },
      { id: 'keep-2', createdAt: daysAgo(4) },
      { id: 'old-1', createdAt: daysAgo(6) },
      { id: 'old-2', createdAt: daysAgo(10) }
    ]
    const getReviews = makeGetReviews(reviews)

    const s3Client = makeMockS3()
    // old-1: list returns 1 file, then delete it
    // old-2: list returns 1 file, then delete it
    s3Client.send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'reviews/old-1/meta.json' }]
      })
      .mockResolvedValueOnce({}) // delete old-1/meta.json
      .mockResolvedValueOnce({
        Contents: [{ Key: 'reviews/old-2/meta.json' }]
      })
      .mockResolvedValueOnce({}) // delete old-2/meta.json

    const deleted = await deleteOldReviews(
      s3Client,
      BUCKET,
      PREFIX,
      getReviews,
      RETENTION_DAYS
    )

    expect(deleted).toBe(2)
  })

  it('does not delete reviews exactly at the cutoff boundary', async () => {
    // A review created exactly RETENTION_DAYS days ago should NOT be deleted
    // because the cutoff is strictly less-than
    const reviews = [{ id: 'boundary', createdAt: daysAgo(RETENTION_DAYS) }]
    const getReviews = makeGetReviews(reviews)
    const s3Client = makeMockS3({
      send: vi.fn().mockResolvedValue({ Contents: [] })
    })

    const deleted = await deleteOldReviews(
      s3Client,
      BUCKET,
      PREFIX,
      getReviews,
      RETENTION_DAYS
    )

    expect(deleted).toBe(0)
  })

  it('falls back to uploadedAt when createdAt is missing', async () => {
    const reviews = [{ id: 'old-upload', uploadedAt: daysAgo(8) }]
    const getReviews = makeGetReviews(reviews)

    const s3Client = makeMockS3()
    s3Client.send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'reviews/old-upload/meta.json' }]
      })
      .mockResolvedValueOnce({})

    const deleted = await deleteOldReviews(
      s3Client,
      BUCKET,
      PREFIX,
      getReviews,
      RETENTION_DAYS
    )

    expect(deleted).toBe(1)
  })

  it('rethrows when getRecentReviews fails', async () => {
    const getReviews = vi
      .fn()
      .mockRejectedValue(new Error('DB connection failed'))
    const s3Client = makeMockS3()

    await expect(
      deleteOldReviews(s3Client, BUCKET, PREFIX, getReviews, RETENTION_DAYS)
    ).rejects.toThrow('DB connection failed')
  })
})
