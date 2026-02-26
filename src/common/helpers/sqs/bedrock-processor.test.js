import { describe, test, expect, beforeEach, vi } from 'vitest'

import { BedrockReviewProcessor } from './bedrock-processor.js'

// Test constants to avoid magic strings and numbers
const TEST_REVIEW_ID = 'review-123'
const TEST_SYSTEM_PROMPT = 'System prompt'
const TEST_USER_PROMPT = 'User prompt'
const LONG_PROMPT_LENGTH = 5000
const BEDROCK_API_ERROR = 'Bedrock API error'

const mockLoggerInfo = vi.fn()
const mockLoggerError = vi.fn()
const mockGetSystemPrompt = vi.fn()
const mockSendMessage = vi.fn()
const mockParseBedrockResponse = vi.fn()

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: (...args) => mockLoggerInfo(...args),
    error: (...args) => mockLoggerError(...args)
  })
}))

vi.mock('../bedrock-client.js', () => ({
  bedrockClient: {
    sendMessage: (...args) => mockSendMessage(...args)
  }
}))

vi.mock('../prompt-manager.js', () => ({
  promptManager: {
    getSystemPrompt: (...args) => mockGetSystemPrompt(...args)
  }
}))

vi.mock('../review-parser.js', () => ({
  parseBedrockResponse: (...args) => mockParseBedrockResponse(...args)
}))

describe('BedrockReviewProcessor - loadSystemPrompt', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  describe('loadSystemPrompt', () => {
    test('Should load system prompt successfully', async () => {
      const mockPrompt = 'You are a content reviewer for GOV.UK...'
      mockGetSystemPrompt.mockResolvedValueOnce(mockPrompt)

      const result = await processor.loadSystemPrompt(TEST_REVIEW_ID)

      expect(result.systemPrompt).toBe(mockPrompt)
      expect(result.promptLoadDuration).toBeGreaterThanOrEqual(0)
      expect(mockGetSystemPrompt).toHaveBeenCalled()
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewId: TEST_REVIEW_ID,
          systemPromptLength: 40,
          durationMs: expect.any(Number)
        }),
        expect.stringContaining('System prompt loaded from S3')
      )
    })

    test('Should handle long system prompts', async () => {
      const longPrompt = 'x'.repeat(LONG_PROMPT_LENGTH)
      mockGetSystemPrompt.mockResolvedValueOnce(longPrompt)

      const result = await processor.loadSystemPrompt('review-456')

      expect(result.systemPrompt).toBe(longPrompt)
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPromptLength: LONG_PROMPT_LENGTH
        }),
        expect.any(String)
      )
    })

    test('Should handle prompt loading error', async () => {
      const error = new Error('S3 bucket not accessible')
      mockGetSystemPrompt.mockRejectedValueOnce(error)

      await expect(processor.loadSystemPrompt('review-789')).rejects.toThrow(
        'S3 bucket not accessible'
      )
    })
  })
})

describe('BedrockReviewProcessor - sendBedrockRequest - Success Cases', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('Should send successful request to Bedrock', async () => {
    const mockResponse = {
      success: true,
      content: 'Review analysis results...',
      usage: {
        inputTokens: 1500,
        outputTokens: 800,
        totalTokens: 2300
      }
    }
    mockSendMessage.mockResolvedValueOnce(mockResponse)

    const result = await processor.sendBedrockRequest(
      TEST_REVIEW_ID,
      'User prompt content',
      'System prompt content'
    )

    expect(result.bedrockResponse).toEqual(mockResponse)
    expect(result.bedrockDuration).toBeGreaterThanOrEqual(0)
    expect(mockSendMessage).toHaveBeenCalledWith('User prompt content', [
      {
        role: 'user',
        content: [{ text: 'System prompt content' }]
      },
      {
        role: 'assistant',
        content: [
          {
            text: 'I understand. I will review content according to GOV.UK standards and provide structured feedback as specified.'
          }
        ]
      }
    ])
  })

  test('Should handle response without usage data', async () => {
    const mockResponse = {
      success: true,
      content: 'Review results without usage data',
      usage: null
    }
    mockSendMessage.mockResolvedValueOnce(mockResponse)

    const result = await processor.sendBedrockRequest(
      'review-no-usage',
      TEST_USER_PROMPT,
      TEST_SYSTEM_PROMPT
    )

    expect(result.bedrockResponse).toEqual(mockResponse)
  })
})

