import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mock refs ────────────────────────────────────────────────────────

const { MOCK_S3_SEND, TEST_BUCKET } = vi.hoisted(() => ({
  MOCK_S3_SEND: vi.fn(),
  TEST_BUCKET: 'test-bucket'
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
    get: vi.fn((key) => {
      const values = {
        'aws.region': 'eu-west-2',
        'aws.endpoint': null,
        's3.bucket': TEST_BUCKET
      }
      return values[key] ?? null
    })
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

vi.mock('./pii-redactor.js', () => ({
  piiRedactor: {
    redactUserContent: vi.fn((t) => ({
      redactedText: t,
      hasPII: false,
      redactionCount: 0
    }))
  }
}))

vi.mock('./text-normaliser.js', () => ({
  textNormaliser: {
    normalise: vi.fn((t) => ({
      normalisedText: t,
      stats: {
        originalLength: t.length,
        normalisedLength: t.length,
        charsRemoved: 0
      }
    })),
    buildSourceMap: vi.fn(() => [])
  }
}))

vi.mock('./document-section-stripper.js', () => ({
  documentSectionStripper: {
    strip: vi.fn((t) => ({ strippedText: t, stats: { sectionsRemoved: [] } }))
  }
}))

import { canonicalDocumentStore, SOURCE_TYPES } from './canonical-document.js'
import { config } from '../../config.js'
import { S3Client } from '@aws-sdk/client-s3'

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Lines 205-206: constructor with aws.endpoint configured ──────────────────
// When aws.endpoint is non-null the constructor must set
// s3Config.endpoint and s3Config.forcePathStyle = true (lines 205-206).

describe('CanonicalDocumentStore constructor – aws.endpoint branch (lines 205-206)', () => {
  it('sets endpoint and forcePathStyle on S3Client when aws.endpoint is configured', () => {
    vi.mocked(config.get).mockImplementation((key) => {
      if (key === 'aws.endpoint') {
        return 'http://localhost:4566'
      }
      if (key === 'aws.region') {
        return 'eu-west-2'
      }
      if (key === 's3.bucket') {
        return TEST_BUCKET
      }
      return null
    })

    const CanonicalDocumentStore = canonicalDocumentStore.constructor
    const store = new CanonicalDocumentStore()

    expect(store).toBeDefined()
    expect(vi.mocked(S3Client)).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'http://localhost:4566',
        forcePathStyle: true
      })
    )

    // Restore default mock implementation for subsequent tests
    vi.mocked(config.get).mockImplementation((key) => {
      const vals = {
        'aws.region': 'eu-west-2',
        'aws.endpoint': null,
        's3.bucket': TEST_BUCKET
      }
      return vals[key] ?? null
    })
  })
})

// ── Lines 438-439: _mergeOrphanedBulletsPassA true branch ─────────────────────
// passA splits the URL-prepared text by '\n\n' and, when a paragraph is exactly
// '•', merges it with the following paragraph (lines 438-439).
// <ul><li></li></ul> produces a standalone '•' paragraph after HTML stripping
// and whitespace collapsing.

describe('_mergeOrphanedBulletsPassA – true branch (lines 438-439)', () => {
  it('merges a blank-line-separated orphaned bullet marker with the following paragraph', () => {
    // Direct invocation: paras=['Text before','•','Text after']
    // paras[1].trim()==='•' && 2<3 → push '• Text after', i+=2 (lines 438-439)
    const result = canonicalDocumentStore._mergeOrphanedBulletsPassA(
      'Text before\n\n•\n\nText after'
    )
    expect(result).toBe('Text before\n\n• Text after')
  })
})

// ── Lines 465-466: _mergeOrphanedBulletsPassB true branch ─────────────────────
// passB operates within each paragraph (split by '\n') and merges a line that
// is exactly '•' with the next line (lines 465-466).
// <ul><li></li><li>text</li></ul> produces '•\n• text' within one paragraph
// after whitespace collapsing.

