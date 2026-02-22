import { createLogger } from './logging/logger.js'

const logger = createLogger()

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
 * Extract field value from block
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

  return {
    severity: severityMatch[1].trim().toLowerCase(),
    category,
    issue,
    why,
    current: extractField(block, 'CURRENT'),
    suggested: extractField(block, 'SUGGESTED')
  }
}

/**
 * Parse the improvements section
 */
function parseImprovements(improvementsText) {
  const blocks = improvementsText.split('[PRIORITY:')
  const improvements = []

  for (const block of blocks) {
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
  let fullText = ''

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

    fullText += line + '\n'
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
 * Parse marker-based review format
 */
function parseMarkerBasedReview(bedrockResponse) {
  const result = {
    scores: {},
    reviewedContent: {
      plainText: '',
      issues: []
    },
    improvements: []
  }

  // Extract [SCORES] section using indexOf
  const scoresStart = bedrockResponse.indexOf('[SCORES]')
  const scoresEnd = bedrockResponse.indexOf('[/SCORES]')
  if (scoresStart !== -1 && scoresEnd !== -1 && scoresEnd > scoresStart) {
    const scoresText = bedrockResponse.substring(scoresStart + 8, scoresEnd)
    result.scores = parseScores(scoresText)
  }

  // Extract [REVIEWED_CONTENT] section using indexOf
  const contentStart = bedrockResponse.indexOf('[REVIEWED_CONTENT]')
  const contentEnd = bedrockResponse.indexOf('[/REVIEWED_CONTENT]')
  if (contentStart !== -1 && contentEnd !== -1 && contentEnd > contentStart) {
    const REVIEWED_CONTENT_TAG_LENGTH = '[REVIEWED_CONTENT]'.length
    const contentText = bedrockResponse.substring(
      contentStart + REVIEWED_CONTENT_TAG_LENGTH,
      contentEnd
    )
    result.reviewedContent = parseReviewedContent(contentText)
  }

  // Extract [IMPROVEMENTS] section using indexOf
  const improvementsStart = bedrockResponse.indexOf('[IMPROVEMENTS]')
  const improvementsEnd = bedrockResponse.indexOf('[/IMPROVEMENTS]')
  if (
    improvementsStart !== -1 &&
    improvementsEnd !== -1 &&
    improvementsEnd > improvementsStart
  ) {
    const IMPROVEMENTS_TAG_LENGTH = '[IMPROVEMENTS]'.length
    const improvementsText = bedrockResponse.substring(
      improvementsStart + IMPROVEMENTS_TAG_LENGTH,
      improvementsEnd
    )
    result.improvements = parseImprovements(improvementsText)
  }

  logger.info(
    {
      scoreCount: Object.keys(result.scores).length,
      issueCount: result.reviewedContent.issues.length,
      improvementCount: result.improvements.length
    },
    'Parsed Bedrock response with markers'
  )

  return result
}

const SCORES_TAG = '[SCORES]'
const SCORES_END_TAG = '[/SCORES]'
const REVIEWED_CONTENT_TAG = '[REVIEWED_CONTENT]'
const REVIEWED_CONTENT_END_TAG = '[/REVIEWED_CONTENT]'
const IMPROVEMENTS_TAG = '[IMPROVEMENTS]'
const IMPROVEMENTS_END_TAG = '[/IMPROVEMENTS]'
const FALLBACK_PREVIEW_LENGTH = 200

/**
 * Helper to check if fallback is needed
 */
function isFallbackNeeded(parsedResult, fallbackRawResponse) {
  const scoresEmpty =
    !parsedResult.scores || Object.keys(parsedResult.scores).length === 0
  const issuesEmpty =
    !parsedResult.reviewedContent?.issues ||
    parsedResult.reviewedContent.issues.length === 0
  const improvementsEmpty =
    !parsedResult.improvements || parsedResult.improvements.length === 0
  return (
    scoresEmpty &&
    issuesEmpty &&
    improvementsEmpty &&
    typeof fallbackRawResponse === 'string' &&
    fallbackRawResponse.length > 0
  )
}

/**
 * Check if parsed result is empty and apply fallback if needed
 */
function applyFallbackIfNeeded(parsedResult, fallbackRawResponse) {
  if (isFallbackNeeded(parsedResult, fallbackRawResponse)) {
    logger.warn(
      {
        fallbackRawResponsePreview: fallbackRawResponse.substring(
          0,
          FALLBACK_PREVIEW_LENGTH
        )
      },
      'Fallback: reparsing reviewContent for missing sections'
    )
    const fallbackHasMarkers =
      fallbackRawResponse.includes(SCORES_TAG) ||
      fallbackRawResponse.includes(REVIEWED_CONTENT_TAG) ||
      fallbackRawResponse.includes(IMPROVEMENTS_TAG)
    return fallbackHasMarkers
      ? parseMarkerBasedReview(fallbackRawResponse)
      : parsePlainTextReview(fallbackRawResponse)
  }

  return parsedResult
}

/**
 * Main parser function - converts Bedrock's plain text to structured JSON
 */
export function parseBedrockResponse(bedrockResponse, fallbackRawResponse) {
  try {
    const hasMarkers =
      bedrockResponse.includes(SCORES_TAG) ||
      bedrockResponse.includes(REVIEWED_CONTENT_TAG) ||
      bedrockResponse.includes(IMPROVEMENTS_TAG)

    let parsedResult
    if (hasMarkers) {
      parsedResult = parseMarkerBasedReview(bedrockResponse)
    } else {
      parsedResult = parsePlainTextReview(bedrockResponse)
    }

    return applyFallbackIfNeeded(parsedResult, fallbackRawResponse)
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to parse Bedrock response')
    return {
      scores: {},
      reviewedContent: {
        plainText: bedrockResponse,
        issues: []
      },
      improvements: []
    }
  }
}
