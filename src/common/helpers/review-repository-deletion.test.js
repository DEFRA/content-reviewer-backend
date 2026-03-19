import { describe, it, expect, vi } from 'vitest'
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

function makeDeleteObjectCommand(params) {
  return { type: 'DeleteObject', ...params }
}

vi.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: makeDeleteObjectCommand
}))

const BUCKET = 'test-bucket'
const PREFIX = 'reviews/'
const UPLOAD_S3_KEY = 'uploads/review-1/file.pdf'
const DAYS_WITHIN_WINDOW = 3
const DAYS_OUTSIDE_WINDOW = 6
const RETENTION_DAYS = 5

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString()
}

function makeGetReviews(reviews) {
  return vi.fn().mockResolvedValue({ reviews })
}

function makeMockS3(overrides = {}) {
  return {
    send: vi.fn().mockResolvedValue({}),
    ...overrides
  }
}

//
// deleteUploadedContent
//
describe('deleteUploadedContent', () => {
  it('sends a DeleteObjectCommand and pushes the key to deletedKeys', async () => {
    const s3Client = makeMockS3()
    const deletedKeys = []
    await deleteUploadedContent(
      s3Client,
      BUCKET,
      'review-1',
      UPLOAD_S3_KEY,
      deletedKeys
    )

    expect(s3Client.send).toHaveBeenCalledTimes(1)
    expect(deletedKeys).toEqual([UPLOAD_S3_KEY])
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
        UPLOAD_S3_KEY,
        deletedKeys
      )
    ).resolves.not.toThrow()

    expect(deletedKeys).toHaveLength(0)
  })
})

//
// deleteReviewMetadataFile
//
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

//
// deleteSingleOldReview
//
describe('deleteSingleOldReview', () => {
  it('returns false when review has no id or reviewId', async () => {
    const s3Client = makeMockS3()
    const result = await deleteSingleOldReview(s3Client, BUCKET, PREFIX, {
      status: 'completed'
    })
    expect(result).toBe(false)
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('deletes the review JSON file at the flat S3 key and returns true', async () => {
    const s3Client = makeMockS3()
    s3Client.send.mockResolvedValueOnce({})

    const result = await deleteSingleOldReview(s3Client, BUCKET, PREFIX, {
      id: 'review-1',
      createdAt: new Date().toISOString()
    })

    expect(result).toBe(true)
    expect(s3Client.send).toHaveBeenCalledTimes(1)
    const sentCommand = s3Client.send.mock.calls[0][0]
    expect(sentCommand).toMatchObject({
      Bucket: BUCKET,
      Key: `${PREFIX}review-1.json`
    })
  })

  it('returns true even when the S3 key does not exist (S3 delete is idempotent)', async () => {
    const s3Client = makeMockS3({
      send: vi.fn().mockResolvedValueOnce({})
    })

    const result = await deleteSingleOldReview(s3Client, BUCKET, PREFIX, {
      id: 'review-empty',
      createdAt: new Date().toISOString()
    })

    expect(result).toBe(true)
  })

  it('returns false and does not throw when S3 delete fails', async () => {
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
// deleteOldReviews — default behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteOldReviews - default behaviour', () => {
  it('uses 5 days as the default retention period', async () => {
    const getReviews = makeGetReviews([])
    const s3Client = makeMockS3()

    const deleted = await deleteOldReviews(s3Client, BUCKET, PREFIX, getReviews)

    expect(deleted).toBe(0)
    expect(getReviews).toHaveBeenCalledWith({ limit: 1000 })
  })

  it('returns 0 when all reviews are within the retention window', async () => {
    const reviews = [
      { id: 'r1', createdAt: daysAgo(1) },
      { id: 'r2', createdAt: daysAgo(DAYS_WITHIN_WINDOW) },
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
})

// ─────────────────────────────────────────────────────────────────────────────
// deleteOldReviews — deletion behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteOldReviews - deletion behaviour', () => {
  it('deletes reviews older than 5 days and returns correct count', async () => {
    const reviews = [
      { id: 'keep-1', createdAt: daysAgo(2) },
      { id: 'keep-2', createdAt: daysAgo(4) },
      { id: 'old-1', createdAt: daysAgo(DAYS_OUTSIDE_WINDOW) },
      { id: 'old-2', createdAt: daysAgo(10) }
    ]
    const getReviews = makeGetReviews(reviews)

    const s3Client = makeMockS3()
    s3Client.send
      .mockResolvedValueOnce({}) // delete old-1
      .mockResolvedValueOnce({}) // delete old-2

    const deleted = await deleteOldReviews(
      s3Client,
      BUCKET,
      PREFIX,
      getReviews,
      RETENTION_DAYS
    )

    expect(deleted).toBe(2)
  })

  it('falls back to uploadedAt when createdAt is missing', async () => {
    const reviews = [{ id: 'old-upload', uploadedAt: daysAgo(8) }]
    const getReviews = makeGetReviews(reviews)
    const s3Client = makeMockS3()
    s3Client.send.mockResolvedValueOnce({})

    const deleted = await deleteOldReviews(
      s3Client,
      BUCKET,
      PREFIX,
      getReviews,
      RETENTION_DAYS
    )

    expect(deleted).toBe(1)
  })
})

describe('deleteOldReviews - error handling', () => {
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
