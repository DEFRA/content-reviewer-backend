import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Constants ────────────────────────────────────────────────────────────────
const NI_NUMBER = 'AB123456C'
const CREDIT_CARD = '4111 1111 1111 1111'
const IPV4_ADDRESS = '192.168.1.100'
const IPV6_ADDRESS = '2001:0DB8:85A3:0000:0000:8A2E:0370:7334'
const DOB_DATE = '01/01/1990'
const DRIVING_LICENSE = 'JONES612178AB1CD'
const PASSPORT_NUMBER = '123456789'
const SSN_NUMBER = '123-45-6789'
const BANK_ACCOUNT = '12345678'
const SORT_CODE = '12-34-56'
const CLEAN_TEXT = 'This content has no personal information whatsoever.'
const SAMPLE_REVIEW = 'The content is good and clear.'
const USER_CONTENT_SAFE = 'My document discusses policy reform.'
const USER_CONTENT_PII = `Contact me at NI number ${NI_NUMBER} for details.`
const REDACTED_LABEL_NI = '[NI_NUMBER_REDACTED]'
const REDACTED_LABEL_CARD = '[CARD_NUMBER_REDACTED]'
const REDACTED_LABEL_IP = '[IP_ADDRESS_REDACTED]'
const REDACTED_LABEL_DATE = '[DATE_REDACTED]'
const REDACTED_LABEL_SSN = '[SSN_REDACTED]'
const REDACTED_LABEL_ACCOUNT = '[ACCOUNT_NUMBER_REDACTED]'
const REDACTED_LABEL_SORT = '[SORT_CODE_REDACTED]'
const REDACTED_ASTERISK_LENGTH = 9
const NON_STRING_INPUT = 42
const REDACTION_PERCENTAGE_HALF = 50

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

import { PIIRedactor, piiRedactor } from './pii-redactor.js'

// ── redact() ─────────────────────────────────────────────────────────────────

describe('PIIRedactor.redact - input validation', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  it('returns passthrough result for null input', () => {
    const result = redactor.redact(null)
    expect(result.redactedText).toBeNull()
    expect(result.redactionCount).toBe(0)
    expect(result.detectedPII).toEqual([])
  })

  it('returns passthrough result for non-string input', () => {
    const result = redactor.redact(NON_STRING_INPUT)
    expect(result.redactedText).toBe(NON_STRING_INPUT)
    expect(result.hasPII).toBeUndefined()
  })

  it('returns clean result for text with no PII', () => {
    const result = redactor.redact(CLEAN_TEXT)
    expect(result.redactedText).toBe(CLEAN_TEXT)
    expect(result.hasPII).toBe(false)
    expect(result.redactionCount).toBe(0)
    expect(result.detectedPII).toEqual([])
  })

  it('returns originalLength and redactedLength', () => {
    const result = redactor.redact(CLEAN_TEXT)
    expect(result.originalLength).toBe(CLEAN_TEXT.length)
    expect(result.redactedLength).toBe(CLEAN_TEXT.length)
  })
})

describe('PIIRedactor.redact - PII pattern detection', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  it('redacts UK National Insurance numbers', () => {
    const result = redactor.redact(`My NI is ${NI_NUMBER}.`)
    expect(result.redactedText).toContain(REDACTED_LABEL_NI)
    expect(result.hasPII).toBe(true)
  })

  it('redacts credit card numbers', () => {
    const result = redactor.redact(`Card: ${CREDIT_CARD}`)
    expect(result.redactedText).toContain(REDACTED_LABEL_CARD)
    expect(result.hasPII).toBe(true)
  })

  it('redacts IPv4 addresses', () => {
    const result = redactor.redact(`Server IP: ${IPV4_ADDRESS}`)
    expect(result.redactedText).toContain(REDACTED_LABEL_IP)
    expect(result.hasPII).toBe(true)
  })

  it('redacts IPv6 addresses', () => {
    const result = redactor.redact(`IPv6: ${IPV6_ADDRESS}`)
    expect(result.redactedText).toContain(REDACTED_LABEL_IP)
    expect(result.hasPII).toBe(true)
  })

  it('redacts dates of birth', () => {
    const result = redactor.redact(`DOB: ${DOB_DATE}`)
    expect(result.redactedText).toContain(REDACTED_LABEL_DATE)
    expect(result.hasPII).toBe(true)
  })

  it('redacts SSN numbers', () => {
    const result = redactor.redact(`SSN: ${SSN_NUMBER}`)
    expect(result.redactedText).toContain(REDACTED_LABEL_SSN)
    expect(result.hasPII).toBe(true)
  })

  it('redacts bank account numbers', () => {
    const result = redactor.redact(`Account: ${BANK_ACCOUNT}`)
    expect(result.redactedText).toContain(REDACTED_LABEL_ACCOUNT)
    expect(result.hasPII).toBe(true)
  })

  it('redacts sort codes', () => {
    const result = redactor.redact(`Sort code: ${SORT_CODE}`, {
      enabledPatterns: ['sortCode']
    })
    expect(result.redactedText).toContain(REDACTED_LABEL_SORT)
    expect(result.hasPII).toBe(true)
  })

  it('detects multiple PII types in one string', () => {
    const text = `NI: ${NI_NUMBER}, IP: ${IPV4_ADDRESS}`
    const result = redactor.redact(text)
    expect(result.detectedPII.length).toBeGreaterThanOrEqual(2)
    expect(result.redactionCount).toBeGreaterThanOrEqual(2)
  })

  it('includes type and count in detectedPII entries', () => {
    const result = redactor.redact(`NI: ${NI_NUMBER}`)
    const niEntry = result.detectedPII.find((p) => p.type === 'niNumber')
    expect(niEntry).toBeDefined()
    expect(niEntry.count).toBeGreaterThanOrEqual(1)
  })
})

