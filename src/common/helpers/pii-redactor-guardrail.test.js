import { describe, test, expect, beforeEach } from 'vitest'
import { PIIRedactor } from './pii-redactor.js'

// Helper to format credit card for testing
const formatCreditCard = (cardNumber) => cardNumber.replaceAll('-', '')

// Constants for test data
const TEST_CONSTANTS = {
  CREDIT_CARD_1: '4111-1111-1111-1111',
  DATE_3: '01/01/1990',
  IP_V4_1: '192.168.1.1',
  REDACTION_LABELS: {
    CARD_NUMBER: '[CARD_NUMBER_REDACTED]'
  },
  PII_TYPES: {
    CREDIT_CARD: 'creditCard'
  },
  ASSESSMENT_TYPES: {
    BEDROCK_GUARDRAIL_PII: 'BEDROCK_GUARDRAIL_PII',
    PII: 'PII',
    PERSONAL_INFORMATION: 'PERSONAL_INFORMATION',
    HATE: 'HATE'
  },
  ACTIONS: {
    BLOCKED: 'BLOCKED'
  },
  CONFIDENCE: {
    HIGH: 'HIGH'
  },
  NUMERIC_VALUES: {
    ZERO: 0,
    ONE: 1,
    TWO: 2
  }
}

describe('PIIRedactor - Guardrail Null Checks', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  describe('extractGuardrailPII method - null/undefined checks', () => {
    test('Should return empty array when guardrailAssessment is null', () => {
      const result = redactor.extractGuardrailPII(null)
      expect(result).toEqual([])
    })

    test('Should return empty array when guardrailAssessment is undefined', () => {
      const result = redactor.extractGuardrailPII(undefined)
      expect(result).toEqual([])
    })

    test('Should return empty array when assessments is missing', () => {
      const result = redactor.extractGuardrailPII({})
      expect(result).toEqual([])
    })
  })
})

describe('PIIRedactor - Guardrail Sensitive Info', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  describe('extractGuardrailPII method - sensitiveInformationPolicy', () => {
    test('Should extract PII from sensitiveInformationPolicy', () => {
      const assessment = {
        assessments: [
          {
            sensitiveInformationPolicy: { detected: true },
            action: TEST_CONSTANTS.ACTIONS.BLOCKED,
            confidence: TEST_CONSTANTS.CONFIDENCE.HIGH
          }
        ]
      }

      const result = redactor.extractGuardrailPII(assessment)

      expect(result.length).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ONE)
      expect(result[0].type).toBe(
        TEST_CONSTANTS.ASSESSMENT_TYPES.BEDROCK_GUARDRAIL_PII
      )
      expect(result[0].action).toBe(TEST_CONSTANTS.ACTIONS.BLOCKED)
      expect(result[0].confidence).toBe(TEST_CONSTANTS.CONFIDENCE.HIGH)
    })
  })
})

describe('PIIRedactor - Guardrail Content Policy', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  describe('extractGuardrailPII method - contentPolicy', () => {
    test('Should extract PII from contentPolicy filters', () => {
      const assessment = {
        assessments: [
          {
            contentPolicy: {
              filters: [
                { type: TEST_CONSTANTS.ASSESSMENT_TYPES.PII, detected: true }
              ]
            },
            action: TEST_CONSTANTS.ACTIONS.BLOCKED
          }
        ]
      }

      const result = redactor.extractGuardrailPII(assessment)

      expect(result.length).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ONE)
      expect(result[0].type).toBe(
        TEST_CONSTANTS.ASSESSMENT_TYPES.BEDROCK_GUARDRAIL_PII
      )
      expect(result[0].action).toBe(TEST_CONSTANTS.ACTIONS.BLOCKED)
    })

    test('Should extract PII from PERSONAL_INFORMATION type', () => {
      const assessment = {
        assessments: [
          {
            contentPolicy: {
              filters: [
                {
                  type: TEST_CONSTANTS.ASSESSMENT_TYPES.PERSONAL_INFORMATION,
                  detected: true
                }
              ]
            },
            action: TEST_CONSTANTS.ACTIONS.BLOCKED
          }
        ]
      }

      const result = redactor.extractGuardrailPII(assessment)

      expect(result.length).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ONE)
      expect(result[0].type).toBe(
        TEST_CONSTANTS.ASSESSMENT_TYPES.BEDROCK_GUARDRAIL_PII
      )
    })
  })
})

