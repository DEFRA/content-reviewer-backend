import { createLogger } from './logging/logger.js'
import { parseIssuePositions } from './review-parser-issue-helpers.js'
import { parseImprovements } from './review-parser-improvements.js'

const logger = createLogger()

// ─── Shared constants ────────────────────────────────────────────────────────
const SCORES_TAG = '[SCORES]'
const REVIEWED_CONTENT_TAG = '[REVIEWED_CONTENT]'
const ISSUE_POSITIONS_TAG = '[ISSUE_POSITIONS]'
const ISSUE_POSITIONS_CLOSE_TAG = '[/ISSUE_POSITIONS]'
const IMPROVEMENTS_TAG = '[IMPROVEMENTS]'

// ─── Score parsing ────────────────────────────────────────────────────────────

/**
 * Try to parse a score from a single line.
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
  return { category, score: Number.parseInt(score), note }
}

/**
 * Parse the [SCORES] section text into a scores object.
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

// ─── Legacy [REVIEWED_CONTENT] parsing ───────────────────────────────────────

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

  return { textChunk: text.substring(pos, markerStart), nextPos: markerEnd + 1 }
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

function parseReviewedContent(contentText) {
  const issues = extractIssues(contentText)
  const plainText = removeIssueMarkers(contentText)
  return { plainText: plainText.trim(), issues }
}

// ─── Score line helper (plain-text format) ────────────────────────────────────

function parseScoreLine(trimmedLine, colonIndex) {
  const afterColon = trimmedLine.substring(colonIndex + 1).trim()

  const MIN_SCORE_PATTERN_LENGTH = 3
  if (
    afterColon.length < MIN_SCORE_PATTERN_LENGTH ||
    !/^\d\/5/.test(afterColon)
  ) {
    return null
  }

  const score = afterColon.charAt(0)
  const DASH_SEARCH_START = 3
  let dashIndex = afterColon.indexOf('-', DASH_SEARCH_START)
  if (dashIndex === -1) {
    dashIndex = afterColon.indexOf('\u2013', DASH_SEARCH_START)
  }

  if (dashIndex <= 0) {
    return null
  }

  const category = trimmedLine.substring(0, colonIndex).trim()
  const note = afterColon.substring(dashIndex + 1).trim()
  return { category, score: Number.parseInt(score), note }
}

// ─── Plain-text format ────────────────────────────────────────────────────────

function parsePlainTextReview(bedrockResponse) {
  const scores = {}
  const improvements = []
  const lines = bedrockResponse.split('\n')

  for (const line of lines) {
    const trimmedLine = line.trim()
    if (!trimmedLine) {
      continue
    }

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
    reviewedContent: { plainText: bedrockResponse, issues: [] },
    improvements
  }
}

// ─── Marker-based format ──────────────────────────────────────────────────────

function extractScores(bedrockResponse) {
  const scoresStart = bedrockResponse.indexOf(SCORES_TAG)
  const scoresEnd = bedrockResponse.indexOf('[/SCORES]')
  if (scoresStart !== -1 && scoresEnd !== -1 && scoresEnd > scoresStart) {
    return parseScores(
      bedrockResponse.substring(scoresStart + SCORES_TAG.length, scoresEnd)
    )
  }
  return {}
}

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

function extractImprovementsSection(bedrockResponse) {
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

function parseMarkerBasedReview(bedrockResponse, originalText = '') {
  const scores = extractScores(bedrockResponse)
  const reviewedContent = extractReviewedContent(bedrockResponse, originalText)
  const improvements = extractImprovementsSection(bedrockResponse)

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

function resolveResponseToParse(primary, fallback) {
  if (primary?.trim()) {
    return primary
  }
  return fallback || ''
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Main parser function — converts Bedrock's plain text to structured JSON.
 *
 * @param {string} bedrockResponse       - Raw structured text response from Bedrock
 * @param {string} [fallbackRawResponse] - Optional fallback response used when
 *   bedrockResponse is empty or blank (backwards compatibility).
 * @param {string} [originalText='']     - The original document text sent to Bedrock.
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
