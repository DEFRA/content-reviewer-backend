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
    const match = line.match(/^(.+?):\s*(\d)\/5\s*-\s*(.+)$/i)
    if (match) {
      const [, category, score, note] = match
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
  const issueRegex = /\[ISSUE:([^\]]+)]([^[]+)\[\/ISSUE]/g
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
  plainText = contentText.replace(/\[ISSUE:[^\]]+]|\[\/ISSUE]/g, '')

  return {
    plainText: plainText.trim(),
    issues
  }
}

/**
 * Parse the improvements section
 */
function parseImprovements(improvementsText) {
  const improvements = []
  const blocks = improvementsText.split('[PRIORITY:')

  for (const block of blocks) {
    if (!block.trim()) continue

    // Extract severity level
    const severityMatch = block.match(/^([^\]]+)\]/)
    if (!severityMatch) continue

    const severity = severityMatch[1].trim().toLowerCase()

    // Extract each field
    const categoryMatch = block.match(/CATEGORY:\s*([^\n]+)/i)
    const issueMatch = block.match(/ISSUE:\s*([^\n]+)/i)
    const whyMatch = block.match(/WHY:\s*([^\n]+)/i)
    const currentMatch = block.match(/CURRENT:\s*([^\n]+)/i)
    const suggestedMatch = block.match(/SUGGESTED:\s*([^\n]+)/i)

    if (categoryMatch && issueMatch && whyMatch) {
      improvements.push({
        severity,
        category: categoryMatch[1].trim(),
        issue: issueMatch[1].trim(),
        why: whyMatch[1].trim(),
        current: currentMatch ? currentMatch[1].trim() : '',
        suggested: suggestedMatch ? suggestedMatch[1].trim() : ''
      })
    }
  }

  return improvements
}

/**
 * Main parser function - converts Bedrock's plain text to structured JSON
 */
export function parseBedrockResponse(bedrockResponse) {
  try {
    logger.info(
      { responseLength: bedrockResponse.length },
      'Parsing Bedrock plain text response'
    )

    const result = {
      scores: {},
      reviewedContent: {
        plainText: '',
        issues: []
      },
      improvements: []
    }

    // Extract sections using markers
    const scoresMatch = bedrockResponse.match(/\[SCORES\](.*?)\[\/SCORES\]/s)
    const contentMatch = bedrockResponse.match(
      /\[REVIEWED_CONTENT\](.*?)\[\/REVIEWED_CONTENT\]/s
    )
    const improvementsMatch = bedrockResponse.match(
      /\[IMPROVEMENTS\](.*?)\[\/IMPROVEMENTS\]/s
    )

    // Parse each section
    if (scoresMatch) {
      result.scores = parseScores(scoresMatch[1])
      logger.debug(
        { scoreCount: Object.keys(result.scores).length },
        'Parsed scores section'
      )
    }

    if (contentMatch) {
      result.reviewedContent = parseReviewedContent(contentMatch[1])
      logger.debug(
        { issueCount: result.reviewedContent.issues.length },
        'Parsed reviewed content'
      )
    }

    if (improvementsMatch) {
      result.improvements = parseImprovements(improvementsMatch[1])
      logger.debug(
        { improvementCount: result.improvements.length },
        'Parsed improvements section'
      )
    }

    logger.info(
      {
        scoreCount: Object.keys(result.scores).length,
        issueCount: result.reviewedContent.issues.length,
        improvementCount: result.improvements.length
      },
      'Successfully parsed Bedrock response'
    )

    return result
  } catch (error) {
    logger.error(
      { error: error.message, stack: error.stack },
      'Failed to parse Bedrock response'
    )

    // Return minimal valid structure on parse failure
    return {
      scores: {},
      reviewedContent: {
        plainText: bedrockResponse,
        issues: []
      },
      improvements: [],
      parseError: error.message
    }
  }
}
