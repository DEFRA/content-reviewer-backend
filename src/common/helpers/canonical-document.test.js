// canonical-document.constants.test.js
// Contains tests for exported constants (SOURCE_TYPES, CANONICAL_STATUS)

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

// ── Constants ─────────────────────────────────────────────────────────────────

const SOURCE_TYPES_KEY_COUNT = 3

describe('SOURCE_TYPES', () => {
  it('exports FILE = "file"', () => {
    expect(SOURCE_TYPES.FILE).toBe('file')
  })
  it('exports URL = "url"', () => {
    expect(SOURCE_TYPES.URL).toBe('url')
  })
  it('exports TEXT = "text"', () => {
    expect(SOURCE_TYPES.TEXT).toBe('text')
  })
  it(`has exactly ${SOURCE_TYPES_KEY_COUNT} keys`, () => {
    expect(Object.keys(SOURCE_TYPES)).toHaveLength(SOURCE_TYPES_KEY_COUNT)
  })
})

describe('CANONICAL_STATUS', () => {
  it('exports PENDING = "pending"', () => {
    expect(CANONICAL_STATUS.PENDING).toBe('pending')
  })
  it('exports PROCESSING = "processing"', () => {
    expect(CANONICAL_STATUS.PROCESSING).toBe('processing')
  })
  it('exports COMPLETED = "completed"', () => {
    expect(CANONICAL_STATUS.COMPLETED).toBe('completed')
  })
  it('exports FAILED = "failed"', () => {
    expect(CANONICAL_STATUS.FAILED).toBe('failed')
  })
  it('has exactly 4 keys', () => {
    expect(Object.keys(CANONICAL_STATUS)).toHaveLength(4)
  })
})

// ── getDocumentKey ────────────────────────────────────────────────────────────

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

// ── generateId ────────────────────────────────────────────────────────────────

describe('CanonicalDocumentStore.generateId', () => {
  it('returns a string starting with "review_"', () => {
    expect(canonicalDocumentStore.constructor.generateId()).toMatch(/^review_/)
  })
  it('produces unique IDs on successive calls', () => {
    const a = canonicalDocumentStore.constructor.generateId()
    const b = canonicalDocumentStore.constructor.generateId()
    expect(a).not.toBe(b)
  })
})

// ── _redactAndNormalise – section stripping ────────────────────────────────────

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

  it('does NOT strip for URL source type', () => {
    canonicalDocumentStore._redactAndNormalise({
      text: 'Some page content.',
      sourceType: SOURCE_TYPES.URL
    })
    expect(MOCK_SECTION_STRIP).not.toHaveBeenCalled()
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
  const text = 'Hello NI AB 12 34 56 C.'
  canonicalDocumentStore._redactAndNormalise({
    text,
    sourceType: SOURCE_TYPES.TEXT
  })
  expect(MOCK_PII_REDACT).toHaveBeenCalledWith(text)
})

it('passes redacted text to normaliser', () => {
  const original = 'Hello NI AB 12 34 56 C.'
  const redacted = 'Hello [NI_NUMBER_REDACTED].'
  MOCK_PII_REDACT.mockReturnValueOnce({
    redactedText: redacted,
    hasPII: true,
    redactionCount: 1
  })
  canonicalDocumentStore._redactAndNormalise({
    text: original,
    sourceType: SOURCE_TYPES.TEXT
  })
  expect(MOCK_NORMALISE).toHaveBeenCalledWith(redacted)
})

// ── _redactAndNormalise – normalisation ───────────────────────────────────────

