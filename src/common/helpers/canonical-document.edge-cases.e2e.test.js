/**
 * canonical-document.edge-cases.e2e.test.js
 *
 * E2E: Boundary / edge-case inputs — empty strings, single characters,
 * only-whitespace, only-PII, only-noise, Unicode extremes, null-like values.
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

const DOC_ID = 'review_e2e-edge-cases-00000001'

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
})

describe('edge cases — empty / near-empty input', () => {
  it('processes an empty string without throwing', async () => {
    await expect(
      canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID,
        text: '',
        sourceType: SOURCE_TYPES.TEXT
      })
    ).resolves.not.toThrow()
  })

  it('empty string produces charCount of 0', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.charCount).toBe(0)
  })

  it('whitespace-only string does not crash', async () => {
    await expect(
      canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID,
        text: '   \n   \t   ',
        sourceType: SOURCE_TYPES.TEXT
      })
    ).resolves.not.toThrow()
  })

  it('single character produces charCount 1', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'X',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.charCount).toBe(1)
    expect(document.canonicalText).toBe('X')
  })
})

describe('edge cases — schema invariants always hold', () => {
  const EDGE_INPUTS = [
    { label: 'empty string', text: '' },
    { label: 'newlines only', text: '\n\n\n' },
    { label: 'single word', text: 'Hello' },
    { label: 'only punctuation', text: '!!!???...' },
    { label: 'only digits', text: '123456789' },
    { label: 'unicode emoji', text: '🌍 Environment 🌱' },
    { label: 'null byte present', text: 'Text\u0000with null' },
    { label: 'BOM at start', text: '\uFEFFDocument text.' }
  ]

  for (const { label, text } of EDGE_INPUTS) {
    it(`schema invariants hold for: ${label}`, async () => {
      const { document } = await canonicalDocumentStore.createCanonicalDocument(
        {
          documentId: DOC_ID,
          text,
          sourceType: SOURCE_TYPES.TEXT
        }
      )
      expect(typeof document.canonicalText).toBe('string')
      expect(document.charCount).toBe(document.canonicalText.length)
      expect(document.tokenEst).toBe(Math.round(document.charCount / 4))
      expect(Array.isArray(document.sourceMap)).toBe(true)
      expect(document.status).toBe(CANONICAL_STATUS.PENDING)
    })
  }
})

describe('edge cases — unicode and special characters', () => {
  it('handles right-to-left text (Arabic) without throwing', async () => {
    await expect(
      canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID,
        text: 'مرحبا بالعالم',
        sourceType: SOURCE_TYPES.TEXT
      })
    ).resolves.not.toThrow()
  })

  it('handles CJK characters without throwing', async () => {
    await expect(
      canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID,
        text: '环境政策文件 2026年',
        sourceType: SOURCE_TYPES.TEXT
      })
    ).resolves.not.toThrow()
  })

  it('strips BOM character from the start of text', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '\uFEFFActual content.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).not.toContain('\uFEFF')
    expect(document.canonicalText).toContain('Actual content.')
  })

  it('handles mixed ASCII and Unicode in one document', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Section A: naïve approach — "smart quotes" and café culture.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.charCount).toBe(document.canonicalText.length)
  })
})

describe('edge cases — only-PII text', () => {
  it('text consisting only of a NI number is fully redacted', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'AB123456C',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).not.toContain('AB123456C')
  })

  it('charCount still equals canonicalText.length after full redaction', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'AB123456C',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.charCount).toBe(document.canonicalText.length)
  })
})

describe('edge cases — S3 always called once regardless of input', () => {
  it('S3 is called once for empty string input', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(MOCK_S3_SEND).toHaveBeenCalledOnce()
  })

  it('S3 is called once for very short input', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Hi',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(MOCK_S3_SEND).toHaveBeenCalledOnce()
  })
})
