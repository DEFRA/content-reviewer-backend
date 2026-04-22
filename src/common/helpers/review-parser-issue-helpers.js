import { createLogger } from './logging/logger.js'

const logger = createLogger()

const FALLBACK_PREVIEW_LENGTH = 200
const CURRENT_LOG_PREVIEW_LENGTH = 80

// How far (in characters) from the stated offset we search for the text span
const OFFSET_FUZZY_WINDOW = 1000

/**
 * Resolve the text span from either the raw text field or by slicing originalText.
 */
function resolveIssueText(rawText, start, end, originalText) {
  if (rawText) {
    return rawText
  }
  if (!originalText) {
    return ''
  }
  return end <= originalText.length
    ? originalText.slice(start, end)
    : originalText.slice(start)
}

/**
 * Returns true if the raw offset values are valid.
 */
function hasValidOffsets(start, end) {
  return !Number.isNaN(start) && !Number.isNaN(end) && end > start && start >= 0
}

/**
 * Attempts to locate `text` in `originalText` near the stated `start` offset.
 * Returns corrected { start, end } if found within OFFSET_FUZZY_WINDOW, or null if not found.
 * If the exact slice already matches, returns the original offsets immediately.
 */
export function findCorrectedOffsets(text, start, end, originalText) {
  if (!originalText || !text) {
    return null
  }

  // Exact match — no correction needed
  if (end <= originalText.length && originalText.slice(start, end) === text) {
    return { start, end }
  }

  // Search within a window around the stated start offset
  const searchFrom = Math.max(0, start - OFFSET_FUZZY_WINDOW)
  const searchTo = Math.min(originalText.length, end + OFFSET_FUZZY_WINDOW)
  const searchRegion = originalText.slice(searchFrom, searchTo)
  const idx = searchRegion.indexOf(text)

  if (idx === -1) {
    return null
  }

  const correctedStart = searchFrom + idx
  const correctedEnd = correctedStart + text.length
  return { start: correctedStart, end: correctedEnd }
}

/**
 * Map a raw issue entry from the JSON to a validated issue object.
 * Returns null if the issue has no resolvable text or has invalid offsets.
 */
function mapRawIssue(raw, originalText) {
  const start = Number(raw.start)
  const end = Number(raw.end)
  const type = raw.type || 'plain-english'

  if (!hasValidOffsets(start, end)) {
    logger.warn(
      { start: raw.start, end: raw.end, type },
      '[review-parser] Skipping issue with invalid offsets'
    )
    return null
  }

  const text = resolveIssueText(raw.text || '', start, end, originalText)

  if (!text) {
    return null
  }

  const corrected = findCorrectedOffsets(text, start, end, originalText)

  if (!corrected) {
    logger.warn(
      {
        ref: raw.ref,
        start,
        end,
        modelText: text.substring(0, CURRENT_LOG_PREVIEW_LENGTH)
      },
      '[review-parser] Discarding issue: text not found near stated offsets'
    )
    return null
  }

  if (corrected.start !== start || corrected.end !== end) {
    logger.info(
      {
        ref: raw.ref,
        originalStart: start,
        originalEnd: end,
        correctedStart: corrected.start,
        correctedEnd: corrected.end
      },
      '[review-parser] Corrected offset mismatch via fuzzy search'
    )
  }

  const ref = raw.ref === undefined ? undefined : Number(raw.ref)

  return { start: corrected.start, end: corrected.end, type, text, ref }
}

/**
 * Parse a JSON string extracted from the [ISSUE_POSITIONS] section.
 */
function parseIssuePositionsJson(jsonStr, originalText) {
  const parsed = JSON.parse(jsonStr)

  if (!Array.isArray(parsed.issues)) {
    logger.warn({ parsed }, '[ISSUE_POSITIONS] JSON missing "issues" array')
    return []
  }

  return parsed.issues
    .map((raw) => mapRawIssue(raw, originalText))
    .filter(Boolean)
}

/**
 * Parse the [ISSUE_POSITIONS] section.
 */
export function parseIssuePositions(issuePositionsText, originalText = '') {
  const trimmed = issuePositionsText.trim()
  if (!trimmed) {
    return { plainText: originalText, issues: [] }
  }

  const jsonStart = trimmed.indexOf('{')
  const jsonEnd = trimmed.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    logger.warn(
      { trimmed },
      'Could not locate JSON object in [ISSUE_POSITIONS]'
    )
    return { plainText: originalText, issues: [] }
  }

  try {
    const issues = parseIssuePositionsJson(
      trimmed.substring(jsonStart, jsonEnd + 1),
      originalText
    )

    logger.info(
      { issueCount: issues.length },
      'Parsed [ISSUE_POSITIONS] successfully'
    )
    return { plainText: originalText, issues }
  } catch (error) {
    logger.warn(
      {
        error: error.message,
        issuePositionsText: trimmed.substring(0, FALLBACK_PREVIEW_LENGTH)
      },
      'Failed to parse [ISSUE_POSITIONS] JSON'
    )
    return { plainText: originalText, issues: [] }
  }
}
