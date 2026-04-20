import { createLogger } from './logging/logger.js'

const logger = createLogger()

// ─── Shared constants ────────────────────────────────────────────────────────
const FALLBACK_PREVIEW_LENGTH = 200
const SCORES_TAG = '[SCORES]'
const REVIEWED_CONTENT_TAG = '[REVIEWED_CONTENT]'
const ISSUE_POSITIONS_TAG = '[ISSUE_POSITIONS]'
const ISSUE_POSITIONS_CLOSE_TAG = '[/ISSUE_POSITIONS]'
const IMPROVEMENTS_TAG = '[IMPROVEMENTS]'

/**
 * Parse the [ISSUE_POSITIONS] section.
 * Expects a single-line JSON: {"issues":[{"start":N,"end":M,"type":"...","text":"..."},...]}
 * Falls back to resolving text from originalText using start/end offsets if text field is missing.
 * @param {string} issuePositionsText - Raw content between [ISSUE_POSITIONS] and [/ISSUE_POSITIONS]
 * @param {string} [originalText=''] - The original input text sent to Bedrock (used to resolve text from offsets)
 * @returns {{ plainText: string, issues: Array<{start:number,end:number,type:string,text:string}> }}
 */
/**
 * Resolve the text span from either the raw text field or by slicing originalText.
 * Extracted to reduce cyclomatic complexity of mapRawIssue.
 * @param {string} rawText
 * @param {number} start
 * @param {number} end
 * @param {string} originalText
 * @returns {string}
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
 * Map a raw issue entry from the JSON to a validated issue object.
 * Returns null if the issue has no resolvable text or has invalid offsets.
 * Preserves the optional `ref` field (1-based integer) used to link issues
 * to their corresponding [PRIORITY] block in [IMPROVEMENTS].
 */
function mapRawIssue(raw, originalText) {
  const start = Number(raw.start)
  const end = Number(raw.end)
  const type = raw.type || 'plain-english'

  // Reject entries with non-numeric or out-of-order offsets
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

  // Preserve ref if present (integer); undefined when the model omits it
  const ref = raw.ref === undefined ? undefined : Number(raw.ref)

  return { start, end, type, text, ref }
}

/**
 * Parse a JSON string extracted from the [ISSUE_POSITIONS] section.
 * Returns validated issues or an empty array on error.
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
 * Expects a single-line JSON: {"issues":[{"start":N,"end":M,"type":"...","text":"..."},...]}
 * Falls back to resolving text from originalText using start/end offsets if text field is missing.
 * @param {string} issuePositionsText - Raw content between [ISSUE_POSITIONS] and [/ISSUE_POSITIONS]
 * @param {string} [originalText=''] - The original input text sent to Bedrock
 * @returns {{ plainText: string, issues: Array<{start:number,end:number,type:string,text:string}> }}
 */
