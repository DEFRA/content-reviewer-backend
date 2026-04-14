import { createLogger } from './logging/logger.js'

const logger = createLogger()

// ─── Keyword lists ───────────────────────────────────────────────────────────

/**
 * Keywords that indicate an improvement is about an unexplained acronym /
 * technical term. Case-insensitive matching is used on the issue + why fields.
 */
const ACRONYM_KEYWORDS = [
  'unexplained',
  'undefined acronym',
  'not explained',
  'not defined',
  'without explanation',
  'needs explanation',
  'should be explained',
  'unfamiliar acronym',
  'jargon',
  'technical term',
  'acronym'
]

/**
 * Keywords that indicate an improvement is about a future-date problem.
 */
const DATE_KEYWORDS = [
  'future date',
  'date in the future',
  'not yet passed',
  'has not occurred',
  "hasn't occurred",
  'upcoming date',
  'future-dated'
]

// ─── Month names for date parsing ────────────────────────────────────────────

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]

const UK_DATE_PART_COUNT = 3

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check whether any keyword from a list appears in the combined text
 * (case-insensitive).
 * @param {string} combinedText - Lower-cased concatenation of relevant fields
 * @param {string[]} keywords
 * @returns {boolean}
 */
function matchesKeywords(combinedText, keywords) {
  return keywords.some((kw) => combinedText.includes(kw))
}

/**
 * Build a lowercase combined string from improvement issue + why fields.
 * @param {{ issue: string, why: string }} improvement
 * @returns {string}
 */
function buildCombinedText(improvement) {
  return `${improvement.issue} ${improvement.why}`.toLowerCase()
}

/**
 * Extract all upper-case "words" (2+ capital letters) from a string.
 * These are candidate acronyms, e.g. "IPAFFS", "MMO", "UK".
 * Uses a simple scan rather than regex to keep complexity low.
 * @param {string} text
 * @returns {string[]}
 */
function extractAcronyms(text) {
  const results = []
  const words = text.split(/[\s,;:.!?()[\]{}]+/)
  for (const word of words) {
    if (
      word.length >= 2 &&
      word === word.toUpperCase() &&
      /^[A-Z]+$/.test(word)
    ) {
      results.push(word)
    }
  }
  return results
}

/**
 * Check whether an acronym is explained in the original text.
 *
 * Looks for patterns like:
 *   "Full Name (ACRONYM)" — e.g. "Import of Products (IPAFFS)"
 *   "ACRONYM (Full Name)" — e.g. "IPAFFS (Import of Products)"
 *
 * @param {string} acronym - e.g. "IPAFFS"
 * @param {string} originalText - The full document text
 * @returns {boolean}
 */
function isAcronymExplainedInText(acronym, originalText) {
  // Pattern 1: "Something (ACRONYM)"
  const wrappedAcronym = `(${acronym})`
  if (originalText.includes(wrappedAcronym)) {
    return true
  }

  // Pattern 2: "ACRONYM (Something)" — the acronym followed by a parenthetical
  const acronymWithParen = `${acronym} (`
  const acronymParenIdx = originalText.indexOf(acronymWithParen)
  if (acronymParenIdx === -1) {
    return false
  }

  // Verify a closing paren follows
  const closeParenIdx = originalText.indexOf(
    ')',
    acronymParenIdx + acronym.length + 2
  )
  return closeParenIdx !== -1
}

// ─── Acronym false-positive detection ────────────────────────────────────────

/**
 * Determine whether an improvement block is a false-positive acronym flag.
 *
 * Strategy:
 * 1. Check if the issue + why text mentions unexplained acronyms / jargon.
 * 2. Extract all upper-case acronyms from the CURRENT field.
 * 3. For each acronym, check whether an expansion exists in originalText.
 * 4. If ALL acronyms in CURRENT are explained, it's a false positive.
 *
 * @param {{ issue: string, why: string, current: string }} improvement
 * @param {string} originalText
 * @returns {boolean}
 */
export function isAcronymFalsePositive(improvement, originalText) {
  if (!originalText) {
    return false
  }

  const combined = buildCombinedText(improvement)

  if (!matchesKeywords(combined, ACRONYM_KEYWORDS)) {
    return false
  }

  // Extract candidate acronyms from CURRENT (or ISSUE if CURRENT is empty)
  const sourceText = improvement.current || improvement.issue || ''
  const acronyms = extractAcronyms(sourceText)

  if (acronyms.length === 0) {
    return false
  }

  // If every acronym found is already explained in the original text → false positive
  return acronyms.every((acr) => isAcronymExplainedInText(acr, originalText))
}

// ─── Date false-positive detection ───────────────────────────────────────────

/**
 * Try to parse an ISO date (YYYY-MM-DD) from text.
 * @param {string} text
 * @returns {Date|null}
 */
function tryParseIsoDate(text) {
  const isoIdx = text.search(/\d{4}-\d{2}-\d{2}/)
  if (isoIdx === -1) {
    return null
  }
  const isoStr = text.substring(isoIdx, isoIdx + 10)
  const ms = Date.parse(isoStr)
  return Number.isNaN(ms) ? null : new Date(ms)
}