describe('PIIRedactor.redact - options', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  it('respects enabledPatterns option — only redacts specified patterns', () => {
    const text = `NI: ${NI_NUMBER}, IP: ${IPV4_ADDRESS}`
    const result = redactor.redact(text, { enabledPatterns: ['niNumber'] })
    expect(result.redactedText).toContain(REDACTED_LABEL_NI)
    expect(result.redactedText).toContain(IPV4_ADDRESS)
  })

  it('uses preserveFormat to replace with asterisks', () => {
    const text = `NI: ${NI_NUMBER}`
    const result = redactor.redact(text, { preserveFormat: true })
    expect(result.redactedText).toContain('*'.repeat(REDACTED_ASTERISK_LENGTH))
    expect(result.redactedText).not.toContain(REDACTED_LABEL_NI)
  })

  it('warns and skips unknown pattern names', () => {
    const result = redactor.redact(CLEAN_TEXT, {
      enabledPatterns: ['unknownPattern']
    })
    expect(result.redactionCount).toBe(0)
  })
})

// ── extractGuardrailPII() ────────────────────────────────────────────────────

describe('PIIRedactor.extractGuardrailPII', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  it('returns empty array when assessment is null', () => {
    expect(redactor.extractGuardrailPII(null)).toEqual([])
  })

  it('returns empty array when assessments property is missing', () => {
    expect(redactor.extractGuardrailPII({})).toEqual([])
  })

  it('returns empty array when assessments is empty', () => {
    expect(redactor.extractGuardrailPII({ assessments: [] })).toEqual([])
  })

  it('extracts PII entity when sensitiveInformationPolicy is present', () => {
    const assessment = {
      action: 'BLOCKED',
      assessments: [{ sensitiveInformationPolicy: { piiEntities: [] } }]
    }
    const result = redactor.extractGuardrailPII(assessment)
    expect(result.length).toBe(1)
    expect(result[0].type).toBe('BEDROCK_GUARDRAIL_PII')
    expect(result[0].action).toBe('BLOCKED')
  })

  it('extracts PII entity when contentPolicy filter type is PII', () => {
    const assessment = {
      action: 'NONE',
      assessments: [
        { contentPolicy: { filters: [{ type: 'PII', action: 'BLOCKED' }] } }
      ]
    }
    const result = redactor.extractGuardrailPII(assessment)
    expect(result.length).toBe(1)
  })

  it('returns empty array when no PII-related assessment found', () => {
    const assessment = {
      action: 'NONE',
      assessments: [{ contentPolicy: { filters: [{ type: 'HATE' }] } }]
    }
    expect(redactor.extractGuardrailPII(assessment)).toEqual([])
  })
})

// ── redactBedrockResponse() ──────────────────────────────────────────────────

describe('PIIRedactor.redactBedrockResponse', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  it('returns clean result when review content has no PII', () => {
    const result = redactor.redactBedrockResponse(SAMPLE_REVIEW)
    expect(result.hasPII).toBe(false)
    expect(result.redactedText).toBe(SAMPLE_REVIEW)
  })

  it('redacts NI number found in Bedrock response', () => {
    const result = redactor.redactBedrockResponse(
      `User mentioned NI ${NI_NUMBER}`
    )
    expect(result.hasPII).toBe(true)
    expect(result.redactedText).toContain(REDACTED_LABEL_NI)
  })
})