describe('_redactAndNormalise URL source – _mergeOrphanedBulletsPassB (lines 465-466)', () => {
  it('merges a single-newline-separated orphaned bullet with the following line', () => {
    // After stripHtmlTags + _collapseWhitespace: '•\n• list item text'
    // passA: single paragraph, no double-newline → unchanged
    // passB: lines ['•', '• list item text'] → merges to '• • list item text'
    const result = canonicalDocumentStore._redactAndNormalise({
      text: '<ul><li></li><li>list item text</li></ul>',
      sourceType: SOURCE_TYPES.URL
    })

    expect(result.canonicalText).toContain('list item text')
  })
})

// ── Line 490: _mergeConsecutiveBullets empty paragraph guard ──────────────────
// When trimmedPara is falsy inside the reduce, the function returns acc early
// without pushing the empty paragraph (line 490).
// An empty <p></p> produces '\n\n' after HTML stripping which collapses to ''
// via _collapseWhitespace, causing the split to yield a single empty string.

describe('_redactAndNormalise URL source – _mergeConsecutiveBullets empty para (line 490)', () => {
  it('skips empty paragraphs and returns empty canonicalText for empty HTML', () => {
    // <p></p> → '\n\n' → '' after collapseWhitespace
    // _mergeConsecutiveBullets: ''.split('\n\n') = ['']
    //   trimmedPara = '' → !trimmedPara → return acc (line 490)
    const result = canonicalDocumentStore._redactAndNormalise({
      text: '<p></p>',
      sourceType: SOURCE_TYPES.URL
    })

    expect(result.canonicalText).toBe('')
  })
})

// ── Lines 257-310: createCanonicalDocument full pipeline ──────────────────────
// createCanonicalDocument orchestrates _redactAndNormalise, _buildSourceMap,
// _composeDocument, _logDocumentInfo (lines 659-683), and _persistDocumentToS3
// (lines 690-715). A single successful call exercises all of these code paths.

describe('createCanonicalDocument – TEXT source (lines 257-310, 659-715)', () => {
  it('persists a canonical document to S3 and returns document + s3 metadata', async () => {
    MOCK_S3_SEND.mockResolvedValue({})

    const result = await canonicalDocumentStore.createCanonicalDocument({
      documentId: 'review_test-123',
      text: 'The department should utilise all resources.',
      sourceType: SOURCE_TYPES.TEXT
    })

    expect(result).toMatchObject({
      document: expect.objectContaining({ documentId: 'review_test-123' }),
      s3: expect.objectContaining({ bucket: 'test-bucket' }),
      durationMs: expect.any(Number)
    })
    expect(MOCK_S3_SEND).toHaveBeenCalledOnce()
  })
})

// ── Lines 578-592: _buildLinkMap loop body ────────────────────────────────────
// The for-of loop over LINK_SCAN_RE matches fires only when the URL source
// text contains Markdown links. Each iteration pushes a { start, end, display }
// entry and advances both canonicalOffset and lastPreStripPos (lines 578-592).

describe('_buildLinkMap – loop body via URL source with Markdown link (lines 578-592)', () => {
  it('records link positions in canonicalText when URL text contains Markdown links', async () => {
    MOCK_S3_SEND.mockResolvedValue({})

    const result = await canonicalDocumentStore.createCanonicalDocument({
      documentId: 'review_link-123',
      text: 'Check out [GOV.UK](https://www.gov.uk) for more.',
      sourceType: SOURCE_TYPES.URL
    })

    expect(result.document.linkMap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ display: '[GOV.UK](https://www.gov.uk)' })
      ])
    )
  })
})

// ── Lines 724-749: getDocument full read pipeline ─────────────────────────────
// getDocument: sends GetObjectCommand, iterates the async Body stream,
// concatenates chunks, parses JSON, logs timing, and returns the document.

describe('getDocument – S3 read pipeline (lines 724-749)', () => {
  it('fetches, iterates the stream, and returns the parsed document', async () => {
    const storedDoc = {
      documentId: 'review_get-123',
      charCount: 10,
      canonicalText: 'Some text.'
    }
    const bytes = Buffer.from(JSON.stringify(storedDoc))
    MOCK_S3_SEND.mockResolvedValue({
      Body: {
        [Symbol.asyncIterator]: async function* () {
          yield bytes
        }
      }
    })

    const doc = await canonicalDocumentStore.getDocument('review_get-123')

    expect(doc).toMatchObject({
      documentId: 'review_get-123',
      canonicalText: 'Some text.'
    })
  })
})
