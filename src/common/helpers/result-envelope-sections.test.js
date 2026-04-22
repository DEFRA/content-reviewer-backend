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

// SCORE_SCALE_FACTOR = 20 (Bedrock scores are 0-5; spec requires 0-100)
const SCALE = 20

// ---------------------------------------------------------------------------
// isValidLinkEntry
// ---------------------------------------------------------------------------

describe('isValidLinkEntry', () => {
  it('returns false when start is not a number', () => {
    expect(isValidLinkEntry({ start: 'a', end: 5, display: 'link' }, 10)).toBe(
      false
    )
  })

  it('returns false when end is not a number', () => {
    expect(isValidLinkEntry({ start: 0, end: null, display: 'link' }, 10)).toBe(
      false
    )
  })

  it('returns false when start is negative', () => {
    expect(isValidLinkEntry({ start: -1, end: 5, display: 'link' }, 10)).toBe(
      false
    )
  })

  it('returns false when end equals start (zero-length range)', () => {
    expect(isValidLinkEntry({ start: 3, end: 3, display: 'link' }, 10)).toBe(
      false
    )
  })

  it('returns false when end is less than start', () => {
    expect(isValidLinkEntry({ start: 5, end: 3, display: 'link' }, 10)).toBe(
      false
    )
  })

  it('returns false when end exceeds textLength', () => {
    expect(isValidLinkEntry({ start: 0, end: 11, display: 'link' }, 10)).toBe(
      false
    )
  })

  it('returns false when display is not a string', () => {
    expect(isValidLinkEntry({ start: 0, end: 5, display: 123 }, 10)).toBe(false)
  })

  it('returns false when display is an empty string', () => {
    expect(isValidLinkEntry({ start: 0, end: 5, display: '' }, 10)).toBe(false)
  })

  it('returns true for a valid entry with end exactly at textLength', () => {
    expect(isValidLinkEntry({ start: 0, end: 10, display: 'link' }, 10)).toBe(
      true
    )
  })

  it('returns true for a valid entry wholly within text', () => {
    expect(isValidLinkEntry({ start: 2, end: 7, display: 'GOV.UK' }, 10)).toBe(
      true
    )
  })
})

// ---------------------------------------------------------------------------
// validatedLinks
// ---------------------------------------------------------------------------

describe('validatedLinks', () => {
  const TEXT = 'Hello world foo'

  it('returns empty array when linkMap is null', () => {
    expect(validatedLinks(TEXT, null)).toEqual([])
  })

  it('returns empty array when linkMap is not an array', () => {
    expect(validatedLinks(TEXT, 'not-array')).toEqual([])
    expect(validatedLinks(TEXT, 42)).toEqual([])
  })

  it('returns empty array when linkMap is an empty array', () => {
    expect(validatedLinks(TEXT, [])).toEqual([])
  })

  it('filters out invalid entries', () => {
    const linkMap = [{ start: -1, end: 5, display: 'bad' }]
    expect(validatedLinks(TEXT, linkMap)).toEqual([])
  })

  it('returns valid entries sorted by start position', () => {
    const linkMap = [
      { start: 6, end: 11, display: 'World' },
      { start: 0, end: 5, display: 'Hello' }
    ]
    const result = validatedLinks(TEXT, linkMap)
    expect(result).toHaveLength(2)
    expect(result[0].start).toBe(0)
    expect(result[1].start).toBe(6)
  })

  it('filters mixed valid and invalid entries', () => {
    const linkMap = [
      { start: 0, end: 5, display: 'Hello' },
      { start: -1, end: 5, display: 'bad' }
    ]
    const result = validatedLinks(TEXT, linkMap)
    expect(result).toHaveLength(1)
    expect(result[0].display).toBe('Hello')
  })
})

// ---------------------------------------------------------------------------
// buildPlainSpan
// ---------------------------------------------------------------------------

