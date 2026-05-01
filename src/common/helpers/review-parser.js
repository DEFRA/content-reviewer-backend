import { createLogger } from './logging/logger.js'
import {
  parseIssuePositions,
  parseReviewedContent,
  locateTextInDocument
} from './review-parser-issues.js'
import { parseImprovements } from './review-parser-improvements.js'

const logger = createLogger()

const SCORES_TAG = '[SCORES]'
const REVIEWED_CONTENT_TAG = '[REVIEWED_CONTENT]'
const ISSUE_POSITIONS_TAG = '[ISSUE_POSITIONS]'
const ISSUE_POSITIONS_CLOSE_TAG = '[/ISSUE_POSITIONS]'
const IMPROVEMENTS_TAG = '[IMPROVEMENTS]'
const TYPE_PLAIN_ENGLISH = 'plain-english'

const CATEGORY_TO_TYPE = {
  'plain english': TYPE_PLAIN_ENGLISH,
  clarity: 'clarity',
  'clarity & structure': 'clarity',
  accessibility: 'accessibility',
  'govuk style compliance': 'govuk-style',
  'gov.uk style compliance': 'govuk-style',
  'content completeness': 'completeness',
  completeness: 'completeness'
}

// ─── Score parsing ────────────────────────────────────────────────────────────

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
    dashIndex = afterColon.indexOf('–', DASH_SEARCH_START)
  }

  if (dashIndex <= 0) {
    return null
  }

  const category = trimmedLine.substring(0, colonIndex).trim()
  const note = afterColon.substring(dashIndex + 1).trim()

  return { category, score: Number.parseInt(score), note }
}

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

// ─── Section extraction ───────────────────────────────────────────────────────

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
    return parseIssuePositions(
      bedrockResponse.substring(
        issuePositionsStart + ISSUE_POSITIONS_TAG.length,
        issuePositionsEnd
      ),
      originalText
    )
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

function extractImprovements(bedrockResponse, originalText = '') {
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
      ),
      originalText
    )
  }
  return []
}

// ─── Issue building ───────────────────────────────────────────────────────────

/**
 * Build the issues array from parsed improvements when the response uses the
 * new inline START:/END: format (no [ISSUE_POSITIONS] section).
 * Uses locateTextInDocument to correct any hallucinated offsets via indexOf.
 */
function buildIssuesFromImprovements(improvements, originalText) {
  return improvements
    .filter((imp) => imp.current)
    .map((imp) => {
      const type =
        CATEGORY_TO_TYPE[imp.category.toLowerCase()] || TYPE_PLAIN_ENGLISH
      const located = locateTextInDocument(imp.current, imp.ref, originalText)
      if (!located) {
        return null
      }
      return {
        start: located.start,
        end: located.end,
        type,
        text: imp.current,
        ref: imp.ref
      }
    })
    .filter(Boolean)
}

// ─── Orchestration ────────────────────────────────────────────────────────────

function parseMarkerBasedReview(bedrockResponse, originalText = '') {
  const scores = extractScores(bedrockResponse)
  const improvements = extractImprovements(bedrockResponse, originalText)

  let reviewedContent
  if (
    bedrockResponse.includes(ISSUE_POSITIONS_TAG) ||
    bedrockResponse.includes(REVIEWED_CONTENT_TAG)
  ) {
    reviewedContent = extractReviewedContent(bedrockResponse, originalText)
  } else {
    const issues = buildIssuesFromImprovements(improvements, originalText)
    reviewedContent = { plainText: originalText, issues }
  }

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

/**
 * Main parser function - converts Bedrock's plain text to structured JSON
 *
 * @param {string} bedrockResponse       - Raw structured text response from Bedrock
 * @param {string} [fallbackRawResponse] - Optional fallback response (backwards compatibility)
 * @param {string} [originalText='']     - The original document text sent to Bedrock
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
