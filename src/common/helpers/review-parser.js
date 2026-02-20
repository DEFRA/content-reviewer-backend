import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * Parse the scores section
 */
function parseScores(scoresText) {
  const scores = {}
  const lines = scoresText.trim().split('\n')

  for (const line of lines) {
    // Match: "Plain English: 4/5 - Good use of simple language"
    // Fixed: Use possessive quantifier pattern to prevent ReDoS
    // Pattern: (?=(.*?))\3 mimics possessive behavior, preventing backtracking
    const match = line.match(/^([^:]+):\s*(\d)\/5\s*-\s*(?=(.*?))\3$/i)
    if (match) {
      const [, category, score, , note] = match
      scores[category.trim()] = {
        score: Number.parseInt(score),
        note: note.trim()
      }
    }
  }

  return scores
}

/**
 * Parse the reviewed content with issue markers
 */
function parseReviewedContent(contentText) {
  const issues = []
  let plainText = contentText

  // Extract all issue markers
  // Simplified regex: Match [ISSUE:category]text[/ISSUE] with reduced complexity
  const issueRegex = /\[ISSUE:([^\]]+)\](.*?)(?=\[\/ISSUE\])\[\/ISSUE\]/gs
  let match

  while ((match = issueRegex.exec(contentText)) !== null) {
    const [, category, text] = match
    issues.push({
      category: category.trim(),
      text: text.trim(),
      position: match.index
    })
  }

  // Remove markers to get plain text
  // Fixed: Use atomic pattern to prevent backtracking
  plainText = contentText.replaceAll(
    /\[ISSUE:(?=[^\]]+)[^\]]+\]|\[\/ISSUE\]/g,
    ''
  )

  return {
    plainText: plainText.trim(),
    issues
  }
}

/**
 * Extract field value from block
 */
function extractField(block, fieldName) {
  const match = block.match(new RegExp(`${fieldName}:\\s*([^\n]+)`, 'i'))
  return match ? match[1].trim() : ''
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
    const scoreMatch = trimmedLine.match(/^([^:]+):\s*(\d)\/5\s*[-–]\s*(.+)$/i)
    if (scoreMatch) {
      const [, category, score, note] = scoreMatch
      scores[category.trim()] = {
        score: Number.parseInt(score),
        note: note.trim()
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
 * Main parser function - converts Bedrock's plain text to structured JSON
 */
export function parseBedrockResponse(bedrockResponse) {
  try {
    // Check if response uses marker format or plain text format
    const hasMarkers = bedrockResponse.includes('[SCORES]') || 
                      bedrockResponse.includes('[REVIEWED_CONTENT]') ||
                      bedrockResponse.includes('[IMPROVEMENTS]')

    if (!hasMarkers) {
      logger.info('Using plain text parser for Bedrock response')
      return parsePlainTextReview(bedrockResponse)
    }

    // Original marker-based parsing
    const result = {
      scores: {},
      reviewedContent: {
        plainText: '',
        issues: []
      },
      improvements: []
    }

    const scoresMatch = bedrockResponse.match(
      /\[SCORES\](?=((?:(?!\[\/SCORES\]).)*?))\1\[\/SCORES\]/s
    )
    const contentMatch = bedrockResponse.match(
      /\[REVIEWED_CONTENT\](?=((?:(?!\[\/REVIEWED_CONTENT\]).)*?))\1\[\/REVIEWED_CONTENT\]/s
    )
    const improvementsMatch = bedrockResponse.match(
      /\[IMPROVEMENTS\](?=((?:(?!\[\/IMPROVEMENTS\]).)*?))\1\[\/IMPROVEMENTS\]/s
    )

    if (scoresMatch) {
      result.scores = parseScores(scoresMatch[1])
    }

    if (contentMatch) {
      result.reviewedContent = parseReviewedContent(contentMatch[1])
    }

    if (improvementsMatch) {
      result.improvements = parseImprovements(improvementsMatch[1])
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
  } catch (error) {
    logger.error(
      { error: error.message },
      'Failed to parse Bedrock response'
    )

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
