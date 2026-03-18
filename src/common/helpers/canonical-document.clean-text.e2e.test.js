/**
 * canonical-document.clean-text.e2e.test.js
 *
 * E2E: clean plain text (no PII, no noise) flows through unchanged.
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

import {
  canonicalDocumentStore,
  SOURCE_TYPES,
  CANONICAL_STATUS
} from './canonical-document.js'

const DOC_ID = 'review_e2e-clean-text-00000001'
const REPEAT_COUNT = 200

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
})

describe('clean text — no transformations required', () => {
  it('preserves plain ASCII prose as canonicalText', async () => {
    const text = 'The quick brown fox jumps over the lazy dog.'
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).toBe(text)
  })

  it('charCount equals the length of canonicalText', async () => {
    const text = 'Simple clean text for charCount test.'
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.charCount).toBe(document.canonicalText.length)
  })

  it('tokenEst is approximately charCount / 4', async () => {
    const text = 'A'.repeat(REPEAT_COUNT)
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.tokenEst).toBe(Math.round(document.charCount / 4))
  })

  it('sourceMap is an array', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Hello world.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(Array.isArray(document.sourceMap)).toBe(true)
  })

  it('status is PENDING', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Hello.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.status).toBe(CANONICAL_STATUS.PENDING)
  })
})
