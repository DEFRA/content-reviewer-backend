import { describe, it, expect, vi } from 'vitest'

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

import {
  deriveEvidence,
  deriveCategory,
  normalizeCategoryDisplay,
  findNearestOccurrence,
  resolveIssuePosition,
  snapToWordBoundary,
  mapIssue,
  mapImprovement,
  hasRefFields,
  buildRefMap,
  buildPairs,
  dedupeOverlaps,
  isValidImprovement,
  buildSortedResults,
  sortAndAlignPairs
} from './result-envelope-issue-mappers.js'

// ── Shared test data ──────────────────────────────────────────────────────────

const CANONICAL = 'The department should utilise all resources.'
const HELLO_WORLD = 'hello world'
const HELLO_WORLD_PADDED = `${HELLO_WORLD}  ` // 'hello world  ' (2 trailing spaces)
const HELLO_WORLD_LEADING = ` ${HELLO_WORLD}` // ' hello world'
const LOCAL_UTILISE_TEXT = 'The utilise resources'
const PLAIN_ENGLISH = 'plain-english'
const PLAIN_ENGLISH_DISPLAY = 'Plain English'
const USE_SIMPLER_LANGUAGE = 'Use simpler language'

// 'utilise' offsets in CANONICAL (and similar sentences with same prefix length)
const UTILISE_START = 22
const UTILISE_END = 29

// 'utilise' offsets in LOCAL_UTILISE_TEXT
const LOCAL_UTILISE_START = 4
const LOCAL_UTILISE_END = 11

// snapToWordBoundary offsets in HELLO_WORLD
const HELLO_MID = 3 // mid-word index inside 'hello'
const HELLO_BOUNDARY = 5 // first char after 'hello'
const WORLD_BOUNDARY = 6 // first char of 'world'
const WORLD_MID = 9 // mid-word index inside 'world'
const WORD_END = 11 // end of 'world'
const PADDED_LEN = 13 // length of 'hello world  ' (2 trailing spaces)

// findNearestOccurrence: second 'utilise' in 'utilise stuff and utilise more'
const NEAREST_HINT = 24
const NEAREST_START = 18
const NEAREST_END = 25

// deriveEvidence / findNearestOccurrence guard tests: arbitrary hint offset
const GUARD_HINT = 5

// deriveEvidence fallback trigger: start deliberately > end
const FALLBACK_TRIG_START = 5
const FALLBACK_TRIG_END = 3

// resolveIssuePosition: original offsets returned as final fallback
const FINAL_FALLBACK_START = 3
const FINAL_FALLBACK_END = 8

// mapIssue: raw start/end when canonicalText is null
const RAW_START = 2
const RAW_END = 7

// buildRefMap / buildPairs: ref number for ref-matching
const TEST_REF = 5

// dedupeOverlaps: overlapping span positions
const FIRST_SPAN_END = 10
const SECOND_SPAN_START = 5
const SECOND_SPAN_END = 15

// buildSortedResults: short arbitrary absEnd for test issue
const SHORT_SPAN_END = 5

// buildSortedResults: unmatched improvement ref
const UNMATCHED_REF = 9

// 'resources' offsets in CANONICAL (used to create a second sortable span)
const RESOURCES_START = 34
const RESOURCES_END = 43

// ── deriveEvidence – fallback path (line 22) ──────────────────────────────────

describe('deriveEvidence – fallback path (line 22)', () => {
  it('returns fallbackText when canonicalText is falsy', () => {
    expect(deriveEvidence(0, GUARD_HINT, null, 'fallback')).toBe('fallback')
  })

  it('returns fallbackText when start >= end', () => {
    expect(
      deriveEvidence(
        FALLBACK_TRIG_START,
        FALLBACK_TRIG_END,
        'some canonical text',
        'fallback text'
      )
    ).toBe('fallback text')
  })

  it('returns empty string when fallbackText is also falsy', () => {
    expect(
      deriveEvidence(
        FALLBACK_TRIG_START,
        FALLBACK_TRIG_END,
        'some canonical text',
        ''
      )
    ).toBe('')
  })
})

// ── deriveEvidence – slice path (line 20) ────────────────────────────────────

describe('deriveEvidence – slice path (line 20)', () => {
  it('returns the canonicalText slice when start < end and canonicalText is truthy', () => {
    expect(deriveEvidence(0, HELLO_BOUNDARY, HELLO_WORLD, 'fallback')).toBe(
      'hello'
    )
  })
})

