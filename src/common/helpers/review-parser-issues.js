import { createLogger } from './logging/logger.js'

const logger = createLogger()

const FALLBACK_PREVIEW_LENGTH = 200
const CURRENT_LOG_PREVIEW_LENGTH = 80
const TYPE_PLAIN_ENGLISH = 'plain-english'

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
 * Locate the exact position of a text span in the document using indexOf.
 * Ignores the model's stated offsets entirely — they are frequently hallucinated.
 * Returns { start, end } on success, or null if the text is not found.
 */
export function locateTextInDocument(text, ref, originalText) {
  const actualStart = originalText ? originalText.indexOf(text) : -1

  if (actualStart === -1) {
    logger.warn(
      { ref, text: text.substring(0, CURRENT_LOG_PREVIEW_LENGTH) },
      '[review-parser] Discarding issue: text not found in document'
    )
    return null
  }

  return { start: actualStart, end: actualStart + text.length }
}

function mapRawIssue(raw, originalText) {
  const start = Number(raw.start)
  const end = Number(raw.end)
  const type = raw.type || TYPE_PLAIN_ENGLISH

  if (Number.isNaN(start) || Number.isNaN(end) || end <= start || start < 0) {
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

  const located = locateTextInDocument(text, raw.ref, originalText)
  if (!located) {
    return null
  }

  const ref = raw.ref === undefined ? undefined : Number(raw.ref)

  return { start: located.start, end: located.end, type, text, ref }
}

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
 * Parse the legacy [ISSUE_POSITIONS] section.
 * Expects a single-line JSON: {"issues":[{"start":N,"end":M,"type":"...","text":"..."},...]}
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

function tryExtractIssue(contentText, searchPos) {
  const ISSUE_TAG_LENGTH = '[ISSUE:'.length
  const CATEGORY_OFFSET = 7
  const END_ISSUE_TAG_LENGTH = 8

  const startMarkerPos = contentText.indexOf('[ISSUE:', searchPos)
  if (startMarkerPos === -1) {
    return null
  }

  const closeBracketPos = contentText.indexOf(
    ']',
    startMarkerPos + ISSUE_TAG_LENGTH
  )
  if (closeBracketPos === -1) {
    return null
  }

  const category = contentText.substring(
    startMarkerPos + CATEGORY_OFFSET,
    closeBracketPos
  )
  const endMarkerPos = contentText.indexOf('[/ISSUE]', closeBracketPos + 1)
  if (endMarkerPos === -1) {
    return null
  }

  const text = contentText.substring(closeBracketPos + 1, endMarkerPos)
  return {
    issue: {
      category: category.trim(),
      text: text.trim(),
      position: startMarkerPos
    },
    nextSearchPos: endMarkerPos + END_ISSUE_TAG_LENGTH
  }
}

function extractIssues(contentText) {
  const issues = []
  let searchPos = 0

  while (searchPos < contentText.length) {
    const result = tryExtractIssue(contentText, searchPos)
    if (!result) {
      break
    }

    issues.push(result.issue)
    searchPos = result.nextSearchPos
  }

  return issues
}

function processMarkerRemoval(text, pos) {
  const ISSUE_TAG_LENGTH = '[ISSUE:'.length
  const markerStart = text.indexOf('[ISSUE:', pos)

  if (markerStart === -1) {
    return { textChunk: text.substring(pos), nextPos: -1 }
  }

  const markerEnd = text.indexOf(']', markerStart + ISSUE_TAG_LENGTH)
  if (markerEnd === -1) {
    return { textChunk: text.substring(pos), nextPos: -1 }
  }

  return {
    textChunk: text.substring(pos, markerStart),
    nextPos: markerEnd + 1
  }
}

function removeIssueMarkers(contentText) {
  const withoutClosingTags = contentText.split('[/ISSUE]').join('')
  let result = ''
  let pos = 0

  while (pos < withoutClosingTags.length && pos !== -1) {
    const { textChunk, nextPos } = processMarkerRemoval(withoutClosingTags, pos)
    result += textChunk
    pos = nextPos
  }

  return result
}

/**
 * Parse the legacy [REVIEWED_CONTENT] section with inline [ISSUE:category] markers.
 */
export function parseReviewedContent(contentText) {
  const issues = extractIssues(contentText)
  const plainText = removeIssueMarkers(contentText)

  return {
    plainText: plainText.trim(),
    issues
  }
}
