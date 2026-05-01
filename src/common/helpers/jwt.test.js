import { describe, test, expect, beforeEach, vi } from 'vitest'

// ── Constants ────────────────────────────────────────────────────────────────
const TEST_SECRET = 'test-secret-that-is-at-least-32-characters-long'
const TEST_USER_ID = 'user-123'
const TEST_EMAIL = 'user@example.com'
const TEST_NAME = 'Test User'
const EXPIRY_1_HOUR = 3600
const EXPIRY_1_SECOND = 1

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock('../../config.js', () => ({
  config: { get: vi.fn() }
}))

import { config } from '../../config.js'
import { signJwt, verifyJwt } from './jwt.js'

function setupConfig(secret = TEST_SECRET) {
  config.get.mockImplementation((key) => {
    if (key === 'jwt.secret') return secret
    return null
  })
}

// ── signJwt ──────────────────────────────────────────────────────────────────

describe('signJwt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupConfig()
  })

  test('Should return a string with three dot-separated parts', () => {
    const token = signJwt({ sub: TEST_USER_ID }, EXPIRY_1_HOUR)
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
  })

  test('Should embed provided payload claims in the token body', () => {
    const token = signJwt(
      { sub: TEST_USER_ID, email: TEST_EMAIL, name: TEST_NAME },
      EXPIRY_1_HOUR
    )
    const body = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    )
    expect(body.sub).toBe(TEST_USER_ID)
    expect(body.email).toBe(TEST_EMAIL)
    expect(body.name).toBe(TEST_NAME)
  })

  test('Should set iat to the current time (seconds)', () => {
    const before = Math.floor(Date.now() / 1000)
    const token = signJwt({ sub: TEST_USER_ID }, EXPIRY_1_HOUR)
    const after = Math.floor(Date.now() / 1000)
    const body = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    )
    expect(body.iat).toBeGreaterThanOrEqual(before)
    expect(body.iat).toBeLessThanOrEqual(after)
  })

  test('Should set exp to iat + expiresInSeconds', () => {
    const token = signJwt({ sub: TEST_USER_ID }, EXPIRY_1_HOUR)
    const body = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    )
    expect(body.exp).toBe(body.iat + EXPIRY_1_HOUR)
  })

  test('Should use HS256 alg in the header', () => {
    const token = signJwt({ sub: TEST_USER_ID }, EXPIRY_1_HOUR)
    const header = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString('utf8')
    )
    expect(header.alg).toBe('HS256')
    expect(header.typ).toBe('JWT')
  })
})

// ── verifyJwt ────────────────────────────────────────────────────────────────

describe('verifyJwt - valid token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupConfig()
  })

  test('Should return the decoded payload for a valid token', () => {
    const token = signJwt(
      { sub: TEST_USER_ID, email: TEST_EMAIL, type: 'access' },
      EXPIRY_1_HOUR
    )
    const payload = verifyJwt(token)
    expect(payload.sub).toBe(TEST_USER_ID)
    expect(payload.email).toBe(TEST_EMAIL)
    expect(payload.type).toBe('access')
  })

  test('Should include iat and exp in the returned payload', () => {
    const token = signJwt({ sub: TEST_USER_ID }, EXPIRY_1_HOUR)
    const payload = verifyJwt(token)
    expect(payload.iat).toBeDefined()
    expect(payload.exp).toBeDefined()
  })
})

describe('verifyJwt - invalid signature', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupConfig()
  })

  test('Should throw when the signature is tampered with', () => {
    const token = signJwt({ sub: TEST_USER_ID }, EXPIRY_1_HOUR)
    const [header, body] = token.split('.')
    const tampered = `${header}.${body}.invalidsignature`
    expect(() => verifyJwt(tampered)).toThrow('Invalid token signature')
  })

  test('Should throw when the payload is tampered with', () => {
    const token = signJwt({ sub: TEST_USER_ID }, EXPIRY_1_HOUR)
    const [header, , signature] = token.split('.')
    const fakeBody = Buffer.from(
      JSON.stringify({ sub: 'attacker', exp: 9999999999, iat: 0 })
    ).toString('base64url')
    const tampered = `${header}.${fakeBody}.${signature}`
    expect(() => verifyJwt(tampered)).toThrow('Invalid token signature')
  })

  test('Should throw when signed with a different secret', () => {
    setupConfig('different-secret-32-chars-min-padded')
    const tokenWithDifferentSecret = signJwt(
      { sub: TEST_USER_ID },
      EXPIRY_1_HOUR
    )

    setupConfig(TEST_SECRET)
    expect(() => verifyJwt(tokenWithDifferentSecret)).toThrow(
      'Invalid token signature'
    )
  })
})

describe('verifyJwt - expired token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupConfig()
  })

  test('Should throw when the token is expired', async () => {
    const token = signJwt({ sub: TEST_USER_ID }, EXPIRY_1_SECOND)
    // Advance time by 2 seconds so the token is expired
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 2000)
    expect(() => verifyJwt(token)).toThrow('Token expired')
    vi.useRealTimers()
  })
})

describe('verifyJwt - malformed token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupConfig()
  })

  test('Should throw when token has fewer than 3 parts', () => {
    expect(() => verifyJwt('onlyone')).toThrow('Invalid token format')
    expect(() => verifyJwt('two.parts')).toThrow('Invalid token format')
  })

  test('Should throw when token has more than 3 parts', () => {
    expect(() => verifyJwt('a.b.c.d')).toThrow('Invalid token format')
  })
})
