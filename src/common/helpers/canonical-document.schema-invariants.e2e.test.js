/**
 * canonical-document.schema-invariants.e2e.test.js
 *
 * E2E: Every document produced by createCanonicalDocument satisfies the
 * canonical schema invariants, regardless of input content or source type.
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

const DOC_ID = 'review_e2e-schema-invariants-00000001'

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
})

// ── Shared assertion helper ───────────────────────────────────────────────────

function assertSchemaInvariants(
  document,
  expectedDocumentId,
  expectedSourceType
) {
  // Required string fields
  expect(typeof document.documentId).toBe('string')
  expect(document.documentId).toBe(expectedDocumentId)

  expect(typeof document.sourceType).toBe('string')
  expect(document.sourceType).toBe(expectedSourceType)

  expect(typeof document.canonicalText).toBe('string')

  // charCount is a non-negative integer
  expect(typeof document.charCount).toBe('number')
  expect(Number.isInteger(document.charCount)).toBe(true)
  expect(document.charCount).toBeGreaterThanOrEqual(0)

  // charCount always equals canonicalText.length
  expect(document.charCount).toBe(document.canonicalText.length)

  // tokenEst is a non-negative integer
  expect(typeof document.tokenEst).toBe('number')
  expect(Number.isInteger(document.tokenEst)).toBe(true)
  expect(document.tokenEst).toBeGreaterThanOrEqual(0)

  // tokenEst is Math.round(charCount / 4)
  expect(document.tokenEst).toBe(Math.round(document.charCount / 4))

  // sourceMap is an array
  expect(Array.isArray(document.sourceMap)).toBe(true)

  // createdAt is an ISO 8601 string
  expect(typeof document.createdAt).toBe('string')
  expect(() => new Date(document.createdAt)).not.toThrow()
  expect(new Date(document.createdAt).toISOString()).toBe(document.createdAt)

  // status is always PENDING on creation
  expect(document.status).toBe(CANONICAL_STATUS.PENDING)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('schema invariants — TEXT source', () => {
  it('satisfies all schema invariants for plain text', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Schema invariants test with TEXT source.',
      sourceType: SOURCE_TYPES.TEXT
    })
    assertSchemaInvariants(document, DOC_ID, SOURCE_TYPES.TEXT)
  })

  it('satisfies invariants for empty-ish text (whitespace only)', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '   ',
      sourceType: SOURCE_TYPES.TEXT
    })
    assertSchemaInvariants(document, DOC_ID, SOURCE_TYPES.TEXT)
  })

  it('satisfies invariants for a single character', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'X',
      sourceType: SOURCE_TYPES.TEXT
    })
    assertSchemaInvariants(document, DOC_ID, SOURCE_TYPES.TEXT)
  })
})

describe('schema invariants — FILE source', () => {
  it('satisfies all schema invariants for file text', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Chapter 1\n\nIntroduction to the policy.',
      sourceType: SOURCE_TYPES.FILE
    })
    assertSchemaInvariants(document, DOC_ID, SOURCE_TYPES.FILE)
  })
})

describe('schema invariants — URL source', () => {
  it('satisfies all schema invariants for URL text', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Content scraped from a web page about environmental policy.',
      sourceType: SOURCE_TYPES.URL
    })
    assertSchemaInvariants(document, DOC_ID, SOURCE_TYPES.URL)
  })
})

const TEST_TEXT = 'Test text.'

describe('schema invariants — optional fields', () => {
  it('title is a string when provided', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: TEST_TEXT,
      sourceType: SOURCE_TYPES.TEXT,
      title: 'My Document Title'
    })
    expect(typeof document.title).toBe('string')
    expect(document.title).toBe('My Document Title')
  })

  it('title is absent (not null/undefined) when not provided', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: TEST_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document).not.toHaveProperty('title')
  })

  it('rawS3Key is a string when provided', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: TEST_TEXT,
      sourceType: SOURCE_TYPES.FILE,
      rawS3Key: 'uploads/review_abc/original.pdf'
    })
    expect(typeof document.rawS3Key).toBe('string')
    expect(document.rawS3Key).toBe('uploads/review_abc/original.pdf')
  })

  it('rawS3Key is absent when not provided', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: TEST_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document).not.toHaveProperty('rawS3Key')
  })
})

describe('schema invariants — return envelope shape', () => {
  it('top-level result has document, s3 and durationMs', async () => {
    const result = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Envelope shape test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(result).toHaveProperty('document')
    expect(result).toHaveProperty('s3')
    expect(result).toHaveProperty('durationMs')
  })

  it('s3 object has bucket, key and location', async () => {
    const result = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'S3 envelope test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(result.s3.bucket).toBe(S3_BUCKET)
    expect(result.s3.key).toBe(`documents/${DOC_ID}.json`)
    expect(result.s3.location).toBe(
      `s3://${S3_BUCKET}/documents/${DOC_ID}.json`
    )
  })

  it('durationMs is a non-negative number', async () => {
    const result = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Duration test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})

// ── linkMap invariants ───────────────────────────────────────────────────────

describe('schema invariants — linkMap field (map-based, URL sources only)', () => {
  it('URL source with links: document includes linkMap as a non-empty array', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '<p>See [the guidance](https://www.gov.uk/guidance) for details.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    // linkMap must be present and be a non-empty array for URL sources with Markdown links
    expect(document).toHaveProperty('linkMap')
    expect(Array.isArray(document.linkMap)).toBe(true)
    expect(document.linkMap.length).toBeGreaterThan(0)
  })

  it('URL source: canonicalText has Markdown links stripped to anchor text', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '<p>See [the guidance](https://www.gov.uk/guidance) for details.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    // canonicalText must not contain Markdown link syntax
    expect(document.canonicalText).toContain('the guidance')
    expect(document.canonicalText).not.toMatch(/\[the guidance\]\(https?:\/\//)
  })

  it('URL source: each linkMap entry has valid start, end and display fields', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '<p>See [the guidance](https://www.gov.uk/guidance) for details.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    for (const entry of document.linkMap) {
      expect(typeof entry.start).toBe('number')
      expect(typeof entry.end).toBe('number')
      expect(entry.end).toBeGreaterThan(entry.start)
      expect(typeof entry.display).toBe('string')
      // display must retain the full [anchor](url) syntax
      expect(entry.display).toMatch(/\[the guidance\]\(https?:\/\//)
    }
  })

  it('URL source: linkMap entry start/end correctly maps anchor text into canonicalText', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '<p>See [the guidance](https://www.gov.uk/guidance) for details.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    const entry = document.linkMap[0]
    // The slice of canonicalText at [start, end) must equal the anchor text
    const anchorInCanonical = document.canonicalText.slice(
      entry.start,
      entry.end
    )
    expect(anchorInCanonical).toBe('the guidance')
  })

  it('URL source without Markdown links: document does NOT include linkMap', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '<p>Plain text without any hyperlinks.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    // No links → linkMap is omitted entirely (not present on the document)
    expect(document).not.toHaveProperty('linkMap')
  })

  it('TEXT source: document does NOT include linkMap', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Plain text paste without links.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document).not.toHaveProperty('linkMap')
  })

  it('FILE source: document does NOT include linkMap', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Extracted text from an uploaded file.',
      sourceType: SOURCE_TYPES.FILE
    })
    expect(document).not.toHaveProperty('linkMap')
  })

  it('URL source: linkMap entry display contains the full Markdown link for each anchor', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: '<p>Apply [online](https://apply.service.gov.uk) now.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    // canonicalText has "online" (plain)
    expect(document.canonicalText).toContain('online')
    // linkMap entry display has "[online](https://apply.service.gov.uk)" (with link)
    const entry = document.linkMap[0]
    expect(entry.display).toContain('[online](https://apply.service.gov.uk)')
    // The anchor slice in canonicalText must be "online"
    expect(document.canonicalText.slice(entry.start, entry.end)).toBe('online')
  })
})
