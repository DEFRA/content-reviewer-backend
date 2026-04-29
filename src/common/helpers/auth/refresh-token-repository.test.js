import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      if (key === 'auth.refreshTokenExpirySeconds') return 604800 // 7 days
      return null
    })
  }
}))

vi.mock('../logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

import {
  storeRefreshToken,
  findRefreshToken,
  deleteRefreshToken,
  deleteAllRefreshTokensForUser
} from './refresh-token-repository.js'

const COLLECTION = 'refresh_tokens'

function createMockCollection() {
  return {
    insertOne: vi.fn().mockResolvedValue({ insertedId: 'mock-id' }),
    findOne: vi.fn().mockResolvedValue(null),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 2 })
  }
}

function createMockDb(collection) {
  return { collection: vi.fn().mockReturnValue(collection) }
}

// ── storeRefreshToken ─────────────────────────────────────────────────────────

describe('storeRefreshToken', () => {
  let col
  let db

  beforeEach(() => {
    vi.clearAllMocks()
    col = createMockCollection()
    db = createMockDb(col)
  })

  it('calls db.collection with "refresh_tokens"', async () => {
    await storeRefreshToken(db, 'u1', 'a@b.com', 'Alice', 'hash123')
    expect(db.collection).toHaveBeenCalledWith(COLLECTION)
  })

  it('inserts a document with userId, email, name and tokenHash', async () => {
    await storeRefreshToken(db, 'u1', 'a@b.com', 'Alice', 'hash123')
    expect(col.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        email: 'a@b.com',
        name: 'Alice',
        tokenHash: 'hash123'
      })
    )
  })

  it('includes createdAt as a Date', async () => {
    await storeRefreshToken(db, 'u1', 'a@b.com', 'Alice', 'hash123')
    const doc = col.insertOne.mock.calls[0][0]
    expect(doc.createdAt).toBeInstanceOf(Date)
  })

  it('sets expiresAt to approximately now + refreshTokenExpirySeconds', async () => {
    const before = Date.now()
    await storeRefreshToken(db, 'u1', 'a@b.com', 'Alice', 'hash123')
    const after = Date.now()
    const doc = col.insertOne.mock.calls[0][0]
    expect(doc.expiresAt).toBeInstanceOf(Date)
    expect(doc.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 604800 * 1000
    )
    expect(doc.expiresAt.getTime()).toBeLessThanOrEqual(after + 604800 * 1000)
  })
})

// ── findRefreshToken ──────────────────────────────────────────────────────────

describe('findRefreshToken', () => {
  let col
  let db

  beforeEach(() => {
    vi.clearAllMocks()
    col = createMockCollection()
    db = createMockDb(col)
  })

  it('calls db.collection with "refresh_tokens"', async () => {
    await findRefreshToken(db, 'hash-abc')
    expect(db.collection).toHaveBeenCalledWith(COLLECTION)
  })

  it('queries with tokenHash and expiresAt > now filter', async () => {
    await findRefreshToken(db, 'hash-abc')
    expect(col.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: 'hash-abc',
        expiresAt: expect.objectContaining({ $gt: expect.any(Date) })
      })
    )
  })

  it('returns the document found by findOne', async () => {
    const doc = { userId: 'u1', tokenHash: 'hash-abc' }
    col.findOne.mockResolvedValueOnce(doc)
    const result = await findRefreshToken(db, 'hash-abc')
    expect(result).toBe(doc)
  })

  it('returns null when no document is found', async () => {
    col.findOne.mockResolvedValueOnce(null)
    const result = await findRefreshToken(db, 'not-found')
    expect(result).toBeNull()
  })
})

// ── deleteRefreshToken ────────────────────────────────────────────────────────

describe('deleteRefreshToken', () => {
  let col
  let db

  beforeEach(() => {
    vi.clearAllMocks()
    col = createMockCollection()
    db = createMockDb(col)
  })

  it('calls db.collection with "refresh_tokens"', async () => {
    await deleteRefreshToken(db, 'hash-xyz')
    expect(db.collection).toHaveBeenCalledWith(COLLECTION)
  })

  it('calls deleteOne with the correct tokenHash filter', async () => {
    await deleteRefreshToken(db, 'hash-xyz')
    expect(col.deleteOne).toHaveBeenCalledWith({ tokenHash: 'hash-xyz' })
  })

  it('resolves without throwing on success', async () => {
    await expect(deleteRefreshToken(db, 'hash-xyz')).resolves.not.toThrow()
  })
})

// ── deleteAllRefreshTokensForUser ─────────────────────────────────────────────

describe('deleteAllRefreshTokensForUser', () => {
  let col
  let db

  beforeEach(() => {
    vi.clearAllMocks()
    col = createMockCollection()
    db = createMockDb(col)
  })

  it('calls db.collection with "refresh_tokens"', async () => {
    await deleteAllRefreshTokensForUser(db, 'user-99')
    expect(db.collection).toHaveBeenCalledWith(COLLECTION)
  })

  it('calls deleteMany with the correct userId filter', async () => {
    await deleteAllRefreshTokensForUser(db, 'user-99')
    expect(col.deleteMany).toHaveBeenCalledWith({ userId: 'user-99' })
  })

  it('resolves without throwing when multiple tokens are deleted', async () => {
    col.deleteMany.mockResolvedValueOnce({ deletedCount: 3 })
    await expect(
      deleteAllRefreshTokensForUser(db, 'user-99')
    ).resolves.not.toThrow()
  })

  it('resolves without throwing when no tokens exist for user', async () => {
    col.deleteMany.mockResolvedValueOnce({ deletedCount: 0 })
    await expect(
      deleteAllRefreshTokensForUser(db, 'unknown-user')
    ).resolves.not.toThrow()
  })
})
