/**
 * canonical-document.large-document.e2e.test.js
 *
 * E2E: Large documents (long texts, many paragraphs) are handled correctly
 * through the full pipeline without truncation or overflow errors.
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

const DOC_ID = 'review_e2e-large-doc-00000001'

// Build a realistic large document: 50 sections of 5 paragraphs each
function buildLargeDocument(sections = 50, paragraphsPerSection = 5) {
  const parts = []
  for (let s = 1; s <= sections; s++) {
    parts.push(`## Section ${s}\n`)
    for (let p = 1; p <= paragraphsPerSection; p++) {
      parts.push(
        `Paragraph ${p} of section ${s}. This sentence provides substantive ` +
          `content that would appear in a real government policy document. ` +
          `It covers aspects of environmental management, policy outcomes, and ` +
          `regulatory compliance requirements for organisations operating in the ` +
          `United Kingdom under relevant legislation.`
      )
    }
  }
  return parts.join('\n\n')
}

const LARGE_DOC = buildLargeDocument()

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
})

describe('large document — pipeline handles high char count', () => {
  it('processes a large document without throwing', async () => {
    await expect(
      canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID,
        text: LARGE_DOC,
        sourceType: SOURCE_TYPES.TEXT
      })
    ).resolves.not.toThrow()
  })

  it('charCount is a large positive number for a large document', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: LARGE_DOC,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.charCount).toBeGreaterThan(10_000)
  })

  it('charCount equals canonicalText.length for large document', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: LARGE_DOC,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.charCount).toBe(document.canonicalText.length)
  })

  it('tokenEst equals Math.round(charCount / 4) for large document', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: LARGE_DOC,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.tokenEst).toBe(Math.round(document.charCount / 4))
  })

  it('sourceMap is an array for large document', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: LARGE_DOC,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(Array.isArray(document.sourceMap)).toBe(true)
  })

  it('preserves all section headings in large document', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: LARGE_DOC,
      sourceType: SOURCE_TYPES.TEXT
    })
    // At minimum the first and last section headings should appear
    expect(document.canonicalText).toContain('## Section 1')
    expect(document.canonicalText).toContain('## Section 50')
  })

  it('calls S3 send once even for large documents', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: LARGE_DOC,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(MOCK_S3_SEND).toHaveBeenCalledOnce()
  })
})

const VERY_LONG_DOC_LENGTH = 50_000
const REPEAT_CHAR_DOC_LENGTH = 40_000

describe('large document — high repeat character count', () => {
  it('handles a 50,000 character plain text document', async () => {
    const veryLong = 'A'.repeat(VERY_LONG_DOC_LENGTH)
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: veryLong,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.charCount).toBeGreaterThan(0)
    expect(document.charCount).toBe(document.canonicalText.length)
  })

  it('tokenEst is ~charCount/4 for very long document', async () => {
    const veryLong = 'B'.repeat(REPEAT_CHAR_DOC_LENGTH)
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: veryLong,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.tokenEst).toBe(Math.round(document.charCount / 4))
  })
})

const FILE_SOURCE_SECTION_COUNT = 20
const FILE_SOURCE_PARAGRAPHS_PER_SECTION = 3

describe('large document — FILE source strips front-matter', () => {
  it('still strips front-matter from a large FILE source document', async () => {
    const titlePage =
      'My Policy Document\nPresented to Parliament by the Secretary of State\nCP 1234'
    const largBody = buildLargeDocument(
      FILE_SOURCE_SECTION_COUNT,
      FILE_SOURCE_PARAGRAPHS_PER_SECTION
    )
    const fullDoc = `${titlePage}\n\n${largBody}`

    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: fullDoc,
      sourceType: SOURCE_TYPES.FILE
    })
    expect(document.canonicalText).not.toContain('Presented to Parliament')
    expect(document.canonicalText).toContain('Section 1')
  })
})
