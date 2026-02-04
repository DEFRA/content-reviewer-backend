import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * PII Redaction Helper
 *
 * This helper detects and redacts Personally Identifiable Information (PII)
 * from text content before storage and display.
 *
 * Works in conjunction with AWS Bedrock Guardrails which also detect PII,
 * but provides an additional client-side layer of protection.
 *
 * PII Types Detected:
 * - Email addresses
 * - Phone numbers (UK, international)
 * - UK National Insurance numbers
 * - UK Postcodes
 * - Credit card numbers
 * - IP addresses
 * - Names (when possible)
 * - Dates of birth
 * - UK Driving license numbers
 * - UK Passport numbers
 */
class PIIRedactor {
  constructor() {
    // PII regex patterns
    this.patterns = {
      // Email addresses
      email: {
        regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        replacement: '[EMAIL_REDACTED]'
      },

      // UK phone numbers (various formats)
      ukPhone: {
        regex:
          /\b(?:(?:\+44\s?|0)(?:\d{2}\s?\d{4}\s?\d{4}|\d{3}\s?\d{3}\s?\d{4}|\d{4}\s?\d{6}|\d{5}\s?\d{5}))\b/g,
        replacement: '[PHONE_REDACTED]'
      },

      // International phone numbers
      intPhone: {
        regex:
          /\b\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}\b/g,
        replacement: '[PHONE_REDACTED]'
      },

      // UK National Insurance number (e.g., QQ123456C)
      niNumber: {
        regex:
          /\b(?:[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z])\s?(?:\d{2}\s?\d{2}\s?\d{2}\s?[A-D]?)\b/gi,
        replacement: '[NI_NUMBER_REDACTED]'
      },

      // UK Postcode (e.g., SW1A 1AA, M1 1AE)
      ukPostcode: {
        regex:
          /\b[A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2}\b|\b[A-Z]{1,2}\d[A-Z]\s?\d[A-Z]{2}\b/gi,
        replacement: '[POSTCODE_REDACTED]'
      },

      // Credit card numbers (basic pattern, 13-19 digits with optional spaces/dashes)
      creditCard: {
        regex: /\b(?:\d{4}[-\s]?){3}\d{1,4}\b/g,
        replacement: '[CARD_NUMBER_REDACTED]'
      },

      // IP addresses (IPv4)
      ipv4: {
        regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
        replacement: '[IP_ADDRESS_REDACTED]'
      },

      // IP addresses (IPv6)
      ipv6: {
        regex: /\b(?:[A-F0-9]{1,4}:){7}[A-F0-9]{1,4}\b/gi,
        replacement: '[IP_ADDRESS_REDACTED]'
      },

      // Dates that might be DOB (various formats)
      dateOfBirth: {
        regex:
          /\b(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{2,4}[-/]\d{1,2}[-/]\d{1,2})\b/g,
        replacement: '[DATE_REDACTED]'
      },

      // UK Driving License (basic pattern)
      ukDrivingLicense: {
        regex: /\b[A-Z]{5}\d{6}[A-Z]{2}\d[A-Z]{2}\b/gi,
        replacement: '[DRIVING_LICENSE_REDACTED]'
      },

      // UK Passport number (9 digits)
      ukPassport: {
        regex: /\b\d{9}\b/g,
        replacement: '[PASSPORT_REDACTED]'
      },

      // Social Security Numbers (US format, for completeness)
      ssn: {
        regex: /\b\d{3}-\d{2}-\d{4}\b/g,
        replacement: '[SSN_REDACTED]'
      },

      // Bank account numbers (8 digits)
      bankAccount: {
        regex: /\b\d{8}\b/g,
        replacement: '[ACCOUNT_NUMBER_REDACTED]'
      },

      // Sort codes (UK, format: 12-34-56)
      sortCode: {
        regex: /\b\d{2}-\d{2}-\d{2}\b/g,
        replacement: '[SORT_CODE_REDACTED]'
      }
    }