// ── normalizeCategoryDisplay – falsy input (line 62) ─────────────────────────

describe('normalizeCategoryDisplay – falsy input (line 62)', () => {
  it('returns empty string when raw is null', () => {
    expect(normalizeCategoryDisplay(null)).toBe('')
  })

  it('returns empty string when raw is undefined', () => {
    expect(normalizeCategoryDisplay(undefined)).toBe('')
  })

  it('returns empty string when raw is empty string', () => {
    expect(normalizeCategoryDisplay('')).toBe('')
  })
})

// ── normalizeCategoryDisplay – truthy input (line 64) ────────────────────────

describe('normalizeCategoryDisplay – truthy input (line 64)', () => {
  it('returns the mapped display name for a known category key', () => {
    expect(normalizeCategoryDisplay(PLAIN_ENGLISH)).toBe(PLAIN_ENGLISH_DISPLAY)
  })

  it('returns the raw value when the key is not in the map', () => {
    expect(normalizeCategoryDisplay('custom-category')).toBe('custom-category')
  })
})

// ── deriveCategory (line 33) ─────────────────────────────────────────────────

describe('deriveCategory (line 33)', () => {
  it('returns rawIssue.type lowercased when present', () => {
    expect(deriveCategory({ type: 'Plain-English' }, null)).toBe(
      'plain-english'
    )
  })

  it('returns improvement.category lowercased when rawIssue.type is absent', () => {
    expect(deriveCategory({}, { category: 'Clarity' })).toBe('clarity')
  })

  it('returns "general" when both rawIssue.type and improvement.category are absent', () => {
    expect(deriveCategory({}, null)).toBe('general')
  })
})

// ── findNearestOccurrence (lines 76-100) ─────────────────────────────────────

describe('findNearestOccurrence – guard and search logic (lines 76-100)', () => {
  it('returns null when searchText is falsy', () => {
    expect(
      findNearestOccurrence('', 'some canonical text', GUARD_HINT)
    ).toBeNull()
  })

  it('returns null when canonicalText is falsy', () => {
    expect(findNearestOccurrence('word', '', GUARD_HINT)).toBeNull()
  })

  it('returns { start, end } when searchText is found once', () => {
    const result = findNearestOccurrence(
      'utilise',
      'The department should utilise resources.',
      UTILISE_START
    )
    expect(result).toEqual({ start: UTILISE_START, end: UTILISE_END })
  })

  it('returns the occurrence nearest to hintMid when multiple matches exist', () => {
    // 'utilise' at index 0 and index 18; hintMid=24 → closer to 18
    const text = 'utilise stuff and utilise more'
    const result = findNearestOccurrence('utilise', text, NEAREST_HINT)
    expect(result).toEqual({ start: NEAREST_START, end: NEAREST_END })
  })

  it('returns null when searchText is not found in canonicalText', () => {
    const result = findNearestOccurrence(
      'nonexistent',
      'The department should utilise resources.',
      GUARD_HINT
    )
    expect(result).toBeNull()
  })
})

// ── resolveIssuePosition – search paths (lines 120-162) ──────────────────────

describe('resolveIssuePosition – exact match at original offsets (line 121)', () => {
  it('returns original start/end immediately when the slice matches issueText', () => {
    const text = LOCAL_UTILISE_TEXT
    // text.slice(4, 11) === 'utilise' → returns immediately (line 121)
    const result = resolveIssuePosition(
      LOCAL_UTILISE_START,
      LOCAL_UTILISE_END,
      'utilise',
      text,
      null
    )
    expect(result).toEqual({
      start: LOCAL_UTILISE_START,
      end: LOCAL_UTILISE_END
    })
  })
})

describe('resolveIssuePosition – issueText found at a different offset (lines 124-140)', () => {
  it('searches canonicalText and returns the found position when slice does not match', () => {
    // start/end (0,5) slice to "The d", which ≠ "utilise" → falls through to search
    const result = resolveIssuePosition(
      0,
      HELLO_BOUNDARY,
      'utilise',
      CANONICAL,
      null
    )
    expect(result).toEqual({ start: UTILISE_START, end: UTILISE_END })
  })
})

