import { describe, it, expect, vi } from 'vitest'

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

import {
  buildNormalizedMapping,
  levenshtein,
  fuzzySearchInRegion,
  findWithinSourceMapRegion,
  resolveIssuePosition
} from './result-envelope-position-resolver.js'

// ── Shared constants ──────────────────────────────────────────────────────────

const CANONICAL = 'The department should utilise all resources.'
const CANONICAL_LEN = CANONICAL.length // 44

// Single-line sourceMap spanning the entire CANONICAL
const FULL_SOURCE_MAP = [{ start: 0, end: CANONICAL_LEN, lineIndex: 0 }]

// Multi-line sourceMap (end values are exclusive, matching buildSourceMap output)
const MULTI_LINE_TEXT =
  'Line one is here.\nLine two has content.\nLine three ends it.'
const MULTI_SOURCE_MAP = [
  { start: 0, end: 17, lineIndex: 0 }, // 'Line one is here.'   (17 chars, 0-16)
  { start: 18, end: 39, lineIndex: 1 }, // 'Line two has content.' (21 chars, 18-38)
  { start: 40, end: 59, lineIndex: 2 } // 'Line three ends it.'  (19 chars, 40-58)
]

// Canonical text with a regular apostrophe — used to test smart-quote normalisation
const GOVUK_TEXT = "The government's policy is clear."
const GOVUK_SOURCE_MAP = [{ start: 0, end: GOVUK_TEXT.length, lineIndex: 0 }]

// ─────────────────────────────────────────────────────────────────────────────
// buildNormalizedMapping
// ─────────────────────────────────────────────────────────────────────────────

describe('buildNormalizedMapping – empty input', () => {
  it('returns empty normalized string and empty indexMap for empty string', () => {
    const { normalized, indexMap } = buildNormalizedMapping('')
    expect(normalized).toBe('')
    expect(indexMap).toEqual([])
  })
})

describe('buildNormalizedMapping – plain ASCII (1:1 mapping)', () => {
  it('maps every character 1:1 when there is no whitespace to collapse', () => {
    const { normalized, indexMap } = buildNormalizedMapping('hello')
    expect(normalized).toBe('hello')
    expect(indexMap).toEqual([0, 1, 2, 3, 4])
  })

  it('preserves a single space and records its original index', () => {
    const { normalized, indexMap } = buildNormalizedMapping('a b')
    expect(normalized).toBe('a b')
    expect(indexMap).toEqual([0, 1, 2])
  })
})

describe('buildNormalizedMapping – whitespace collapsing', () => {
  it('collapses double space to single space and skips the second original index', () => {
    const { normalized, indexMap } = buildNormalizedMapping('a  b')
    // 'a' → idx 0, ' ' (first of two) → idx 1, 'b' → idx 3 (idx 2 was second space)
    expect(normalized).toBe('a b')
    expect(indexMap).toEqual([0, 1, 3])
  })

  it('collapses tab characters as whitespace', () => {
    const { normalized } = buildNormalizedMapping('a\tb')
    expect(normalized).toBe('a b')
  })

  it('collapses newline as whitespace', () => {
    const { normalized } = buildNormalizedMapping('a\nb')
    expect(normalized).toBe('a b')
  })

  it('only emits one space for a run of many whitespace characters', () => {
    const { normalized, indexMap } = buildNormalizedMapping('x   y')
    expect(normalized).toBe('x y')
    // space at original index 1 is kept; originals 2 and 3 are skipped; 'y' maps to 4
    expect(indexMap).toEqual([0, 1, 4])
  })
})