describe('buildPlainSpan', () => {
  const TEXT = 'Hello world foo'
  //            0123456789012345
  //                     1111111

  it('returns a direct slice when links array is empty', () => {
    expect(buildPlainSpan(TEXT, [], 0, 5)).toBe('Hello')
    expect(buildPlainSpan(TEXT, [], 6, 11)).toBe('world')
  })

  it('substitutes a link wholly within the range', () => {
    const links = [{ start: 6, end: 11, display: 'WORLD' }]
    expect(buildPlainSpan(TEXT, links, 0, TEXT.length)).toBe('Hello WORLD foo')
  })

  it('includes plain text before and after a substituted link', () => {
    const links = [{ start: 6, end: 11, display: 'WORLD' }]
    expect(buildPlainSpan(TEXT, links, 0, 11)).toBe('Hello WORLD')
  })

  it('stops adding text before the link when link.start equals pos', () => {
    const links = [{ start: 0, end: 5, display: 'HELLO' }]
    expect(buildPlainSpan(TEXT, links, 0, TEXT.length)).toBe('HELLO world foo')
  })

  it('breaks early when a link starts at or after the range end', () => {
    const links = [{ start: 12, end: 15, display: 'FOO' }]
    // range is [0, 5) — link at 12 is outside
    expect(buildPlainSpan(TEXT, links, 0, 5)).toBe('Hello')
  })

  it('skips a link that ends before or at the range start (beforeRange)', () => {
    const links = [{ start: 0, end: 5, display: 'HELLO' }]
    // range is [6, 15) — link ends at 5 which is <= 6
    expect(buildPlainSpan(TEXT, links, 6, TEXT.length)).toBe('world foo')
  })

  it('skips a link that partially overlaps the range without being wholly within', () => {
    // link spans [3, 9), range is [0, 7) — link.end 9 > to 7, so not whollyWithin
    const links = [{ start: 3, end: 9, display: 'overlap' }]
    expect(buildPlainSpan(TEXT, links, 0, 7)).toBe('Hello w')
  })

  it('handles multiple links within the range', () => {
    const links = [
      { start: 0, end: 5, display: 'HELLO' },
      { start: 6, end: 11, display: 'WORLD' }
    ]
    expect(buildPlainSpan(TEXT, links, 0, TEXT.length)).toBe('HELLO WORLD foo')
  })

  it('appends trailing text after the last link when pos < to', () => {
    const links = [{ start: 0, end: 5, display: 'HELLO' }]
    expect(buildPlainSpan(TEXT, links, 0, 8)).toBe('HELLO wo')
  })

  it('returns empty string when from equals to', () => {
    expect(buildPlainSpan(TEXT, [], 5, 5)).toBe('')
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
    const result = buildAnnotatedSections('Hello world', [])
    expect(result).toEqual([
      { text: 'Hello world', issueIdx: null, category: null }
    ])
  })

  it('wraps a single issue at the start followed by trailing plain text', () => {
    const result = buildAnnotatedSections('Hello world', [
      { absStart: 0, absEnd: 5, category: 'grammar' }
    ])
    expect(result).toEqual([
      { text: 'Hello', issueIdx: 0, category: 'grammar' },
      { text: ' world', issueIdx: null, category: null }
    ])
  })

  it('prepends plain text before an issue in the middle', () => {
    const result = buildAnnotatedSections('Hello world', [
      { absStart: 6, absEnd: 11, category: 'style' }
    ])
    expect(result).toEqual([
      { text: 'Hello ', issueIdx: null, category: null },
      { text: 'world', issueIdx: 0, category: 'style' }
    ])
  })

  it('produces no trailing section when issue ends exactly at text end', () => {
    const result = buildAnnotatedSections('Hello', [
      { absStart: 0, absEnd: 5, category: 'grammar' }
    ])
    expect(result).toEqual([
      { text: 'Hello', issueIdx: 0, category: 'grammar' }
    ])
  })

  it('handles multiple non-overlapping issues with plain spans between them', () => {
    const text = 'Hello world foo'
    const result = buildAnnotatedSections(text, [
      { absStart: 0, absEnd: 5, category: 'grammar' },
      { absStart: 12, absEnd: 15, category: 'style' }
    ])
    expect(result).toEqual([
      { text: 'Hello', issueIdx: 0, category: 'grammar' },
      { text: ' world ', issueIdx: null, category: null },
      { text: 'foo', issueIdx: 1, category: 'style' }
    ])
  })

  it('uses default null linkMap when not provided', () => {
    const result = buildAnnotatedSections('Hello world', [])
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Hello world')
  })

  it('substitutes link display text in plain spans when linkMap is provided', () => {
    // text:    "Visit gov.uk for info"
    //           0     6    11
    const text = 'Visit gov.uk for info'
    const linkMap = [{ start: 6, end: 12, display: 'GOV.UK' }]
    const result = buildAnnotatedSections(text, [], linkMap)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Visit GOV.UK for info')
  })
})

// ---------------------------------------------------------------------------
// mapScores
// ---------------------------------------------------------------------------

