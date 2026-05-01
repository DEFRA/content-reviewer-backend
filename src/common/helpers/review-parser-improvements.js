import { createLogger } from './logging/logger.js'

const logger = createLogger()

const CURRENT_LOG_PREVIEW_LENGTH = 80

function extractField(block, fieldName) {
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

function extractSuggestedField(block) {
  const SUGGESTED_MARKER = 'SUGGESTED:'

  const suggestedStart = block.indexOf(SUGGESTED_MARKER)
  if (suggestedStart === -1) {
    return ''
  }

  const valueStart = suggestedStart + SUGGESTED_MARKER.length
  return block.substring(valueStart).trim()
}

function currentTextExistsInDocument(current, originalText) {
  if (!current || !originalText) {
    return true
  }
  return originalText.includes(current)
}

function validateImprovementFields(current, suggested, originalText) {
  if (!suggested) {
    return 'missing SUGGESTED field'
  }
  if (current.trim() === suggested.trim()) {
    return 'CURRENT equals SUGGESTED'
  }
  if (!currentTextExistsInDocument(current, originalText)) {
    return 'CURRENT text not found in document'
  }
  return null
}

function parseImprovementBlock(block, originalText = '') {
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

  const rawStart = extractField(block, 'START')
  const rawEnd = extractField(block, 'END')
  const start = rawStart === '' ? undefined : Number(rawStart)
  const end = rawEnd === '' ? undefined : Number(rawEnd)

  const current = extractCurrentField(block)
  const suggested = extractSuggestedField(block)

  const rejectionReason = validateImprovementFields(
    current,
    suggested,
    originalText
  )
  if (rejectionReason) {
    logger.warn(
      {
        category,
        issue,
        current: current.substring(0, CURRENT_LOG_PREVIEW_LENGTH)
      },
      `[review-parser] Discarding improvement block: ${rejectionReason}`
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
    ref,
    start,
    end
  }
}

/**
 * Parse the [IMPROVEMENTS] section into an array of improvement objects.
 */
export function parseImprovements(improvementsText, originalText = '') {
  const blocks = improvementsText.split('[PRIORITY:')
  const improvements = []

  for (const rawBlock of blocks) {
    const block = rawBlock.replaceAll('[/PRIORITY]', '')
    const improvement = parseImprovementBlock(block, originalText)
    if (improvement) {
      improvements.push(improvement)
    }
  }

  return improvements
}
