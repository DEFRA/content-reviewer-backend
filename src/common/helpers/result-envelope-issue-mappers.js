import { randomUUID } from 'node:crypto'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

// Bedrock scores are 0-5; spec requires 0-100
export const SCORE_SCALE_FACTOR = 20

// Fuzzy matching — minimum search length to attempt and required similarity
const FUZZY_MIN_SEARCH_LENGTH = 8
const FUZZY_SIMILARITY_THRESHOLD = 0.82

/**
 * Derive the evidence text for an issue: prefer slicing canonicalText by offset,
 * fall back to the raw issue's text field.
 * @param {number} start
 * @param {number} end
 * @param {string} canonicalText
 * @param {string} fallbackText
 * @returns {string}
 */
export function deriveEvidence(start, end, canonicalText, fallbackText) {
  if (canonicalText && start < end) {
    return canonicalText.slice(start, end)
  }
  return fallbackText || ''
}

/**
 * Derive the category for an issue from the raw issue type or improvement category.
 * Returns a lowercase-hyphenated value used for CSS class names.
 * @param {Object} rawIssue
 * @param {Object|null} improvement
 * @returns {string}
 */
export function deriveCategory(rawIssue, improvement) {
  return (rawIssue.type || improvement?.category || 'general').toLowerCase()
}

const DISPLAY_PLAIN_ENGLISH = 'Plain English'
const DISPLAY_CLARITY = 'Clarity & Structure'
const DISPLAY_GOVUK_STYLE = 'GOV.UK Style Compliance'
const DISPLAY_COMPLETENESS = 'Content Completeness'

const CATEGORY_DISPLAY_NAMES = {
  'plain-english': DISPLAY_PLAIN_ENGLISH,
  'plain english': DISPLAY_PLAIN_ENGLISH,
  clarity: DISPLAY_CLARITY,
  'clarity & structure': DISPLAY_CLARITY,
  accessibility: 'Accessibility',
  'govuk-style': DISPLAY_GOVUK_STYLE,
  'govuk style': DISPLAY_GOVUK_STYLE,
  'govuk style compliance': DISPLAY_GOVUK_STYLE,
  'gov.uk style compliance': DISPLAY_GOVUK_STYLE,
  completeness: DISPLAY_COMPLETENESS,
  'content completeness': DISPLAY_COMPLETENESS
}

/**
 * Map a raw category value to the canonical Title Case display name.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeCategoryDisplay(raw) {
  if (!raw) {
    return ''
  }
  return CATEGORY_DISPLAY_NAMES[raw.toLowerCase()] || raw
}

/**
 * Build a normalized version of text for fuzzy matching and a mapping array
 * from each normalized-string index back to its original-string index.
 *
 * Normalization: collapses runs of whitespace to a single space and converts
 * Unicode smart quotes/apostrophes to their ASCII equivalents.
 *
 * @param {string} text
 * @returns {{ normalized: string, indexMap: number[] }}
 */
export function buildNormalizedMapping(text) {
  let normalized = ''
  const indexMap = []
  let prevWasSpace = false

  for (let i = 0; i < text.length; i++) {
    let ch = text[i]
    if (ch === '\u2018' || ch === '\u2019') {
      ch = "'"
    }
    if (ch === '\u201C' || ch === '\u201D') {
      ch = '"'
    }

    if (/\s/.test(ch)) {
      if (!prevWasSpace) {
        normalized += ' '
        indexMap.push(i)
        prevWasSpace = true
      }
    } else {
      normalized += ch
      indexMap.push(i)
      prevWasSpace = false
    }
  }

  return { normalized, indexMap }
}

/**
 * Compute Levenshtein edit distance between strings a and b.
 * Uses a two-row rolling array — memory is O(n).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  if (m === 0) {
    return n
  }
  if (n === 0) {
    return m
  }

  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = Array.from({ length: n + 1 })

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1])
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/**
 * Slide a fixed-length window over normRegion and return the position with the
 * highest Levenshtein similarity to normSearch, provided it meets `threshold`.
 *
 * Called by findWithinSourceMapRegion when exact normalised indexOf fails.
 * normRegion is already a small slice (typically ±1 line around the hint) so
 * the O(region × search²) cost is acceptable in practice.
 *
 * @param {string}   normSearch    - whitespace/quote-normalised search text
 * @param {string}   normRegion    - whitespace/quote-normalised region text
 * @param {number[]} indexMap      - maps normRegion index → regionText index
 * @param {number}   regionStart   - offset of region within canonicalText
 * @param {number}   [threshold]   - minimum similarity score (default 0.82)
 * @returns {{ start: number, end: number } | null}
 */
