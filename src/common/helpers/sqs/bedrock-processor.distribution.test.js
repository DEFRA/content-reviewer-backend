import { describe, test, expect, beforeEach, vi } from 'vitest'

import { BedrockReviewProcessor } from './bedrock-processor.js'
import { config } from '../../../config.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const SCORE_VALUE = 3
const BELOW_MIN_DOC_LENGTH = 299
const MEDIUM_DOC_LENGTH = 600
const STANDARD_DOC_LENGTH = 900
const FIRST_THIRD_OFFSET = 50
const SECOND_THIRD_OFFSET = 350
const THIRD_THIRD_OFFSET = 650
const FOLLOW_UP_OFFSET = 700

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

vi.mock('../../../config.js', () => ({
  config: {
    get: vi.fn((key) => key === 'bedrock.enforceDistribution')
  }
}))

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
  scores: { clarity: SCORE_VALUE }
})

// ── enforceDistribution — skip conditions ────────────────────────────────────

describe('BedrockReviewProcessor - enforceDistribution - skip conditions', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('skips when distribution enforcement is disabled', async () => {
    vi.mocked(config.get).mockReturnValueOnce(false)

    const parsedReview = makeReview([FIRST_THIRD_OFFSET, SECOND_THIRD_OFFSET])
    const text = makeText(STANDARD_DOC_LENGTH)

    await processor.enforceDistribution(
      'rev-disabled',
      parsedReview,
      text,
      'sys'
    )

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 'rev-disabled' }),
      expect.stringContaining('disabled')
    )
  })

  test('skips when document is shorter than 300 chars', async () => {
    const parsedReview = makeReview([10, FIRST_THIRD_OFFSET])

    await processor.enforceDistribution(
      'rev-1',
      parsedReview,
      makeText(BELOW_MIN_DOC_LENGTH),
      'sys-prompt'
    )
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  test('skips when parsedReview has no issues', async () => {
    const parsedReview = makeReview([])
    const text = makeText(MEDIUM_DOC_LENGTH)

    await processor.enforceDistribution('rev-2', parsedReview, text, 'sys')

    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  test('skips when reviewedContent is absent', async () => {
    const parsedReview = { improvements: [], scores: {} }
    const text = makeText(MEDIUM_DOC_LENGTH)

    await processor.enforceDistribution('rev-3', parsedReview, text, 'sys')

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
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = makeReview([
      FIRST_THIRD_OFFSET,
      SECOND_THIRD_OFFSET,
      THIRD_THIRD_OFFSET
    ])

    await processor.enforceDistribution('rev-4', parsedReview, text, 'sys')

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 'rev-4' }),
      expect.stringContaining('All thirds covered')
    )
  })
})

// ── enforceDistribution — fires follow-up calls ───────────────────────────────

