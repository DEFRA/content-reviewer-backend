import { describe, test, expect, beforeEach, vi } from 'vitest'

import { BedrockReviewProcessor } from './bedrock-processor.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const SCORE_VALUE = 3
const STANDARD_DOC_LENGTH = 900
const FIRST_THIRD_OFFSET = 50
const SECOND_THIRD_OFFSET = 350
const FOLLOW_UP_OFFSET = 700
const FIRST_THIRD_OFFSET_B = 20
const FIRST_THIRD_OFFSET_C = 30
const MIDDLE_THIRD_OFFSET = 400
const ORPHAN_REF = 99

// ── Shared mocks ──────────────────────────────────────────────────────────────

const mockLoggerInfo = vi.fn()
const mockLoggerWarn = vi.fn()
const mockLoggerError = vi.fn()
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
  bedrockClient: {
    sendMessage: (...args) => mockSendMessage(...args)
  }
}))

vi.mock('../prompt-manager.js', () => ({
  promptManager: {
    getSystemPrompt: vi.fn()
  }
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

// ── performFollowUpForThird ───────────────────────────────────────────────────

describe('BedrockReviewProcessor - performFollowUpForThird', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('returns parsed result on success', async () => {
    const parsedResult = {
      reviewedContent: { issues: [{ ref: 1, start: 10 }] },
      improvements: []
    }
    mockSendMessage.mockResolvedValueOnce({
      success: true,
      content: 'result content'
    })
    mockParseBedrockResponse.mockReturnValueOnce(parsedResult)

    const result = await processor.performFollowUpForThird(
      'rev-fu-1',
      makeText(STANDARD_DOC_LENGTH),
      0,
      STANDARD_DOC_LENGTH,
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
      makeText(STANDARD_DOC_LENGTH),
      1,
      STANDARD_DOC_LENGTH,
      'sys'
    )

    expect(result).toBeNull()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ thirdIndex: 1, blocked: true }),
      expect.stringContaining('second third')
    )
  })

  test('logs the correct third name for index 2 (third)', async () => {
    const parsedResult = { reviewedContent: { issues: [] }, improvements: [] }
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'c' })
    mockParseBedrockResponse.mockReturnValueOnce(parsedResult)

    await processor.performFollowUpForThird(
      'rev-fu-3',
      makeText(STANDARD_DOC_LENGTH),
      2,
      STANDARD_DOC_LENGTH,
      'sys'
    )

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ thirdName: 'third', thirdIndex: 2 }),
      expect.stringContaining('third third')
    )
  })
})

// ── performFollowUpForThird — ?? 0 issueCount fallback ───────────────────────

describe('BedrockReviewProcessor - performFollowUpForThird - ?? 0 issueCount fallback', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('uses ?? 0 when parsed result has no reviewedContent', async () => {
    const parsedNoContent = { improvements: [], scores: {} }
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'raw' })
    mockParseBedrockResponse.mockReturnValueOnce(parsedNoContent)

    const result = await processor.performFollowUpForThird(
      'rev-no-content',
      makeText(STANDARD_DOC_LENGTH),
      2,
      STANDARD_DOC_LENGTH,
      'sys'
    )

    expect(result).toEqual(parsedNoContent)
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ issueCount: 0 }),
      expect.any(String)
    )
  })
})

// ── mergeFollowUp — ref renumbering ──────────────────────────────────────────