export function fuzzySearchInRegion(
  normSearch,
  normRegion,
  indexMap,
  regionStart,
  threshold = FUZZY_SIMILARITY_THRESHOLD
) {
  if (normSearch.length < FUZZY_MIN_SEARCH_LENGTH) {
    return null
  }
  if (normRegion.length < normSearch.length) {
    return null
  }

  const searchLen = normSearch.length
  const maxAllowedDist = Math.floor(searchLen * (1 - threshold))

  let bestDist = maxAllowedDist + 1
  let bestIdx = -1

  for (let i = 0; i <= normRegion.length - searchLen; i++) {
    const dist = levenshtein(normSearch, normRegion.slice(i, i + searchLen))
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
      if (dist === 0) {
        break
      } // exact match, can't improve
    }
  }

  if (bestIdx === -1) {
    return null
  }

  const endIdx = bestIdx + searchLen - 1
  if (endIdx >= indexMap.length) {
    return null
  }

  const origStart = regionStart + indexMap[bestIdx]
  const origEnd = regionStart + indexMap[endIdx] + 1

  if (origEnd <= origStart) {
    return null
  }

  return { start: origStart, end: origEnd }
}

/**
 * Return true when the required inputs for a sourceMap region search are valid.
 * @param {string} searchText
 * @param {string} canonicalText
 * @param {Array}  sourceMap
 * @returns {boolean}
 */
function isValidRegionSearchInput(searchText, canonicalText, sourceMap) {
  return (
    Boolean(searchText) &&
    Boolean(canonicalText) &&
    Array.isArray(sourceMap) &&
    sourceMap.length > 0
  )
}

/**
 * Search for searchText (after whitespace/quote normalisation) within the
 * region of canonicalText identified by the sourceMap lines that overlap the
 * LLM-hinted offsets (expanded by ±1 line to absorb small offset errors).
 *
 * Returns `{ start, end }` in canonicalText coordinates, or `null` when the
 * text cannot be located within the region.
 *
 * @param {string} searchText
 * @param {string} canonicalText
 * @param {Array}  sourceMap   - array of { start, end, lineIndex } entries
 * @param {number} llmStart    - LLM-reported start offset (hint)
 * @param {number} llmEnd      - LLM-reported end offset (hint)
 * @returns {{ start: number, end: number } | null}
 */
export function findWithinSourceMapRegion(
  searchText,
  canonicalText,
  sourceMap,
  llmStart,
  llmEnd
) {
  if (!isValidRegionSearchInput(searchText, canonicalText, sourceMap)) {
    return null
  }

  // Find entries whose range overlaps the LLM hint
  const overlapping = sourceMap.filter(
    (entry) => entry.end >= llmStart && entry.start <= llmEnd
  )
  if (!overlapping.length) {
    return null
  }

  // Expand ±1 line to absorb small offset errors from the model
  const minLine = Math.max(0, overlapping[0].lineIndex - 1)
  const maxLine = overlapping.at(-1).lineIndex + 1

  const expanded = sourceMap.filter(
    (entry) => entry.lineIndex >= minLine && entry.lineIndex <= maxLine
  )

  const regionStart = expanded[0].start
  const regionEnd = Math.min(expanded.at(-1).end, canonicalText.length)
  const regionText = canonicalText.slice(regionStart, regionEnd)

  const { normalized: normRegion, indexMap } =
    buildNormalizedMapping(regionText)
  const { normalized: normSearch } = buildNormalizedMapping(searchText)

  if (!normSearch.length) {
    return null
  }

  const idx = normRegion.indexOf(normSearch)
  if (idx === -1) {
    const fuzzyResult = fuzzySearchInRegion(
      normSearch,
      normRegion,
      indexMap,
      regionStart
    )
    if (fuzzyResult) {
      logger.info(
        {
          resolvedStart: fuzzyResult.start,
          resolvedEnd: fuzzyResult.end,
          llmStart,
          llmEnd,
          text: searchText.substring(0, 60)
        },
        '[result-envelope] Resolved position via fuzzy match within sourceMap region'
      )
    }
    return fuzzyResult
  }

  const endIdx = idx + normSearch.length - 1
  if (endIdx >= indexMap.length) {
    return null
  }

  const origStart = regionStart + indexMap[idx]
  const origEnd = regionStart + indexMap[endIdx] + 1

  if (origEnd <= origStart) {
    return null
  }

  return { start: origStart, end: origEnd }
}

