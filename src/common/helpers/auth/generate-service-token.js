import { createHmac } from 'node:crypto'

/**
 * Generate HMAC-SHA256 signature for service authentication
 * Used by backend to verify tokens received from frontend
 *
 * @param {string} secret - Shared secret (BACKEND_SERVICE_TOKEN)
 * @param {string} method - HTTP method (e.g., 'POST', 'GET')
 * @param {string} path - Request path (e.g., '/api/review/text')
 * @param {number} timestamp - Timestamp in milliseconds
 * @returns {string} HMAC-SHA256 signature (hex)
 */
export function generateServiceToken(secret, method, path, timestamp) {
  if (!secret) {
    throw new Error('BACKEND_SERVICE_TOKEN is not configured')
  }

  // Message format: METHOD:PATH:TIMESTAMP
  // This ensures token is specific to the request
  const message = `${method}:${path}:${timestamp}`

  const hmac = createHmac('sha256', secret)
  hmac.update(message)
  return hmac.digest('hex')
}

/**
 * Verify a service token from a frontend request
 *
 * @param {string} token - Token from x-service-token header
 * @param {string} secret - Shared secret (BACKEND_SERVICE_TOKEN)
 * @param {string} method - HTTP method from request
 * @param {string} path - Request path
 * @param {number} timestamp - Timestamp from x-timestamp header
 * @param {number} maxAgeMs - Maximum age of token in milliseconds (default 60 seconds)
 * @returns {object} { valid: boolean, reason?: string }
 */
export function verifyServiceToken(
  token,
  secret,
  method,
  path,
  timestamp,
  maxAgeMs = 60000
) {
  try {
    // Validate timestamp is recent (prevent replay attacks)
    const now = Date.now()
    const age = now - timestamp

    if (age < 0) {
      return {
        valid: false,
        reason: 'Timestamp is in the future'
      }
    }

    if (age > maxAgeMs) {
      return {
        valid: false,
        reason: `Timestamp is too old (${(age / 1000).toFixed(2)}s, max: ${(maxAgeMs / 1000).toFixed(2)}s)`
      }
    }

    // Generate expected token
    const expectedToken = generateServiceToken(secret, method, path, timestamp)

    // Compare using constant-time comparison to prevent timing attacks
    if (token.length !== expectedToken.length) {
      return {
        valid: false,
        reason: 'Token format mismatch'
      }
    }

    let isValid = true
    for (let i = 0; i < token.length; i++) {
      if (token[i] !== expectedToken[i]) {
        isValid = false
      }
    }

    if (!isValid) {
      return {
        valid: false,
        reason: 'Token signature mismatch'
      }
    }

    return { valid: true }
  } catch (error) {
    return {
      valid: false,
      reason: `Verification error: ${error.message}`
    }
  }
}
