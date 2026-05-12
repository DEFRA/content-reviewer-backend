import { randomUUID } from 'node:crypto'
import { createLogger } from './logging/logger.js'
import { resolveIssuePosition } from './result-envelope-position-resolver.js'

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
const DISPLAY_GOVUK_STYLE = 'GOV.UK Style Compliance'

const CATEGORY_DISPLAY_NAMES = {
  'plain-english': DISPLAY_PLAIN_ENGLISH,
  'plain english': DISPLAY_PLAIN_ENGLISH,
  'govuk-style': DISPLAY_GOVUK_STYLE,
  'govuk style': DISPLAY_GOVUK_STYLE,
  'govuk style compliance': DISPLAY_GOVUK_STYLE,
  'gov.uk style compliance': DISPLAY_GOVUK_STYLE
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
export function buildSortedResults(deduped) {
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
    issueId: sortedIssues[seqIdx].issueId,
    start: pair.issue.absStart,
    end: pair.issue.absEnd
  }))

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
  return buildSortedResults(deduped)
}