describe('resolveIssuePosition – fallbackText path (lines 144-158)', () => {
  it('uses fallbackText when issueText is truthy but not found in canonicalText', () => {
    const result = resolveIssuePosition(
      0,
      HELLO_BOUNDARY,
      'NOTFOUND',
      CANONICAL,
      'utilise'
    )
    expect(result).toEqual({ start: UTILISE_START, end: UTILISE_END })
  })
})

describe('resolveIssuePosition – falsy issueText jumps to fallbackText (line 126 false branch)', () => {
  it('skips issueText search when issueText is falsy, uses fallbackText instead', () => {
    const result = resolveIssuePosition(
      0,
      HELLO_BOUNDARY,
      '',
      CANONICAL,
      'utilise'
    )
    expect(result).toEqual({ start: UTILISE_START, end: UTILISE_END })
  })
})

describe('resolveIssuePosition – original offsets returned as final fallback (line 162)', () => {
  it('returns the original start/end when neither issueText nor fallbackText is found', () => {
    const result = resolveIssuePosition(
      FINAL_FALLBACK_START,
      FINAL_FALLBACK_END,
      'NOTHERE',
      'The department should work hard.',
      'ALSOMISSING'
    )
    expect(result).toEqual({
      start: FINAL_FALLBACK_START,
      end: FINAL_FALLBACK_END
    })
  })
})

// ── snapToWordBoundary – while-loop bodies (lines 234, 239, 243, 247) ────────

describe('snapToWordBoundary – while-loop bodies (lines 234, 239, 243, 247)', () => {
  it('expands start leftwards through word characters when start is mid-word (line 234)', () => {
    // start=3 is inside 'hello' → s-- runs to 0
    const result = snapToWordBoundary(HELLO_WORLD, HELLO_MID, HELLO_BOUNDARY)
    expect(result.start).toBe(0)
  })

  it('expands end rightwards through word characters when end is mid-word (line 239)', () => {
    // end=9 is inside 'world' → e++ runs to 11
    const result = snapToWordBoundary(HELLO_WORLD, WORLD_BOUNDARY, WORLD_MID)
    expect(result.end).toBe(WORD_END)
  })

  it('trims trailing whitespace from end (line 243)', () => {
    // 'hello world  ' end=13 → e-- twice to 11
    const result = snapToWordBoundary(HELLO_WORLD_PADDED, 0, PADDED_LEN)
    expect(result.end).toBe(WORD_END)
  })

  it('trims leading whitespace from start (line 247)', () => {
    // ' hello world' start=0 (leading space) → s++ to 1
    const result = snapToWordBoundary(HELLO_WORLD_LEADING, 0, WORLD_BOUNDARY)
    expect(result.start).toBe(1)
  })
})

// ── mapIssue (lines 174-201) ─────────────────────────────────────────────────

describe('mapIssue (lines 174-201)', () => {
  it('returns a full issue object with resolved position when canonicalText is provided', () => {
    const rawIssue = {
      start: LOCAL_UTILISE_START,
      end: LOCAL_UTILISE_END,
      text: 'utilise',
      type: PLAIN_ENGLISH,
      ref: 1
    }
    const improvement = {
      severity: 'high',
      why: 'jargon',
      suggested: 'use',
      current: 'utilise'
    }
    const result = mapIssue(rawIssue, improvement, 0, LOCAL_UTILISE_TEXT)

    expect(result).toMatchObject({
      absStart: LOCAL_UTILISE_START,
      absEnd: LOCAL_UTILISE_END,
      category: PLAIN_ENGLISH,
      severity: 'high',
      why: 'jargon',
      suggested: 'use',
      evidence: 'utilise',
      chunkIdx: 0,
      ref: 1
    })
    expect(result.issueId).toMatch(/^issue-/)
  })

  it('uses raw start/end when canonicalText is falsy', () => {
    const rawIssue = {
      start: RAW_START,
      end: RAW_END,
      text: 'hello',
      type: 'clarity',
      ref: null
    }
    const result = mapIssue(rawIssue, null, 1, null)

    expect(result.absStart).toBe(RAW_START)
    expect(result.absEnd).toBe(RAW_END)
  })
})

// ── mapImprovement (line 210) ─────────────────────────────────────────────────

