import { describe, test, expect, beforeEach, vi } from 'vitest'

import { BedrockReviewProcessor } from './bedrock-processor.js'

// ── Shared mocks ──────────────────────────────────────────────────────────────

const mockLoggerInfo = vi.fn()
const mockLoggerWarn = vi.fn()
const mockLoggerError = vi.fn()
const mockGetSystemPrompt = vi.fn()
const mockSendMessage = vi.fn()
const mockParseBedrockResponse = vi.fn()

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: (...args) => mockLoggerInfo(...args),
    warn: (...args) => mockLoggerWarn(...args),
    error: (...args) => mockLoggerError(...args)
  })
}))

vi.mock('../bedrock-client.js', () => ({
  bedrockClient: { sendMessage: (...args) => mockSendMessage(...args) }
}))

vi.mock('../prompt-manager.js', () => ({
  promptManager: { getSystemPrompt: (...args) => mockGetSystemPrompt(...args) }
}))

vi.mock('../review-parser.js', () => ({
  parseBedrockResponse: (...args) => mockParseBedrockResponse(...args)
}))

// ── Test constants ────────────────────────────────────────────────────────────

// Document lengths
const SHORT_TEXT_LENGTH = 299 // one below the 300-char minimum threshold
const MEDIUM_TEXT_LENGTH = 600 // long enough to pass the minimum check
const TEXT_LENGTH = 900 // standard 3-equal-thirds document

// Issue start positions within a TEXT_LENGTH=900 document
const FIRST_THIRD_POS = 50 // well inside first third (0–299)
const FIRST_THIRD_POS_B = 10 // alternative first-third position
const MIDDLE_THIRD_POS = 350 // well inside middle third (300–599)
const FINAL_THIRD_POS = 700 // well inside final third (600–899)
const FINAL_THIRD_POS_EARLY = 650 // alternative final-third position

// Third indices (0 = first, 1 = middle, 2 = final)
const THIRD_INDEX_FIRST = 0
const THIRD_INDEX_MIDDLE = 1
const THIRD_INDEX_FINAL = 2

const CLARITY_SCORE = 3

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeText = (length) => 'a'.repeat(length)

const makeReview = (issueStarts = []) => ({
  reviewedContent: {
    issues: issueStarts.map((start, i) => ({
      ref: i + 1,
      start,
      end: start + 10,
      type: 'style',
      text: 'sample'
    }))
  },
  improvements: issueStarts.map((_, i) => ({
    ref: i + 1,
    severity: 'medium',
    category: 'Style',
    issue: 'Issue text',
    why: 'Because',
    current: 'old text',
    suggested: 'new text'
  })),
  scores: { clarity: CLARITY_SCORE }
})

// ── enforceDistribution — skip conditions ────────────────────────────────────

describe('BedrockReviewProcessor - enforceDistribution - skip conditions', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('skips when document is shorter than 300 chars', async () => {
    const parsedReview = makeReview([FIRST_THIRD_POS_B, FIRST_THIRD_POS])
    await processor.enforceDistribution(
      'rev-1',
      parsedReview,
      makeText(SHORT_TEXT_LENGTH),
      'sys-prompt'
    )
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  test('skips when parsedReview has no issues', async () => {
    await processor.enforceDistribution(
      'rev-2',
      makeReview([]),
      makeText(MEDIUM_TEXT_LENGTH),
      'sys'
    )
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  test('skips when reviewedContent is absent', async () => {
    await processor.enforceDistribution(
      'rev-3',
      { improvements: [], scores: {} },
      makeText(MEDIUM_TEXT_LENGTH),
      'sys'
    )
    expect(mockSendMessage).not.toHaveBeenCalled()
  })
})

// ── enforceDistribution — all thirds covered ─────────────────────────────────

describe('BedrockReviewProcessor - enforceDistribution - all thirds covered', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('does not fire follow-up calls when all thirds have issues', async () => {
    const parsedReview = makeReview([
      FIRST_THIRD_POS,
      MIDDLE_THIRD_POS,
      FINAL_THIRD_POS_EARLY
    ])
    await processor.enforceDistribution(
      'rev-4',
      parsedReview,
      makeText(TEXT_LENGTH),
      'sys'
    )

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 'rev-4' }),
      expect.stringContaining('All thirds covered')
    )
  })
})

// ── performFollowUpForThird — success and blocked ─────────────────────────────

