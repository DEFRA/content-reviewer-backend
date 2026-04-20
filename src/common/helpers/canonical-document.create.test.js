// canonical-document.create.test.js
// Tests for createCanonicalDocument and getDocument.
// Extracted from canonical-document.test.js to keep each file ≤ 500 lines.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mock refs ────────────────────────────────────────────────────────

const {
  MOCK_S3_SEND,
  MOCK_PII_REDACT,
  MOCK_NORMALISE,
  MOCK_BUILD_SOURCE_MAP,
  MOCK_SECTION_STRIP,
  S3_BUCKET
} = vi.hoisted(() => ({
  MOCK_S3_SEND: vi.fn(),
  MOCK_PII_REDACT: vi.fn(),
  MOCK_NORMALISE: vi.fn(),
  MOCK_BUILD_SOURCE_MAP: vi.fn(),
  MOCK_SECTION_STRIP: vi.fn(),
  S3_BUCKET: 'test-cdp-bucket'
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
        's3.bucket': S3_BUCKET
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

vi.mock('./document-section-stripper.js', () => ({
  documentSectionStripper: { strip: MOCK_SECTION_STRIP }
}))

vi.mock('./pii-redactor.js', () => ({
  piiRedactor: { redactUserContent: MOCK_PII_REDACT }
}))

vi.mock('./text-normaliser.js', () => ({
  textNormaliser: {
    normalise: MOCK_NORMALISE,
    buildSourceMap: MOCK_BUILD_SOURCE_MAP
  }
}))

import {
  canonicalDocumentStore,
  SOURCE_TYPES,
  CANONICAL_STATUS
} from './canonical-document.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'review_abc123-def456'
const RAW_S3_KEY = 'uploads/review_abc123-def456/original.pdf'
const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog.'

function makePiiResult(text, hasPII = false) {
  return { redactedText: text, hasPII, redactionCount: hasPII ? 1 : 0 }
}

function makeNormResult(text) {
  return {
    normalisedText: text,
    stats: {
      originalLength: text.length,
      normalisedLength: text.length,
      charsRemoved: 0
    }
  }
}

function makeS3Body(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj))
  return {
    [Symbol.asyncIterator]: async function* () {
      yield bytes
    }
  }
}

// ── beforeEach ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
  MOCK_PII_REDACT.mockImplementation((t) => makePiiResult(t))
  MOCK_NORMALISE.mockImplementation((t) => makeNormResult(t))
  MOCK_BUILD_SOURCE_MAP.mockReturnValue([])
  MOCK_SECTION_STRIP.mockImplementation((t) => ({
    strippedText: t,
    stats: { sectionsRemoved: [] }
  }))
})

// ── createCanonicalDocument – return shape ────────────────────────────────────

describe('createCanonicalDocument - return shape (structure)', () => {
  it('returns { document, s3, durationMs }', async () => {
    const result = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(result).toHaveProperty('document')
    expect(result).toHaveProperty('s3')
    expect(result).toHaveProperty('durationMs')
  })

  it('s3 object has bucket, key, and location', async () => {
    const result = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(result.s3.bucket).toBe(S3_BUCKET)
    expect(result.s3.key).toBe(`documents/${DOCUMENT_ID}.json`)
    expect(result.s3.location).toBe(
      `s3://${S3_BUCKET}/documents/${DOCUMENT_ID}.json`
    )
  })
})

describe('createCanonicalDocument - return shape (document fields)', () => {
  it('document has required schema fields', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document).toHaveProperty('documentId', DOCUMENT_ID)
    expect(document).toHaveProperty('sourceType', SOURCE_TYPES.TEXT)
    expect(document).toHaveProperty('canonicalText')
    expect(document).toHaveProperty('charCount')
    expect(document).toHaveProperty('tokenEst')
    expect(document).toHaveProperty('sourceMap')
    expect(document).toHaveProperty('createdAt')
    expect(document).toHaveProperty('status', CANONICAL_STATUS.PENDING)
  })

  it('document.charCount equals canonicalText.length', async () => {
    MOCK_NORMALISE.mockReturnValueOnce(makeNormResult(SAMPLE_TEXT))
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.charCount).toBe(SAMPLE_TEXT.length)
  })

  it('document.tokenEst ≈ charCount / 4', async () => {
    const text = 'A'.repeat(100)
    MOCK_NORMALISE.mockReturnValueOnce(makeNormResult(text))
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document.tokenEst).toBe(text.length / 4)
  })
})

describe('createCanonicalDocument - return shape (optional fields)', () => {
  it('includes title in document when provided', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.TEXT,
      title: 'My Policy Paper'
    })
    expect(document.title).toBe('My Policy Paper')
  })

  it('omits title when not provided', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document).not.toHaveProperty('title')
  })

  it('includes rawS3Key in document when provided', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.FILE,
      rawS3Key: RAW_S3_KEY
    })
    expect(document.rawS3Key).toBe(RAW_S3_KEY)
  })

  it('omits rawS3Key when not provided', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(document).not.toHaveProperty('rawS3Key')
  })
})

// ── createCanonicalDocument – S3 persistence ──────────────────────────────────

