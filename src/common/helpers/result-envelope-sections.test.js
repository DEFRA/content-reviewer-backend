import { describe, it, expect, vi } from 'vitest'

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))

vi.mock('./logging/logger.js', () => ({
  createLogger: () => mockLogger
}))

import {
  isValidLinkEntry,
  validatedLinks,
  buildPlainSpan,
  buildAnnotatedSections,
  mapScores
} from './result-envelope-sections.js'

// Scores are stored as 1-5 matching LLM output — no scale factor applied

// ── Shared string fixtures ────────────────────────────────────────────────────
const HELLO_WORLD_FOO = 'Hello world foo'
const HELLO_WORLD = 'Hello world'
const DISPLAY_LINK = 'link'
const DISPLAY_GOVUK = 'GOV.UK'

// ── Offsets within HELLO_WORLD_FOO: "Hello world foo" (length 15) ────────────
// H e l l o   w o r l  d     f  o  o
// 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14
const HELLO_END = 5 // exclusive end of 'Hello'
const WORLD_START = 6 // start of 'world'
const WORLD_END = 11 // exclusive end of 'world'
const FOO_START = 12 // start of 'foo'
const FOO_END = 15 // exclusive end of 'foo' / text length
const PARTIAL_TEXT_END = 8 // 8-char slice: 'HELLO wo'
const EMPTY_POS = 5 // from === to for zero-length range test

// ── Overlap / partial-range offsets ──────────────────────────────────────────
const OVERLAP_START = 3 // link starts mid-word [3,9)
const OVERLAP_END = 9 // link ends mid-word
const PARTIAL_RANGE_END = 7 // range [0,7) for partial-overlap test

// ── isValidLinkEntry fixture values ──────────────────────────────────────────
const ENTRY_TEXT_LEN = 10 // textLength argument
const ENTRY_END_OVER = 11 // end > ENTRY_TEXT_LEN
const ENTRY_NEG_START = -1 // invalid negative start
const ENTRY_MID_START = 2 // valid mid-text start
const ENTRY_MID_END = 7 // valid mid-text end
const ENTRY_EQUAL_POS = 3 // start === end (zero-length range)
const ENTRY_FLIP_START = 5 // end < start scenario
const ENTRY_FLIP_END = 3
const ENTRY_INVALID_DISPLAY = 123 // non-string display value
const NON_ARRAY_VAL = 42 // non-array linkMap value

// ── buildAnnotatedSections link position ─────────────────────────────────────
const GOVUK_LINK_START = 6
const GOVUK_LINK_END = 12

// ── Score test values ─────────────────────────────────────────────────────────
const SCORE_2 = 2
const SCORE_3 = 3
const SCORE_4 = 4
const SCORE_5 = 5

// ---------------------------------------------------------------------------
// isValidLinkEntry
// ---------------------------------------------------------------------------

