import { config } from '../../../config.js'
import { createLogger } from '../logging/logger.js'

const logger = createLogger()
const COLLECTION = 'refresh_tokens'

/**
 * Persist a new refresh token.
 * Stores the SHA-256 hash — never the plaintext token.
 *
 * @param {import('mongodb').Db} db
 * @param {string} userId
 * @param {string} email
 * @param {string} name
 * @param {string} tokenHash  SHA-256 hex digest of the plaintext token
 */
export async function storeRefreshToken(db, userId, email, name, tokenHash) {
  const expirySeconds = config.get('auth.refreshTokenExpirySeconds')
  const expiresAt = new Date(Date.now() + expirySeconds * 1000)

  await db.collection(COLLECTION).insertOne({
    userId,
    email,
    name,
    tokenHash,
    createdAt: new Date(),
    expiresAt
  })

  logger.debug({ userId }, 'Refresh token stored')
}

/**
 * Look up a non-expired refresh token by its hash.
 *
 * @param {import('mongodb').Db} db
 * @param {string} tokenHash
 * @returns {Promise<Object|null>} stored document, or null if not found / expired
 */
export async function findRefreshToken(db, tokenHash) {
  return db.collection(COLLECTION).findOne({
    tokenHash,
    expiresAt: { $gt: new Date() }
  })
}

/**
 * Delete a single refresh token (single-session logout).
 *
 * @param {import('mongodb').Db} db
 * @param {string} tokenHash
 */
export async function deleteRefreshToken(db, tokenHash) {
  const result = await db.collection(COLLECTION).deleteOne({ tokenHash })
  logger.debug({ deletedCount: result.deletedCount }, 'Refresh token deleted')
}

/**
 * Delete all refresh tokens for a user (logout all sessions).
 *
 * @param {import('mongodb').Db} db
 * @param {string} userId
 */
export async function deleteAllRefreshTokensForUser(db, userId) {
  const result = await db.collection(COLLECTION).deleteMany({ userId })
  logger.debug(
    { userId, deletedCount: result.deletedCount },
    'All refresh tokens deleted for user'
  )
}