/**
 * Search canonicalText for the nearest occurrence of `searchText` to `hintMid`.
 * Returns `{ start, end }` when found, or `null` when the text is not present.
 * @param {string} searchText
 * @param {string} canonicalText
 * @param {number} hintMid
 * @returns {{ start: number, end: number } | null}
 */
export function findNearestOccurrence(searchText, canonicalText, hintMid) {
  if (!searchText || !canonicalText) {
    return null
  }
  let bestStart = -1
  let bestDistance = Infinity
  let searchFrom = 0

  while (searchFrom <= canonicalText.length) {
    const found = canonicalText.indexOf(searchText, searchFrom)
    if (found === -1) {
      break
    }
    const mid = found + searchText.length / 2
    const dist = Math.abs(mid - hintMid)
    if (dist < bestDistance) {
      bestDistance = dist
      bestStart = found
    }
    searchFrom = found + 1
  }

  if (bestStart === -1) {
    return null
  }
  return { start: bestStart, end: bestStart + searchText.length }
}

/**
 * Return `{ start, end }` when the canonical text slice exactly matches issueText,
 * otherwise null.
 * @param {string} issueText
 * @param {string} canonicalText
 * @param {number} start
 * @param {number} end
 * @returns {{ start: number, end: number } | null}
 */
function resolveExactMatch(issueText, canonicalText, start, end) {
  if (issueText && canonicalText.slice(start, end) === issueText) {
    return { start, end }
  }
  return null
}

/**
 * Resolve the best character-offset pair for a raw issue using verbatim text
 * fields as ground truth.  Falls back to the original offsets if not found.
 *
 * Resolution order:
 *   1. Exact slice match at the reported offsets
 *   2. Nearest exact occurrence of issueText in full canonicalText
 *   3. Normalised (whitespace/quote) search within the sourceMap line region
 *   4. Nearest exact occurrence of fallbackText (improvement.current) in full canonicalText
 *   5. Normalised search of fallbackText within the sourceMap line region
 *   6. Original offsets as-is (last resort)
 *
 * @param {number}      start
 * @param {number}      end
 * @param {string}      issueText
 * @param {string}      canonicalText
 * @param {string|null} [fallbackText]
 * @param {Array|null}  [sourceMap]
 * @returns {{ start: number, end: number }}
 */
export function resolveIssuePosition(
  start,
  end,
  issueText,
  canonicalText,
  fallbackText = null,
  sourceMap = null
) {
  // Step 1: exact slice match
  const exact = resolveExactMatch(issueText, canonicalText, start, end)
  if (exact) {
    return exact
  }

  const hintMid = (start + end) / 2

  // Steps 2–3: search by issueText
  if (issueText) {
    const found2 = findNearestOccurrence(issueText, canonicalText, hintMid)
    if (found2) {
      logger.info(
        {
          originalStart: start,
          originalEnd: end,
          resolvedStart: found2.start,
          resolvedEnd: found2.end,
          source: 'issueText',
          text: issueText.substring(0, 60)
        },
        '[result-envelope] Resolved issue position via issueText search'
      )
      return found2
    }
    const found3 = sourceMap
      ? findWithinSourceMapRegion(
          issueText,
          canonicalText,
          sourceMap,
          start,
          end
        )
      : null
    if (found3) {
      logger.info(
        {
          originalStart: start,
          originalEnd: end,
          resolvedStart: found3.start,
          resolvedEnd: found3.end,
          source: 'sourceMap-region-normalised',
          text: issueText.substring(0, 60)
        },
        '[result-envelope] Resolved issue position via normalised sourceMap region search'
      )
      return found3
    }
  }

  // Steps 4–5: search by fallbackText
  if (fallbackText) {
    const found4 = findNearestOccurrence(fallbackText, canonicalText, hintMid)
    if (found4) {
      logger.info(
        {
          originalStart: start,
          originalEnd: end,
          resolvedStart: found4.start,
          resolvedEnd: found4.end,
          source: 'fallbackText (improvement.current)',
          text: fallbackText.substring(0, 60)
        },
        '[result-envelope] Resolved issue position via improvement.current fallback'
      )
      return found4
    }
    const found5 = sourceMap
      ? findWithinSourceMapRegion(
          fallbackText,
          canonicalText,
          sourceMap,
          start,
          end
        )
      : null
    if (found5) {
      logger.info(
        {
          originalStart: start,
          originalEnd: end,
          resolvedStart: found5.start,
          resolvedEnd: found5.end,
          source: 'sourceMap-region-normalised-fallback',
          text: fallbackText.substring(0, 60)
        },
        '[result-envelope] Resolved issue position via normalised sourceMap region search (improvement.current fallback)'
      )
      return found5
    }
  }

  return { start, end }
}