// ── redactUserContent() ──────────────────────────────────────────────────────

describe('PIIRedactor.redactUserContent', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  it('returns clean result for safe content', () => {
    const result = redactor.redactUserContent(USER_CONTENT_SAFE)
    expect(result.hasPII).toBe(false)
  })

  it('redacts PII in user content and logs a warning', () => {
    const result = redactor.redactUserContent(USER_CONTENT_PII)
    expect(result.hasPII).toBe(true)
    expect(result.redactedText).toContain(REDACTED_LABEL_NI)
  })
})

// ── createPIIReport() ────────────────────────────────────────────────────────

describe('PIIRedactor.createPIIReport', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  it('returns hasPII false when detectedPII is empty', () => {
    const report = redactor.createPIIReport(CLEAN_TEXT, CLEAN_TEXT, [])
    expect(report.hasPII).toBe(false)
    expect(report.totalRedactions).toBe(0)
  })

  it('returns hasPII true with correct counts', () => {
    const detected = [{ type: 'niNumber', count: 2 }]
    const report = redactor.createPIIReport('original', 'redacted', detected)
    expect(report.hasPII).toBe(true)
    expect(report.totalRedactions).toBe(2)
    expect(report.piiTypes).toEqual(['niNumber'])
  })

  it('includes timestamp in the report', () => {
    const report = redactor.createPIIReport(CLEAN_TEXT, CLEAN_TEXT, [])
    expect(report.timestamp).toBeDefined()
  })

  it('calculates redactionPercentage correctly', () => {
    const original = 'ABCDEFGHIJ'
    const redacted = 'ABCDE'
    const report = redactor.createPIIReport(original, redacted, [])
    expect(report.redactionPercentage).toBe(REDACTION_PERCENTAGE_HALF)
  })

  it('handles zero-length originalText without dividing by zero', () => {
    const report = redactor.createPIIReport('', '', [])
    expect(report.redactionPercentage).toBe(0)
  })
})

// ── validateNoPII() ──────────────────────────────────────────────────────────

describe('PIIRedactor.validateNoPII', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  it('returns isValid true for clean text', () => {
    const result = redactor.validateNoPII(CLEAN_TEXT)
    expect(result.isValid).toBe(true)
    expect(result.hasPII).toBe(false)
    expect(result.message).toBe('No PII detected')
  })

  it('returns isValid false for text containing PII', () => {
    const result = redactor.validateNoPII(`NI: ${NI_NUMBER}`)
    expect(result.isValid).toBe(false)
    expect(result.hasPII).toBe(true)
    expect(result.message).toContain('PII detected')
  })

  it('includes detectedPII in result', () => {
    const result = redactor.validateNoPII(`NI: ${NI_NUMBER}`)
    expect(Array.isArray(result.detectedPII)).toBe(true)
  })
})

// ── singleton export ─────────────────────────────────────────────────────────

describe('piiRedactor singleton', () => {
  it('is an instance of PIIRedactor', () => {
    expect(piiRedactor).toBeInstanceOf(PIIRedactor)
  })

  it('exposes redact method', () => {
    expect(typeof piiRedactor.redact).toBe('function')
  })

  it('exposes validateNoPII method', () => {
    expect(typeof piiRedactor.validateNoPII).toBe('function')
  })

  it('has patterns property with expected keys', () => {
    expect(piiRedactor.patterns).toHaveProperty('niNumber')
    expect(piiRedactor.patterns).toHaveProperty('creditCard')
    expect(piiRedactor.patterns).toHaveProperty('ipv4')
    expect(piiRedactor.patterns).toHaveProperty('sortCode')
  })
})

// ── UK Driving License ───────────────────────────────────────────────────────

describe('PIIRedactor.redact - driving license', () => {
  let redactor

  beforeEach(() => {
    redactor = new PIIRedactor()
  })

  it('redacts UK driving license numbers', () => {
    const result = redactor.redact(`License: ${DRIVING_LICENSE}`)
    expect(result.hasPII).toBe(true)
    expect(result.redactedText).toContain('[DRIVING_LICENSE_REDACTED]')
  })

  it('redacts UK passport numbers', () => {
    const result = redactor.redact(`Passport: ${PASSPORT_NUMBER}`)
    expect(result.hasPII).toBe(true)
    expect(result.redactedText).toContain('[PASSPORT_REDACTED]')
  })
})
