import { describe, it, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'

vi.mock('../../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      if (key === 'auth.jwtSecret') return 'test-jwt-secret-min-32-chars-long!!'
      if (key === 'auth.accessTokenExpirySeconds') return 900
      return null
    })
  }
}))

import { config } from '../../../config.js'
import {
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken
} from './jwt-service.js'

// ── generateAccessToken ───────────────────────────────────────────────────────

describe('generateAccessToken - token structure', () => {
  it('returns a string with three dot-separated parts', () => {
    const token = generateAccessToken('user-1', 'a@b.com', 'Alice')
    expect(token.split('.')).toHaveLength(3)
  })

  it('header encodes alg:HS256 and typ:JWT', () => {
    const token = generateAccessToken('user-1', 'a@b.com', 'Alice')
    const header = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString()
    )
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' })
  })

  it('payload contains sub, email, name, iat and exp claims', () => {
    const before = Math.floor(Date.now() / 1000)
    const token = generateAccessToken('user-42', 'test@example.com', 'Bob')
    const after = Math.floor(Date.now() / 1000)
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString()
    )
    expect(payload.sub).toBe('user-42')
    expect(payload.email).toBe('test@example.com')
    expect(payload.name).toBe('Bob')
    expect(payload.iat).toBeGreaterThanOrEqual(before)
    expect(payload.iat).toBeLessThanOrEqual(after)
    expect(payload.exp).toBe(payload.iat + 900)
  })

  it('produces different tokens on successive calls (different iat)', async () => {
    const t1 = generateAccessToken('u1', 'a@b.com', 'Alice')
    await new Promise((r) => setTimeout(r, 1100)) // ensure iat differs
    const t2 = generateAccessToken('u1', 'a@b.com', 'Alice')
    expect(t1).not.toBe(t2)
  })
})

// ── verifyAccessToken ─────────────────────────────────────────────────────────

describe('verifyAccessToken - valid token', () => {
  it('returns the decoded claims for a valid token', () => {
    const token = generateAccessToken('user-99', 'x@y.com', 'Carol')
    const claims = verifyAccessToken(token)
    expect(claims.sub).toBe('user-99')
    expect(claims.email).toBe('x@y.com')
    expect(claims.name).toBe('Carol')
  })

  it('returns iat and exp in the claims', () => {
    const token = generateAccessToken('user-1', 'a@b.com', 'Dave')
    const claims = verifyAccessToken(token)
    expect(claims.iat).toBeTypeOf('number')
    expect(claims.exp).toBeTypeOf('number')
    expect(claims.exp).toBeGreaterThan(claims.iat)
  })
})

describe('verifyAccessToken - malformed tokens', () => {
  it('throws "Invalid token format" when token is null', () => {
    expect(() => verifyAccessToken(null)).toThrow('Invalid token format')
  })

  it('throws "Invalid token format" when token has only two parts', () => {
    expect(() => verifyAccessToken('header.payload')).toThrow(
      'Invalid token format'
    )
  })

  it('throws "Invalid token format" when token has four parts', () => {
    expect(() => verifyAccessToken('a.b.c.d')).toThrow('Invalid token format')
  })

  it('throws "Invalid token format" for an empty string', () => {
    expect(() => verifyAccessToken('')).toThrow('Invalid token format')
  })
})

describe('verifyAccessToken - signature validation', () => {
  it('throws "Invalid token signature" when signature is tampered', () => {
    const token = generateAccessToken('u1', 'a@b.com', 'Eve')
    const [h, p] = token.split('.')
    const tampered = `${h}.${p}.invalidsignaturepadding`
    expect(() => verifyAccessToken(tampered)).toThrow('Invalid token signature')
  })

  it('throws "Invalid token signature" when payload is modified', () => {
    const token = generateAccessToken('u1', 'a@b.com', 'Eve')
    const parts = token.split('.')
    const fakePayload = Buffer.from(
      JSON.stringify({
        sub: 'hacker',
        email: 'h@x.com',
        iat: 0,
        exp: 9_999_999_999
      })
    ).toString('base64url')
    const forged = `${parts[0]}.${fakePayload}.${parts[2]}`
    expect(() => verifyAccessToken(forged)).toThrow('Invalid token signature')
  })
})

describe('verifyAccessToken - expiry', () => {
  it('throws "Token expired" for an expired token (exp in the past)', () => {
    // Build a token with an exp already in the past
    const now = Math.floor(Date.now() / 1000)
    const secret = config.get('auth.jwtSecret')
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' })
    ).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'u1',
        email: 'a@b.com',
        name: 'X',
        iat: now - 1000,
        exp: now - 1 // expired 1 second ago
      })
    ).toString('base64url')
    const sig = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url')
    const expiredToken = `${header}.${payload}.${sig}`

    expect(() => verifyAccessToken(expiredToken)).toThrow('Token expired')
  })

  it('throws "Token expired" when exp claim is missing', () => {
    const secret = config.get('auth.jwtSecret')

    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' })
    ).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'u1',
        email: 'a@b.com',
        iat: Math.floor(Date.now() / 1000)
      })
      // no exp field
    ).toString('base64url')
    const sig = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url')

    expect(() => verifyAccessToken(`${header}.${payload}.${sig}`)).toThrow(
      'Token expired'
    )
  })
})

describe('verifyAccessToken - invalid payload encoding', () => {
  it('throws "Invalid token payload" when payload is not valid base64url JSON', () => {
    const secret = config.get('auth.jwtSecret')

    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' })
    ).toString('base64url')
    const badPayload = Buffer.from('not-valid-json!!!').toString('base64url')
    const sig = createHmac('sha256', secret)
      .update(`${header}.${badPayload}`)
      .digest('base64url')

    expect(() => verifyAccessToken(`${header}.${badPayload}.${sig}`)).toThrow(
      'Invalid token payload'
    )
  })
})

// ── generateRefreshToken ──────────────────────────────────────────────────────

describe('generateRefreshToken', () => {
  it('returns an object with token and hash properties', () => {
    const result = generateRefreshToken()
    expect(result).toHaveProperty('token')
    expect(result).toHaveProperty('hash')
  })

  it('token is a 64-character hex string (32 random bytes)', () => {
    const { token } = generateRefreshToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hash is a 64-character hex string (SHA-256)', () => {
    const { hash } = generateRefreshToken()
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hash equals SHA-256 of the token', () => {
    const { token, hash } = generateRefreshToken()
    expect(hashRefreshToken(token)).toBe(hash)
  })

  it('produces unique tokens on each call', () => {
    const t1 = generateRefreshToken().token
    const t2 = generateRefreshToken().token
    expect(t1).not.toBe(t2)
  })
})

// ── hashRefreshToken ──────────────────────────────────────────────────────────

describe('hashRefreshToken', () => {
  it('returns a 64-character hex string', () => {
    expect(hashRefreshToken('any-input')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', () => {
    const input = 'stable-token-value'
    expect(hashRefreshToken(input)).toBe(hashRefreshToken(input))
  })

  it('produces different hashes for different inputs', () => {
    expect(hashRefreshToken('token-a')).not.toBe(hashRefreshToken('token-b'))
  })

  it('matches the hash returned by generateRefreshToken', () => {
    const { token, hash } = generateRefreshToken()
    expect(hashRefreshToken(token)).toBe(hash)
  })
})