describe('BedrockReviewProcessor - performFollowUpForThird - success and blocked', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('returns parsed result on success', async () => {
    const parsedResult = {
      reviewedContent: { issues: [{ ref: 1, start: FIRST_THIRD_POS_B }] },
      improvements: []
    }
    mockSendMessage.mockResolvedValueOnce({
      success: true,
      content: 'result content'
    })
    mockParseBedrockResponse.mockReturnValueOnce(parsedResult)

    const result = await processor.performFollowUpForThird(
      'rev-fu-1',
      makeText(TEXT_LENGTH),
      THIRD_INDEX_FIRST,
      TEXT_LENGTH,
      'sys'
    )

    expect(result).toEqual(parsedResult)
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringContaining('first third'),
      [],
      'sys'
    )
  })

  test('returns null when Bedrock call is blocked', async () => {
    mockSendMessage.mockResolvedValueOnce({
      success: false,
      blocked: true,
      content: ''
    })

    const result = await processor.performFollowUpForThird(
      'rev-fu-2',
      makeText(TEXT_LENGTH),
      THIRD_INDEX_MIDDLE,
      TEXT_LENGTH,
      'sys'
    )

    expect(result).toBeNull()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        thirdIndex: THIRD_INDEX_MIDDLE,
        blocked: true
      }),
      expect.stringContaining('second third')
    )
  })
})

// ── performFollowUpForThird — third name and ?? 0 fallback ───────────────────

describe('BedrockReviewProcessor - performFollowUpForThird - third name and fallback', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('logs the correct third name for index 2', async () => {
    const parsedResult = { reviewedContent: { issues: [] }, improvements: [] }
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'c' })
    mockParseBedrockResponse.mockReturnValueOnce(parsedResult)

    await processor.performFollowUpForThird(
      'rev-fu-3',
      makeText(TEXT_LENGTH),
      THIRD_INDEX_FINAL,
      TEXT_LENGTH,
      'sys'
    )

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        thirdName: 'third',
        thirdIndex: THIRD_INDEX_FINAL
      }),
      expect.stringContaining('third third')
    )
  })

  test('uses ?? 0 when parsed result has no reviewedContent', async () => {
    const parsedNoContent = { improvements: [], scores: {} }
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'raw' })
    mockParseBedrockResponse.mockReturnValueOnce(parsedNoContent)

    const result = await processor.performFollowUpForThird(
      'rev-no-content',
      makeText(TEXT_LENGTH),
      THIRD_INDEX_FINAL,
      TEXT_LENGTH,
      'sys'
    )

    expect(result).toEqual(parsedNoContent)
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ issueCount: 0 }),
      expect.any(String)
    )
  })
})

// ── parseBedrockResponseData — enforceDistribution integration ────────────────

describe('BedrockReviewProcessor - parseBedrockResponseData with distribution enforcement', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('calls enforceDistribution when originalText and reviewedContent are present', async () => {
    const parsedReview = makeReview([
      FIRST_THIRD_POS,
      MIDDLE_THIRD_POS,
      FINAL_THIRD_POS
    ])
    mockParseBedrockResponse.mockReturnValueOnce(parsedReview)
    mockGetSystemPrompt.mockResolvedValueOnce('sys-prompt')

    const result = await processor.parseBedrockResponseData(
      'rev-dist-1',
      { bedrockResponse: { content: 'raw' } },
      makeText(TEXT_LENGTH)
    )

    expect(mockGetSystemPrompt).toHaveBeenCalled()
    expect(result.parsedReview).toEqual(parsedReview)
  })

  test('skips enforceDistribution when originalText is empty', async () => {
    const parsedReview = makeReview([FIRST_THIRD_POS])
    mockParseBedrockResponse.mockReturnValueOnce(parsedReview)

    await processor.parseBedrockResponseData(
      'rev-dist-2',
      { bedrockResponse: { content: 'raw' } },
      ''
    )

    expect(mockGetSystemPrompt).not.toHaveBeenCalled()
  })

  test('skips enforceDistribution when reviewedContent is absent', async () => {
    mockParseBedrockResponse.mockReturnValueOnce({
      scores: {},
      improvements: []
    })

    await processor.parseBedrockResponseData(
      'rev-dist-3',
      { bedrockResponse: { content: 'raw' } },
      makeText(TEXT_LENGTH)
    )

    expect(mockGetSystemPrompt).not.toHaveBeenCalled()
  })
})