describe('mapImprovement (line 210)', () => {
  it('maps a parsed improvement to the spec shape', () => {
    const parsed = {
      severity: 'medium',
      category: PLAIN_ENGLISH,
      issue: USE_SIMPLER_LANGUAGE,
      why: 'Accessibility',
      current: 'utilise',
      suggested: 'use',
      ref: 1
    }
    const result = mapImprovement(parsed, 'issue-abc')

    expect(result).toEqual({
      issueId: 'issue-abc',
      severity: 'medium',
      category: PLAIN_ENGLISH_DISPLAY,
      issue: USE_SIMPLER_LANGUAGE,
      why: 'Accessibility',
      current: 'utilise',
      suggested: 'use',
      ref: 1
    })
  })
})

// ── hasRefFields (lines 261-270) ─────────────────────────────────────────────

describe('hasRefFields (lines 261-270)', () => {
  it('returns false when issues array is empty', () => {
    expect(hasRefFields([], [{ ref: 1 }])).toBe(false)
  })

  it('returns true when all issues have valid ref and at least one improvement has ref', () => {
    expect(hasRefFields([{ ref: 1 }], [{ ref: 1 }])).toBe(true)
  })

  it('returns false when an issue has no ref property', () => {
    expect(hasRefFields([{}], [{ ref: 1 }])).toBe(false)
  })

  it('returns false when no improvement has ref', () => {
    expect(hasRefFields([{ ref: 1 }], [{}])).toBe(false)
  })
})

// ── buildRefMap (lines 280-289) ──────────────────────────────────────────────

describe('buildRefMap (lines 280-289)', () => {
  it('returns an empty map when useRefMatching is false', () => {
    const map = buildRefMap([{ ref: 1, issue: 'x' }], false)
    expect(map.size).toBe(0)
  })

  it('returns a populated map keyed by ref when useRefMatching is true', () => {
    const imp = { ref: 1, issue: 'x' }
    const map = buildRefMap([imp], true)
    expect(map.get(1)).toBe(imp)
  })

  it('does not overwrite an existing ref entry (first wins)', () => {
    const imp1 = { ref: 1, issue: 'first' }
    const imp2 = { ref: 1, issue: 'second' }
    const map = buildRefMap([imp1, imp2], true)
    expect(map.get(1)).toBe(imp1)
  })
})

// ── buildPairs (lines 309-335) ───────────────────────────────────────────────

describe('buildPairs (lines 309-335)', () => {
  it('maps issues to snapped pairs, filters invalid spans, and sorts by absStart', () => {
    const issues = [
      {
        issueId: 'i1',
        absStart: UTILISE_START,
        absEnd: UTILISE_END,
        ref: null
      },
      { issueId: 'i2', absStart: -1, absEnd: 0, ref: null } // invalid span
    ]
    const improvements = [
      { ref: null, issue: USE_SIMPLER_LANGUAGE, suggested: 'use' },
      null
    ]
    const pairs = buildPairs(CANONICAL, issues, improvements, false, new Map())

    expect(pairs).toHaveLength(1)
    expect(pairs[0].issue.absStart).toBe(UTILISE_START)
  })

  it('uses refMap for lookup when useRefMatching is true', () => {
    const imp = { ref: TEST_REF, issue: USE_SIMPLER_LANGUAGE, suggested: 'use' }
    const refMap = new Map([[TEST_REF, imp]])
    const issues = [
      {
        issueId: 'i1',
        absStart: UTILISE_START,
        absEnd: UTILISE_END,
        ref: TEST_REF
      }
    ]
    const pairs = buildPairs(CANONICAL, issues, [], true, refMap)

    expect(pairs[0].improvement).toBe(imp)
  })

  it('sorts pairs by ascending absStart when given out-of-order spans (line 335)', () => {
    // Two valid spans in reverse order → sort fires and reorders them
    const issues = [
      {
        issueId: 'i2',
        absStart: RESOURCES_START,
        absEnd: RESOURCES_END,
        ref: null
      },
      { issueId: 'i1', absStart: UTILISE_START, absEnd: UTILISE_END, ref: null }
    ]
    const improvements = [null, null]
    const pairs = buildPairs(CANONICAL, issues, improvements, false, new Map())

    expect(pairs[0].issue.absStart).toBe(UTILISE_START)
    expect(pairs[1].issue.absStart).toBe(RESOURCES_START)
  })
})

// ── dedupeOverlaps (lines 345-364) ───────────────────────────────────────────

