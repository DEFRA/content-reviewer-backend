import { randomUUID } from 'node:crypto'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

// Bedrock scores are 0-5; spec requires 0-100
export const SCORE_SCALE_FACTOR = 20

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
 * Resolve the best character-offset pair for a raw issue using verbatim text
 * fields as ground truth.  Falls back to the original offsets if not found.
 * @param {number} start
 * @param {number} end
 * @param {string} issueText
 * @param {string} canonicalText
 * @param {string|null} [fallbackText]
 * @returns {{ start: number, end: number }}
 */
export function resolveIssuePosition(
  start,
  end,
  issueText,
  canonicalText,
  fallbackText = null
) {
  if (issueText && canonicalText.slice(start, end) === issueText) {
    return { start, end }
  }

  const hintMid = (start + end) / 2

  if (issueText) {
    const found = findNearestOccurrence(issueText, canonicalText, hintMid)
    if (found) {
      logger.info(
        {
          originalStart: start,
          originalEnd: end,
          resolvedStart: found.start,
          resolvedEnd: found.end,
          source: 'issueText',
          text: issueText.substring(0, 60)
        },
        '[result-envelope] Resolved issue position via issueText search'
      )
      return found
    }
  }

  if (fallbackText) {
    const found = findNearestOccurrence(fallbackText, canonicalText, hintMid)
    if (found) {
      logger.info(
        {
          originalStart: start,
          originalEnd: end,
          resolvedStart: found.start,
          resolvedEnd: found.end,
          source: 'fallbackText (improvement.current)',
          text: fallbackText.substring(0, 60)
        },
        '[result-envelope] Resolved issue position via improvement.current fallback'
      )
      return found
    }
  }

  return { start, end }
}

/**
 * Map a parsed issue + its paired improvement into the spec issue object.
 * @param {Object} rawIssue
 * @param {Object} improvement
 * @param {number} idx
 * @param {string} canonicalText
 * @returns {Object}
 */
export function mapIssue(rawIssue, improvement, idx, canonicalText) {
  let start = rawIssue.start ?? 0
  let end = rawIssue.end ?? 0

  if (canonicalText) {
    const resolved = resolveIssuePosition(
      start,
      end,
      rawIssue.text || '',
      canonicalText,
      improvement?.current || null
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
