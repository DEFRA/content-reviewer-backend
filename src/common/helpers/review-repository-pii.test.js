import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  redactImprovements,
  redactPIIFromReview
} from './review-repository-pii.js'
import * as piiRedactorModule from './pii-redactor.js'

vi.mock('./pii-redactor.js', () => ({
  piiRedactor: {
    redact: vi.fn(),
    redactBedrockResponse: vi.fn()
  }
}))

// Test constants
const MOCK_REDACTED_TEXT = 'Redacted text'
const MOCK_REDACTED_RESPONSE = 'Redacted response'
const MOCK_REDACTED_IMPROVEMENT = 'Redacted improvement'
const EXPECTED_IMPROVEMENTS_COUNT = 3
const EXPECTED_REDACT_CALLS = 4
const MOCK_REVIEW_SCORE = 95
// Helper to create standard mock redaction result
const createMockRedactResult = (
  redactedText,
  hasPII = false,
  redactionCount = 0
) => ({
  redactedText,
  hasPII,
  redactionCount
})

describe('redactImprovements - basic functionality', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should return empty array when improvements is empty', () => {
    const result = redactImprovements([])
    expect(result).toEqual([])
  })
  it('should redact PII from current field only', () => {
    piiRedactorModule.piiRedactor.redact.mockReturnValue(
      createMockRedactResult('Redacted current text', true, 1)
    )
    const improvements = [
      { current: 'Contact John at john@example.com', category: 'contact' }
    ]
    const result = redactImprovements(improvements)
    expect(piiRedactorModule.piiRedactor.redact).toHaveBeenCalledWith(
      'Contact John at john@example.com',
      { preserveFormat: false }
    )
    expect(result).toEqual([
      { current: 'Redacted current text', category: 'contact' }
    ])
  })
  it('should redact PII from suggested field only', () => {
    piiRedactorModule.piiRedactor.redact.mockReturnValue(
      createMockRedactResult('Redacted suggested text', true, 1)
    )
    const improvements = [
      { suggested: 'Contact us at support@company.com', category: 'contact' }
    ]
    const result = redactImprovements(improvements)
    expect(piiRedactorModule.piiRedactor.redact).toHaveBeenCalledWith(
      'Contact us at support@company.com',
      { preserveFormat: false }
    )
    expect(result).toEqual([
      { suggested: 'Redacted suggested text', category: 'contact' }
    ])
  })
})

describe('redactImprovements - combined field redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should redact PII from both current and suggested fields', () => {
    piiRedactorModule.piiRedactor.redact
      .mockReturnValueOnce(createMockRedactResult('Redacted current', true, 1))
      .mockReturnValueOnce(
        createMockRedactResult('Redacted suggested', true, 1)
      )
    const improvements = [
      {
        current: 'Current with NI number QQ123456C',
        suggested: 'Suggested with card 4532-1234-5678-9010',
        category: 'security'
      }
    ]
    const result = redactImprovements(improvements)
    expect(piiRedactorModule.piiRedactor.redact).toHaveBeenCalledTimes(2)
    expect(result).toEqual([
      {
        current: 'Redacted current',
        suggested: 'Redacted suggested',
        category: 'security'
      }
    ])
  })
})

describe('redactImprovements - multiple improvements handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should handle multiple improvements with different fields', () => {
    piiRedactorModule.piiRedactor.redact.mockReturnValue(
      createMockRedactResult(MOCK_REDACTED_TEXT)
    )
    const improvements = [
      { current: 'First current' },
      { suggested: 'Second suggested' },
      { current: 'Third current', suggested: 'Third suggested' }
    ]
    const result = redactImprovements(improvements)
    expect(piiRedactorModule.piiRedactor.redact).toHaveBeenCalledTimes(
      EXPECTED_REDACT_CALLS
    )
    expect(result).toHaveLength(EXPECTED_IMPROVEMENTS_COUNT)
    expect(result[0]).toEqual({ current: MOCK_REDACTED_TEXT })
    expect(result[1]).toEqual({ suggested: MOCK_REDACTED_TEXT })
    expect(result[2]).toEqual({
      current: MOCK_REDACTED_TEXT,
      suggested: MOCK_REDACTED_TEXT
    })
  })
  it('should preserve other properties in improvements', () => {
    piiRedactorModule.piiRedactor.redact.mockReturnValue(
      createMockRedactResult(MOCK_REDACTED_TEXT)
    )
    const improvements = [
      {
        current: 'Original text',
        category: 'accessibility',
        severity: 'high',
        lineNumber: 42
      }
    ]
    const result = redactImprovements(improvements)
    expect(result).toEqual([
      {
        current: MOCK_REDACTED_TEXT,
        category: 'accessibility',
        severity: 'high',
        lineNumber: 42
      }
    ])
  })
})

describe('redactImprovements - edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should handle improvements without current or suggested fields', () => {
    const improvements = [
      { category: 'general', severity: 'low' },
      { type: 'info', message: 'No PII here' }
    ]
    const result = redactImprovements(improvements)
    expect(piiRedactorModule.piiRedactor.redact).not.toHaveBeenCalled()
    expect(result).toEqual(improvements)
  })
})