describe('BedrockReviewProcessor - mergeFollowUp - ref renumbering', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('renumbers follow-up refs starting after the max existing ref', async () => {
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = makeReview([
      10,
      FIRST_THIRD_OFFSET_B,
      FIRST_THIRD_OFFSET_C
    ])
    const issuesBefore = parsedReview.reviewedContent.issues.length

    const followUpIssues = [
      {
        ref: 1,
        start: MIDDLE_THIRD_OFFSET,
        end: MIDDLE_THIRD_OFFSET + 10,
        type: 'style',
        text: 'x'
      },
      {
        ref: 2,
        start: FOLLOW_UP_OFFSET,
        end: FOLLOW_UP_OFFSET + 10,
        type: 'style',
        text: 'y'
      }
    ]
    const followUpImprovements = [
      {
        ref: 1,
        severity: 'low',
        category: 'Style',
        issue: 'I1',
        why: 'W',
        current: 'c1',
        suggested: 's1'
      },
      {
        ref: 2,
        severity: 'high',
        category: 'Style',
        issue: 'I2',
        why: 'W',
        current: 'c2',
        suggested: 's2'
      }
    ]

    mockSendMessage
      .mockResolvedValueOnce({ success: true, content: 'fu1' })
      .mockResolvedValueOnce({ success: true, content: 'fu2' })

    mockParseBedrockResponse
      .mockReturnValueOnce({
        reviewedContent: { issues: [followUpIssues[0]] },
        improvements: [followUpImprovements[0]]
      })
      .mockReturnValueOnce({
        reviewedContent: { issues: [followUpIssues[1]] },
        improvements: [followUpImprovements[1]]
      })

    await processor.enforceDistribution('rev-ref-1', parsedReview, text, 'sys')

    const allIssues = parsedReview.reviewedContent.issues
    const allImprovements = parsedReview.improvements

    expect(allIssues).toHaveLength(issuesBefore + 2)
    expect(allIssues[issuesBefore].ref).toBe(issuesBefore + 1)
    expect(allIssues[issuesBefore + 1].ref).toBe(issuesBefore + 2)
    expect(allImprovements[issuesBefore].ref).toBe(issuesBefore + 1)
    expect(allImprovements[issuesBefore + 1].ref).toBe(issuesBefore + 2)
  })
})

// ── mergeFollowUp — no ref property ──────────────────────────────────────────

describe('BedrockReviewProcessor - mergeFollowUp - no ref property', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('handles follow-up improvements with no ref property', async () => {
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = makeReview([FIRST_THIRD_OFFSET, SECOND_THIRD_OFFSET])
    const issuesBefore = parsedReview.reviewedContent.issues.length

    // issue and improvement deliberately have no ref property
    const followUpParsed = {
      reviewedContent: {
        issues: [
          {
            start: FOLLOW_UP_OFFSET,
            end: FOLLOW_UP_OFFSET + 10,
            type: 'style',
            text: 'z'
          }
        ]
      },
      improvements: [
        {
          severity: 'medium',
          category: 'Tone',
          issue: 'No ref',
          why: 'W',
          current: 'a',
          suggested: 'b'
        }
      ]
    }

    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'fu' })
    mockParseBedrockResponse.mockReturnValueOnce(followUpParsed)

    await processor.enforceDistribution('rev-ref-2', parsedReview, text, 'sys')

    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore + 1)
    expect(parsedReview.improvements[issuesBefore].ref).toBeUndefined()
  })
})

// ── mergeFollowUp — orphan ref fallback ───────────────────────────────────────

describe('BedrockReviewProcessor - mergeFollowUp - orphan ref fallback', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('falls back to imp.ref when improvement ref is absent from refMap', async () => {
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = makeReview([FIRST_THIRD_OFFSET, SECOND_THIRD_OFFSET])
    const issuesBefore = parsedReview.reviewedContent.issues.length

    // issue ref=1 → refMap: {1 → issuesBefore+1}
    // improvement ref=ORPHAN_REF has no matching issue ref → kept via ?? imp.ref
    const followUpParsed = {
      reviewedContent: {
        issues: [
          {
            ref: 1,
            start: FOLLOW_UP_OFFSET,
            end: FOLLOW_UP_OFFSET + 10,
            type: 'style',
            text: 'z'
          }
        ]
      },
      improvements: [
        {
          ref: ORPHAN_REF,
          severity: 'low',
          category: 'Clarity',
          issue: 'Orphan improvement',
          why: 'W',
          current: 'old',
          suggested: 'new'
        }
      ]
    }

    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'fu' })
    mockParseBedrockResponse.mockReturnValueOnce(followUpParsed)

    await processor.enforceDistribution(
      'rev-orphan-ref',
      parsedReview,
      text,
      'sys'
    )

    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore + 1)
    expect(parsedReview.improvements[issuesBefore].ref).toBe(ORPHAN_REF)
  })
})

// ── mergeFollowUp — null ref ?? 0 fallback ────────────────────────────────────