describe('BedrockReviewProcessor - sendBedrockRequest - Failure Cases', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('Should handle blocked content by guardrails', async () => {
    const mockResponse = {
      success: false,
      blocked: true,
      reason: 'Content contains inappropriate material',
      content: ''
    }
    mockSendMessage.mockResolvedValueOnce(mockResponse)

    await expect(
      processor.sendBedrockRequest(
        'review-blocked',
        'Inappropriate content',
        TEST_SYSTEM_PROMPT
      )
    ).rejects.toThrow('Content blocked by guardrails')

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: 'review-blocked',
        blocked: true,
        reason: 'Content contains inappropriate material',
        durationMs: expect.any(Number)
      }),
      expect.stringContaining('[BEDROCK] AI review FAILED')
    )
  })

  test('Should handle Bedrock failure without blocking', async () => {
    const mockResponse = {
      success: false,
      blocked: false,
      reason: 'Service unavailable',
      content: ''
    }
    mockSendMessage.mockResolvedValueOnce(mockResponse)

    await expect(
      processor.sendBedrockRequest(
        'review-failed',
        TEST_USER_PROMPT,
        TEST_SYSTEM_PROMPT
      )
    ).rejects.toThrow('Bedrock review failed')
  })
})

describe('BedrockReviewProcessor - performBedrockReview', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  describe('performBedrockReview', () => {
    test('Should handle network timeout', async () => {
      const error = new Error('Network timeout')
      mockSendMessage.mockRejectedValueOnce(error)

      await expect(
        processor.sendBedrockRequest('review-timeout', 'prompt', 'system')
      ).rejects.toThrow('Network timeout')
    })

    test('Should perform complete review successfully', async () => {
      const textContent = 'This is the content to be reviewed.'
      const systemPrompt = 'You are a reviewer...'
      const mockBedrockResponse = {
        success: true,
        content: 'Detailed review results',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150
        }
      }

      mockGetSystemPrompt.mockResolvedValueOnce(systemPrompt)
      mockSendMessage.mockResolvedValueOnce(mockBedrockResponse)

      const result = await processor.performBedrockReview(
        TEST_REVIEW_ID,
        textContent
      )

      expect(result.bedrockResponse).toEqual(mockBedrockResponse)
      expect(result.bedrockDuration).toBeGreaterThanOrEqual(0)
    })

    test('Should include proper prompt formatting', async () => {
      const textContent = 'Sample content'
      const systemPrompt = 'System instructions'

      mockGetSystemPrompt.mockResolvedValueOnce(systemPrompt)
      mockSendMessage.mockResolvedValueOnce({
        success: true,
        content: 'Review',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      })

      await processor.performBedrockReview('review-format', textContent)

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.stringContaining('Please review the following content:'),
        expect.any(Array)
      )
    })

    test('Should handle prompt loading error', async () => {
      const error = new Error('Failed to load prompt')
      mockGetSystemPrompt.mockRejectedValueOnce(error)

      await expect(
        processor.performBedrockReview('review-error', 'content')
      ).rejects.toThrow('Failed to load prompt')
    })
    test('Should propagate Bedrock sending error', async () => {
      mockGetSystemPrompt.mockResolvedValueOnce(TEST_SYSTEM_PROMPT)
      mockSendMessage.mockRejectedValueOnce(new Error(BEDROCK_API_ERROR))

      await expect(
        processor.performBedrockReview('review-api-error', 'content')
      ).rejects.toThrow(BEDROCK_API_ERROR)
    })
    test('Should propagate Bedrock sending error', async () => {
      mockGetSystemPrompt.mockResolvedValueOnce(TEST_SYSTEM_PROMPT)
      mockSendMessage.mockRejectedValueOnce(new Error(BEDROCK_API_ERROR))

      await expect(
        processor.performBedrockReview('review-api-error', 'content')
      ).rejects.toThrow(BEDROCK_API_ERROR)
    })
  })
})

