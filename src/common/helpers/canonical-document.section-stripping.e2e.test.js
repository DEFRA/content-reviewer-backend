/**
 * canonical-document.section-stripping.e2e.test.js
 *
 * E2E: Front-matter sections (title page, copyright, TOC) are stripped from
 * FILE and URL sources but preserved for TEXT sources.
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

const DOC_ID = 'review_e2e-section-strip-00000001'

// A realistic document with a title page, copyright page, TOC and body
const DOCUMENT_WITH_FRONT_MATTER = [
  // Page 0: title page (short, contains "Presented to Parliament")
  'My Policy Document\nPresented to Parliament by the Secretary of State\nJune 2026\nCP 1234',
  // Page 1: copyright page
  "© Crown copyright 2026\nPublished by His Majesty's Stationery Office\nISBN 978-1-5286-0000-0",
  // Page 2: table of contents
  'Contents\n\n1. Introduction .............. 5\n2. Background ................ 7\n3. Conclusions .............. 12',
  // Page 3+: body
  '1. Introduction\n\nThis document sets out the policy framework.',
  '2. Background\n\nHistory of the policy dates back to 2010.'
].join('\n\n')

const BODY_CONTENT =
  '1. Introduction\n\nThis document sets out the policy framework.'

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
})

describe('section stripping — FILE source strips front-matter', () => {
  it('removes the title page from FILE source output', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: DOCUMENT_WITH_FRONT_MATTER,
      sourceType: SOURCE_TYPES.FILE
    })
    expect(document.canonicalText).not.toContain('Presented to Parliament')
  })

  it('removes the copyright page from FILE source output', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: DOCUMENT_WITH_FRONT_MATTER,
      sourceType: SOURCE_TYPES.FILE
    })
    expect(document.canonicalText).not.toContain('Crown copyright')
  })

  it('removes the table of contents from FILE source output', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: DOCUMENT_WITH_FRONT_MATTER,
      sourceType: SOURCE_TYPES.FILE
    })
    // TOC dot-leader pattern should not appear
    expect(document.canonicalText).not.toMatch(/\.{4,}/)
  })

  it('preserves body content after stripping front-matter from FILE source', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: DOCUMENT_WITH_FRONT_MATTER,
      sourceType: SOURCE_TYPES.FILE
    })
    expect(document.canonicalText).toContain('Introduction')
    expect(document.canonicalText).toContain('policy framework')
  })

  it('removes the table of contents from URL source output', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: DOCUMENT_WITH_FRONT_MATTER,
      sourceType: SOURCE_TYPES.URL
    })
    expect(document.canonicalText).not.toMatch(/\.{4,}/)
  })
})

describe('section stripping — TEXT source preserves everything', () => {
  it('does NOT strip front-matter signals from TEXT source (user paste)', async () => {
    // If a user deliberately pastes something that looks like a TOC, we keep it
    const userPaste =
      'My notes:\n\nContents\n\n1. Topic A ........... 1\n\nActual content here.'
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: userPaste,
      sourceType: SOURCE_TYPES.TEXT
    })
    // The TOC-like entry should be preserved because sourceType is TEXT
    expect(document.canonicalText).toContain('Topic A')
  })

  it('preserves copyright-like text in TEXT source', async () => {
    const userPaste =
      '© Copyright 2026 My Organisation. All rights reserved.\n\nPolicy text follows.'
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: userPaste,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.canonicalText).toContain('© Copyright 2026')
  })
})

describe('section stripping — charCount reflects stripped result', () => {
  it('charCount for FILE source is less than the raw input length', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: DOCUMENT_WITH_FRONT_MATTER,
      sourceType: SOURCE_TYPES.FILE
    })
    expect(document.charCount).toBeLessThan(DOCUMENT_WITH_FRONT_MATTER.length)
  })

  it('charCount still equals canonicalText.length after stripping', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: DOCUMENT_WITH_FRONT_MATTER,
      sourceType: SOURCE_TYPES.FILE
    })
    expect(document.charCount).toBe(document.canonicalText.length)
  })
})

describe('section stripping — minimal document with only body', () => {
  it('returns body content unchanged when no front-matter present', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: BODY_CONTENT,
      sourceType: SOURCE_TYPES.FILE
    })
    expect(document.canonicalText).toContain('Introduction')
    expect(document.canonicalText).toContain('policy framework')
  })
})