describe('redactPIIFromReview - missing or null result', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should return default piiRedactionInfo when review has no result', () => {
    const review = { id: '123', status: 'pending' }
    const result = redactPIIFromReview(review)
    expect(result).toEqual({
      hasPII: false,
      redactionCount: 0
    })
    expect(
      piiRedactorModule.piiRedactor.redactBedrockResponse
    ).not.toHaveBeenCalled()
  })
  it('should return default piiRedactionInfo when review.result is null', () => {
    const review = { id: '123', result: null }
    const result = redactPIIFromReview(review)
    expect(result).toEqual({
      hasPII: false,
      redactionCount: 0
    })
  })
  it('should return default piiRedactionInfo when review.result is undefined', () => {
    const review = { id: '123' }
    const result = redactPIIFromReview(review)
    expect(result).toEqual({
      hasPII: false,
      redactionCount: 0
    })
  })
})

describe('redactPIIFromReview - rawResponse redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should redact PII from rawResponse and return redaction info', () => {
    const mockRedactionResult = {
      redactedText: MOCK_REDACTED_RESPONSE,
      hasPII: true,
      redactionCount: 2,
      detectedPII: ['NI_NUMBER', 'EMAIL']
    }
    piiRedactorModule.piiRedactor.redactBedrockResponse.mockReturnValue(
      mockRedactionResult
    )
    const review = {
      result: {
        rawResponse: 'Original response with PII'
      }
    }
    const result = redactPIIFromReview(review)
    expect(
      piiRedactorModule.piiRedactor.redactBedrockResponse
    ).toHaveBeenCalledWith('Original response with PII')
    expect(review.result.rawResponse).toBe(MOCK_REDACTED_RESPONSE)
    expect(result).toEqual({
      hasPII: true,
      redactionCount: 2,
      detectedPII: ['NI_NUMBER', 'EMAIL']
    })
  })
})

describe('redactPIIFromReview - improvements redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should redact improvements from reviewData', () => {
    piiRedactorModule.piiRedactor.redactBedrockResponse.mockReturnValue(
      createMockRedactResult(MOCK_REDACTED_RESPONSE)
    )
    piiRedactorModule.piiRedactor.redact.mockReturnValue(
      createMockRedactResult(MOCK_REDACTED_IMPROVEMENT)
    )
    const review = {
      result: {
        rawResponse: 'Response',
        reviewData: {
          improvements: [
            { current: 'Current text' },
            { suggested: 'Suggested text' }
          ]
        }
      }
    }
    const result = redactPIIFromReview(review)
    expect(review.result.reviewData.improvements).toEqual([
      { current: MOCK_REDACTED_IMPROVEMENT },
      { suggested: MOCK_REDACTED_IMPROVEMENT }
    ])
    expect(result.hasPII).toBe(false)
  })
})

describe('redactPIIFromReview - plainText redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should redact plainText from reviewedContent', () => {
    piiRedactorModule.piiRedactor.redactBedrockResponse.mockReturnValue(
      createMockRedactResult(MOCK_REDACTED_RESPONSE)
    )
    piiRedactorModule.piiRedactor.redact.mockReturnValue(
      createMockRedactResult('Redacted plain text', true, 1)
    )
    const review = {
      result: {
        rawResponse: 'Response',
        reviewData: {
          reviewedContent: {
            plainText: 'Original plain text with PII'
          }
        }
      }
    }
    const result = redactPIIFromReview(review)
    expect(piiRedactorModule.piiRedactor.redact).toHaveBeenCalledWith(
      'Original plain text with PII',
      { preserveFormat: false }
    )
    expect(review.result.reviewData.reviewedContent.plainText).toBe(
      'Redacted plain text'
    )
    expect(result.hasPII).toBe(false)
  })
})

describe('redactPIIFromReview - comprehensive redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should handle review with all fields requiring redaction', () => {
    const mockBedrockResult = {
      redactedText: 'Redacted bedrock response',
      hasPII: true,
      redactionCount: 3,
      detectedPII: ['NI_NUMBER', 'CARD_NUMBER', 'EMAIL']
    }
    piiRedactorModule.piiRedactor.redactBedrockResponse.mockReturnValue(
      mockBedrockResult
    )
    piiRedactorModule.piiRedactor.redact.mockReturnValue(
      createMockRedactResult(MOCK_REDACTED_TEXT)
    )
    const review = {
      result: {
        rawResponse: 'Bedrock response with PII',
        reviewData: {
          improvements: [
            { current: 'Current 1', suggested: 'Suggested 1' },
            { current: 'Current 2' }
          ],
          reviewedContent: {
            plainText: 'Plain text content'
          }
        }
      }
    }
    const result = redactPIIFromReview(review)
    expect(
      piiRedactorModule.piiRedactor.redactBedrockResponse
    ).toHaveBeenCalledTimes(1)
    expect(piiRedactorModule.piiRedactor.redact).toHaveBeenCalledTimes(
      EXPECTED_REDACT_CALLS
    )
    expect(result).toEqual({
      hasPII: true,
      redactionCount: 3,
      detectedPII: ['NI_NUMBER', 'CARD_NUMBER', 'EMAIL']
    })
  })
})