describe('_redactAndNormalise normalisation', () => {
  it('calls textNormaliser.normalise with the redacted text', () => {
    canonicalDocumentStore._redactAndNormalise({
      text: 'Plain text.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(MOCK_NORMALISE).toHaveBeenCalledWith('Plain text.')
  })
})

// ── _redactAndNormalise – return values ───────────────────────────────────────

describe('_redactAndNormalise return values - basic return fields', () => {
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

describe('_redactAndNormalise return values - originType field', () => {
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

describe('_redactAndNormalise return values - sectionStripStats field', () => {
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

// ── _buildSourceMap ───────────────────────────────────────────────────────────

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

// ── _composeDocument ──────────────────────────────────────────────────────────

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
    expect(canonicalDocumentStore._composeDocument(baseArgs).documentId).toBe(
      DOCUMENT_ID
    )
  })
  it('includes sourceType', () => {
    expect(canonicalDocumentStore._composeDocument(baseArgs).sourceType).toBe(
      SOURCE_TYPES.TEXT
    )
  })
  it('includes canonicalText', () => {
    expect(
      canonicalDocumentStore._composeDocument(baseArgs).canonicalText
    ).toBe('Canonical text.')
  })
  it('includes charCount and tokenEst', () => {
    const doc = canonicalDocumentStore._composeDocument(baseArgs)
    expect(doc.charCount).toBe(CHAR_COUNT)
    expect(doc.tokenEst).toBe(4)
  })
  it('sets status to CANONICAL_STATUS.PENDING', () => {
    expect(canonicalDocumentStore._composeDocument(baseArgs).status).toBe(
      CANONICAL_STATUS.PENDING
    )
  })
  it('includes title when provided', () => {
    expect(canonicalDocumentStore._composeDocument(baseArgs).title).toBe(
      'My Document'
    )
  })
  it('omits title when null', () => {
    expect(
      canonicalDocumentStore._composeDocument({ ...baseArgs, title: null })
    ).not.toHaveProperty('title')
  })
  it('includes rawS3Key when provided', () => {
    expect(
      canonicalDocumentStore._composeDocument({
        ...baseArgs,
        rawS3Key: RAW_S3_KEY
      }).rawS3Key
    ).toBe(RAW_S3_KEY)
  })
  it('omits rawS3Key when null', () => {
    expect(
      canonicalDocumentStore._composeDocument({ ...baseArgs, rawS3Key: null })
    ).not.toHaveProperty('rawS3Key')
  })
  it('includes sourceMap array', () => {
    const map = [{ start: 0, end: 15, blockType: 'line' }]
    expect(
      canonicalDocumentStore._composeDocument({ ...baseArgs, sourceMap: map })
        .sourceMap
    ).toEqual(map)
  })
})

// ── _redactAndNormalise – HTML tag stripping for URL sources ──────────────────

describe('_redactAndNormalise URL source — stripHtmlTags branches', () => {
  it('strips HTML tags and inserts a space at tag boundaries', () => {
    // Input contains an opening and closing tag — exercises inTag=true,
    // inTag=false, and the space-insertion-at-> branch.
    MOCK_SECTION_STRIP.mockReturnValueOnce({
      strippedText: 'Hello World',
      stats: { sectionsRemoved: [] }
    })
    const result = canonicalDocumentStore._redactAndNormalise({
      text: '<p>Hello</p> World',
      sourceType: SOURCE_TYPES.URL
    })
    // stripHtmlTags runs before the mock; verify PII redactor received
    // the stripped+collapsed text (no angle brackets)
    const callArg = MOCK_PII_REDACT.mock.calls[0][0]
    expect(callArg).not.toContain('<')
    expect(callArg).not.toContain('>')
    expect(result.canonicalText).toBeDefined()
  })

  it('handles characters inside a tag (the discard branch)', () => {
    // Long attribute value exercises the "char inside tag — discard" else branch
    MOCK_SECTION_STRIP.mockReturnValueOnce({
      strippedText: 'Link text',
      stats: { sectionsRemoved: [] }
    })
    canonicalDocumentStore._redactAndNormalise({
      text: '<a href="https://www.gov.uk/some-very-long-path">Link text</a>',
      sourceType: SOURCE_TYPES.URL
    })
    const callArg = MOCK_PII_REDACT.mock.calls[0][0]
    expect(callArg).not.toContain('href')
    expect(callArg).not.toContain('<')
  })

  it('decodes HTML entities after tag stripping', () => {
    MOCK_SECTION_STRIP.mockReturnValueOnce({
      strippedText: 'cats & dogs',
      stats: { sectionsRemoved: [] }
    })
    canonicalDocumentStore._redactAndNormalise({
      text: '<p>cats &amp; dogs</p>',
      sourceType: SOURCE_TYPES.URL
    })
    const callArg = MOCK_PII_REDACT.mock.calls[0][0]
    // &amp; should have been decoded to & before reaching the PII redactor
    expect(callArg).toContain('&')
    expect(callArg).not.toContain('&amp;')
  })

  it('collapses multiple spaces on a line but preserves paragraph breaks', () => {
    canonicalDocumentStore._redactAndNormalise({
      text: '<div>word1   \n\n   word2</div>',
      sourceType: SOURCE_TYPES.URL
    })
    const callArg = MOCK_PII_REDACT.mock.calls[0][0]
    // Multiple horizontal spaces are collapsed to one; paragraph breaks (\n\n)
    // are preserved as structural separators — URL sources skip section stripping.
    expect(callArg).not.toMatch(/ {2,}/)
  })

  it('converts <li> elements to bullet markers (• ) for list preservation', () => {
    canonicalDocumentStore._redactAndNormalise({
      text: '<ul><li>Item one</li><li>Item two</li></ul>',
      sourceType: SOURCE_TYPES.URL
    })
    const callArg = MOCK_PII_REDACT.mock.calls[0][0]
    expect(callArg).toContain('• Item one')
    expect(callArg).toContain('• Item two')
    // Consecutive bullet items must be grouped (separated by \n not \n\n)
    expect(callArg).toMatch(/• Item one\n• Item two/)
  })

  it('keeps bullet items from the same list grouped on consecutive lines', () => {
    // Whitespace between </li> and <li> must not create paragraph breaks
    canonicalDocumentStore._redactAndNormalise({
      text: '<ul>\n  <li>First</li>\n  <li>Second</li>\n  <li>Third</li>\n</ul>',
      sourceType: SOURCE_TYPES.URL
    })
    const callArg = MOCK_PII_REDACT.mock.calls[0][0]
    // All three items must appear on consecutive lines (no \n\n between them)
    expect(callArg).toMatch(/• First\n• Second\n• Third/)
  })
})