describe('BedrockReviewProcessor - enforceDistribution - fires follow-up calls', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('fires follow-up for one missing third and merges result', async () => {
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = makeReview([FIRST_THIRD_OFFSET, SECOND_THIRD_OFFSET])
    const issuesBefore = parsedReview.reviewedContent.issues.length

    const followUpParsed = {
      reviewedContent: {
        issues: [
          {
            ref: 1,
            start: FOLLOW_UP_OFFSET,
            end: FOLLOW_UP_OFFSET + 10,
            type: 'style',
            text: 'x'
          }
        ]
      },
      improvements: [
        {
          ref: 1,
          severity: 'low',
          category: 'Style',
          issue: 'Follow-up issue',
          why: 'Because',
          current: 'old',
          suggested: 'new'
        }
      ]
    }
    mockSendMessage.mockResolvedValueOnce({
      success: true,
      content: 'follow-up content'
    })
    mockParseBedrockResponse.mockReturnValueOnce(followUpParsed)

    await processor.enforceDistribution('rev-5', parsedReview, text, 'sys')

    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    const mergedIssues = parsedReview.reviewedContent.issues
    expect(mergedIssues).toHaveLength(issuesBefore + 1)
    expect(mergedIssues[issuesBefore].ref).toBe(issuesBefore + 1)
    expect(mergedIssues[issuesBefore].start).toBe(FOLLOW_UP_OFFSET)
    expect(parsedReview.improvements).toHaveLength(issuesBefore + 1)
    expect(parsedReview.improvements[issuesBefore].ref).toBe(issuesBefore + 1)
  })

  test('fires follow-up calls in parallel for multiple missing thirds', async () => {
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = makeReview([FIRST_THIRD_OFFSET])
    const issuesBefore = parsedReview.reviewedContent.issues.length

    const makeFollowUpParsed = (start) => ({
      reviewedContent: {
        issues: [{ ref: 1, start, end: start + 10, type: 'style', text: 'x' }]
      },
      improvements: []
    })

    mockSendMessage
      .mockResolvedValueOnce({ success: true, content: 'fu1' })
      .mockResolvedValueOnce({ success: true, content: 'fu2' })

    mockParseBedrockResponse
      .mockReturnValueOnce(makeFollowUpParsed(SECOND_THIRD_OFFSET))
      .mockReturnValueOnce(makeFollowUpParsed(FOLLOW_UP_OFFSET))

    await processor.enforceDistribution('rev-6', parsedReview, text, 'sys')

    expect(mockSendMessage).toHaveBeenCalledTimes(2)
    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore + 2)
  })
})

// ── enforceDistribution — skips when follow-up fails ─────────────────────────

describe('BedrockReviewProcessor - enforceDistribution - skips when follow-up fails', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('skips a third when follow-up Bedrock call fails', async () => {
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = makeReview([FIRST_THIRD_OFFSET, SECOND_THIRD_OFFSET])

    mockSendMessage.mockResolvedValueOnce({
      success: false,
      blocked: false,
      content: ''
    })

    const issuesBefore = parsedReview.reviewedContent.issues.length

    await processor.enforceDistribution('rev-7', parsedReview, text, 'sys')

    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 'rev-7' }),
      expect.stringContaining('failed or blocked')
    )
  })

  test('skips a third when follow-up call throws', async () => {
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = makeReview([FIRST_THIRD_OFFSET, SECOND_THIRD_OFFSET])

    mockSendMessage.mockRejectedValueOnce(new Error('Network error'))

    const issuesBefore = parsedReview.reviewedContent.issues.length

    await processor.enforceDistribution('rev-8', parsedReview, text, 'sys')

    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore)
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 'rev-8', thirdIndex: 2 }),
      expect.stringContaining('threw unexpectedly')
    )
  })

  test('skips merging when follow-up returns zero issues', async () => {
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = makeReview([FIRST_THIRD_OFFSET, SECOND_THIRD_OFFSET])

    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'empty' })
    mockParseBedrockResponse.mockReturnValueOnce({
      reviewedContent: { issues: [] },
      improvements: []
    })

    const issuesBefore = parsedReview.reviewedContent.issues.length

    await processor.enforceDistribution('rev-9', parsedReview, text, 'sys')

    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore)
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
      FIRST_THIRD_OFFSET,
      SECOND_THIRD_OFFSET,
      FOLLOW_UP_OFFSET
    ])

    mockParseBedrockResponse.mockReturnValueOnce(parsedReview)
    mockGetSystemPrompt.mockResolvedValueOnce('sys-prompt')

    const result = await processor.parseBedrockResponseData(
      'rev-dist-1',
      { bedrockResponse: { content: 'raw' } },
      makeText(STANDARD_DOC_LENGTH)
    )

    expect(mockGetSystemPrompt).toHaveBeenCalled()
    expect(result.parsedReview).toEqual(parsedReview)
  })

  test('skips enforceDistribution when originalText is empty', async () => {
    const parsedReview = makeReview([FIRST_THIRD_OFFSET])
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
      makeText(STANDARD_DOC_LENGTH)
    )

    expect(mockGetSystemPrompt).not.toHaveBeenCalled()
  })
})