describe('BedrockReviewProcessor - mergeFollowUp - null ref ?? 0 fallback', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('uses ?? 0 in maxRef reduce when existing issue has null ref', async () => {
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = {
      reviewedContent: {
        issues: [{ ref: null, start: 0, end: 10, type: 'style', text: 'x' }]
      },
      improvements: [],
      scores: {}
    }

    const followUpParsed = {
      reviewedContent: {
        issues: [
          {
            ref: 1,
            start: FOLLOW_UP_OFFSET,
            end: FOLLOW_UP_OFFSET + 10,
            type: 'style',
            text: 'y'
          }
        ]
      },
      improvements: []
    }

    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'fu' })
    mockParseBedrockResponse.mockReturnValueOnce(followUpParsed)

    // Middle third also missing — provide empty result for that follow-up call
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'fu2' })
    mockParseBedrockResponse.mockReturnValueOnce({
      reviewedContent: { issues: [] },
      improvements: []
    })

    await processor.enforceDistribution(
      'rev-null-ref',
      parsedReview,
      text,
      'sys'
    )

    // maxRef from existing issues is 0 (null ?? 0 = 0); follow-up ref=1 → renumbered to 1
    const merged = parsedReview.reviewedContent.issues
    expect(merged.length).toBeGreaterThan(1)
    expect(merged.at(-1).ref).toBe(1)
  })
})

// ── mergeFollowUp — no reviewedContent in follow-up ──────────────────────────

describe('BedrockReviewProcessor - mergeFollowUp - no reviewedContent in follow-up', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('exits early via || [] when follow-up has no reviewedContent', async () => {
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = makeReview([FIRST_THIRD_OFFSET, SECOND_THIRD_OFFSET])
    const issuesBefore = parsedReview.reviewedContent.issues.length

    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'raw' })
    mockParseBedrockResponse.mockReturnValueOnce({ scores: {} })

    await processor.enforceDistribution('rev-no-rc', parsedReview, text, 'sys')

    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore)
  })
})

// ── mergeFollowUp — no improvements on parsedReview ──────────────────────────

describe('BedrockReviewProcessor - mergeFollowUp - no improvements on parsedReview', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('uses || [] when parsedReview has no improvements property', async () => {
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = {
      reviewedContent: {
        issues: [{ ref: 1, start: 10, end: 10 + 10, type: 'style', text: 'x' }]
      }
      // no improvements property
    }

    const followUpParsed = {
      reviewedContent: {
        issues: [
          {
            ref: 1,
            start: FOLLOW_UP_OFFSET,
            end: FOLLOW_UP_OFFSET + 10,
            type: 'style',
            text: 'y'
          }
        ]
      },
      improvements: []
    }

    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'fu' })
    mockParseBedrockResponse.mockReturnValueOnce(followUpParsed)

    await processor.enforceDistribution(
      'rev-no-imps',
      parsedReview,
      text,
      'sys'
    )

    expect(parsedReview.reviewedContent.issues).toHaveLength(2)
    expect(parsedReview.improvements).toHaveLength(0)
  })
})

// ── mergeFollowUp — no improvements on follow-up ─────────────────────────────

describe('BedrockReviewProcessor - mergeFollowUp - no improvements on follow-up', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('uses || [] when follow-up has no improvements property', async () => {
    const text = makeText(STANDARD_DOC_LENGTH)
    const parsedReview = makeReview([FIRST_THIRD_OFFSET, SECOND_THIRD_OFFSET])
    const issuesBefore = parsedReview.reviewedContent.issues.length

    // follow-up has reviewedContent.issues but NO improvements property
    const followUpParsed = {
      reviewedContent: {
        issues: [
          {
            ref: 1,
            start: FOLLOW_UP_OFFSET,
            end: FOLLOW_UP_OFFSET + 10,
            type: 'style',
            text: 'z'
          }
        ]
      }
    }

    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'fu' })
    mockParseBedrockResponse.mockReturnValueOnce(followUpParsed)

    await processor.enforceDistribution(
      'rev-no-fu-imps',
      parsedReview,
      text,
      'sys'
    )

    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore + 1)
    expect(parsedReview.improvements).toHaveLength(issuesBefore)
  })
})
