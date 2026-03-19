/**
 * canonical-document.pii-redaction.e2e.test.js
 *
 * E2E: PII-containing text is redacted before being stored as canonicalText.
 * Only AWS S3 and config are mocked; all other modules run real code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { MOCK_S3_SEND, S3_BUCKET } = vi.hoisted(() => ({
  MOCK_S3_SEND: vi.fn(),
  S3_BUCKET: 'e2e-test-bucket'
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

const DOC_ID = 'review_e2e-pii-redaction-00000001'

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
})

describe('PII redaction — real piiRedactor runs in pipeline', () => {
  it('redacts a UK National Insurance number', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'My NI number is AB123456C.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).not.toContain('AB123456C')
    expect(document.canonicalText).toContain('[NI_NUMBER_REDACTED]')
  })

  it('redacts an IPv4 address', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'The server is at 192.168.1.1.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).not.toContain('192.168.1.1')
    expect(document.canonicalText).toContain('[IP_ADDRESS_REDACTED]')
  })

  it('redacts a credit card number', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Card: 4111 1111 1111 1111.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).not.toContain('4111 1111 1111 1111')
    expect(document.canonicalText).toContain('[CARD_NUMBER_REDACTED]')
  })

  it('redacts a sort code', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Sort code 12-34-56 for the account.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).not.toContain('12-34-56')
    expect(document.canonicalText).toContain('[SORT_CODE_REDACTED]')
  })

  it('preserves surrounding text after PII redaction', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Contact John at AB123456C for details.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).toContain('Contact John at')
    expect(document.canonicalText).toContain('for details.')
  })

  it('records charCount from redacted (shorter) text', async () => {
    const rawText = 'NI: AB123456C is private.'
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: rawText,
      sourceType: SOURCE_TYPES.TEXT
    })
    // After redaction the text changes, charCount must match canonicalText
    expect(document.charCount).toBe(document.canonicalText.length)
  })

  it('text without PII is unchanged by the redactor', async () => {
    const clean = 'This text contains no personal information whatsoever.'
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: clean,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).toBe(clean)
  })

  it('handles multiple PII instances in one document', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'NI: AB123456C. Server: 10.0.0.1. Sort code: 12-34-56.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).not.toContain('AB123456C')
    expect(document.canonicalText).not.toContain('10.0.0.1')
    expect(document.canonicalText).not.toContain('12-34-56')
  })
})
