// canonical-document.url-stripping.test.js
// Tests for the URL HTML-stripping path in _redactAndNormalise.
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

import { canonicalDocumentStore, SOURCE_TYPES } from './canonical-document.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── _redactAndNormalise – URL HTML stripping ──────────────────────────────────
// These tests verify what the PII redactor receives after HTML stripping so we
// can assert word-split and paragraph-preservation behaviour without needing
// to bypass the hoisted mocks.

describe('_redactAndNormalise – URL HTML stripping: word preservation', () => {
  it('does not split words wrapped in inline <span> tags', () => {
    // "farm<span>ers</span>" must become "farmers", not "farm ers"
    canonicalDocumentStore._redactAndNormalise({
      text: '<p>The <span>farm</span><span>ers</span> need support.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    const textPassedToPii = MOCK_PII_REDACT.mock.calls[0][0]
    expect(textPassedToPii).toContain('farmers')
    expect(textPassedToPii).not.toMatch(/farm\s+ers/)
  })

  it('does not split words wrapped in inline <strong> tags', () => {
    canonicalDocumentStore._redactAndNormalise({
      text: '<p>con<strong>firm</strong>ation</p>',
      sourceType: SOURCE_TYPES.URL
    })
    const textPassedToPii = MOCK_PII_REDACT.mock.calls[0][0]
    expect(textPassedToPii).toContain('confirmation')
  })

  it('inserts a newline between block-level elements', () => {
    canonicalDocumentStore._redactAndNormalise({
      text: '<p>First paragraph.</p><p>Second paragraph.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    const textPassedToPii = MOCK_PII_REDACT.mock.calls[0][0]
    // block tags produce \n so the two paragraphs are on separate lines
    expect(textPassedToPii).toMatch(/First paragraph\.\s+Second paragraph\./)
  })
})

describe('_redactAndNormalise – URL HTML stripping: paragraph structure', () => {
  it('preserves paragraph breaks as distinct lines (not collapsed to spaces)', () => {
    canonicalDocumentStore._redactAndNormalise({
      text: '<p>Paragraph one.</p>\n<p>Paragraph two.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    const textPassedToPii = MOCK_PII_REDACT.mock.calls[0][0]
    // Should NOT produce "Paragraph one. Paragraph two." on a single line
    expect(textPassedToPii).not.toBe('Paragraph one. Paragraph two.')
    // Each paragraph should be on its own line
    const lines = textPassedToPii
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    expect(lines).toContain('Paragraph one.')
    expect(lines).toContain('Paragraph two.')
  })

  it('strips the HTML <head> and <title> so "Extracted content" does not appear', () => {
    canonicalDocumentStore._redactAndNormalise({
      text: '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="source-url" content="https://www.gov.uk/test"></head><body><section><p>Real content here.</p></section></body></html>',
      sourceType: SOURCE_TYPES.URL
    })
    const textPassedToPii = MOCK_PII_REDACT.mock.calls[0][0]
    expect(textPassedToPii).not.toContain('Extracted content')
    expect(textPassedToPii).toContain('Real content here.')
  })

  it('does not collapse multiple paragraphs into a single space-separated line', () => {
    canonicalDocumentStore._redactAndNormalise({
      text: '<section><p>Line A.</p><p>Line B.</p><p>Line C.</p></section>',
      sourceType: SOURCE_TYPES.URL
    })
    const textPassedToPii = MOCK_PII_REDACT.mock.calls[0][0]
    expect(textPassedToPii).not.toBe('Line A. Line B. Line C.')
  })
})

describe('_redactAndNormalise – URL HTML stripping: linkMap building', () => {
  it('strips Markdown links [text](url) from canonicalText so Bedrock sees clean prose', () => {
    // The map-based approach strips Markdown links from canonicalText (used by Bedrock)
    // and builds a linkMap recording their positions for rendering plain sections.
    canonicalDocumentStore._redactAndNormalise({
      text: '<p>See [the guidance](https://www.gov.uk/guidance/test) for details.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    // canonicalText path (first PII call) should have the link stripped to anchor text only
    const canonicalPassedToPii = MOCK_PII_REDACT.mock.calls[0][0]
    expect(canonicalPassedToPii).toContain('the guidance')
    expect(canonicalPassedToPii).not.toContain(
      '[the guidance](https://www.gov.uk/guidance/test)'
    )
  })

  it('preserves [text](url) Markdown links in the preStripText path (second PII call) for URL sources', () => {
    // The preStripText path goes through a separate PII call with links intact
    // so the linkMap can be built after normalisation
    canonicalDocumentStore._redactAndNormalise({
      text: '<p>See [the guidance](https://www.gov.uk/guidance/test) for details.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    // preStripText path (second PII call) must retain the full Markdown link
    const preStripPassedToPii = MOCK_PII_REDACT.mock.calls[1][0]
    expect(preStripPassedToPii).toContain(
      '[the guidance](https://www.gov.uk/guidance/test)'
    )
  })

  it('returns a linkMap with correct offsets for URL sources with Markdown links', () => {
    const result = canonicalDocumentStore._redactAndNormalise({
      text: '<p>See [the guidance](https://www.gov.uk/guidance/test) for details.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    expect(Array.isArray(result.linkMap)).toBe(true)
    expect(result.linkMap.length).toBe(1)
    const entry = result.linkMap[0]
    // The slice of canonicalText at [start, end) must equal the anchor text
    expect(result.canonicalText.slice(entry.start, entry.end)).toBe(
      'the guidance'
    )
    expect(entry.display).toContain(
      '[the guidance](https://www.gov.uk/guidance/test)'
    )
  })

  it('returns linkMap as null for URL sources without Markdown links', () => {
    const result = canonicalDocumentStore._redactAndNormalise({
      text: '<p>Plain text without any hyperlinks.</p>',
      sourceType: SOURCE_TYPES.URL
    })
    expect(result.linkMap).toBeNull()
  })

  it('does not produce a second PII call for non-URL sources (no linkMap)', () => {
    // FILE and TEXT sources do not generate a preStripText path, so only one PII call is made
    canonicalDocumentStore._redactAndNormalise({
      text: 'Plain text content without links.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(MOCK_PII_REDACT).toHaveBeenCalledTimes(1)
  })
})