/**
 * Map a parsed issue + its paired improvement into the spec issue object.
 * @param {Object}     rawIssue
 * @param {Object}     improvement
 * @param {number}     idx
 * @param {string}     canonicalText
 * @param {Array|null} [sourceMap]
 * @returns {Object}
 */
export function mapIssue(
  rawIssue,
  improvement,
  idx,
  canonicalText,
  sourceMap = null
) {
  let start = rawIssue.start ?? 0
  let end = rawIssue.end ?? 0

  if (canonicalText) {
    const resolved = resolveIssuePosition(
      start,
      end,
      rawIssue.text || '',
      canonicalText,
      improvement?.current || null,
      sourceMap
    )
    start = resolved.start
    end = resolved.end
  }

  return {
    issueId: `issue-${randomUUID()}`,
    absStart: start,
    absEnd: end,
    category: deriveCategory(rawIssue, improvement),
    severity: improvement?.severity || 'medium',
    why: improvement?.why || improvement?.issue || '',
    suggested: improvement?.suggested || '',
    evidence: deriveEvidence(start, end, canonicalText, rawIssue.text),
    chunkIdx: idx,
    ref: rawIssue.ref
  }
}

/**
 * Build an improvement object that mirrors its parsed improvement.
 * @param {Object} parsedImprovement
 * @param {string} issueId
 * @returns {Object}
 */
export function mapImprovement(parsedImprovement, issueId) {
  return {
    issueId,
    severity: parsedImprovement?.severity || 'medium',
    category: normalizeCategoryDisplay(parsedImprovement?.category),
    issue: parsedImprovement?.issue || '',
    why: parsedImprovement?.why || '',
    current: parsedImprovement?.current || '',
    suggested: parsedImprovement?.suggested || '',
    ref: parsedImprovement?.ref
  }
}

/**
 * Snap a character offset pair to the nearest word boundaries in text.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {{ start: number, end: number }}
 */
export function snapToWordBoundary(text, start, end) {
  const wordChar = /\w/

  let s = start
  while (s > 0 && wordChar.test(text[s - 1])) {
    s--
  }

  let e = end
  while (e < text.length && wordChar.test(text[e])) {
    e++
  }

  while (e > s && /\s/.test(text[e - 1])) {
    e--
  }

  while (s < e && /\s/.test(text[s])) {
    s++
  }

  return { start: s, end: e }
}

/**
 * Determine whether all issues carry a valid `ref` field AND at least one
 * improvement also carries a `ref` field.
 * @param {Array} issues
 * @param {Array} improvements
 * @returns {boolean}
 */
export function hasRefFields(issues, improvements) {
  if (issues.length === 0) {
    return false
  }
  const allIssuesHaveRef = issues.every(
    (i) => i.ref !== undefined && !Number.isNaN(i.ref)
  )
  const anyImprovementHasRef = improvements.some(
    (imp) => imp.ref !== undefined && !Number.isNaN(imp.ref)
  )
  return allIssuesHaveRef && anyImprovementHasRef
}

/**
 * Build a ref → improvement lookup map from the improvements array.
 * @param {Array}   improvements
 * @param {boolean} useRefMatching
 * @returns {Map}
 */
export function buildRefMap(improvements, useRefMatching) {
  const refMap = new Map()
  if (!useRefMatching) {
    return refMap
  }
  for (const imp of improvements) {
    if (imp.ref !== undefined && !refMap.has(imp.ref)) {
      refMap.set(imp.ref, imp)
    }
  }
  return refMap
}

/**
 * Map issues to (snapped-offset issue, improvement) pairs, filter invalid
 * spans, then sort by ascending absStart.
 * @param {string}  canonicalText
 * @param {Array}   issues
 * @param {Array}   improvements
 * @param {boolean} useRefMatching
 * @param {Map}     refMap
 * @returns {Array}
 */