function parseIssuePositions(issuePositionsText, originalText = '') {
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

/**
 * Try to parse a score from a line
 */
function tryParseScoreLine(line) {
  const colonIndex = line.indexOf(':')
  if (colonIndex <= 0) {
    return null
  }

  const category = line.substring(0, colonIndex).trim()
  const afterColon = line.substring(colonIndex + 1).trim()

  const MIN_SCORE_PATTERN_LENGTH = 3
  const DASH_SEARCH_START = 3

  if (
    afterColon.length < MIN_SCORE_PATTERN_LENGTH ||
    !/^\d\/5/.test(afterColon)
  ) {
    return null
  }

  const score = afterColon.charAt(0)
  const dashIndex = afterColon.indexOf('-', DASH_SEARCH_START)

  if (dashIndex <= 0) {
    return null
  }

  const note = afterColon.substring(dashIndex + 1).trim()
  return {
    category,
    score: Number.parseInt(score),
    note
  }
}

/**
 * Parse the scores section
 */
function parseScores(scoresText) {
  const scores = {}
  const lines = scoresText.trim().split('\n')

  for (const line of lines) {
    const scoreData = tryParseScoreLine(line)
    if (scoreData) {
      scores[scoreData.category] = {
        score: scoreData.score,
        note: scoreData.note
      }
    }
  }

  return scores
}

/**
 * Try to extract a single issue at the given position
 */
function tryExtractIssue(contentText, searchPos) {
  const ISSUE_TAG_LENGTH = '[ISSUE:'.length
  const CATEGORY_OFFSET = 7 // '[ISSUE:'.length
  const END_ISSUE_TAG_LENGTH = 8 // '[/ISSUE]'.length

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

/**
 * Extract issues from content text
 */
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

/**
 * Process a marker removal step
 */
function processMarkerRemoval(text, pos) {
  const ISSUE_TAG_LENGTH = '[ISSUE:'.length
  const markerStart = text.indexOf('[ISSUE:', pos)

  if (markerStart === -1) {
    return {
      textChunk: text.substring(pos),
      nextPos: -1
    }
  }

  const markerEnd = text.indexOf(']', markerStart + ISSUE_TAG_LENGTH)
  if (markerEnd === -1) {
    return {
      textChunk: text.substring(pos),
      nextPos: -1
    }
  }

  return {
    textChunk: text.substring(pos, markerStart),
    nextPos: markerEnd + 1
  }
}

/**
 * Remove issue markers from content
 */
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
 * Parse the reviewed content with issue markers
 */
function parseReviewedContent(contentText) {
  const issues = extractIssues(contentText)
  const plainText = removeIssueMarkers(contentText)

  return {
    plainText: plainText.trim(),
    issues
  }
}

/**
 * Extract field value from block — single-line fields only.
 * Reads from the field name up to the first newline (or end of block).
 * Used for REF, CATEGORY, ISSUE, WHY — fields that are always one line.
 */
function extractField(block, fieldName) {
  // Use indexOf instead of regex to avoid backtracking
  const searchString = `${fieldName}:`
  const startIndex = block.indexOf(searchString)

  if (startIndex === -1) {
    return ''
  }

  const valueStart = startIndex + searchString.length
  let lineEnd = block.indexOf('\n', valueStart)

  if (lineEnd === -1) {
    lineEnd = block.length
  }

  return block.substring(valueStart, lineEnd).trim()
}

/**
 * Extract the CURRENT: field value from a [PRIORITY] block.
 *
 * CURRENT: can legitimately span multiple lines when the highlighted issue
 * is a long sentence or passage that the model wrapped across lines.
 * We read from CURRENT: up to the SUGGESTED: field (which always follows it)
 * so that we capture the full multi-line value without bleeding into other fields.
 */
function extractCurrentField(block) {
  const CURRENT_MARKER = 'CURRENT:'
  const SUGGESTED_MARKER = 'SUGGESTED:'

  const currentStart = block.indexOf(CURRENT_MARKER)
  if (currentStart === -1) {
    return ''
  }

  const valueStart = currentStart + CURRENT_MARKER.length
  const suggestedStart = block.indexOf(SUGGESTED_MARKER, valueStart)
  let valueEnd = block.length
  if (suggestedStart !== -1) {
    valueEnd = suggestedStart
  }

  return block.substring(valueStart, valueEnd).trim()
}

/**
 * Extract the SUGGESTED: field value from a [PRIORITY] block.
 *
 * SUGGESTED: is the last named field before [/PRIORITY], so we read from
 * SUGGESTED: to the end of the block (the [/PRIORITY] delimiter is stripped
 * by the caller's split, so block.length is the safe boundary).
 */
function extractSuggestedField(block) {
  const SUGGESTED_MARKER = 'SUGGESTED:'

  const suggestedStart = block.indexOf(SUGGESTED_MARKER)
  if (suggestedStart === -1) {
    return ''
  }

  const valueStart = suggestedStart + SUGGESTED_MARKER.length
  return block.substring(valueStart).trim()
}

/**
 * Parse a single improvement block
 */
function parseImprovementBlock(block) {
  const severityMatch = block.trim() && block.match(/^([^\]]+)\]/)
  if (!severityMatch) {
    return null
  }

  const category = extractField(block, 'CATEGORY')
  const issue = extractField(block, 'ISSUE')
  const why = extractField(block, 'WHY')

  if (!category || !issue || !why) {
    return null
  }

  // Extract REF: field — present when the model follows the new prompt format.
  // Stored as an integer when valid; undefined when absent (legacy/fallback path).
  const rawRef = extractField(block, 'REF')
  const ref = rawRef ? Number(rawRef) : undefined

  const current = extractCurrentField(block)
  const suggested = extractSuggestedField(block)

  // Discard blocks where SUGGESTED is absent — the prompt mandates a concrete
  // rewrite for every improvement; an empty SUGGESTED renders it unusable.
  if (!suggested) {
    logger.warn(
      { category, issue },
      '[review-parser] Discarding improvement block with missing SUGGESTED field'
    )
    return null
  }

  // Discard blocks where CURRENT and SUGGESTED are identical after normalising
  // whitespace — these are no-op suggestions that provide no value to the user.
  // The model is instructed to omit these, but this is a hard enforcement layer.
  if (current.trim() === suggested.trim()) {
    logger.warn(
      { category, issue, current: current.substring(0, 80) },
      '[review-parser] Discarding improvement block where CURRENT equals SUGGESTED'
    )
    return null
  }

  return {
    severity: severityMatch[1].trim().toLowerCase(),
    category,
    issue,
    why,
    current,
    suggested,
    ref
  }
}