describe('mapScores', () => {
  it('returns all zeros when rawScores is null', () => {
    const result = mapScores(null)
    expect(result.plainEnglish).toBe(0)
    expect(result.clarity).toBe(0)
    expect(result.accessibility).toBe(0)
    expect(result.govukStyle).toBe(0)
    expect(result.completeness).toBe(0)
    expect(result.overall).toBe(0)
  })

  it('returns all zeros when rawScores is undefined', () => {
    const result = mapScores(undefined)
    expect(result.overall).toBe(0)
  })

  it('returns all zeros when rawScores is an empty object', () => {
    const result = mapScores({})
    expect(result.overall).toBe(0)
  })

  it('maps plain english score using the "plain english" key', () => {
    const result = mapScores({ 'plain english': { score: 4, note: 'Good' } })
    expect(result.plainEnglish).toBe(4 * SCALE)
    expect(result.plainEnglishNote).toBe('Good')
  })

  it('maps plain english score using the alternate "plain-english" key', () => {
    const result = mapScores({ 'plain-english': { score: 3, note: '' } })
    expect(result.plainEnglish).toBe(3 * SCALE)
  })

  it('maps clarity using the "clarity & structure" key', () => {
    const result = mapScores({
      'clarity & structure': { score: 3, note: 'OK' }
    })
    expect(result.clarity).toBe(3 * SCALE)
    expect(result.clarityNote).toBe('OK')
  })

  it('maps clarity using the fallback "clarity" key', () => {
    const result = mapScores({ clarity: { score: 2, note: '' } })
    expect(result.clarity).toBe(2 * SCALE)
  })

  it('maps accessibility using the "accessibility" key', () => {
    const result = mapScores({ accessibility: { score: 5, note: 'Excellent' } })
    expect(result.accessibility).toBe(5 * SCALE)
    expect(result.accessibilityNote).toBe('Excellent')
  })

  it('maps accessibility using the fallback "accessible" key', () => {
    const result = mapScores({ accessible: { score: 4, note: '' } })
    expect(result.accessibility).toBe(4 * SCALE)
  })

  it('maps govukStyle using the "gov.uk style compliance" key', () => {
    const result = mapScores({
      'gov.uk style compliance': { score: 4, note: '' }
    })
    expect(result.govukStyle).toBe(4 * SCALE)
  })

  it('maps govukStyle using the "govuk style compliance" key', () => {
    const result = mapScores({
      'govuk style compliance': { score: 3, note: '' }
    })
    expect(result.govukStyle).toBe(3 * SCALE)
  })

  it('maps govukStyle using the "formatting" fallback key', () => {
    const result = mapScores({ formatting: { score: 3, note: '' } })
    expect(result.govukStyle).toBe(3 * SCALE)
  })

  it('maps completeness using the "content completeness" key', () => {
    const result = mapScores({
      'content completeness': { score: 4, note: '' }
    })
    expect(result.completeness).toBe(4 * SCALE)
  })

  it('maps completeness using the fallback "completeness" key', () => {
    const result = mapScores({ completeness: { score: 3.5, note: '' } })
    expect(result.completeness).toBe(Math.round(3.5 * SCALE))
  })

  it('uses 0 when val.score is missing', () => {
    const result = mapScores({ 'plain english': { note: 'No score' } })
    expect(result.plainEnglish).toBe(0)
  })

  it('uses empty string when val.note is missing', () => {
    const result = mapScores({ 'plain english': { score: 4 } })
    expect(result.plainEnglishNote).toBe('')
  })

  it('calculates overall as the average of all non-zero category scores', () => {
    const result = mapScores({
      'plain english': { score: 4 },
      clarity: { score: 2 },
      accessibility: { score: 5 },
      'gov.uk style compliance': { score: 4 },
      completeness: { score: 3 }
    })
    const expected = Math.round((80 + 40 + 100 + 80 + 60) / 5)
    expect(result.overall).toBe(expected)
  })

  it('excludes zero-value scores from the overall average', () => {
    const result = mapScores({
      'plain english': { score: 5 },
      clarity: { score: 0 }
    })
    // Only plainEnglish (100) is non-zero; clarity (0) is excluded
    expect(result.overall).toBe(100)
  })

  it('returns overall of 0 when all scores are zero', () => {
    const result = mapScores({
      'plain english': { score: 0 },
      clarity: { score: 0 }
    })
    expect(result.overall).toBe(0)
  })

  it('exposes style as an alias for govukStyle and tone as an alias for clarity', () => {
    const result = mapScores({
      'gov.uk style compliance': { score: 3 },
      clarity: { score: 4 }
    })
    expect(result.style).toBe(result.govukStyle)
    expect(result.tone).toBe(result.clarity)
  })

  it('handles score keys case-insensitively', () => {
    const result = mapScores({ 'Plain English': { score: 4 } })
    expect(result.plainEnglish).toBe(4 * SCALE)
  })
})