describe('dedupeOverlaps (lines 345-364)', () => {
  it('passes through non-overlapping pairs unchanged', () => {
    const pairs = [
      { issue: { absStart: 0, absEnd: SECOND_SPAN_START }, improvement: {} },
      {
        issue: { absStart: FIRST_SPAN_END, absEnd: SECOND_SPAN_END },
        improvement: {}
      }
    ]
    expect(dedupeOverlaps(pairs)).toHaveLength(2)
  })

  it('drops the overlapping span and logs a warning (lines 348-359)', () => {
    const pairs = [
      {
        issue: { absStart: 0, absEnd: FIRST_SPAN_END },
        improvement: {},
        originalIdx: 0,
        ref: null
      },
      {
        issue: { absStart: SECOND_SPAN_START, absEnd: SECOND_SPAN_END },
        improvement: {},
        originalIdx: 1,
        ref: null
      }
    ]
    const result = dedupeOverlaps(pairs)
    expect(result).toHaveLength(1)
    expect(result[0].issue.absStart).toBe(0)
  })
})

// ── isValidImprovement (lines 373-381) ───────────────────────────────────────

describe('isValidImprovement (lines 373-381)', () => {
  it('returns false when improvement is null', () => {
    expect(isValidImprovement(null)).toBe(false)
  })

  it('returns true when improvement has a non-trivial suggested and real title', () => {
    expect(
      isValidImprovement({
        suggested: 'use plain language',
        issue: 'Jargon found'
      })
    ).toBe(true)
  })

  it('returns falsy when suggested is empty', () => {
    expect(
      isValidImprovement({ suggested: '', issue: 'Jargon found' })
    ).toBeFalsy()
  })

  it('returns falsy when issue is the placeholder "issue identified"', () => {
    expect(
      isValidImprovement({
        suggested: 'use plain language',
        issue: 'Issue identified'
      })
    ).toBeFalsy()
  })
})

// ── buildSortedResults (lines 393-435) ───────────────────────────────────────

const BASE_IMPROVEMENT = {
  ref: 1,
  issue: USE_SIMPLER_LANGUAGE,
  suggested: 'use',
  severity: 'medium',
  category: PLAIN_ENGLISH,
  why: '',
  current: ''
}

describe('buildSortedResults (lines 393-435)', () => {
  it('returns sortedIssues and sortedImprovements from valid pairs', () => {
    const deduped = [
      {
        issue: {
          issueId: 'i1',
          absStart: 0,
          absEnd: SHORT_SPAN_END,
          chunkIdx: 0
        },
        improvement: { ref: 1, issue: USE_SIMPLER_LANGUAGE, suggested: 'use' },
        originalIdx: 0
      }
    ]
    const { sortedIssues, sortedImprovements } = buildSortedResults(
      deduped,
      [BASE_IMPROVEMENT],
      false
    )

    expect(sortedIssues).toHaveLength(1)
    expect(sortedImprovements).toHaveLength(1)
  })

  it('logs a warning when some pairs have invalid improvements (droppedCount > 0)', () => {
    const deduped = [
      {
        issue: { issueId: 'i1', absStart: 0, absEnd: SHORT_SPAN_END },
        improvement: null,
        originalIdx: 0
      }
    ]
    const { sortedIssues } = buildSortedResults(deduped, [], false)
    expect(sortedIssues).toHaveLength(0)
  })

  it('logs a warning when improvements are unmatched (unmatchedCount > 0)', () => {
    const extraImprovements = [
      { ref: UNMATCHED_REF, issue: 'x', suggested: 'y' }
    ]
    const { sortedIssues } = buildSortedResults([], extraImprovements, true)
    expect(sortedIssues).toHaveLength(0)
  })
})

// ── sortAndAlignPairs (lines 447-467) ────────────────────────────────────────

describe('sortAndAlignPairs (lines 447-467)', () => {
  it('returns sortedIssues and sortedImprovements via the full pipeline', () => {
    const issues = [
      {
        issueId: 'i1',
        absStart: UTILISE_START,
        absEnd: UTILISE_END,
        ref: 1,
        chunkIdx: 0
      }
    ]
    const improvements = [{ ...BASE_IMPROVEMENT, ref: 1 }]
    const { sortedIssues, sortedImprovements } = sortAndAlignPairs(
      CANONICAL,
      issues,
      improvements
    )

    expect(sortedIssues).toHaveLength(1)
    expect(sortedImprovements).toHaveLength(1)
  })
})