describe('buildNormalizedMapping – smart quote substitution', () => {
  it('replaces left single quote (U+2018) with ASCII apostrophe', () => {
    const { normalized } = buildNormalizedMapping('\u2018hello\u2019')
    expect(normalized).toBe("'hello'")
  })

  it('replaces right single quote (U+2019) with ASCII apostrophe', () => {
    const { normalized } = buildNormalizedMapping('it\u2019s')
    expect(normalized).toBe("it's")
  })

  it('replaces left double quote (U+201C) with ASCII double quote', () => {
    const { normalized } = buildNormalizedMapping('\u201Chello\u201D')
    expect(normalized).toBe('"hello"')
  })

  it('replaces right double quote (U+201D) with ASCII double quote', () => {
    const { normalized } = buildNormalizedMapping('\u201D')
    expect(normalized).toBe('"')
  })

  it('preserves the indexMap length when smart quotes are substituted (1:1)', () => {
    // Each smart quote is still 1 code unit, replaced by 1 ASCII char
    const text = '\u2018x\u2019'
    const { normalized, indexMap } = buildNormalizedMapping(text)
    expect(normalized).toBe("'x'")
    expect(indexMap.length).toBe(3)
    expect(indexMap).toEqual([0, 1, 2])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// levenshtein
// ─────────────────────────────────────────────────────────────────────────────

describe('levenshtein – empty string edge cases', () => {
  it('returns 0 when both strings are empty', () => {
    expect(levenshtein('', '')).toBe(0)
  })

  it('returns b.length when a is empty (all insertions)', () => {
    expect(levenshtein('', 'abc')).toBe(3)
  })

  it('returns a.length when b is empty (all deletions)', () => {
    expect(levenshtein('abc', '')).toBe(3)
  })
})

describe('levenshtein – identical strings', () => {
  it('returns 0 for identical single-char strings', () => {
    expect(levenshtein('a', 'a')).toBe(0)
  })

  it('returns 0 for identical multi-char strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0)
  })
})

describe('levenshtein – single edit operations', () => {
  it('returns 1 for a single substitution', () => {
    expect(levenshtein('hello', 'hallo')).toBe(1)
  })

  it('returns 1 for a single insertion', () => {
    expect(levenshtein('hell', 'hello')).toBe(1)
  })

  it('returns 1 for a single deletion', () => {
    expect(levenshtein('hello', 'hell')).toBe(1)
  })
})

describe('levenshtein – multiple edits', () => {
  it('returns 3 when every character is different (same length)', () => {
    expect(levenshtein('abc', 'xyz')).toBe(3)
  })

  it('returns the correct distance for a realistic typo', () => {
    // 'utilise' → 'utilize': s→z = 1 substitution
    expect(levenshtein('utilise', 'utilize')).toBe(1)
  })

  it('handles strings of different lengths', () => {
    // 'kitten' → 'sitting': 3 edits (k→s, e→i, append g)
    expect(levenshtein('kitten', 'sitting')).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fuzzySearchInRegion
// ─────────────────────────────────────────────────────────────────────────────

// Helpers for constructing inputs
function makeInputs(text) {
  return buildNormalizedMapping(text)
}

describe('fuzzySearchInRegion – early-exit guards', () => {
  it('returns null when normSearch is shorter than FUZZY_MIN_SEARCH_LENGTH (8)', () => {
    const { normalized: normRegion, indexMap } = makeInputs('hello world')
    // 'short' has 5 chars < 8
    expect(fuzzySearchInRegion('short', normRegion, indexMap, 0)).toBeNull()
  })

  it('returns null when normRegion is shorter than normSearch', () => {
    const { normalized: normRegion, indexMap } = makeInputs('hi')
    expect(
      fuzzySearchInRegion('longer than region', normRegion, indexMap, 0)
    ).toBeNull()
  })
})

describe('fuzzySearchInRegion – exact match', () => {
  it('finds an exact match and returns correct original offsets', () => {
    const region = 'say hello world again'
    const { normalized: normRegion, indexMap } = makeInputs(region)
    // normSearch = 'hello world' (11 chars, ≥ 8)
    const result = fuzzySearchInRegion(
      'hello world',
      normRegion,
      indexMap,
      0 // regionStart
    )
    // 'hello world' starts at index 4 in region
    expect(result).toEqual({ start: 4, end: 15 })
  })

  it('applies regionStart offset correctly', () => {
    const region = 'say hello world again'
    const { normalized: normRegion, indexMap } = makeInputs(region)
    const REGION_OFFSET = 50
    const result = fuzzySearchInRegion(
      'hello world',
      normRegion,
      indexMap,
      REGION_OFFSET
    )
    expect(result).toEqual({
      start: REGION_OFFSET + 4,
      end: REGION_OFFSET + 15
    })
  })
})

describe('fuzzySearchInRegion – fuzzy (within threshold) match', () => {
  it('matches a string with a single-character substitution within the 0.82 threshold', () => {
    // 'quick brown fax' vs 'quick brown fox': 1 edit in 15 chars = similarity 0.933 > 0.82
    const region = 'The quick brown fox jumps.'
    const { normalized: normRegion, indexMap } = makeInputs(region)
    const result = fuzzySearchInRegion(
      'quick brown fax',
      normRegion,
      indexMap,
      0
    )
    // best window at i=4: 'quick brown fox' (15 chars), dist=1 ≤ floor(15*0.18)=2
    expect(result).not.toBeNull()
    expect(result.start).toBe(4)
    expect(result.end).toBe(19)
  })
})

describe('fuzzySearchInRegion – no match above threshold', () => {
  it('returns null when even the best window exceeds the allowed distance', () => {
    // 'abcdefghij' vs completely different region → no window within threshold
    const region = 'xxxxxxxxxxxxxxxxxxxxxxxxxx'
    const { normalized: normRegion, indexMap } = makeInputs(region)
    const result = fuzzySearchInRegion(
      'abcdefghij', // 10 chars, maxAllowedDist = floor(10*0.18) = 1
      normRegion,
      indexMap,
      0
    )
    expect(result).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// findWithinSourceMapRegion
// ─────────────────────────────────────────────────────────────────────────────

describe('findWithinSourceMapRegion – invalid input guards', () => {
  it('returns null when searchText is falsy', () => {
    expect(
      findWithinSourceMapRegion('', CANONICAL, FULL_SOURCE_MAP, 0, 10)
    ).toBeNull()
  })

  it('returns null when canonicalText is falsy', () => {
    expect(
      findWithinSourceMapRegion('utilise', '', FULL_SOURCE_MAP, 0, 10)
    ).toBeNull()
  })

  it('returns null when sourceMap is null', () => {
    expect(
      findWithinSourceMapRegion('utilise', CANONICAL, null, 0, 10)
    ).toBeNull()
  })

  it('returns null when sourceMap is not an array', () => {
    expect(
      findWithinSourceMapRegion('utilise', CANONICAL, {}, 0, 10)
    ).toBeNull()
  })

  it('returns null when sourceMap is an empty array', () => {
    expect(
      findWithinSourceMapRegion('utilise', CANONICAL, [], 0, 10)
    ).toBeNull()
  })
})

describe('findWithinSourceMapRegion – no overlapping entries', () => {
  it('returns null when llmStart/llmEnd do not overlap any sourceMap entry', () => {
    // FULL_SOURCE_MAP covers 0-44; using offsets far beyond that
    const result = findWithinSourceMapRegion(
      'utilise',
      CANONICAL,
      FULL_SOURCE_MAP,
      200,
      210
    )
    expect(result).toBeNull()
  })
})

describe('findWithinSourceMapRegion – exact normalised match', () => {
  it('finds a substring that exists verbatim within the sourceMap region', () => {
    // 'utilise all' is a substring of CANONICAL starting at index 22
    const result = findWithinSourceMapRegion(
      'utilise all',
      CANONICAL,
      FULL_SOURCE_MAP,
      22,
      33
    )
    expect(result).toEqual({ start: 22, end: 33 })
  })

  it('normalises smart quotes in searchText to find a match in plain-apostrophe canonical text', () => {
    // Canonical text has regular apostrophe; search has smart apostrophe (U+2019)
    // Normalisation converts U+2019 → ' so indexOf succeeds
    const searchText = 'government\u2019s policy' // 19 chars with smart apostrophe
    const result = findWithinSourceMapRegion(
      searchText,
      GOVUK_TEXT,
      GOVUK_SOURCE_MAP,
      0,
      GOVUK_TEXT.length
    )
    expect(result).not.toBeNull()
    // "government's policy" starts at index 4 in GOVUK_TEXT
    expect(result.start).toBe(4)
  })

  it('uses expanded ±1 line window and still finds text in the correct entry', () => {
    // Line two content: 'Line two has content.' (indices 18-38)
    const searchText = 'two has content'
    const result = findWithinSourceMapRegion(
      searchText,
      MULTI_LINE_TEXT,
      MULTI_SOURCE_MAP,
      18,
      38
    )
    expect(result).not.toBeNull()
    expect(result.start).toBe(23) // 'Line two has content.' → 't' of 'two' is at offset 23 in MULTI_LINE_TEXT
  })
})

describe('findWithinSourceMapRegion – fuzzy match fallback', () => {
  it('falls back to fuzzy matching when exact normalised search fails', () => {
    // 'quick brown fax' (≥8 chars) does not occur verbatim but is within edit distance
    const canonicalText = 'The quick brown fox jumps over the lazy dog.'
    const sourceMap = [{ start: 0, end: canonicalText.length, lineIndex: 0 }]
    const result = findWithinSourceMapRegion(
      'quick brown fax',
      canonicalText,
      sourceMap,
      4,
      19
    )
    expect(result).not.toBeNull()
    // Should resolve to the position of 'quick brown fox' in the canonical
    expect(result.start).toBe(4)
    expect(result.end).toBe(19)
  })

  it('returns null when fuzzy match also fails to find anything close enough', () => {
    // Search term completely unrelated to canonical content
    const canonicalText = 'The quick brown fox jumps over the lazy dog.'
    const sourceMap = [{ start: 0, end: canonicalText.length, lineIndex: 0 }]
    const result = findWithinSourceMapRegion(
      'zzzzzzzzzzzzzzzz', // 16 chars, all 'z' — far from any content
      canonicalText,
      sourceMap,
      0,
      20
    )
    expect(result).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolveIssuePosition – sourceMap-assisted steps (3 and 5)
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveIssuePosition – step 3: sourceMap normalised search for issueText', () => {
  it('resolves via sourceMap when issueText has smart quote absent from exact search', () => {
    // issueText has U+2019 (smart apostrophe); canonical has plain apostrophe.
    // Step 1: slice(0,5) = "The g" ≠ issueText → miss.
    // Step 2: exact indexOf fails (different quote char) → null.
    // Step 3: normalised search within sourceMap region succeeds.
    const issueText = 'government\u2019s policy' // 19 chars
    const result = resolveIssuePosition(
      0,
      5,
      issueText,
      GOVUK_TEXT,
      null,
      GOVUK_SOURCE_MAP
    )
    // "government's policy" starts at 4 in GOVUK_TEXT
    expect(result.start).toBe(4)
    expect(result.end).toBeGreaterThan(4)
  })

  it('resolves via sourceMap fuzzy match when issueText has a small typo', () => {
    // 'quick brown fax' is not in the text verbatim (step 2 misses)
    // but fuzzy match within sourceMap region resolves it
    const canonicalText = 'The quick brown fox jumps over the lazy dog.'
    const sourceMap = [{ start: 0, end: canonicalText.length, lineIndex: 0 }]
    const result = resolveIssuePosition(
      0,
      5,
      'quick brown fax',
      canonicalText,
      null,
      sourceMap
    )
    expect(result.start).toBe(4) // 'quick brown fox' starts at 4
  })

  it('returns original offsets when step 3 sourceMap search also finds nothing', () => {
    const canonicalText = 'The quick brown fox jumps.'
    const sourceMap = [{ start: 0, end: canonicalText.length, lineIndex: 0 }]
    const START = 3
    const END = 8
    // issueText not found anywhere and too different for fuzzy
    const result = resolveIssuePosition(
      START,
      END,
      'zzzzzzzzzzzzzzzz',
      canonicalText,
      null,
      sourceMap
    )
    expect(result).toEqual({ start: START, end: END })
  })
})

describe('resolveIssuePosition – step 5: sourceMap normalised search for fallbackText', () => {
  it('resolves via sourceMap fallback when issueText is absent and fallbackText has smart quote', () => {
    // issueText = '' → skips steps 2-3
    // fallbackText has smart apostrophe (U+2019) → step 4 exact search misses
    // step 5 normalised sourceMap search succeeds
    const fallbackText = 'government\u2019s policy'
    const result = resolveIssuePosition(
      0,
      5,
      '',
      GOVUK_TEXT,
      fallbackText,
      GOVUK_SOURCE_MAP
    )
    expect(result.start).toBe(4)
    expect(result.end).toBeGreaterThan(4)
  })

  it('returns original offsets when both issueText and fallbackText sourceMap searches fail', () => {
    const canonicalText = 'The quick brown fox jumps.'
    const sourceMap = [{ start: 0, end: canonicalText.length, lineIndex: 0 }]
    const START = 3
    const END = 8
    const result = resolveIssuePosition(
      START,
      END,
      'zzzzzzzzzzzzzzzz',
      canonicalText,
      'yyyyyyyyyyyyyyy', // also not found
      sourceMap
    )
    expect(result).toEqual({ start: START, end: END })
  })

  it('resolves via sourceMap fallback fuzzy match for fallbackText', () => {
    // issueText is not found; fallbackText has a 1-char typo (fuzzy matches)
    const canonicalText = 'The quick brown fox jumps over the lazy dog.'
    const sourceMap = [{ start: 0, end: canonicalText.length, lineIndex: 0 }]
    const result = resolveIssuePosition(
      0,
      5,
      'notfoundanywhere12345', // issueText not found anywhere
      canonicalText,
      'quick brown fax', // fallbackText: 1 typo from 'quick brown fox'
      sourceMap
    )
    // Falls through steps 2-3 (issueText absent), step 4 exact misses, step 5 fuzzy hits
    expect(result.start).toBe(4)
  })
})

describe('resolveIssuePosition – step 3 ternary: null sourceMap skips sourceMap search', () => {
  it('skips step 3 when sourceMap is null and falls through to original offsets', () => {
    const START = 3
    const END = 8
    // issueText truthy but not in canonical; sourceMap null → step 3 skipped
    const result = resolveIssuePosition(
      START,
      END,
      'notpresentatall12345',
      'The quick brown fox.',
      null,
      null // no sourceMap
    )
    expect(result).toEqual({ start: START, end: END })
  })

  it('skips step 5 when sourceMap is null and returns original offsets', () => {
    const START = 3
    const END = 8
    // issueText absent, fallbackText not in canonical, no sourceMap
    const result = resolveIssuePosition(
      START,
      END,
      '',
      'The quick brown fox.',
      'notpresentatall12345',
      null
    )
    expect(result).toEqual({ start: START, end: END })
  })
})