describe('PIIRedactor - Guardrail Action Handling', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  describe('extractGuardrailPII method - action handling', () => {
    test('Should use guardrail-level action if assessment action is missing', () => {
      const assessment = {
        action: TEST_CONSTANTS.ACTIONS.BLOCKED,
        assessments: [
          {
            sensitiveInformationPolicy: { detected: true }
          }
        ]
      }

      const result = redactor.extractGuardrailPII(assessment)

      expect(result.length).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ONE)
      expect(result[0].action).toBe(TEST_CONSTANTS.ACTIONS.BLOCKED)
    })
  })
})

describe('PIIRedactor - Guardrail Multiple Assessments', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  describe('extractGuardrailPII method - multiple assessments', () => {
    test('Should handle multiple assessments', () => {
      const assessment = {
        assessments: [
          {
            sensitiveInformationPolicy: { detected: true },
            action: TEST_CONSTANTS.ACTIONS.BLOCKED
          },
          {
            contentPolicy: {
              filters: [
                { type: TEST_CONSTANTS.ASSESSMENT_TYPES.PII, detected: true }
              ]
            },
            action: TEST_CONSTANTS.ACTIONS.BLOCKED
          }
        ]
      }

      const result = redactor.extractGuardrailPII(assessment)

      expect(result.length).toBe(TEST_CONSTANTS.NUMERIC_VALUES.TWO)
    })

    test('Should not extract non-PII assessments', () => {
      const assessment = {
        assessments: [
          {
            contentPolicy: {
              filters: [
                { type: TEST_CONSTANTS.ASSESSMENT_TYPES.HATE, detected: true }
              ]
            },
            action: TEST_CONSTANTS.ACTIONS.BLOCKED
          }
        ]
      }

      const result = redactor.extractGuardrailPII(assessment)

      expect(result.length).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ZERO)
    })
  })
})

describe('PIIRedactor - Bedrock Response Redaction', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  describe('redactBedrockResponse method', () => {
    test('Should redact PII from Bedrock response', () => {
      const reviewContent = `Card number ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)} was reviewed`
      const result = redactor.redactBedrockResponse(reviewContent)

      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.CARD_NUMBER
      )
      expect(result.hasPII).toBe(true)
    })

    test('Should use limited pattern set', () => {
      const reviewContent = `Card ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)} and date ${TEST_CONSTANTS.DATE_3}`
      const result = redactor.redactBedrockResponse(reviewContent)

      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.CARD_NUMBER
      )
      expect(result.redactedText).toContain(TEST_CONSTANTS.DATE_3)
    })

    test('Should handle response without PII', () => {
      const reviewContent = 'This is a clean review response'
      const result = redactor.redactBedrockResponse(reviewContent)

      expect(result.redactedText).toBe(reviewContent)
      expect(result.hasPII).toBe(false)
    })
  })
})

describe('PIIRedactor - User Content Redaction', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  describe('redactUserContent method', () => {
    test('Should redact PII from user content', () => {
      const userContent = `My card is ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)}`
      const result = redactor.redactUserContent(userContent)

      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.CARD_NUMBER
      )
      expect(result.hasPII).toBe(true)
    })

    test('Should use all patterns', () => {
      const userContent = `Card: ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)}, DOB: ${TEST_CONSTANTS.DATE_3}, IP: ${TEST_CONSTANTS.IP_V4_1}`
      const result = redactor.redactUserContent(userContent)

      expect(result.detectedPII.length).toBeGreaterThan(
        TEST_CONSTANTS.NUMERIC_VALUES.ONE
      )
      expect(result.hasPII).toBe(true)
    })

    test('Should handle content without PII', () => {
      const userContent = 'Clean user content'
      const result = redactor.redactUserContent(userContent)

      expect(result.redactedText).toBe(userContent)
      expect(result.hasPII).toBe(false)
    })
  })
})
