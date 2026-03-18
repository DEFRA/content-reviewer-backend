/**
 * canonical-document.text-normalisation.e2e.test.js
 *
 * E2E: Text normalisation is applied correctly through the real pipeline.
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

const DOC_ID = 'review_e2e-text-norm-00000001'

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
})

describe('text normalisation — real textNormaliser runs in pipeline', () => {
  it('normalises unicode ligatures (fi → fi)', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'The \uFB01nal report.',
      sourceType: SOURCE_TYPES.TEXT
    })
    // ligature \uFB01 (ﬁ) should be converted to plain "fi"
    expect(document.canonicalText).not.toContain('\uFB01')
    expect(document.canonicalText).toContain('final report')
  })

  it('normalises smart opening quote (\u2018) to straight apostrophe', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '\u2018quoted text\u2019',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).not.toContain('\u2018')
    expect(document.canonicalText).not.toContain('\u2019')
  })

  it('strips standalone page-number lines', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Introduction\n\nPage 1\n\nFirst paragraph of content.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).not.toMatch(/^Page 1$/m)
    expect(document.canonicalText).toContain('Introduction')
    expect(document.canonicalText).toContain('First paragraph of content.')
  })

  it('strips invisible control characters (BOM, zero-width space)', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      // BOM \uFEFF  and zero-width space \u200B
      text: '\uFEFFHello\u200B world.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).not.toContain('\uFEFF')
    expect(document.canonicalText).not.toContain('\u200B')
    expect(document.canonicalText).toContain('Hello')
  })

  it('preserves Markdown ATX heading markers', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '## Section 2\n\nContent here.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).toContain('## Section 2')
  })

  it('preserves bullet list markers', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '- First item\n- Second item',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).toContain('- First item')
    expect(document.canonicalText).toContain('- Second item')
  })

  it('preserves URLs without corruption', async () => {
    const url = 'https://www.gov.uk/guidance/some-policy?ref=abc&q=1'
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: `See ${url} for details.`,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).toContain(url)
  })

  it('collapses multiple blank lines to a single blank line', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Para one.\n\n\n\n\nPara two.',
      sourceType: SOURCE_TYPES.TEXT
    })
    // Should not have more than 2 consecutive newlines
    expect(document.canonicalText).not.toMatch(/\n{3,}/)
  })

  it('charCount matches canonicalText length after normalisation', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Normalisation \uFB01x test \u200B with extra   spaces.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.charCount).toBe(document.canonicalText.length)
  })
})