describe('redactPIIFromReview - result without rawResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should skip rawResponse redaction when rawResponse is absent', () => {
    piiRedactorModule.piiRedactor.redact.mockReturnValue(
      createMockRedactResult('Redacted plain text')
    )
    const review = {
      result: {
        reviewData: {
          reviewedContent: {
            plainText: 'Plain text with no raw response'
          }
        }
      }
    }
    const result = redactPIIFromReview(review)
    expect(
      piiRedactorModule.piiRedactor.redactBedrockResponse
    ).not.toHaveBeenCalled()
    expect(result).toEqual({ hasPII: false, redactionCount: 0 })
  })
})

describe('redactPIIFromReview - null handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should handle reviewData without improvements array', () => {
    piiRedactorModule.piiRedactor.redactBedrockResponse.mockReturnValue(
      createMockRedactResult(MOCK_REDACTED_RESPONSE)
    )
    const review = {
      result: {
        rawResponse: 'Response',
        reviewData: {
          improvements: null,
          reviewedContent: { plainText: 'Text' }
        }
      }
    }
    redactPIIFromReview(review)
    expect(review.result.reviewData.improvements).toBeNull()
  })
  it('should handle reviewData without reviewedContent', () => {
    piiRedactorModule.piiRedactor.redactBedrockResponse.mockReturnValue(
      createMockRedactResult(MOCK_REDACTED_RESPONSE)
    )
    piiRedactorModule.piiRedactor.redact.mockReturnValue(
      createMockRedactResult(MOCK_REDACTED_TEXT)
    )
    const review = {
      result: {
        rawResponse: 'Response',
        reviewData: {
          improvements: [{ current: 'Text' }]
        }
      }
    }
    const result = redactPIIFromReview(review)
    expect(result.hasPII).toBe(false)
  })
  it('should handle reviewedContent without plainText', () => {
    piiRedactorModule.piiRedactor.redactBedrockResponse.mockReturnValue(
      createMockRedactResult(MOCK_REDACTED_RESPONSE)
    )
    const review = {
      result: {
        rawResponse: 'Response',
        reviewData: {
          reviewedContent: { html: '<p>Content</p>' }
        }
      }
    }
    const result = redactPIIFromReview(review)
    expect(piiRedactorModule.piiRedactor.redact).not.toHaveBeenCalled()
    expect(result.hasPII).toBe(false)
  })
  it('should handle reviewData as null', () => {
    piiRedactorModule.piiRedactor.redactBedrockResponse.mockReturnValue(
      createMockRedactResult(MOCK_REDACTED_RESPONSE)
    )
    const review = {
      result: {
        rawResponse: 'Response',
        reviewData: null
      }
    }
    const result = redactPIIFromReview(review)
    expect(result.hasPII).toBe(false)
  })
})

describe('redactPIIFromReview - mutation and preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should mutate the original review object', () => {
    const mockResult = {
      redactedText: 'Mutated response',
      hasPII: true,
      redactionCount: 1,
      detectedPII: ['EMAIL']
    }
    piiRedactorModule.piiRedactor.redactBedrockResponse.mockReturnValue(
      mockResult
    )
    const review = { result: { rawResponse: 'Original' } }
    redactPIIFromReview(review)
    expect(review.result.rawResponse).toBe('Mutated response')
  })
  it('should handle empty improvements array', () => {
    piiRedactorModule.piiRedactor.redactBedrockResponse.mockReturnValue(
      createMockRedactResult(MOCK_REDACTED_RESPONSE)
    )
    const review = {
      result: {
        rawResponse: 'Response',
        reviewData: { improvements: [] }
      }
    }
    const result = redactPIIFromReview(review)
    expect(review.result.reviewData.improvements).toEqual([])
    expect(result.hasPII).toBe(false)
  })
  it('should preserve other properties in review object', () => {
    const mockResult = {
      redactedText: MOCK_REDACTED_RESPONSE,
      hasPII: true,
      redactionCount: 1,
      detectedPII: ['EMAIL']
    }
    piiRedactorModule.piiRedactor.redactBedrockResponse.mockReturnValue(
      mockResult
    )
    const review = {
      id: 'review-123',
      userId: 'user-456',
      status: 'completed',
      timestamp: '2024-01-01T00:00:00Z',
      result: {
        rawResponse: 'Original response',
        score: MOCK_REVIEW_SCORE
      }
    }
    redactPIIFromReview(review)
    expect(review.id).toBe('review-123')
    expect(review.userId).toBe('user-456')
    expect(review.status).toBe('completed')
    expect(review.timestamp).toBe('2024-01-01T00:00:00Z')
    expect(review.result.score).toBe(MOCK_REVIEW_SCORE)
  })
})