    logger.info('PII Redactor initialized with pattern matching')
  }

  /**
   * Redact PII from text content
   * @param {string} text - Text to redact
   * @param {Object} options - Redaction options
   * @param {Array<string>} options.enabledPatterns - Specific patterns to use (default: all)
   * @param {boolean} options.preserveFormat - Whether to preserve text length (default: false)
   * @returns {Object} Result with redacted text and detected PII types
   */
  redact(text, options = {}) {
    if (!text || typeof text !== 'string') {
      return {
        redactedText: text,
        detectedPII: [],
        redactionCount: 0,
        originalLength: 0,
        redactedLength: 0
      }
    }

    const {
      enabledPatterns = Object.keys(this.patterns),
      preserveFormat = false
    } = options

    let redactedText = text
    const detectedPII = []
    let redactionCount = 0

    // Apply each pattern
    for (const patternName of enabledPatterns) {
      if (!this.patterns[patternName]) {
        logger.warn(
          { patternName },
          `Unknown PII pattern: ${patternName}, skipping`
        )
        continue
      }

      const pattern = this.patterns[patternName]
      const matches = text.match(pattern.regex)

      if (matches && matches.length > 0) {
        detectedPII.push({
          type: patternName,
          count: matches.length,
          examples: matches.slice(0, 2) // Show max 2 examples for logging
        })

        redactionCount += matches.length

        // Apply redaction
        if (preserveFormat) {
          // Replace with asterisks matching original length
          redactedText = redactedText.replace(pattern.regex, (match) => {
            return '*'.repeat(match.length)
          })
        } else {
          // Replace with redaction label
          redactedText = redactedText.replace(
            pattern.regex,
            pattern.replacement
          )
        }
      }
    }

    if (detectedPII.length > 0) {
      logger.info(
        {
          detectedPII: detectedPII.map((p) => ({
            type: p.type,
            count: p.count
          })),
          totalRedactions: redactionCount
        },
        `PII detected and redacted: ${redactionCount} instances across ${detectedPII.length} types`
      )
    }

    return {
      redactedText,
      detectedPII,
      redactionCount,
      originalLength: text.length,
      redactedLength: redactedText.length,
      hasPII: detectedPII.length > 0
    }
  }

  /**
   * Extract PII entities from Bedrock guardrail assessment
   * @param {Object} guardrailAssessment - Guardrail assessment from Bedrock response
   * @returns {Array} List of detected PII entities with types and actions
   */
  extractGuardrailPII(guardrailAssessment) {
    if (!guardrailAssessment || !guardrailAssessment.assessments) {
      return []
    }

    const piiEntities = []

    for (const assessment of guardrailAssessment.assessments) {
      // Check for PII-related assessments
      if (
        assessment.sensitiveInformationPolicy ||
        assessment.contentPolicy?.filters?.some(
          (f) => f.type === 'PII' || f.type === 'PERSONAL_INFORMATION'
        )
      ) {
        piiEntities.push({
          action: assessment.action || guardrailAssessment.action,
          type: 'BEDROCK_GUARDRAIL_PII',
          confidence: assessment.confidence || 'HIGH',
          details: assessment
        })
      }
    }

    if (piiEntities.length > 0) {
      logger.info(
        { piiCount: piiEntities.length },
        `Bedrock guardrails detected ${piiEntities.length} PII entity/entities`
      )
    }

    return piiEntities
  }

  /**
   * Redact PII from Bedrock response content
   * This is applied to the AI's review output
   * @param {string} reviewContent - Review content from Bedrock
   * @returns {Object} Redacted review with metadata
   */
  redactBedrockResponse(reviewContent) {
    // Apply redaction to the review content
    // (in case the AI quoted user input containing PII)
    const result = this.redact(reviewContent, {
      enabledPatterns: [
        'email',
        'ukPhone',
        'intPhone',
        'niNumber',
        'ukPostcode',
        'creditCard',
        'ipv4',
        'ipv6',
        'ukDrivingLicense',
        'ukPassport',
        'ssn',
        'bankAccount',
        'sortCode'
      ]
    })

    return result
  }

  /**
   * Redact PII from user-submitted content before sending to Bedrock
   * @param {string} userContent - User's content to review
   * @returns {Object} Redacted content with metadata
   */
  redactUserContent(userContent) {
    const result = this.redact(userContent)

    if (result.hasPII) {
      logger.warn(
        {
          detectedPII: result.detectedPII.map((p) => p.type),
          redactionCount: result.redactionCount
        },
        `User content contains PII - ${result.redactionCount} instances redacted before processing`
      )
    }

    return result
  }

  /**
   * Create a PII detection report
   * @param {string} originalText - Original text
   * @param {string} redactedText - Redacted text
   * @param {Array} detectedPII - List of detected PII
   * @returns {Object} PII report
   */
  createPIIReport(originalText, redactedText, detectedPII) {
    return {
      hasPII: detectedPII.length > 0,
      piiTypes: detectedPII.map((p) => p.type),
      totalRedactions: detectedPII.reduce((sum, p) => sum + p.count, 0),
      redactionPercentage:
        originalText.length > 0
          ? ((originalText.length - redactedText.length) /
              originalText.length) *
            100
          : 0,
      detectedPII,
      timestamp: new Date().toISOString()
    }
  }

  /**
   * Validate if text is safe (no PII detected)
   * @param {string} text - Text to validate
   * @returns {Object} Validation result
   */
  validateNoPII(text) {
    const result = this.redact(text)

    return {
      isValid: !result.hasPII,
      hasPII: result.hasPII,
      detectedPII: result.detectedPII,
      message: result.hasPII
        ? `PII detected: ${result.detectedPII.map((p) => p.type).join(', ')}`
        : 'No PII detected'
    }
  }
}

// Export singleton instance
export const piiRedactor = new PIIRedactor()

// Export class for testing
export { PIIRedactor }
