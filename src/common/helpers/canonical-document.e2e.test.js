/**
 * canonical-document.e2e.test.js
 *
 * E2E: Full pipeline integration tests for canonical document creation.
 * Exercises: raw text → PII redaction → text normalisation → canonical document
 *
 * Only AWS S3 and config are mocked; all other modules run real code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mock refs ────────────────────────────────────────────────────────
const { MOCK_S3_SEND, S3_BUCKET } = vi.hoisted(() => ({
  MOCK_S3_SEND: vi.fn(),
  S3_BUCKET: 'e2e-canonical-test-bucket'
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: MOCK_S3_SEND }
  }),
  PutObjectCommand: vi.fn(function (input) {
    return input
  }),
  GetObjectCommand: vi.fn(function (input) {
    return input
  })
}))

vi.mock('../../config.js', () => ({
  config: {
    get: vi.fn(
      (key) =>
        ({
          'aws.region': 'eu-west-2',
          'aws.endpoint': null,
          's3.bucket': S3_BUCKET
        })[key] ?? null
    )
  }
}))

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

import { canonicalDocumentStore, SOURCE_TYPES } from './canonical-document.js'

const DOC_ID = 'review_e2e-canonical-00000001'

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
})

// ─────────────────────────────────────────────────────────────────────────────
describe('canonical-document e2e — plain text pipeline', () => {
  it('creates a canonical document from plain text without throwing', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      sourceType: SOURCE_TYPES.TEXT,
      text: 'Hello world. This is a test document.'
    })

    expect(document).toBeDefined()
    expect(document.canonicalText).toBeTruthy()
  })

  it('preserves non-PII content through the full pipeline', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      sourceType: SOURCE_TYPES.TEXT,
      text: 'The quick brown fox jumps over the lazy dog.'
    })

    expect(document.canonicalText).toContain('quick brown fox')
  })

  it('persists the document to S3', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      sourceType: SOURCE_TYPES.TEXT,
      text: 'Some content to persist.'
    })

    expect(MOCK_S3_SEND).toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('canonical-document e2e — PII redaction', () => {
  it('redacts UK National Insurance numbers', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      sourceType: SOURCE_TYPES.TEXT,
      text: 'The applicant NI number is AB 12 34 56 C.'
    })

    expect(document.canonicalText).not.toContain('AB 12 34 56 C')
    expect(document.canonicalText).toContain('[NI_NUMBER_REDACTED]')
  })

  it('redacts credit card numbers', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      sourceType: SOURCE_TYPES.TEXT,
      text: 'Payment made using card 4111 1111 1111 1111.'
    })

    expect(document.canonicalText).not.toContain('4111 1111 1111 1111')
    expect(document.canonicalText).toContain('[CARD_NUMBER_REDACTED]')
  })

  it('redacts IPv4 addresses', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      sourceType: SOURCE_TYPES.TEXT,
      text: 'Request originated from 192.168.1.100 at midnight.'
    })

    expect(document.canonicalText).not.toContain('192.168.1.100')
    expect(document.canonicalText).toContain('[IP_ADDRESS_REDACTED]')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('canonical-document e2e — text normalisation', () => {
  it('normalises smart quotes to ASCII', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      sourceType: SOURCE_TYPES.TEXT,
      text: '\u201cHello\u201d and \u2018world\u2019'
    })

    expect(document.canonicalText).toContain('"Hello"')
    expect(document.canonicalText).toContain("'world'")
  })

  it('collapses multiple blank lines to at most two', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      sourceType: SOURCE_TYPES.TEXT,
      text: 'Line one\n\n\n\n\nLine two'
    })

    expect(document.canonicalText).not.toMatch(/\n{3,}/)
  })

  it('removes null bytes and zero-width characters', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      sourceType: SOURCE_TYPES.TEXT,
      text: 'Clean\u0000text\u200bwith\uFEFFartefacts'
    })

    // Verify no null bytes, zero-width spaces or BOM markers remain
    expect(document.canonicalText).not.toContain('\u0000')
    expect(document.canonicalText).not.toContain('\u200b')
    expect(document.canonicalText).not.toContain('\uFEFF')
    expect(document.canonicalText).toContain('Clean')
  })

  it('expands ligatures', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      sourceType: SOURCE_TYPES.TEXT,
      text: 'The \uFB01nal \uFB00ort was e\uFB03cient'
    })

    // \uFB01 = ﬁ → fi,  \uFB00 = ﬀ → ff,  \uFB03 = ﬃ → ffi
    expect(document.canonicalText).toContain('final')
    expect(document.canonicalText).toContain('ffort')
    expect(document.canonicalText).toContain('efficient')
  })
})
