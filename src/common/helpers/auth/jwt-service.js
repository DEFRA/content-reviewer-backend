import {
  createHmac,
  randomBytes,
  createHash,
  timingSafeEqual
} from 'node:crypto'
import { config } from '../../../config.js'

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url')
}

function base64UrlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8')
}

const JWT_HEADER = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))

/**
 * Generate a short-lived JWT access token.
 * @param {string} userId
 * @param {string} email
 * @param {string} name
 * @returns {string} Signed JWT
 */
export function generateAccessToken(userId, email, name) {
  const secret = config.get('auth.jwtSecret')
  const expirySeconds = config.get('auth.accessTokenExpirySeconds')
  const now = Math.floor(Date.now() / 1000)

  const payload = base64UrlEncode(
    JSON.stringify({
      sub: userId,
      email,
      name,
      iat: now,
      exp: now + expirySeconds
    })
  )
  const signature = createHmac('sha256', secret)
    .update(`${JWT_HEADER}.${payload}`)
    .digest('base64url')

  return `${JWT_HEADER}.${payload}.${signature}`
}

/**
 * Verify a JWT access token and return its payload.
 * @param {string} token
 * @returns {{ sub: string, email: string, name: string, iat: number, exp: number }}
 * @throws {Error} if the token is malformed, has a bad signature, or is expired
 */
export function verifyAccessToken(token) {
  const secret = config.get('auth.jwtSecret')

  const parts = token?.split('.')
  if (!parts || parts.length !== 3) {
    throw new Error('Invalid token format')
  }

  const [header, payload, signature] = parts

  const expectedSig = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url')

  const sigBuf = Buffer.from(signature)
  const expBuf = Buffer.from(expectedSig)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Invalid token signature')
  }

  let claims
  try {
    claims = JSON.parse(base64UrlDecode(payload))
  } catch {
    throw new Error('Invalid token payload')
  }

  if (!claims.exp || Math.floor(Date.now() / 1000) > claims.exp) {
    throw new Error('Token expired')
  }

  return claims
}

/**
 * Generate a cryptographically secure refresh token.
 * @returns {{ token: string, hash: string }}
 *   token — the plaintext value given to the client
 *   hash  — SHA-256 hex digest stored in the database (never store plaintext)
 */
export function generateRefreshToken() {
  const token = randomBytes(32).toString('hex')
  const hash = createHash('sha256').update(token).digest('hex')
  return { token, hash }
}

/**
 * Hash a refresh token for database lookup.
 * @param {string} token
 * @returns {string} SHA-256 hex digest
 */
export function hashRefreshToken(token) {
  return createHash('sha256').update(token).digest('hex')
}
