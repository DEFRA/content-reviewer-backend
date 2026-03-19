/**
 * canonical-document.methods.test.js
 *
 * Unit tests for the private/internal methods of CanonicalDocumentStore:
 *   - getDocumentKey
 *   - generateId  (static)
 *   - _redactAndNormalise
 *   - _buildSourceMap
 *   - _composeDocument
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ───────────────────────────────────────────────────────────

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

// Hoisted mocks for helper modules
vi.mock('./document-section-stripper.js', () => ({
  documentSectionStripper: {
    strip: MOCK_SECTION_STRIP
  }
}))
vi.mock('./pii-redactor.js', () => ({
  piiRedactor: {
    redactUserContent: MOCK_PII_REDACT
  }
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

const CanonicalDocumentStore = canonicalDocumentStore.constructor

// ── Helpers ─────────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'review_abc123-def456'
const RAW_S3_KEY = 'uploads/review_abc123-def456/original.pdf'

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

// ── beforeEach ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_PII_REDACT.mockImplementation((t) => makePiiResult(t))
  MOCK_NORMALISE.mockImplementation((t) => makeNormResult(t))
  MOCK_BUILD_SOURCE_MAP.mockReturnValue([])
  MOCK_SECTION_STRIP.mockImplementation((t) => ({
    strippedText: t,
    stats: { sectionsRemoved: [] }
  }))
})

// ── getDocumentKey ───────────────────────────────────────────────────────────

describe('getDocumentKey', () => {
  it('returns documents/{documentId}.json', () => {
    expect(canonicalDocumentStore.getDocumentKey(DOCUMENT_ID)).toBe(
      `documents/${DOCUMENT_ID}.json`
    )
  })

  it('uses the "documents" prefix', () => {
    expect(canonicalDocumentStore.getDocumentKey('review_xyz')).toMatch(
      /^documents\//
    )
  })
})

// ── generateId (static) ──────────────────────────────────────────────────────

describe('CanonicalDocumentStore.generateId', () => {
  it('returns a string starting with "review_"', () => {
    const id = CanonicalDocumentStore.generateId()
    expect(id).toMatch(/^review_/)
  })

  it('produces unique IDs on successive calls', () => {
    const a = CanonicalDocumentStore.generateId()
    const b = CanonicalDocumentStore.generateId()
    expect(a).not.toBe(b)
  })
})

// ── _redactAndNormalise ───────────────────────────────────────────────────────

const DUPLICATE_PII_TEXT = 'Hello NI AB 12 34 56 C.'

// Section stripping tests for _redactAndNormalise
describe('_redactAndNormalise section stripping', () => {
  it('does NOT strip for TEXT source type', () => {
    canonicalDocumentStore._redactAndNormalise({
      text: 'Hello world.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(MOCK_SECTION_STRIP).not.toHaveBeenCalled()
  })

  it('DOES strip for FILE source type', () => {
    MOCK_SECTION_STRIP.mockReturnValueOnce({
      strippedText: 'Body text.',
      stats: { sectionsRemoved: ['titlePage'] }
    })
    canonicalDocumentStore._redactAndNormalise({
      text: 'Title Page\nBody text.',
      sourceType: SOURCE_TYPES.FILE
    })
    expect(MOCK_SECTION_STRIP).toHaveBeenCalledOnce()
  })

  it('DOES strip for URL source type', () => {
    canonicalDocumentStore._redactAndNormalise({
      text: 'Some page content.',
      sourceType: SOURCE_TYPES.URL
    })
    expect(MOCK_SECTION_STRIP).toHaveBeenCalledOnce()
  })

  it('passes stripped text to PII redactor', () => {
    MOCK_SECTION_STRIP.mockReturnValueOnce({
      strippedText: 'Stripped body.',
      stats: { sectionsRemoved: ['titlePage'] }
    })
    canonicalDocumentStore._redactAndNormalise({
      text: 'Title.\fStripped body.',
      sourceType: SOURCE_TYPES.FILE
    })
    expect(MOCK_PII_REDACT).toHaveBeenCalledWith('Stripped body.')
  })
})

it('calls piiRedactor.redactUserContent with the working text', () => {
  canonicalDocumentStore._redactAndNormalise({
    text: DUPLICATE_PII_TEXT,
    sourceType: SOURCE_TYPES.TEXT
  })
  expect(MOCK_PII_REDACT).toHaveBeenCalledWith(DUPLICATE_PII_TEXT)
})

const REDACTED_NI_TEXT = 'Hello [NI_NUMBER_REDACTED].'

it('passes redacted text to normaliser', () => {
  MOCK_PII_REDACT.mockReturnValueOnce({
    redactedText: REDACTED_NI_TEXT,
    hasPII: true,
    redactionCount: 1
  })
  canonicalDocumentStore._redactAndNormalise({
    text: DUPLICATE_PII_TEXT,
    sourceType: SOURCE_TYPES.TEXT
  })
  expect(MOCK_NORMALISE).toHaveBeenCalledWith(REDACTED_NI_TEXT)
  expect(MOCK_NORMALISE).toHaveBeenCalledWith(REDACTED_NI_TEXT)
})

// Normalisation tests for _redactAndNormalise
describe('_redactAndNormalise normalisation', () => {
  it('calls textNormaliser.normalise with the redacted text', () => {
    canonicalDocumentStore._redactAndNormalise({
      text: 'Plain text.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(MOCK_NORMALISE).toHaveBeenCalledWith('Plain text.')
  })
})

// Return value tests for _redactAndNormalise
describe('_redactAndNormalise return values - canonicalText and charCount', () => {
  it('returns canonicalText from normaliser output', () => {
    MOCK_NORMALISE.mockReturnValueOnce(makeNormResult('Normalised text.'))
    const result = canonicalDocumentStore._redactAndNormalise({
      text: 'Raw text.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(result.canonicalText).toBe('Normalised text.')
  })

  it('computes charCount from canonicalText length', () => {
    const text = 'Exactly 20 char text.'
    MOCK_NORMALISE.mockReturnValueOnce(makeNormResult(text))
    const result = canonicalDocumentStore._redactAndNormalise({
      text,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(result.charCount).toBe(text.length)
  })
})

describe('_redactAndNormalise return values - tokenEst and createdAt', () => {
  it('computes tokenEst as Math.round(charCount / 4)', () => {
    const text = 'A'.repeat(100)
    MOCK_NORMALISE.mockReturnValueOnce(makeNormResult(text))
    const result = canonicalDocumentStore._redactAndNormalise({
      text,
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(result.tokenEst).toBe(Math.round(text.length / 4))
  })

  it('returns ISO 8601 createdAt string', () => {
    const result = canonicalDocumentStore._redactAndNormalise({
      text: 'Hi.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('_redactAndNormalise return values - originType', () => {
  it('sets originType to "textarea" for TEXT source', () => {
    const result = canonicalDocumentStore._redactAndNormalise({
      text: 'Hi.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(result.originType).toBe('textarea')
  })

  it('sets originType to "page" for FILE source', () => {
    const result = canonicalDocumentStore._redactAndNormalise({
      text: 'Hi.',
      sourceType: SOURCE_TYPES.FILE
    })
    expect(result.originType).toBe('page')
  })

  it('sets originType to "url" for URL source', () => {
    const result = canonicalDocumentStore._redactAndNormalise({
      text: 'Hi.',
      sourceType: SOURCE_TYPES.URL
    })
    expect(result.originType).toBe('url')
  })
})

describe('_redactAndNormalise return values - sectionStripStats', () => {
  it('returns sectionStripStats = null for TEXT source', () => {
    const result = canonicalDocumentStore._redactAndNormalise({
      text: 'Hi.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(result.sectionStripStats).toBeNull()
  })

  it('returns sectionStripStats from stripper for FILE source', () => {
    MOCK_SECTION_STRIP.mockReturnValueOnce({
      strippedText: 'Body.',
      stats: { sectionsRemoved: ['titlePage', 'toc'] }
    })
    const result = canonicalDocumentStore._redactAndNormalise({
      text: 'Title.\nBody.',
      sourceType: SOURCE_TYPES.FILE
    })
    expect(result.sectionStripStats).toEqual({
      sectionsRemoved: ['titlePage', 'toc']
    })
  })
})

// ── _buildSourceMap ──────────────────────────────────────────────────────────

describe('_buildSourceMap', () => {
  it('calls textNormaliser.buildSourceMap with correct arguments', () => {
    const fakeMap = [{ start: 0, end: 5 }]
    MOCK_BUILD_SOURCE_MAP.mockReturnValueOnce(fakeMap)

    const result = canonicalDocumentStore._buildSourceMap({
      canonicalText: 'Hello',
      originType: 'textarea',
      rawS3Key: RAW_S3_KEY
    })

    expect(MOCK_BUILD_SOURCE_MAP).toHaveBeenCalledWith(
      'Hello',
      'textarea',
      RAW_S3_KEY
    )
    expect(result).toBe(fakeMap)
  })

  it('passes null when rawS3Key is falsy', () => {
    canonicalDocumentStore._buildSourceMap({
      canonicalText: 'Hello',
      originType: 'textarea',
      rawS3Key: null
    })
    expect(MOCK_BUILD_SOURCE_MAP).toHaveBeenCalledWith(
      'Hello',
      'textarea',
      null
    )
  })
})

// ── _composeDocument ─────────────────────────────────────────────────────────

describe('_composeDocument', () => {
  const CHAR_COUNT = 15
  const baseArgs = {
    documentId: DOCUMENT_ID,
    sourceType: SOURCE_TYPES.TEXT,
    rawS3Key: null,
    canonicalText: 'Canonical text.',
    charCount: CHAR_COUNT,
    tokenEst: 4,
    sourceMap: [],
    createdAt: '2026-03-17T10:00:00.000Z',
    title: 'My Document'
  }

  it('includes documentId', () => {
    const doc = canonicalDocumentStore._composeDocument(baseArgs)
    expect(doc.documentId).toBe(DOCUMENT_ID)
  })

  it('includes sourceType', () => {
    const doc = canonicalDocumentStore._composeDocument(baseArgs)
    expect(doc.sourceType).toBe(SOURCE_TYPES.TEXT)
  })

  it('includes canonicalText', () => {
    const doc = canonicalDocumentStore._composeDocument(baseArgs)
    expect(doc.canonicalText).toBe('Canonical text.')
  })
  it('includes charCount and tokenEst', () => {
    const doc = canonicalDocumentStore._composeDocument(baseArgs)
    expect(doc.charCount).toBe(CHAR_COUNT)
    expect(doc.tokenEst).toBe(4)
  })

  it('sets status to CANONICAL_STATUS.PENDING', () => {
    const doc = canonicalDocumentStore._composeDocument(baseArgs)
    expect(doc.status).toBe(CANONICAL_STATUS.PENDING)
  })

  it('includes title when provided', () => {
    const doc = canonicalDocumentStore._composeDocument(baseArgs)
    expect(doc.title).toBe('My Document')
  })

  it('omits title when null', () => {
    const doc = canonicalDocumentStore._composeDocument({
      ...baseArgs,
      title: null
    })
    expect(doc).not.toHaveProperty('title')
  })

  it('includes rawS3Key when provided', () => {
    const doc = canonicalDocumentStore._composeDocument({
      ...baseArgs,
      rawS3Key: RAW_S3_KEY
    })
    expect(doc.rawS3Key).toBe(RAW_S3_KEY)
  })

  it('omits rawS3Key when null', () => {
    const doc = canonicalDocumentStore._composeDocument({
      ...baseArgs,
      rawS3Key: null
    })
    expect(doc).not.toHaveProperty('rawS3Key')
  })

  it('includes sourceMap array', () => {
    const map = [{ start: 0, end: 15, blockType: 'line' }]
    const doc = canonicalDocumentStore._composeDocument({
      ...baseArgs,
      sourceMap: map
    })
    expect(doc.sourceMap).toEqual(map)
  })
})