describe('isValidLinkEntry', () => {
  it('returns false when start is not a number', () => {
    expect(
      isValidLinkEntry(
        { start: 'a', end: HELLO_END, display: DISPLAY_LINK },
        ENTRY_TEXT_LEN
      )
    ).toBe(false)
  })

  it('returns false when end is not a number', () => {
    expect(
      isValidLinkEntry(
        { start: 0, end: null, display: DISPLAY_LINK },
        ENTRY_TEXT_LEN
      )
    ).toBe(false)
  })

  it('returns false when start is negative', () => {
    expect(
      isValidLinkEntry(
        { start: ENTRY_NEG_START, end: HELLO_END, display: DISPLAY_LINK },
        ENTRY_TEXT_LEN
      )
    ).toBe(false)
  })

  it('returns false when end equals start (zero-length range)', () => {
    expect(
      isValidLinkEntry(
        { start: ENTRY_EQUAL_POS, end: ENTRY_EQUAL_POS, display: DISPLAY_LINK },
        ENTRY_TEXT_LEN
      )
    ).toBe(false)
  })

  it('returns false when end is less than start', () => {
    expect(
      isValidLinkEntry(
        { start: ENTRY_FLIP_START, end: ENTRY_FLIP_END, display: DISPLAY_LINK },
        ENTRY_TEXT_LEN
      )
    ).toBe(false)
  })

  it('returns false when end exceeds textLength', () => {
    expect(
      isValidLinkEntry(
        { start: 0, end: ENTRY_END_OVER, display: DISPLAY_LINK },
        ENTRY_TEXT_LEN
      )
    ).toBe(false)
  })

  it('returns false when display is not a string', () => {
    expect(
      isValidLinkEntry(
        { start: 0, end: HELLO_END, display: ENTRY_INVALID_DISPLAY },
        ENTRY_TEXT_LEN
      )
    ).toBe(false)
  })

  it('returns false when display is an empty string', () => {
    expect(
      isValidLinkEntry(
        { start: 0, end: HELLO_END, display: '' },
        ENTRY_TEXT_LEN
      )
    ).toBe(false)
  })

  it('returns true for a valid entry with end exactly at textLength', () => {
    expect(
      isValidLinkEntry(
        { start: 0, end: ENTRY_TEXT_LEN, display: DISPLAY_LINK },
        ENTRY_TEXT_LEN
      )
    ).toBe(true)
  })

  it('returns true for a valid entry wholly within text', () => {
    expect(
      isValidLinkEntry(
        { start: ENTRY_MID_START, end: ENTRY_MID_END, display: DISPLAY_GOVUK },
        ENTRY_TEXT_LEN
      )
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// validatedLinks
// ---------------------------------------------------------------------------

describe('validatedLinks', () => {
  it('returns empty array when linkMap is null', () => {
    expect(validatedLinks(HELLO_WORLD_FOO, null)).toEqual([])
  })

  it('returns empty array when linkMap is not an array', () => {
    expect(validatedLinks(HELLO_WORLD_FOO, 'not-array')).toEqual([])
    expect(validatedLinks(HELLO_WORLD_FOO, NON_ARRAY_VAL)).toEqual([])
  })

  it('returns empty array when linkMap is an empty array', () => {
    expect(validatedLinks(HELLO_WORLD_FOO, [])).toEqual([])
  })

  it('filters out invalid entries', () => {
    const linkMap = [{ start: ENTRY_NEG_START, end: HELLO_END, display: 'bad' }]
    expect(validatedLinks(HELLO_WORLD_FOO, linkMap)).toEqual([])
  })

  it('returns valid entries sorted by start position', () => {
    const linkMap = [
      { start: WORLD_START, end: WORLD_END, display: 'World' },
      { start: 0, end: HELLO_END, display: 'Hello' }
    ]
    const result = validatedLinks(HELLO_WORLD_FOO, linkMap)
    expect(result).toHaveLength(2)
    expect(result[0].start).toBe(0)
    expect(result[1].start).toBe(WORLD_START)
  })

  it('filters mixed valid and invalid entries', () => {
    const linkMap = [
      { start: 0, end: HELLO_END, display: 'Hello' },
      { start: ENTRY_NEG_START, end: HELLO_END, display: 'bad' }
    ]
    const result = validatedLinks(HELLO_WORLD_FOO, linkMap)
    expect(result).toHaveLength(1)
    expect(result[0].display).toBe('Hello')
  })
})

// ---------------------------------------------------------------------------
// buildPlainSpan
// ---------------------------------------------------------------------------

describe('buildPlainSpan', () => {
  // HELLO_WORLD_FOO = 'Hello world foo'
  // H e l l o   w o r l  d     f  o  o
  // 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14

  it('returns a direct slice when links array is empty', () => {
    expect(buildPlainSpan(HELLO_WORLD_FOO, [], 0, HELLO_END)).toBe('Hello')
    expect(buildPlainSpan(HELLO_WORLD_FOO, [], WORLD_START, WORLD_END)).toBe(
      'world'
    )
  })

  it('substitutes a link wholly within the range', () => {
    const links = [{ start: WORLD_START, end: WORLD_END, display: 'WORLD' }]
    expect(
      buildPlainSpan(HELLO_WORLD_FOO, links, 0, HELLO_WORLD_FOO.length)
    ).toBe('Hello WORLD foo')
  })

  it('includes plain text before and after a substituted link', () => {
    const links = [{ start: WORLD_START, end: WORLD_END, display: 'WORLD' }]
    expect(buildPlainSpan(HELLO_WORLD_FOO, links, 0, WORLD_END)).toBe(
      'Hello WORLD'
    )
  })

  it('stops adding text before the link when link.start equals pos', () => {
    const links = [{ start: 0, end: HELLO_END, display: 'HELLO' }]
    expect(
      buildPlainSpan(HELLO_WORLD_FOO, links, 0, HELLO_WORLD_FOO.length)
    ).toBe('HELLO world foo')
  })

  it('breaks early when a link starts at or after the range end', () => {
    const links = [{ start: FOO_START, end: FOO_END, display: 'FOO' }]
    // range is [0, 5) — link at 12 is outside
    expect(buildPlainSpan(HELLO_WORLD_FOO, links, 0, HELLO_END)).toBe('Hello')
  })

  it('skips a link that ends before or at the range start (beforeRange)', () => {
    const links = [{ start: 0, end: HELLO_END, display: 'HELLO' }]
    // range is [6, 15) — link ends at 5 which is <= 6
    expect(
      buildPlainSpan(
        HELLO_WORLD_FOO,
        links,
        WORLD_START,
        HELLO_WORLD_FOO.length
      )
    ).toBe('world foo')
  })

  it('skips a link that partially overlaps the range without being wholly within', () => {
    // link spans [3, 9), range is [0, 7) — link.end 9 > to 7, so not whollyWithin
    const links = [
      { start: OVERLAP_START, end: OVERLAP_END, display: 'overlap' }
    ]
    expect(buildPlainSpan(HELLO_WORLD_FOO, links, 0, PARTIAL_RANGE_END)).toBe(
      'Hello w'
    )
  })

  it('handles multiple links within the range', () => {
    const links = [
      { start: 0, end: HELLO_END, display: 'HELLO' },
      { start: WORLD_START, end: WORLD_END, display: 'WORLD' }
    ]
    expect(
      buildPlainSpan(HELLO_WORLD_FOO, links, 0, HELLO_WORLD_FOO.length)
    ).toBe('HELLO WORLD foo')
  })

  it('appends trailing text after the last link when pos < to', () => {
    const links = [{ start: 0, end: HELLO_END, display: 'HELLO' }]
    expect(buildPlainSpan(HELLO_WORLD_FOO, links, 0, PARTIAL_TEXT_END)).toBe(
      'HELLO wo'
    )
  })

  it('returns empty string when from equals to', () => {
    expect(buildPlainSpan(HELLO_WORLD_FOO, [], EMPTY_POS, EMPTY_POS)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// buildAnnotatedSections
// ---------------------------------------------------------------------------

describe('buildAnnotatedSections', () => {
  it('returns empty array for empty canonicalText', () => {
    expect(buildAnnotatedSections('', [])).toEqual([])
  })

  it('returns empty array for null canonicalText', () => {
    expect(buildAnnotatedSections(null, [])).toEqual([])
  })

  it('returns a single plain section when there are no issues', () => {
    const result = buildAnnotatedSections(HELLO_WORLD, [])
    expect(result).toEqual([
      { text: HELLO_WORLD, issueIdx: null, category: null }
    ])
  })

  it('wraps a single issue at the start followed by trailing plain text', () => {
    const result = buildAnnotatedSections(HELLO_WORLD, [
      { start: 0, end: HELLO_END, category: 'grammar' }
    ])
    expect(result).toEqual([
      { text: 'Hello', issueIdx: 0, category: 'grammar' },
      { text: ' world', issueIdx: null, category: null }
    ])
  })

  it('prepends plain text before an issue in the middle', () => {
    const result = buildAnnotatedSections(HELLO_WORLD, [
      { start: WORLD_START, end: WORLD_END, category: 'style' }
    ])
    expect(result).toEqual([
      { text: 'Hello ', issueIdx: null, category: null },
      { text: 'world', issueIdx: 0, category: 'style' }
    ])
  })

  it('produces no trailing section when issue ends exactly at text end', () => {
    const result = buildAnnotatedSections('Hello', [
      { start: 0, end: HELLO_END, category: 'grammar' }
    ])
    expect(result).toEqual([
      { text: 'Hello', issueIdx: 0, category: 'grammar' }
    ])
  })

  it('handles multiple non-overlapping issues with plain spans between them', () => {
    const result = buildAnnotatedSections(HELLO_WORLD_FOO, [
      { start: 0, end: HELLO_END, category: 'grammar' },
      { start: FOO_START, end: FOO_END, category: 'style' }
    ])
    expect(result).toEqual([
      { text: 'Hello', issueIdx: 0, category: 'grammar' },
      { text: ' world ', issueIdx: null, category: null },
      { text: 'foo', issueIdx: 1, category: 'style' }
    ])
  })

  it('uses default null linkMap when not provided', () => {
    const result = buildAnnotatedSections(HELLO_WORLD, [])
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe(HELLO_WORLD)
  })

  it('substitutes link display text in plain spans when linkMap is provided', () => {
    // text: "Visit gov.uk for info"
    //        0     6    12
    const text = 'Visit gov.uk for info'
    const linkMap = [
      { start: GOVUK_LINK_START, end: GOVUK_LINK_END, display: DISPLAY_GOVUK }
    ]
    const result = buildAnnotatedSections(text, [], linkMap)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Visit GOV.UK for info')
  })
})

// ---------------------------------------------------------------------------
// mapScores
// ---------------------------------------------------------------------------

describe('mapScores — zero values', () => {
  it('returns all zeros when rawScores is null', () => {
    const result = mapScores(null)
    expect(result.plainEnglish).toBe(0)
    expect(result.clarity).toBe(0)
    expect(result.accessibility).toBe(0)
    expect(result.govukStyle).toBe(0)
    expect(result.completeness).toBe(0)
  })

  it('returns all zeros when rawScores is undefined', () => {
    const result = mapScores(undefined)
    expect(result.plainEnglish).toBe(0)
  })

  it('returns all zeros when rawScores is an empty object', () => {
    const result = mapScores({})
    expect(result.plainEnglish).toBe(0)
  })
})

describe('mapScores — plain english', () => {
  it('maps plain english score using the "plain english" key', () => {
    const result = mapScores({
      'plain english': { score: SCORE_4, note: 'Good' }
    })
    expect(result.plainEnglish).toBe(SCORE_4)
    expect(result.plainEnglishNote).toBe('Good')
  })

  it('maps plain english score using the alternate "plain-english" key', () => {
    const result = mapScores({ 'plain-english': { score: SCORE_3, note: '' } })
    expect(result.plainEnglish).toBe(SCORE_3)
  })
})

describe('mapScores — clarity', () => {
  it('maps clarity using the "clarity & structure" key', () => {
    const result = mapScores({
      'clarity & structure': { score: SCORE_3, note: 'OK' }
    })
    expect(result.clarity).toBe(SCORE_3)
    expect(result.clarityNote).toBe('OK')
  })

  it('maps clarity using the fallback "clarity" key', () => {
    const result = mapScores({ clarity: { score: SCORE_2, note: '' } })
    expect(result.clarity).toBe(SCORE_2)
  })
})

describe('mapScores — accessibility', () => {
  it('maps accessibility using the "accessibility" key', () => {
    const result = mapScores({
      accessibility: { score: SCORE_5, note: 'Excellent' }
    })
    expect(result.accessibility).toBe(SCORE_5)
    expect(result.accessibilityNote).toBe('Excellent')
  })

  it('maps accessibility using the fallback "accessible" key', () => {
    const result = mapScores({ accessible: { score: SCORE_4, note: '' } })
    expect(result.accessibility).toBe(SCORE_4)
  })
})

describe('mapScores — govuk style', () => {
  it('maps govukStyle using the "gov.uk style compliance" key', () => {
    const result = mapScores({
      'gov.uk style compliance': { score: SCORE_4, note: '' }
    })
    expect(result.govukStyle).toBe(SCORE_4)
  })

  it('maps govukStyle using the "govuk style compliance" key', () => {
    const result = mapScores({
      'govuk style compliance': { score: SCORE_3, note: '' }
    })
    expect(result.govukStyle).toBe(SCORE_3)
  })

  it('maps govukStyle using the "formatting" fallback key', () => {
    const result = mapScores({ formatting: { score: SCORE_3, note: '' } })
    expect(result.govukStyle).toBe(SCORE_3)
  })
})

describe('mapScores — completeness', () => {
  it('maps completeness using the "content completeness" key', () => {
    const result = mapScores({
      'content completeness': { score: SCORE_4, note: '' }
    })
    expect(result.completeness).toBe(SCORE_4)
  })

  it('maps completeness using the fallback "completeness" key', () => {
    const result = mapScores({ completeness: { score: SCORE_3, note: '' } })
    expect(result.completeness).toBe(SCORE_3)
  })
})

describe('mapScores — edge cases and full mapping', () => {
  it('uses 0 when val.score is missing', () => {
    const result = mapScores({ 'plain english': { note: 'No score' } })
    expect(result.plainEnglish).toBe(0)
  })

  it('uses empty string when val.note is missing', () => {
    const result = mapScores({ 'plain english': { score: SCORE_4 } })
    expect(result.plainEnglishNote).toBe('')
  })

  it('maps all five categories correctly in one call', () => {
    const result = mapScores({
      'plain english': { score: SCORE_4 },
      clarity: { score: SCORE_2 },
      accessibility: { score: SCORE_5 },
      'gov.uk style compliance': { score: SCORE_4 },
      completeness: { score: SCORE_3 }
    })
    expect(result.plainEnglish).toBe(SCORE_4)
    expect(result.clarity).toBe(SCORE_2)
    expect(result.accessibility).toBe(SCORE_5)
    expect(result.govukStyle).toBe(SCORE_4)
    expect(result.completeness).toBe(SCORE_3)
  })

  it('handles score keys case-insensitively', () => {
    const result = mapScores({ 'Plain English': { score: SCORE_4 } })
    expect(result.plainEnglish).toBe(SCORE_4)
  })
})