/**
 * Parse the improvements section
 */
function parseImprovements(improvementsText) {
  const blocks = improvementsText.split('[PRIORITY:')
  const improvements = []

  for (const rawBlock of blocks) {
    const block = rawBlock.replaceAll('[/PRIORITY]', '')
    const improvement = parseImprovementBlock(block)
    if (improvement) {
      improvements.push(improvement)
    }
  }

  return improvements
}

/**
 * Helper function to parse a score line
 */
function parseScoreLine(trimmedLine, colonIndex) {
  const afterColon = trimmedLine.substring(colonIndex + 1).trim()

  // Check if it starts with a digit followed by /5
  const MIN_SCORE_PATTERN_LENGTH = 3 // Minimum length for "X/5" pattern
  if (
    afterColon.length < MIN_SCORE_PATTERN_LENGTH ||
    !/^\d\/5/.test(afterColon)
  ) {
    return null
  }

  const score = afterColon.charAt(0)
  // Find the dash separator (either - or –)
  const DASH_SEARCH_START = 3 // Start searching after "X/5"
  let dashIndex = afterColon.indexOf('-', DASH_SEARCH_START)
  if (dashIndex === -1) {
    dashIndex = afterColon.indexOf('–', DASH_SEARCH_START)
  }

  if (dashIndex <= 0) {
    return null
  }

  const category = trimmedLine.substring(0, colonIndex).trim()
  const note = afterColon.substring(dashIndex + 1).trim()

  return {
    category,
    score: Number.parseInt(score),
    note
  }
}

/**
 * Parse plain text review format (actual Bedrock output)
 * Converts plain text to the expected scores/reviewedContent/improvements format
 */
function parsePlainTextReview(bedrockResponse) {
  const scores = {}
  const improvements = []

  const lines = bedrockResponse.split('\n')

  for (const line of lines) {
    const trimmedLine = line.trim()
    if (!trimmedLine) {
      continue
    }

    // Match "Category: 3/5 - Feedback text"
    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex > 0) {
      const scoreData = parseScoreLine(trimmedLine, colonIndex)
      if (scoreData) {
        scores[scoreData.category] = {
          score: scoreData.score,
          note: scoreData.note
        }
      }
    }
  }

  logger.info(
    { scoreCount: Object.keys(scores).length },
    'Converted plain text to scores format'
  )

  return {
    scores,
    reviewedContent: {
      plainText: bedrockResponse,
      issues: []
    },
    improvements
  }
}

/**
 * Extract and parse the [SCORES] section from a Bedrock response
 */
function extractScores(bedrockResponse) {
  const SCORES_TAG_LENGTH = SCORES_TAG.length
  const scoresStart = bedrockResponse.indexOf(SCORES_TAG)
  const scoresEnd = bedrockResponse.indexOf('[/SCORES]')
  if (scoresStart !== -1 && scoresEnd !== -1 && scoresEnd > scoresStart) {
    return parseScores(
      bedrockResponse.substring(scoresStart + SCORES_TAG_LENGTH, scoresEnd)
    )
  }
  return {}
}

/**
 * Extract and parse the reviewed content ([ISSUE_POSITIONS] or legacy [REVIEWED_CONTENT])
 */
