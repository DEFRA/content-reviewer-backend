import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../../config.js'

/**
 * Minimal HS256 JWT implementation using Node.js built-in crypto.
 * No external dependency required.
 */

function b64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function b64urlDecode(str) {
  return JSON.parse(Buffer.from(str, 'base64url').toString('utf8'))
}

function computeSignature(header, body, secret) {
  return createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url')
}

/**
 * Sign a JWT with the configured secret.
 * @param {Object} payload - Claims to embed (must NOT contain exp/iat — they are added here).
 * @param {number} expiresInSeconds - Token lifetime in seconds.
 * @returns {string} Signed JWT string.
 */
export function signJwt(payload, expiresInSeconds) {
  const secret = config.get('jwt.secret')
  const header = b64urlEncode({ alg: 'HS256', typ: 'JWT' })
  const now = Math.floor(Date.now() / 1000)
  const body = b64urlEncode({
    ...payload,
    iat: now,
    exp: now + expiresInSeconds
  })
  const signature = computeSignature(header, body, secret)
  return `${header}.${body}.${signature}`
}

/**
 * Verify a JWT and return its payload.
 * Throws if the signature is invalid or the token is expired.
 * @param {string} token
 * @returns {Object} Decoded payload.
 */
const JWT_PARTS_COUNT = 3

export function verifyJwt(token) {
  const secret = config.get('jwt.secret')
  const parts = token.split('.')
  if (parts.length !== JWT_PARTS_COUNT) {
    throw new Error('Invalid token format')
  }
  const [header, body, signature] = parts

  const expected = computeSignature(header, body, secret)
  const sigBuf = Buffer.from(signature, 'base64url')
  const expBuf = Buffer.from(expected, 'base64url')

  // Constant-time comparison to prevent timing attacks
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Invalid token signature')
  }

  const claims = b64urlDecode(body)
  if (claims.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired')
  }
  return claims
}
