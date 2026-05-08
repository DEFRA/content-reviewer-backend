import { createLogger } from './logging/logger.js'

const logger = createLogger()

const CURRENT_LOG_PREVIEW_LENGTH = 80

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