function extractReviewedContent(bedrockResponse, originalText) {
  const issuePositionsStart = bedrockResponse.indexOf(ISSUE_POSITIONS_TAG)
  const issuePositionsEnd = bedrockResponse.indexOf(ISSUE_POSITIONS_CLOSE_TAG)
  if (
    issuePositionsStart !== -1 &&
    issuePositionsEnd !== -1 &&
    issuePositionsEnd > issuePositionsStart
  ) {
    const issuePositionsText = bedrockResponse.substring(
      issuePositionsStart + ISSUE_POSITIONS_TAG.length,
      issuePositionsEnd
    )
    return parseIssuePositions(issuePositionsText, originalText)
  }

  // Fall back to legacy [REVIEWED_CONTENT] section if present
  const contentStart = bedrockResponse.indexOf(REVIEWED_CONTENT_TAG)
  const contentEnd = bedrockResponse.indexOf('[/REVIEWED_CONTENT]')
  if (contentStart !== -1 && contentEnd !== -1 && contentEnd > contentStart) {
    return parseReviewedContent(
      bedrockResponse.substring(
        contentStart + REVIEWED_CONTENT_TAG.length,
        contentEnd
      )
    )
  }

  return { plainText: originalText, issues: [] }
}

/**
 * Extract and parse the [IMPROVEMENTS] section from a Bedrock response
 */
function extractImprovements(bedrockResponse) {
  const improvementsStart = bedrockResponse.indexOf(IMPROVEMENTS_TAG)
  const improvementsEnd = bedrockResponse.indexOf('[/IMPROVEMENTS]')
  if (
    improvementsStart !== -1 &&
    improvementsEnd !== -1 &&
    improvementsEnd > improvementsStart
  ) {
    return parseImprovements(
      bedrockResponse.substring(
        improvementsStart + IMPROVEMENTS_TAG.length,
        improvementsEnd
      )
    )
  }
  return []
}

/**
 * Parse marker-based review format
 */
function parseMarkerBasedReview(bedrockResponse, originalText = '') {
  const scores = extractScores(bedrockResponse)
  const reviewedContent = extractReviewedContent(bedrockResponse, originalText)
  const improvements = extractImprovements(bedrockResponse)

  logger.info(
    {
      scoreCount: Object.keys(scores).length,
      issueCount: reviewedContent.issues.length,
      improvementCount: improvements.length
    },
    'Parsed Bedrock response with markers'
  )

  return { scores, reviewedContent, improvements }
}

/**
 * Determine which response string to actually parse.
 * If the primary response has no parseable content, fall back to
 * fallbackRawResponse (kept for backwards compatibility).
 * @param {string} primary
 * @param {string} fallback
 * @returns {string}
 */
function resolveResponseToParse(primary, fallback) {
  if (primary?.trim()) {
    return primary
  }
  return fallback || ''
}

/**
 * Main parser function - converts Bedrock's plain text to structured JSON
 *
 * @param {string} bedrockResponse       - Raw structured text response from Bedrock
 * @param {string} [fallbackRawResponse] - Optional fallback response used when
 *   bedrockResponse is empty or blank (backwards compatibility).
 * @param {string} [originalText='']     - The original document text sent to Bedrock.
 *   Used to: (1) populate reviewedContent.plainText, and (2) resolve issue text
 *   from char offsets when the model omits the 'text' field in [ISSUE_POSITIONS].
 */
export function parseBedrockResponse(
  bedrockResponse,
  fallbackRawResponse,
  originalText = ''
) {
  try {
    const responseToParse = resolveResponseToParse(
      bedrockResponse,
      fallbackRawResponse
    )

    const hasMarkers =
      responseToParse.includes(SCORES_TAG) ||
      responseToParse.includes(REVIEWED_CONTENT_TAG) ||
      responseToParse.includes(ISSUE_POSITIONS_TAG) ||
      responseToParse.includes(IMPROVEMENTS_TAG)

    if (hasMarkers) {
      return parseMarkerBasedReview(responseToParse, originalText)
    }

    return parsePlainTextReview(responseToParse)
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to parse Bedrock response')
    return {
      scores: {},
      reviewedContent: {
        plainText: originalText || bedrockResponse || '',
        issues: []
      },
      improvements: []
    }
  }
}
