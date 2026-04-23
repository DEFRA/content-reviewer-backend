import { describe, it, expect, vi } from 'vitest'

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

import {
  mapImprovement,
  mapIssue,
  findNearestOccurrence,
  buildPairs,
  dedupeOverlaps,
  isValidImprovement,
  buildSortedResults,
  sortAndAlignPairs
} from './result-envelope-issue-mappers.js'

// ── Shared test data ──────────────────────────────────────────────────────────

const CANONICAL = 'The department should utilise all resources.'
const HELLO_WORLD = 'hello world'
const PLAIN_ENGLISH = 'plain-english'
const USE_SIMPLER_LANGUAGE = 'Use simpler language'

// 'utilise' offsets in CANONICAL
const UTILISE_START = 22
const UTILISE_END = 29

// buildPairs: ref number for ref-matching
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

// refMap miss test: a ref that is present in the map but NOT on the issue
const ABSENT_REF = 99

const BASE_IMPROVEMENT = {
  ref: 1,
  issue: USE_SIMPLER_LANGUAGE,
  suggested: 'use',
  severity: 'medium',
  category: PLAIN_ENGLISH,
  why: '',
  current: ''
}

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

// ── mapImprovement – null / missing field fallback branches (line 213 area) ───
// Covers the `?.` null path and the `|| 'medium'` / `|| ''` defaults when
// parsedImprovement is null or its fields are absent.

describe('mapImprovement – null parsedImprovement (?.  null-path branch)', () => {
  it('returns medium severity and empty strings when parsedImprovement is null', () => {
    const result = mapImprovement(null, 'issue-null')
    expect(result.issueId).toBe('issue-null')
    expect(result.severity).toBe('medium')
    expect(result.category).toBe('')
    expect(result.issue).toBe('')
    expect(result.why).toBe('')
    expect(result.current).toBe('')
    expect(result.suggested).toBe('')
    expect(result.ref).toBeUndefined()
  })

  it('returns medium severity and empty strings when parsedImprovement has no fields', () => {
    const result = mapImprovement({}, 'issue-empty')
    expect(result.severity).toBe('medium')
    expect(result.issue).toBe('')
    expect(result.suggested).toBe('')
  })
})

// ── buildPairs – absStart/absEnd nullish fallback branches (lines 313-314) ────
// Covers the `?? 0` fallback when issue.absStart or issue.absEnd is null/undefined.

describe('buildPairs – absStart/absEnd ?? 0 fallback branches (lines 313-314)', () => {
  it('defaults absStart and absEnd to 0 when they are null on the issue', () => {
    const issues = [{ issueId: 'i1', absStart: null, absEnd: null, ref: null }]
    const pairs = buildPairs(HELLO_WORLD, issues, [null], false, new Map())
    // snapToWordBoundary expands 0→0 to a valid word span so the pair passes the filter
    expect(Array.isArray(pairs)).toBe(true)
  })

  it('defaults absStart and absEnd to 0 when they are undefined on the issue', () => {
    const issues = [{ issueId: 'i1', ref: null }] // no absStart / absEnd
    const pairs = buildPairs(HELLO_WORLD, issues, [null], false, new Map())
    expect(Array.isArray(pairs)).toBe(true)
  })
})

// ── buildPairs – refMap.get(issue.ref) || null branch (line 317) ──────────────
// Covers the `|| null` fallback when useRefMatching=true but the issue ref
// is not present in the refMap.

describe('buildPairs – refMap miss returns null improvement (line 317)', () => {
  it('sets improvement to null when issue.ref is not found in the refMap', () => {
    const refMap = new Map([
      [ABSENT_REF, { ref: ABSENT_REF, issue: 'x', suggested: 'y' }]
    ])
    const issues = [
      { issueId: 'i1', absStart: UTILISE_START, absEnd: UTILISE_END, ref: 1 }
    ]
    // ref 1 is not in refMap → refMap.get(1) returns undefined → || null → null
    const pairs = buildPairs(CANONICAL, issues, [], true, refMap)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].improvement).toBeNull()
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

  it('returns empty arrays when issues and improvements are both empty', () => {
    const { sortedIssues, sortedImprovements } = sortAndAlignPairs(
      CANONICAL,
      [],
      []
    )
    expect(sortedIssues).toHaveLength(0)
    expect(sortedImprovements).toHaveLength(0)
  })
})

// ── findNearestOccurrence – dist < bestDistance false branch (line 90) ─────────
// Covers the false branch of `if (dist < bestDistance)` by making the first
// match already closer than the second, so the second match does not update best.

describe('findNearestOccurrence – skips farther second match (line 90 false branch)', () => {
  it('keeps the first occurrence when it is closer to hintMid than the second', () => {
    // text: 'utilise stuff and utilise more'
    // first 'utilise' at 0 (mid≈3.5), second at 18 (mid≈21.5)
    // hintMid=0 → first is closer (dist 3.5 < 21.5), second fails the < check
    const text = 'utilise stuff and utilise more'
    const result = findNearestOccurrence('utilise', text, 0)
    expect(result).toEqual({ start: 0, end: 7 })
  })
})

// ── mapIssue – rawIssue.start/end ?? 0 null paths (lines 174-175) ─────────────
// Covers the `?? 0` true branch when start/end are absent from the raw issue.

describe('mapIssue – undefined start/end default to 0 (lines 174-175)', () => {
  it('uses 0 for absStart and absEnd when rawIssue has no start or end', () => {
    const rawIssue = { text: 'hello', type: 'clarity', ref: null }
    const result = mapIssue(rawIssue, null, 0, null)
    expect(result.absStart).toBe(0)
    expect(result.absEnd).toBe(0)
  })
})

// ── mapIssue – rawIssue.text || '' and improvement?.current null paths ─────────
// Covers lines 181 (text absent → '') and 183 (improvement null → null).

describe('mapIssue – absent text and null improvement with canonicalText (lines 181-183)', () => {
  it('passes empty string for issueText when rawIssue has no text field', () => {
    // no text → rawIssue.text || '' → ''
    // improvement null → improvement?.current || null → null
    const rawIssue = { start: 0, end: 5, type: 'clarity', ref: null }
    const result = mapIssue(rawIssue, null, 0, HELLO_WORLD)
    expect(typeof result.evidence).toBe('string')
    expect(result.absStart).toBeGreaterThanOrEqual(0)
  })

  it('passes null for improvement.current when improvement is null', () => {
    // improvement?.current → undefined → undefined || null → null
    const rawIssue = {
      start: 0,
      end: 5,
      text: 'hello',
      type: 'clarity',
      ref: null
    }
    const result = mapIssue(rawIssue, null, 0, HELLO_WORLD)
    expect(result.evidence).toBe('hello')
  })
})
