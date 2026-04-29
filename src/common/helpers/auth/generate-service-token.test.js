import { describe, it, expect } from 'vitest'
import {
  generateServiceToken,
  verifyServiceToken
} from './generate-service-token.js'

const SECRET = 'test-shared-secret-value'
const METHOD = 'POST'
const PATH = '/api/review/text'

// ── generateServiceToken ──────────────────────────────────────────────────────

describe('generateServiceToken - output format', () => {
  it('returns a 64-character lowercase hex string', () => {
    const token = generateServiceToken(SECRET, METHOD, PATH, Date.now())
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for identical inputs', () => {
    const ts = 1_714_000_000_000
    expect(generateServiceToken(SECRET, METHOD, PATH, ts)).toBe(
      generateServiceToken(SECRET, METHOD, PATH, ts)
    )
  })
})

describe('generateServiceToken - throws on missing secret', () => {
  it('throws when secret is an empty string', () => {
    expect(() => generateServiceToken('', METHOD, PATH, Date.now())).toThrow(
      'BACKEND_SERVICE_TOKEN is not configured'
    )
  })

  it('throws when secret is undefined', () => {
    expect(() =>
      generateServiceToken(undefined, METHOD, PATH, Date.now())
    ).toThrow('BACKEND_SERVICE_TOKEN is not configured')
  })

  it('throws when secret is null', () => {
    expect(() => generateServiceToken(null, METHOD, PATH, Date.now())).toThrow(
      'BACKEND_SERVICE_TOKEN is not configured'
    )
  })
})

describe('generateServiceToken - uniqueness', () => {
  const ts = 1_714_000_000_000

  it('produces different tokens for different HTTP methods', () => {
    expect(generateServiceToken(SECRET, 'GET', PATH, ts)).not.toBe(
      generateServiceToken(SECRET, 'POST', PATH, ts)
    )
  })

  it('produces different tokens for different paths', () => {
    expect(generateServiceToken(SECRET, METHOD, '/api/a', ts)).not.toBe(
      generateServiceToken(SECRET, METHOD, '/api/b', ts)
    )
  })

  it('produces different tokens for different timestamps', () => {
    expect(generateServiceToken(SECRET, METHOD, PATH, 1000)).not.toBe(
      generateServiceToken(SECRET, METHOD, PATH, 2000)
    )
  })

  it('produces different tokens for different secrets', () => {
    expect(generateServiceToken('secret-a', METHOD, PATH, ts)).not.toBe(
      generateServiceToken('secret-b', METHOD, PATH, ts)
    )
  })
})

// ── verifyServiceToken ────────────────────────────────────────────────────────

describe('verifyServiceToken - valid token', () => {
  it('returns valid:true for a freshly generated token', () => {
    const ts = Date.now()
    const token = generateServiceToken(SECRET, METHOD, PATH, ts)
    expect(verifyServiceToken(token, SECRET, METHOD, PATH, ts)).toEqual({
      valid: true
    })
  })

  it('accepts a token within a custom maxAgeMs window', () => {
    const ts = Date.now() - 30_000 // 30 s old — within 60 s window
    const token = generateServiceToken(SECRET, METHOD, PATH, ts)
    expect(verifyServiceToken(token, SECRET, METHOD, PATH, ts, 60_000)).toEqual(
      { valid: true }
    )
  })
})

describe('verifyServiceToken - timestamp checks', () => {
  it('returns valid:false when timestamp is in the future', () => {
    const ts = Date.now() + 999_999
    const token = generateServiceToken(SECRET, METHOD, PATH, ts)
    const result = verifyServiceToken(token, SECRET, METHOD, PATH, ts)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('Timestamp is in the future')
  })

  it('returns valid:false when timestamp is older than maxAgeMs (default 60 s)', () => {
    const ts = Date.now() - 120_000
    const token = generateServiceToken(SECRET, METHOD, PATH, ts)
    const result = verifyServiceToken(token, SECRET, METHOD, PATH, ts)
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('Timestamp is too old')
    expect(result.reason).toContain('s, max:')
  })

  it('returns valid:false when timestamp exceeds a custom maxAgeMs', () => {
    const ts = Date.now() - 90_000
    const token = generateServiceToken(SECRET, METHOD, PATH, ts)
    const result = verifyServiceToken(token, SECRET, METHOD, PATH, ts, 60_000)
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('Timestamp is too old')
  })
})

describe('verifyServiceToken - signature checks', () => {
  it('returns valid:false with "Token format mismatch" when token length differs', () => {
    const ts = Date.now()
    const result = verifyServiceToken('short-token', SECRET, METHOD, PATH, ts)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('Token format mismatch')
  })

  it('returns valid:false with "Token signature mismatch" for a tampered token', () => {
    const ts = Date.now()
    const tampered = 'a'.repeat(64) // correct length, wrong value
    const result = verifyServiceToken(tampered, SECRET, METHOD, PATH, ts)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('Token signature mismatch')
  })

  it('returns valid:false when the wrong secret is used for verification', () => {
    const ts = Date.now()
    const token = generateServiceToken('correct-secret', METHOD, PATH, ts)
    const result = verifyServiceToken(token, 'wrong-secret', METHOD, PATH, ts)
    expect(result.valid).toBe(false)
  })

  it('returns valid:false with "Token signature mismatch" for wrong method', () => {
    const ts = Date.now()
    const token = generateServiceToken(SECRET, 'GET', PATH, ts)
    const result = verifyServiceToken(token, SECRET, 'POST', PATH, ts)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('Token signature mismatch')
  })
})

describe('verifyServiceToken - error handling', () => {
  it('returns valid:false with "Verification error" when secret is empty (throws internally)', () => {
    const ts = Date.now()
    const token = generateServiceToken(SECRET, METHOD, PATH, ts)
    const result = verifyServiceToken(token, '', METHOD, PATH, ts)
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('Verification error')
  })
})