describe('BedrockReviewProcessor - parseBedrockResponseData - Success Cases', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('Should parse Bedrock response data successfully', async () => {
    const bedrockResult = {
      bedrockResponse: {
        content: '{"scores": {"clarity": 8}, "improvements": ["Fix typo"]}'
      }
    }

    const mockParsedReview = {
      scores: { clarity: 8, accuracy: 7 },
      reviewedContent: {
        issues: ['Issue 1', 'Issue 2']
      },
      improvements: ['Fix typo']
    }

    mockParseBedrockResponse.mockReturnValueOnce(mockParsedReview)

    const result = await processor.parseBedrockResponseData(
      TEST_REVIEW_ID,
      bedrockResult
    )

    expect(result.parsedReview).toEqual(mockParsedReview)
    expect(result.parseDuration).toBeGreaterThanOrEqual(0)
    expect(result.finalReviewContent).toBe(
      '{"scores": {"clarity": 8}, "improvements": ["Fix typo"]}'
    )
  })

  test('Should handle response without reviewContent fallback', async () => {
    const bedrockResult = {
      bedrockResponse: {
        content: 'Direct content without reviewContent field'
      }
    }

    const mockParsedReview = {
      scores: { quality: 9 },
      improvements: ['Improvement']
    }

    mockParseBedrockResponse.mockReturnValueOnce(mockParsedReview)

    const result = await processor.parseBedrockResponseData(
      'review-no-fallback',
      bedrockResult
    )

    expect(result.finalReviewContent).toBe(
      'Direct content without reviewContent field'
    )
  })
})

describe('BedrockReviewProcessor - parseBedrockResponseData - Error Cases', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('Should handle parse errors', async () => {
    const bedrockResult = {
      bedrockResponse: {
        content: 'Invalid JSON content'
      }
    }

    const mockParsedReview = {
      parseError: 'Failed to parse JSON',
      scores: {},
      improvements: []
    }

    mockParseBedrockResponse.mockReturnValueOnce(mockParsedReview)

    const result = await processor.parseBedrockResponseData(
      'review-parse-error',
      bedrockResult
    )

    expect(result.parsedReview.parseError).toBe('Failed to parse JSON')
  })
})

describe('BedrockReviewProcessor - parseBedrockResponseData - Edge Cases - Scores', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('Should handle response with no scores', async () => {
    const bedrockResult = {
      bedrockResponse: {
        content: 'Response without scores'
      }
    }

    const mockParsedReview = {
      scores: null,
      reviewedContent: { issues: [] },
      improvements: []
    }

    mockParseBedrockResponse.mockReturnValueOnce(mockParsedReview)

    await processor.parseBedrockResponseData('review-no-scores', bedrockResult)

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        parsedScoreCount: 0
      }),
      expect.any(String)
    )
  })

  test('Should handle response with missing reviewedContent', async () => {
    const bedrockResult = {
      bedrockResponse: {
        content: 'Minimal response'
      }
    }

    const mockParsedReview = {
      scores: { score1: 5 },
      improvements: ['Imp1', 'Imp2', 'Imp3']
    }

    mockParseBedrockResponse.mockReturnValueOnce(mockParsedReview)

    await processor.parseBedrockResponseData('review-minimal', bedrockResult)

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        parsedIssueCount: 0
      }),
      expect.any(String)
    )
  })
})

describe('BedrockReviewProcessor - parseBedrockResponseData - Edge Cases - Improvements', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('Should handle empty improvements array', async () => {
    const bedrockResult = {
      bedrockResponse: {
        content: 'Perfect content'
      }
    }

    const mockParsedReview = {
      scores: { perfection: 10 },
      reviewedContent: { issues: [] },
      improvements: []
    }

    mockParseBedrockResponse.mockReturnValueOnce(mockParsedReview)

    const result = await processor.parseBedrockResponseData(
      'review-perfect',
      bedrockResult
    )

    expect(result.parsedReview.improvements).toHaveLength(0)
  })

  test('Should handle null improvements', async () => {
    const bedrockResult = {
      bedrockResponse: {
        content: 'Response'
      }
    }

    const mockParsedReview = {
      scores: { test: 1 },
      reviewedContent: { issues: ['Issue'] },
      improvements: null
    }

    mockParseBedrockResponse.mockReturnValueOnce(mockParsedReview)

    await processor.parseBedrockResponseData(
      'review-null-improvements',
      bedrockResult
    )

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        parsedImprovementCount: 0
      }),
      expect.any(String)
    )
  })
})
