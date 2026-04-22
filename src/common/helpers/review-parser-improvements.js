import { createLogger } from './logging/logger.js'

const logger = createLogger()

const CURRENT_LOG_PREVIEW_LENGTH = 80

/**
 * Extract a named single-line field from a [PRIORITY] block.
 */
export function extractField(block, fieldName) {
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
 * Reads from CURRENT: up to SUGGESTED: to support multi-line values.
 */
export function extractCurrentField(block) {
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
 * Reads from SUGGESTED: to the end of the block.
 */
export function extractSuggestedField(block) {
  const SUGGESTED_MARKER = 'SUGGESTED:'

  const suggestedStart = block.indexOf(SUGGESTED_MARKER)
  if (suggestedStart === -1) {
    return ''
  }

  const valueStart = suggestedStart + SUGGESTED_MARKER.length
  return block.substring(valueStart).trim()
}

/**
 * Parse a single [PRIORITY] improvement block.
 * Returns null if mandatory fields are missing or CURRENT === SUGGESTED.
 */
export function parseImprovementBlock(block) {
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

  const rawRef = extractField(block, 'REF')
  const ref = rawRef ? Number(rawRef) : undefined

  const current = extractCurrentField(block)
  const suggested = extractSuggestedField(block)

  if (!suggested) {
    logger.warn(
      { category, issue },
      '[review-parser] Discarding improvement block with missing SUGGESTED field'
    )
    return null
  }

  if (current.trim() === suggested.trim()) {
    logger.warn(
      {
        category,
        issue,
        current: current.substring(0, CURRENT_LOG_PREVIEW_LENGTH)
      },
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
 * Parse the full [IMPROVEMENTS] section into an array of improvement objects.
 */
export function parseImprovements(improvementsText) {
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