/**
 * Try to parse a UK-format slash date (DD/MM/YYYY) from text.
 * @param {string} text
 * @returns {Date|null}
 */
function tryParseSlashDate(text) {
  const slashIdx = text.search(/\d{1,2}\/\d{1,2}\/\d{4}/)
  if (slashIdx === -1) {
    return null
  }
  const slashEnd = text.indexOf(' ', slashIdx)
  const slashStr = text.substring(
    slashIdx,
    slashEnd === -1 ? undefined : slashEnd
  )
  const parts = slashStr.split('/')
  if (parts.length !== UK_DATE_PART_COUNT) {
    return null
  }
  const dateObj = new Date(
    Date.UTC(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]))
  )
  return Number.isNaN(dateObj.getTime()) ? null : dateObj
}

/**
 * Try to parse a date from a single month candidate match.
 * @param {string} text - Original text
 * @param {string} lowerText - Lower-cased text
 * @param {string} month - Lower-case month name
 * @returns {Date|null}
 */
function tryParseMonthCandidate(text, lowerText, month) {
  const monthIdx = lowerText.indexOf(month)
  if (monthIdx === -1) {
    return null
  }

  // Look for year after month name
  const afterMonth = text.substring(monthIdx + month.length).trim()
  const yearMatch = /^(\d{4})\b/.exec(afterMonth)
  if (!yearMatch) {
    return null
  }
  const year = Number(yearMatch[1])

  // Look for day before month name (strip ordinal suffixes)
  const beforeMonth = text.substring(0, monthIdx).trim()
  const dayMatch = /(\d{1,2})(?:st|nd|rd|th)?$/.exec(beforeMonth)
  const day = dayMatch ? Number(dayMatch[1]) : 1

  const dateObj = new Date(Date.UTC(year, MONTHS.indexOf(month), day))
  return Number.isNaN(dateObj.getTime()) ? null : dateObj
}

/**
 * Try to parse a natural language date ("1 January 2025", "January 2025", etc.)
 * from text by scanning for month names.
 * @param {string} text
 * @returns {Date|null}
 */
function tryParseNaturalDate(text) {
  const lowerText = text.toLowerCase()

  for (const month of MONTHS) {
    const result = tryParseMonthCandidate(text, lowerText, month)
    if (result) {
      return result
    }
  }

  return null
}

/**
 * Try to find and parse a date from a text string.
 * Delegates to specialised parsers for each format.
 * @param {string} text
 * @returns {Date|null}
 */
function findDateInText(text) {
  return (
    tryParseIsoDate(text) ||
    tryParseSlashDate(text) ||
    tryParseNaturalDate(text)
  )
}

/**
 * Determine whether an improvement block is a false-positive future-date flag.
 *
 * Strategy:
 * 1. Check if the issue + why text is about a future date.
 * 2. Extract a date from the CURRENT field.
 * 3. Compare to today (UTC). If the date is on or before today → false positive.
 *
 * @param {{ issue: string, why: string, current: string }} improvement
 * @returns {boolean}
 */
export function isDateFalsePositive(improvement) {
  const combined = buildCombinedText(improvement)

  if (!matchesKeywords(combined, DATE_KEYWORDS)) {
    return false
  }

  // Try to find a date in CURRENT, then in ISSUE
  const sourceText = improvement.current || improvement.issue || ''
  const parsed = findDateInText(sourceText)

  if (!parsed) {
    return false
  }

  // Build today at midnight UTC for comparison
  const now = new Date()
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )

  // If the date is on or before today, flagging it as "future" is a false positive
  return parsed.getTime() <= todayUtc.getTime()
}

// ─── Combined filter ─────────────────────────────────────────────────────────

/**
 * Remove false-positive improvements and their linked issues.
 *
 * @param {Array} improvements - Parsed improvement blocks
 * @param {Array} issues - Parsed issues from [ISSUE_POSITIONS] or [REVIEWED_CONTENT]
 * @param {string} originalText - The original document text
 * @returns {{ improvements: Array, issues: Array }}
 */
export function filterFalsePositives(improvements, issues, originalText) {
  const removedRefs = new Set()
  const filtered = []

  for (const imp of improvements) {
    const isAcronymFP = isAcronymFalsePositive(imp, originalText)
    const isDateFP = isDateFalsePositive(imp)

    if (isAcronymFP || isDateFP) {
      const fpType = isAcronymFP ? 'acronym' : 'date'
      logger.info(
        { category: imp.category, issue: imp.issue, ref: imp.ref, fpType },
        '[false-positive-filter] Removed false positive'
      )
      if (imp.ref !== undefined) {
        removedRefs.add(imp.ref)
      }
    } else {
      filtered.push(imp)
    }
  }

  // Also remove any linked issues from [ISSUE_POSITIONS]
  const filteredIssues =
    removedRefs.size > 0
      ? issues.filter(
          (iss) => iss.ref === undefined || !removedRefs.has(iss.ref)
        )
      : issues

  return { improvements: filtered, issues: filteredIssues }
}