export function buildPairs(
  canonicalText,
  issues,
  improvements,
  useRefMatching,
  refMap
) {
  return issues
    .map((issue, idx) => {
      const snapped = snapToWordBoundary(
        canonicalText,
        issue.absStart ?? 0,
        issue.absEnd ?? 0
      )
      const improvement = useRefMatching
        ? refMap.get(issue.ref) || null
        : improvements[idx] || null
      return {
        issue: { ...issue, absStart: snapped.start, absEnd: snapped.end },
        improvement,
        originalIdx: idx
      }
    })
    .filter(({ issue }) => {
      const { absStart, absEnd } = issue
      return (
        typeof absStart === 'number' &&
        typeof absEnd === 'number' &&
        absStart >= 0 &&
        absEnd > absStart &&
        absEnd <= canonicalText.length
      )
    })
    .sort((a, b) => a.issue.absStart - b.issue.absStart)
}

/**
 * Remove overlapping issue spans from a sorted pairs array.
 * Earlier spans take precedence; later overlapping spans are dropped.
 * @param {Array} sortedPairs
 * @returns {Array}
 */
export function dedupeOverlaps(sortedPairs) {
  const deduped = []
  let cursor = 0
  for (const pair of sortedPairs) {
    if (pair.issue.absStart < cursor) {
      logger.warn(
        {
          absStart: pair.issue.absStart,
          absEnd: pair.issue.absEnd,
          cursor,
          originalIdx: pair.originalIdx,
          ref: pair.issue.ref
        },
        '[result-envelope] Dropping overlapping issue span'
      )
      continue
    }
    deduped.push(pair)
    cursor = pair.issue.absEnd
  }
  return deduped
}

/**
 * Return true when an improvement is displayable.
 * @param {Object|null} improvement
 * @returns {boolean}
 */
export function isValidImprovement(improvement) {
  if (!improvement) {
    return false
  }
  const hasSuggested =
    improvement.suggested && improvement.suggested.trim().length > 0
  const hasRealTitle =
    improvement.issue &&
    improvement.issue.trim().toLowerCase() !== 'issue identified'
  return hasSuggested && hasRealTitle
}

/**
 * Build sortedIssues and sortedImprovements from deduplicated pairs.
 * Only pairs with a valid improvement are included.
 * @param {Array}   deduped
 * @param {Array}   improvements
 * @param {boolean} useRefMatching
 * @returns {{ sortedIssues: Array, sortedImprovements: Array }}
 */
export function buildSortedResults(deduped, improvements, useRefMatching) {
  const validPairs = deduped.filter((pair) =>
    isValidImprovement(pair.improvement)
  )

  const droppedCount = deduped.length - validPairs.length
  if (droppedCount > 0) {
    logger.warn(
      { droppedCount },
      '[result-envelope] Dropped pairs with invalid/missing improvements (no highlight or improvement card will appear)'
    )
  }

  const sortedIssues = validPairs.map((pair, seqIdx) => ({
    ...pair.issue,
    chunkIdx: seqIdx
  }))

  const sortedImprovements = validPairs.map((pair, seqIdx) => ({
    ...pair.improvement,
    issueId: sortedIssues[seqIdx].issueId
  }))

  const matchedRefs = new Set(
    validPairs
      .filter((p) => p.improvement !== null)
      .map((p) =>
        useRefMatching ? p.issue.ref : improvements.indexOf(p.improvement)
      )
  )
  const unmatchedCount = useRefMatching
    ? improvements.filter(
        (imp) => imp.ref !== undefined && !matchedRefs.has(imp.ref)
      ).length
    : Math.max(0, improvements.length - deduped.length)

  if (unmatchedCount > 0) {
    logger.warn(
      { unmatchedCount, useRefMatching },
      '[result-envelope] Unmatched improvements discarded (no corresponding highlight in text)'
    )
  }

  return { sortedIssues, sortedImprovements }
}

/**
 * Sort and align issues with their paired improvements using ref-based
 * matching (primary) or index-based pairing (fallback).
 * @param {string} canonicalText
 * @param {Array}  issues
 * @param {Array}  improvements
 * @returns {{ sortedIssues: Array, sortedImprovements: Array }}
 */
export function sortAndAlignPairs(canonicalText, issues, improvements) {
  const useRefMatching = hasRefFields(issues, improvements)

  logger.info(
    {
      useRefMatching,
      issueCount: issues.length,
      improvementCount: improvements.length
    },
    `[result-envelope] Pairing strategy: ${useRefMatching ? 'ref-based' : 'index-based (fallback)'}`
  )

  const refMap = buildRefMap(improvements, useRefMatching)
  const pairs = buildPairs(
    canonicalText,
    issues,
    improvements,
    useRefMatching,
    refMap
  )
  const deduped = dedupeOverlaps(pairs)
  return buildSortedResults(deduped, improvements, useRefMatching)
}
