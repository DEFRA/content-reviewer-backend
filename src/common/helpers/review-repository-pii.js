import { piiRedactor } from './pii-redactor.js'

/**
 * Redact PII from review improvements
 * @param {Array} improvements - Array of improvement objects
 * @returns {Array} Redacted improvements
 */
export function redactImprovements(improvements) {
  return improvements.map((improvement) => {
    const redactedImprovement = { ...improvement }
    if (improvement.current) {
      const redacted = piiRedactor.redact(improvement.current, {
        preserveFormat: false
      })
      redactedImprovement.current = redacted.redactedText
    }
    if (improvement.suggested) {
      const redacted = piiRedactor.redact(improvement.suggested, {
        preserveFormat: false
      })
      redactedImprovement.suggested = redacted.redactedText
    }
    return redactedImprovement
  })
}

/**
 * Redact PII from review results
 * @param {Object} review - Review object
 * @returns {Object} PII redaction information
 */
export function redactPIIFromReview(review) {
  let piiRedactionInfo = { hasPII: false, redactionCount: 0 }

  if (!review.result) {
    return piiRedactionInfo
  }

  // Redact PII from raw response
  if (review.result.rawResponse) {
    const redactionResult = piiRedactor.redactBedrockResponse(
      review.result.rawResponse
    )
    review.result.rawResponse = redactionResult.redactedText
    piiRedactionInfo = {
      hasPII: redactionResult.hasPII,
      redactionCount: redactionResult.redactionCount,
      detectedPII: redactionResult.detectedPII
    }
  }

  // Redact PII from reviewData
  if (review.result.reviewData) {
    if (Array.isArray(review.result.reviewData.improvements)) {
      review.result.reviewData.improvements = redactImprovements(
        review.result.reviewData.improvements
      )
    }

    if (review.result.reviewData.reviewedContent?.plainText) {
      const redacted = piiRedactor.redact(
        review.result.reviewData.reviewedContent.plainText,
        { preserveFormat: false }
      )
      review.result.reviewData.reviewedContent.plainText = redacted.redactedText
    }
  }

  return piiRedactionInfo
}
