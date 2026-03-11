import { describe, test, expect, beforeEach } from 'vitest'
import { PIIRedactor, piiRedactor } from './pii-redactor.js'

const formatCreditCard = (cardNumber) => cardNumber.replaceAll('-', '')
const TEST_CONSTANTS = {
  NI_NUMBER_1: 'QQ123456C',
  NI_NUMBER_2: 'AB123456D',
  CREDIT_CARD_1: '4111-1111-1111-1111',
  CREDIT_CARD_2: '5500000000000004',
  CREDIT_CARD_3: '378282246310005',
  IP_V4_1: '192.168.1.1',
  IP_V4_2: '10.0.0.1',
  IP_V4_3: '127.0.0.1',
  IP_V6_1: '2001:0DB8:AC10:FE01:0000:0000:0000:0000',
  IP_V6_2: '2A02:0DB8:AC10:FE01:0000:0000:0000:0001',
  DATE_1: '01/12/1990',
  DATE_2: '25-06-1985',
  DATE_3: '01/01/1990',
  DRIVING_LICENSE: 'MORGA753116SM9IJ',
  PASSPORT: '123456789',
  SSN: '123-45-6789',
  BANK_ACCOUNT: '12345678',
  SORT_CODE: '12-34-56',
  REDACTION_LABELS: {
    NI_NUMBER: '[NI_NUMBER_REDACTED]',
    CARD_NUMBER: '[CARD_NUMBER_REDACTED]',
    IP_ADDRESS: '[IP_ADDRESS_REDACTED]',
    DATE: '[DATE_REDACTED]',
    DRIVING_LICENSE: '[DRIVING_LICENSE_REDACTED]',
    PASSPORT: '[PASSPORT_REDACTED]',
    SSN: '[SSN_REDACTED]',
    ACCOUNT_NUMBER: '[ACCOUNT_NUMBER_REDACTED]',
    SORT_CODE: '[SORT_CODE_REDACTED]'
  },
  PII_TYPES: {
    NI_NUMBER: 'niNumber',
    CREDIT_CARD: 'creditCard',
    IPV4: 'ipv4',
    IPV6: 'ipv6',
    DATE_OF_BIRTH: 'dateOfBirth',
    UK_DRIVING_LICENSE: 'ukDrivingLicense',
    UK_PASSPORT: 'ukPassport',
    SSN: 'ssn',
    BANK_ACCOUNT: 'bankAccount',
    SORT_CODE: 'sortCode'
  },
  MESSAGES: { NO_PII: 'No PII detected', PII_DETECTED: 'PII detected' },
  ASSESSMENT_TYPES: {
    BEDROCK_GUARDRAIL_PII: 'BEDROCK_GUARDRAIL_PII',
    PII: 'PII',
    PERSONAL_INFORMATION: 'PERSONAL_INFORMATION',
    HATE: 'HATE'
  },
  ACTIONS: { BLOCKED: 'BLOCKED' },
  CONFIDENCE: { HIGH: 'HIGH' },
  NUMERIC_VALUES: {
    ZERO: 0,
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FIVE: 5,
    MAX_EXAMPLES: 2,
    LONG_TEXT_REPEAT: 10000
  }
}
describe('PIIRedactor - Input Validation', () => {
  let redactor
  beforeEach(() => {
    redactor = new PIIRedactor()
  })
  describe('redact method - input validation', () => {
    test('Should handle null, undefined, and non-string input', () => {
      const resultNull = redactor.redact(null)
      const resultUndefined = redactor.redact(undefined)
      const numericValue = 123
      const resultNumber = redactor.redact(numericValue)
      const resultObject = redactor.redact({})
      expect(resultNull.redactedText).toBe(null)
      expect(resultNull.detectedPII).toEqual([])
      expect(resultNull.redactionCount).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ZERO)
      expect(resultUndefined.redactedText).toBe(undefined)
      expect(resultUndefined.detectedPII).toEqual([])
      expect(resultUndefined.redactionCount).toBe(
        TEST_CONSTANTS.NUMERIC_VALUES.ZERO
      )
      expect(resultNumber.redactedText).toBe(numericValue)
      expect(resultNumber.detectedPII).toEqual([])
      expect(resultObject.redactedText).toEqual({})
      expect(resultObject.detectedPII).toEqual([])
    })
    test('Should handle empty string', () => {
      const result = redactor.redact('')
      expect(result.redactedText).toBe('')
      expect(result.detectedPII).toEqual([])
      expect(result.redactionCount).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ZERO)
      expect(result.originalLength).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ZERO)
      expect(result.redactedLength).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ZERO)
    })
  })
})
describe('PIIRedactor - UK National Insurance', () => {
  let redactor
  beforeEach(() => {
    redactor = new PIIRedactor()
  })
  describe('redact method - UK National Insurance numbers', () => {
    test('Should redact UK National Insurance numbers', () => {
      const text = `${TEST_CONSTANTS.NI_NUMBER_1} and ${TEST_CONSTANTS.NI_NUMBER_2}`
      const result = redactor.redact(text)
      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.NI_NUMBER
      )
      expect(result.detectedPII.length).toBeGreaterThan(
        TEST_CONSTANTS.NUMERIC_VALUES.ZERO
      )
      expect(
        result.detectedPII.some(
          (p) => p.type === TEST_CONSTANTS.PII_TYPES.NI_NUMBER
        )
      ).toBe(true)
      expect(result.hasPII).toBe(true)
      expect(result.redactionCount).toBeGreaterThan(
        TEST_CONSTANTS.NUMERIC_VALUES.ZERO
      )
    })
  })
})
describe('PIIRedactor - Credit Cards', () => {
  let redactor
  beforeEach(() => {
    redactor = new PIIRedactor()
  })
  describe('redact method - credit card numbers', () => {
    test('Should redact credit card numbers', () => {
      const text = `Card: ${TEST_CONSTANTS.CREDIT_CARD_1} and ${TEST_CONSTANTS.CREDIT_CARD_2}`
      const result = redactor.redact(text)
      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.CARD_NUMBER
      )
      expect(
        result.detectedPII.some(
          (p) => p.type === TEST_CONSTANTS.PII_TYPES.CREDIT_CARD
        )
      ).toBe(true)
      expect(result.hasPII).toBe(true)
    })
    test('Should redact credit card numbers with spaces', () => {
      const text = 'Card: 4111 1111 1111 1111'
      const result = redactor.redact(text)
      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.CARD_NUMBER
      )
      expect(result.hasPII).toBe(true)
    })
  })
})
describe('PIIRedactor - IP Addresses', () => {
  let redactor
  beforeEach(() => {
    redactor = new PIIRedactor()
  })
  describe('redact method - IP addresses', () => {
    test('Should redact IPv4 addresses', () => {
      const text = `Server IP: ${TEST_CONSTANTS.IP_V4_1} and ${TEST_CONSTANTS.IP_V4_2}`
      const result = redactor.redact(text)
      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.IP_ADDRESS
      )
      expect(
        result.detectedPII.some((p) => p.type === TEST_CONSTANTS.PII_TYPES.IPV4)
      ).toBe(true)
      expect(result.hasPII).toBe(true)
    })
    test('Should redact IPv6 addresses', () => {
      const text = `IPv6: ${TEST_CONSTANTS.IP_V6_1}`
      const result = redactor.redact(text)
      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.IP_ADDRESS
      )
      expect(
        result.detectedPII.some((p) => p.type === TEST_CONSTANTS.PII_TYPES.IPV6)
      ).toBe(true)
      expect(result.hasPII).toBe(true)
    })
  })
})
describe('PIIRedactor - Dates and IDs', () => {
  let redactor
  beforeEach(() => {
    redactor = new PIIRedactor()
  })
  describe('redact method - dates and identification numbers', () => {
    test('Should redact dates', () => {
      const text = `DOB: ${TEST_CONSTANTS.DATE_1} and ${TEST_CONSTANTS.DATE_2}`
      const result = redactor.redact(text)
      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.DATE
      )
      expect(
        result.detectedPII.some(
          (p) => p.type === TEST_CONSTANTS.PII_TYPES.DATE_OF_BIRTH
        )
      ).toBe(true)
      expect(result.hasPII).toBe(true)
    })
    test('Should redact UK driving license numbers', () => {
      const text = `License: ${TEST_CONSTANTS.DRIVING_LICENSE}`
      const result = redactor.redact(text)
      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.DRIVING_LICENSE
      )
      expect(
        result.detectedPII.some(
          (p) => p.type === TEST_CONSTANTS.PII_TYPES.UK_DRIVING_LICENSE
        )
      ).toBe(true)
      expect(result.hasPII).toBe(true)
    })
    test('Should redact UK passport numbers', () => {
      const text = `Passport: ${TEST_CONSTANTS.PASSPORT}`
      const result = redactor.redact(text)
      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.PASSPORT
      )
      expect(
        result.detectedPII.some(
          (p) => p.type === TEST_CONSTANTS.PII_TYPES.UK_PASSPORT
        )
      ).toBe(true)
      expect(result.hasPII).toBe(true)
    })
    test('Should redact US Social Security Numbers', () => {
      const text = `SSN: ${TEST_CONSTANTS.SSN}`
      const result = redactor.redact(text)
      expect(result.redactedText).toContain(TEST_CONSTANTS.REDACTION_LABELS.SSN)
      expect(
        result.detectedPII.some((p) => p.type === TEST_CONSTANTS.PII_TYPES.SSN)
      ).toBe(true)
      expect(result.hasPII).toBe(true)
    })
  })
})
describe('PIIRedactor - Financial Information', () => {
  let redactor
  beforeEach(() => {
    redactor = new PIIRedactor()
  })
  describe('redact method - financial information', () => {
    test('Should redact bank account numbers', () => {
      const text = `Account: ${TEST_CONSTANTS.BANK_ACCOUNT}`
      const result = redactor.redact(text)
      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.ACCOUNT_NUMBER
      )
      expect(
        result.detectedPII.some(
          (p) => p.type === TEST_CONSTANTS.PII_TYPES.BANK_ACCOUNT
        )
      ).toBe(true)
      expect(result.hasPII).toBe(true)
    })
    test('Should redact UK sort codes', () => {
      const text = `Sort code ${TEST_CONSTANTS.SORT_CODE}`
      const result = redactor.redact(text)
      expect(result.redactedText).not.toBe(text)
      expect(result.hasPII).toBe(true)
    })
  })
})
describe('PIIRedactor - Options and Configuration', () => {
  let redactor
  beforeEach(() => {
    redactor = new PIIRedactor()
  })
  describe('redact method - options and configuration', () => {
    test('Should redact multiple PII types in same text', () => {
      const text = `Card ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)} IP ${TEST_CONSTANTS.IP_V4_1}`
      const result = redactor.redact(text)
      expect(result.detectedPII.length).toBeGreaterThan(
        TEST_CONSTANTS.NUMERIC_VALUES.ZERO
      )
      expect(result.redactionCount).toBeGreaterThanOrEqual(
        TEST_CONSTANTS.NUMERIC_VALUES.TWO
      )
      expect(result.hasPII).toBe(true)
    })
    test('Should preserve format when preserveFormat option is true', () => {
      const text = `Card ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)}`
      const result = redactor.redact(text, { preserveFormat: true })
      expect(result.redactedText).toMatch(/\*+/)
      expect(result.redactedText).not.toContain(
        TEST_CONSTANTS.REDACTION_LABELS.CARD_NUMBER
      )
      expect(result.hasPII).toBe(true)
    })
    test('Should only use enabled patterns when specified', () => {
      const text = `Card: ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)}`
      const result = redactor.redact(text, {
        enabledPatterns: [TEST_CONSTANTS.PII_TYPES.CREDIT_CARD]
      })
      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.CARD_NUMBER
      )
      expect(result.detectedPII.length).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ONE)
      expect(result.detectedPII[0].type).toBe(
        TEST_CONSTANTS.PII_TYPES.CREDIT_CARD
      )
    })
    test('Should handle unknown pattern names gracefully', () => {
      const text = 'Some text'
      const result = redactor.redact(text, {
        enabledPatterns: ['unknownPattern', TEST_CONSTANTS.PII_TYPES.NI_NUMBER]
      })
      expect(result.redactedText).toBe('Some text')
      expect(result.detectedPII).toEqual([])
    })
  })
})
describe('PIIRedactor - Metadata and Clean Text', () => {
  let redactor
  beforeEach(() => {
    redactor = new PIIRedactor()
  })
  describe('redact method - metadata and clean text', () => {
    test('Should not redact text without PII', () => {
      const text = 'This is a clean text without any personal information.'
      const result = redactor.redact(text)
      expect(result.redactedText).toBe(text)
      expect(result.detectedPII).toEqual([])
      expect(result.redactionCount).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ZERO)
      expect(result.hasPII).toBe(false)
    })
    test('Should return correct originalLength and redactedLength', () => {
      const text = `Card ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)}`
      const result = redactor.redact(text)
      expect(result.originalLength).toBe(text.length)
      expect(result.redactedLength).toBeGreaterThan(
        TEST_CONSTANTS.NUMERIC_VALUES.ZERO
      )
    })
    test('Should include examples in detectedPII', () => {
      const text = `Card ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)} and ${TEST_CONSTANTS.CREDIT_CARD_2} and ${TEST_CONSTANTS.CREDIT_CARD_3}`
      const result = redactor.redact(text)
      expect(result.detectedPII[0].examples).toBeDefined()
      expect(result.detectedPII[0].examples.length).toBeLessThanOrEqual(
        TEST_CONSTANTS.NUMERIC_VALUES.MAX_EXAMPLES
      )
    })
  })
})
describe('PIIRedactor - PII Report Creation', () => {
  let redactor
  beforeEach(() => {
    redactor = new PIIRedactor()
  })
  describe('createPIIReport method', () => {
    test('Should create report with PII detected', () => {
      const originalText = `Card: ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)}`
      const redactedText = `Card: ${TEST_CONSTANTS.REDACTION_LABELS.CARD_NUMBER}`
      const detectedPII = [
        {
          type: TEST_CONSTANTS.PII_TYPES.CREDIT_CARD,
          count: TEST_CONSTANTS.NUMERIC_VALUES.ONE
        }
      ]
      const report = redactor.createPIIReport(
        originalText,
        redactedText,
        detectedPII
      )
      expect(report.hasPII).toBe(true)
      expect(report.piiTypes).toEqual([TEST_CONSTANTS.PII_TYPES.CREDIT_CARD])
      expect(report.totalRedactions).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ONE)
      expect(report.detectedPII).toEqual(detectedPII)
      expect(report.timestamp).toBeDefined()
    })
    test('Should create report without PII', () => {
      const originalText = 'Clean text'
      const redactedText = 'Clean text'
      const detectedPII = []
      const report = redactor.createPIIReport(
        originalText,
        redactedText,
        detectedPII
      )
      expect(report.hasPII).toBe(false)
      expect(report.piiTypes).toEqual([])
      expect(report.totalRedactions).toBe(TEST_CONSTANTS.NUMERIC_VALUES.ZERO)
    })
    test('Should calculate total redactions and handle empty text', () => {
      const detectedPII = [
        {
          type: TEST_CONSTANTS.PII_TYPES.CREDIT_CARD,
          count: TEST_CONSTANTS.NUMERIC_VALUES.TWO
        },
        {
          type: TEST_CONSTANTS.PII_TYPES.IPV4,
          count: TEST_CONSTANTS.NUMERIC_VALUES.THREE
        }
      ]
      const report = redactor.createPIIReport('text', 'text', detectedPII)
      expect(report.totalRedactions).toBe(TEST_CONSTANTS.NUMERIC_VALUES.FIVE)
      const emptyReport = redactor.createPIIReport('', '', [])
      expect(emptyReport.redactionPercentage).toBe(
        TEST_CONSTANTS.NUMERIC_VALUES.ZERO
      )
    })
    test('Should include timestamp in ISO format', () => {
      const report = redactor.createPIIReport('text', 'text', [])
      expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  })
})
describe('PIIRedactor - PII Validation', () => {
  let redactor
  beforeEach(() => {
    redactor = new PIIRedactor()
  })
  describe('validateNoPII method', () => {
    test('Should return valid when no PII detected', () => {
      const text = 'This is clean text'
      const result = redactor.validateNoPII(text)
      expect(result.isValid).toBe(true)
      expect(result.hasPII).toBe(false)
      expect(result.detectedPII).toEqual([])
      expect(result.message).toBe(TEST_CONSTANTS.MESSAGES.NO_PII)
    })
    test('Should return invalid when PII detected and list all types', () => {
      const text = `Card ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)}`
      const result = redactor.validateNoPII(text)
      expect(result.isValid).toBe(false)
      expect(result.hasPII).toBe(true)
      expect(result.detectedPII.length).toBeGreaterThan(
        TEST_CONSTANTS.NUMERIC_VALUES.ZERO
      )
      expect(result.message).toContain(TEST_CONSTANTS.MESSAGES.PII_DETECTED)
      expect(result.message).toContain(TEST_CONSTANTS.PII_TYPES.CREDIT_CARD)
      const multiPII = `Card: ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)}, IP: ${TEST_CONSTANTS.IP_V4_1}`
      const result2 = redactor.validateNoPII(multiPII)
      expect(result2.isValid).toBe(false)
      expect(result2.message).toContain(TEST_CONSTANTS.PII_TYPES.CREDIT_CARD)
      expect(result2.message).toContain(TEST_CONSTANTS.PII_TYPES.IPV4)
    })
  })
})
describe('PIIRedactor - Singleton Instance', () => {
  describe('singleton instance', () => {
    test('Should export and use piiRedactor singleton', () => {
      expect(piiRedactor).toBeInstanceOf(PIIRedactor)
      const text = `Card ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)}`
      const result = piiRedactor.redact(text)
      expect(result.hasPII).toBe(true)
    })
  })
})
describe('PIIRedactor - Edge Cases', () => {
  let redactor
  beforeEach(() => {
    redactor = new PIIRedactor()
  })
  describe('edge cases', () => {
    test('Should handle very long text', () => {
      const longText = 'Clean text. '.repeat(
        TEST_CONSTANTS.NUMERIC_VALUES.LONG_TEXT_REPEAT
      )
      const result = redactor.redact(longText)
      expect(result.redactedText).toBe(longText)
      expect(result.hasPII).toBe(false)
    })
    test('Should handle text with special characters', () => {
      const text = `Special chars: @#$%^&*() with Card: ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)}`
      const result = redactor.redact(text)
      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.CARD_NUMBER
      )
      expect(result.redactedText).toContain('@#$%^&*()')
    })
    test('Should handle text with newlines and tabs', () => {
      const text = `Line 1\nCard: ${formatCreditCard(TEST_CONSTANTS.CREDIT_CARD_1)}\tLine 2`
      const result = redactor.redact(text)
      expect(result.redactedText).toContain(
        TEST_CONSTANTS.REDACTION_LABELS.CARD_NUMBER
      )
      expect(result.redactedText).toContain('\n')
      expect(result.redactedText).toContain('\t')
    })
    test('Should handle consecutive PII items', () => {
      const text = `${TEST_CONSTANTS.IP_V4_1} ${TEST_CONSTANTS.IP_V4_2} ${TEST_CONSTANTS.IP_V4_3}`
      const result = redactor.redact(text)
      expect(result.redactionCount).toBe(TEST_CONSTANTS.NUMERIC_VALUES.THREE)
    })
    test('Should handle mixed case in PII patterns', () => {
      const text = `IPv6: ${TEST_CONSTANTS.IP_V6_1} and ${TEST_CONSTANTS.IP_V6_2}`
      const result = redactor.redact(text)
      expect(result.redactionCount).toBeGreaterThanOrEqual(
        TEST_CONSTANTS.NUMERIC_VALUES.ONE
      )
    })
  })
})
