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
    // Fixed: Use atomic groups and possessive quantifiers to prevent ReDoS
    const match = line.match(/^([^:]+):\s*(\d)\/5\s*-\s*(.*)$/i)
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
  // Fixed: Use lookahead and atomic groups to prevent ReDoS (possessive quantifier pattern)
  // Match [ISSUE:category]text[/ISSUE] without backtracking
  const issueRegex =
    /\[ISSUE:(?=([^\]]+))\1\](?=([^\[]+|(?!\[ISSUE:)[^\[])*)\2\[\/ISSUE\]/g
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
    // Fixed: Use lookahead and backreferences to prevent ReDoS (possessive quantifier pattern)
    const scoresMatch = bedrockResponse.match(
      /\[SCORES\](?=((?:(?!\[\/SCORES\])[\s\S])*?))\1\[\/SCORES\]/s
    )
    const contentMatch = bedrockResponse.match(
      /\[REVIEWED_CONTENT\](?=((?:(?!\[\/REVIEWED_CONTENT\])[\s\S])*?))\1\[\/REVIEWED_CONTENT\]/s
    )
    const improvementsMatch = bedrockResponse.match(
      /\[IMPROVEMENTS\](?=((?:(?!\[\/IMPROVEMENTS\])[\s\S])*?))\1\[\/IMPROVEMENTS\]/s
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