describe('createCanonicalDocument - S3 persistence', () => {
  it('calls S3 send once (PutObjectCommand)', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(MOCK_S3_SEND).toHaveBeenCalledOnce()
  })

  it('puts object to the correct S3 key', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.Key).toBe(`documents/${DOCUMENT_ID}.json`)
    expect(putCmd.Bucket).toBe(S3_BUCKET)
  })

  it('uploads JSON with ContentType application/json', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.ContentType).toBe('application/json')
  })

  it('includes metadata on the S3 put command', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.Metadata).toMatchObject({
      documentId: DOCUMENT_ID,
      sourceType: SOURCE_TYPES.TEXT,
      piiRedacted: 'false'
    })
  })

  it('sets piiRedacted=true in metadata when PII is found', async () => {
    MOCK_PII_REDACT.mockReturnValueOnce({
      redactedText: 'Hello [NI_NUMBER_REDACTED].',
      hasPII: true,
      redactionCount: 1
    })
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: 'Hello AB123456C.',
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.Metadata.piiRedacted).toBe('true')
  })

  it('propagates S3 errors', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('S3 network error'))
    await expect(
      canonicalDocumentStore.createCanonicalDocument({
        documentId: DOCUMENT_ID,
        text: SAMPLE_TEXT,
        sourceType: SOURCE_TYPES.TEXT
      })
    ).rejects.toThrow('S3 network error')
  })
})

// ── createCanonicalDocument – pipeline ordering ────────────────────────────────

describe('createCanonicalDocument - pipeline ordering', () => {
  it('calls stripper → PII redactor → normaliser in order (FILE source)', async () => {
    const callOrder = []
    MOCK_SECTION_STRIP.mockImplementation((t) => {
      callOrder.push('strip')
      return { strippedText: t, stats: { sectionsRemoved: [] } }
    })
    MOCK_PII_REDACT.mockImplementation((t) => {
      callOrder.push('pii')
      return makePiiResult(t)
    })
    MOCK_NORMALISE.mockImplementation((t) => {
      callOrder.push('normalise')
      return makeNormResult(t)
    })
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.FILE
    })
    expect(callOrder).toEqual(['strip', 'pii', 'normalise'])
  })

  it('skips stripper for TEXT source and runs PII then normalise', async () => {
    const callOrder = []
    MOCK_SECTION_STRIP.mockImplementation(() => {
      callOrder.push('strip')
      return { strippedText: '', stats: {} }
    })
    MOCK_PII_REDACT.mockImplementation((t) => {
      callOrder.push('pii')
      return makePiiResult(t)
    })
    MOCK_NORMALISE.mockImplementation((t) => {
      callOrder.push('normalise')
      return makeNormResult(t)
    })
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(callOrder).toEqual(['pii', 'normalise'])
  })
})

describe('createCanonicalDocument - sourceType defaults', () => {
  it('defaults sourceType to TEXT when not provided', async () => {
    const { document } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOCUMENT_ID,
      text: SAMPLE_TEXT
    })
    expect(document.sourceType).toBe(SOURCE_TYPES.TEXT)
  })
})

describe('createCanonicalDocument - stripped sections log branch (L690)', () => {
  it('logs stripped front-matter section names when sectionsRemoved is non-empty', async () => {
    MOCK_SECTION_STRIP.mockReturnValueOnce({
      strippedText: 'Body content.',
      stats: { sectionsRemoved: ['titlePage', 'toc'] }
    })

    // Should not throw; the logger.info inside _logDocumentInfo takes the
    // sectionStripMsg truthy branch when sectionsRemoved.length > 0
    await expect(
      canonicalDocumentStore.createCanonicalDocument({
        documentId: DOCUMENT_ID,
        text: 'Title Page\nBody content.',
        sourceType: SOURCE_TYPES.FILE
      })
    ).resolves.toBeDefined()
  })
})

// ── getDocument ───────────────────────────────────────────────────────────────

function makeStoredDoc(overrides = {}) {
  return {
    documentId: DOCUMENT_ID,
    sourceType: SOURCE_TYPES.FILE,
    rawS3Key: RAW_S3_KEY,
    canonicalText: 'Sample canonical text.',
    charCount: 22,
    tokenEst: 6,
    sourceMap: [],
    createdAt: '2026-03-13T10:00:00.000Z',
    status: CANONICAL_STATUS.PENDING,
    ...overrides
  }
}

describe('getDocument', () => {
  it('reads from S3 using the correct key', async () => {
    const stored = makeStoredDoc()
    MOCK_S3_SEND.mockResolvedValueOnce({ Body: makeS3Body(stored) })
    await canonicalDocumentStore.getDocument(DOCUMENT_ID)
    const [[getCmd]] = MOCK_S3_SEND.mock.calls
    expect(getCmd.Key).toBe(`documents/${DOCUMENT_ID}.json`)
    expect(getCmd.Bucket).toBe(S3_BUCKET)
  })

  it('returns the parsed document object', async () => {
    const stored = makeStoredDoc()
    MOCK_S3_SEND.mockResolvedValueOnce({ Body: makeS3Body(stored) })
    const doc = await canonicalDocumentStore.getDocument(DOCUMENT_ID)
    expect(doc).toEqual(stored)
  })

  it('returns the correct canonicalText', async () => {
    const stored = makeStoredDoc({ canonicalText: 'Specific canonical text.' })
    MOCK_S3_SEND.mockResolvedValueOnce({ Body: makeS3Body(stored) })
    const doc = await canonicalDocumentStore.getDocument(DOCUMENT_ID)
    expect(doc.canonicalText).toBe('Specific canonical text.')
  })

  it('propagates S3 errors', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('NoSuchKey'))
    await expect(
      canonicalDocumentStore.getDocument(DOCUMENT_ID)
    ).rejects.toThrow('NoSuchKey')
  })
})
