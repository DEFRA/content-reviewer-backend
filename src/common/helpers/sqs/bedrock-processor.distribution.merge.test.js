import { describe, test, expect, beforeEach, vi } from 'vitest'

import { BedrockReviewProcessor } from './bedrock-processor.js'

// ── Shared mocks ──────────────────────────────────────────────────────────────

const mockLoggerWarn = vi.fn()
const mockLoggerError = vi.fn()
const mockSendMessage = vi.fn()
const mockParseBedrockResponse = vi.fn()

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: (...args) => mockLoggerWarn(...args),
    error: (...args) => mockLoggerError(...args)
  })
}))

vi.mock('../bedrock-client.js', () => ({
  bedrockClient: { sendMessage: (...args) => mockSendMessage(...args) }
}))

vi.mock('../prompt-manager.js', () => ({
  promptManager: { getSystemPrompt: vi.fn() }
}))

vi.mock('../review-parser.js', () => ({
  parseBedrockResponse: (...args) => mockParseBedrockResponse(...args)
}))

// ── Test constants ────────────────────────────────────────────────────────────

const TEXT_LENGTH = 900

// Issue start positions (thirds: 0–299, 300–599, 600–899)
const FIRST_THIRD_POS = 50
const FIRST_THIRD_POS_B = 10
const FIRST_THIRD_POS_C = 20
const FIRST_THIRD_POS_D = 30
const MIDDLE_THIRD_POS = 350
const MIDDLE_THIRD_FOLLOW_UP_POS = 400
const MIDDLE_THIRD_FOLLOW_UP_END = 410
const FINAL_THIRD_POS = 700
const FINAL_THIRD_END = 710
const THIRD_INDEX_FINAL = 2

// Expected lengths and ref numbers after merging follow-up results
const MERGED_TOTAL_THREE = 3 // two-existing + one-merged, or one-existing + two-merged
const MERGED_TOTAL_FIVE = 5 // three-existing + two-merged
const FOURTH_REF = 4 // first merged ref when three issues existed before
const FIFTH_REF = 5 // second merged ref when three issues existed before
const FOURTH_ITEM_INDEX = 3 // zero-based index of the 4th array element
const FIFTH_ITEM_INDEX = 4 // zero-based index of the 5th array element

const ORPHAN_REF = 99 // improvement ref with no matching issue ref in refMap

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
  scores: {}
})

// ── enforceDistribution — missing thirds: merge cases ────────────────────────

describe('BedrockReviewProcessor - enforceDistribution - missing thirds - merge', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('fires follow-up for one missing third and merges result', async () => {
    const text = makeText(TEXT_LENGTH)
    const parsedReview = makeReview([FIRST_THIRD_POS, MIDDLE_THIRD_POS])
    const followUpParsed = {
      reviewedContent: {
        issues: [
          {
            ref: 1,
            start: FINAL_THIRD_POS,
            end: FINAL_THIRD_END,
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
    expect(mergedIssues).toHaveLength(MERGED_TOTAL_THREE)
    expect(mergedIssues[THIRD_INDEX_FINAL].ref).toBe(MERGED_TOTAL_THREE)
    expect(mergedIssues[THIRD_INDEX_FINAL].start).toBe(FINAL_THIRD_POS)
    expect(parsedReview.improvements).toHaveLength(MERGED_TOTAL_THREE)
    expect(parsedReview.improvements[THIRD_INDEX_FINAL].ref).toBe(
      MERGED_TOTAL_THREE
    )
  })

  test('fires follow-up calls in parallel for multiple missing thirds', async () => {
    const text = makeText(TEXT_LENGTH)
    const parsedReview = makeReview([FIRST_THIRD_POS])
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
      .mockReturnValueOnce(makeFollowUpParsed(MIDDLE_THIRD_POS))
      .mockReturnValueOnce(makeFollowUpParsed(FINAL_THIRD_POS))

    await processor.enforceDistribution('rev-6', parsedReview, text, 'sys')

    expect(mockSendMessage).toHaveBeenCalledTimes(2)
    expect(parsedReview.reviewedContent.issues).toHaveLength(MERGED_TOTAL_THREE)
  })
})

// ── enforceDistribution — missing thirds: error cases ────────────────────────

describe('BedrockReviewProcessor - enforceDistribution - missing thirds - errors', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('skips a third when follow-up Bedrock call fails', async () => {
    const parsedReview = makeReview([FIRST_THIRD_POS, MIDDLE_THIRD_POS])
    mockSendMessage.mockResolvedValueOnce({
      success: false,
      blocked: false,
      content: ''
    })
    const issuesBefore = parsedReview.reviewedContent.issues.length

    await processor.enforceDistribution(
      'rev-7',
      parsedReview,
      makeText(TEXT_LENGTH),
      'sys'
    )

    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 'rev-7' }),
      expect.stringContaining('failed or blocked')
    )
  })

  test('skips a third when follow-up call throws', async () => {
    const parsedReview = makeReview([FIRST_THIRD_POS, MIDDLE_THIRD_POS])
    mockSendMessage.mockRejectedValueOnce(new Error('Network error'))
    const issuesBefore = parsedReview.reviewedContent.issues.length

    await processor.enforceDistribution(
      'rev-8',
      parsedReview,
      makeText(TEXT_LENGTH),
      'sys'
    )

    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore)
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: 'rev-8',
        thirdIndex: THIRD_INDEX_FINAL
      }),
      expect.stringContaining('threw unexpectedly')
    )
  })

  test('skips merging when follow-up returns zero issues', async () => {
    const parsedReview = makeReview([FIRST_THIRD_POS, MIDDLE_THIRD_POS])
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'empty' })
    mockParseBedrockResponse.mockReturnValueOnce({
      reviewedContent: { issues: [] },
      improvements: []
    })
    const issuesBefore = parsedReview.reviewedContent.issues.length

    await processor.enforceDistribution(
      'rev-9',
      parsedReview,
      makeText(TEXT_LENGTH),
      'sys'
    )

    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore)
  })
})

// ── mergeFollowUp — basic ref renumbering ─────────────────────────────────────

describe('BedrockReviewProcessor - mergeFollowUp - basic ref renumbering', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('renumbers follow-up refs starting after the max existing ref', async () => {
    const text = makeText(TEXT_LENGTH)
    const parsedReview = makeReview([
      FIRST_THIRD_POS_B,
      FIRST_THIRD_POS_C,
      FIRST_THIRD_POS_D
    ])
    const issueA = {
      ref: 1,
      start: MIDDLE_THIRD_FOLLOW_UP_POS,
      end: MIDDLE_THIRD_FOLLOW_UP_END,
      type: 'style',
      text: 'x'
    }
    const issueB = {
      ref: 2,
      start: FINAL_THIRD_POS,
      end: FINAL_THIRD_END,
      type: 'style',
      text: 'y'
    }
    const impA = {
      ref: 1,
      severity: 'low',
      category: 'Style',
      issue: 'I1',
      why: 'W',
      current: 'c1',
      suggested: 's1'
    }
    const impB = {
      ref: 2,
      severity: 'high',
      category: 'Style',
      issue: 'I2',
      why: 'W',
      current: 'c2',
      suggested: 's2'
    }

    mockSendMessage
      .mockResolvedValueOnce({ success: true, content: 'fu1' })
      .mockResolvedValueOnce({ success: true, content: 'fu2' })
    mockParseBedrockResponse
      .mockReturnValueOnce({
        reviewedContent: { issues: [issueA] },
        improvements: [impA]
      })
      .mockReturnValueOnce({
        reviewedContent: { issues: [issueB] },
        improvements: [impB]
      })

    await processor.enforceDistribution('rev-ref-1', parsedReview, text, 'sys')

    const allIssues = parsedReview.reviewedContent.issues
    const allImprovements = parsedReview.improvements
    expect(allIssues).toHaveLength(MERGED_TOTAL_FIVE)
    expect(allIssues[FOURTH_ITEM_INDEX].ref).toBe(FOURTH_REF)
    expect(allIssues[FIFTH_ITEM_INDEX].ref).toBe(FIFTH_REF)
    expect(allImprovements[FOURTH_ITEM_INDEX].ref).toBe(FOURTH_REF)
    expect(allImprovements[FIFTH_ITEM_INDEX].ref).toBe(FIFTH_REF)
  })
})

// ── mergeFollowUp — null ref in follow-up improvements ───────────────────────

describe('BedrockReviewProcessor - mergeFollowUp - null ref in follow-up', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('handles follow-up improvements with null ref', async () => {
    const parsedReview = makeReview([FIRST_THIRD_POS, MIDDLE_THIRD_POS])
    const followUpParsed = {
      reviewedContent: {
        issues: [
          {
            ref: null,
            start: FINAL_THIRD_POS,
            end: FINAL_THIRD_END,
            type: 'style',
            text: 'z'
          }
        ]
      },
      improvements: [
        {
          ref: null,
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

    await processor.enforceDistribution(
      'rev-ref-2',
      parsedReview,
      makeText(TEXT_LENGTH),
      'sys'
    )

    expect(parsedReview.reviewedContent.issues).toHaveLength(MERGED_TOTAL_THREE)
    expect(parsedReview.improvements[THIRD_INDEX_FINAL].ref).toBeNull()
  })
})

// ── mergeFollowUp — null ref in maxRef computation ───────────────────────────

describe('BedrockReviewProcessor - mergeFollowUp - null ref maxRef computation', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('uses ?? 0 fallback in maxRef reduce when existing issue has null ref', async () => {
    const text = makeText(TEXT_LENGTH)
    const parsedReview = {
      reviewedContent: {
        issues: [
          {
            ref: null,
            start: FIRST_THIRD_POS_B,
            end: FIRST_THIRD_POS_C,
            type: 'style',
            text: 'x'
          }
        ]
      },
      improvements: [],
      scores: {}
    }
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'fu' })
    mockParseBedrockResponse.mockReturnValueOnce({
      reviewedContent: {
        issues: [
          {
            ref: 1,
            start: FINAL_THIRD_POS,
            end: FINAL_THIRD_END,
            type: 'style',
            text: 'y'
          }
        ]
      },
      improvements: []
    })
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

    const merged = parsedReview.reviewedContent.issues
    expect(merged.length).toBeGreaterThan(1)
    // maxRef from existing issues is 0 (null ?? 0), so merged issue gets ref=1
    expect(merged.at(-1).ref).toBe(1)
  })
})

// ── mergeFollowUp — orphan ref fallback ──────────────────────────────────────

describe('BedrockReviewProcessor - mergeFollowUp - orphan ref fallback', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('falls back to imp.ref when improvement ref is absent from refMap', async () => {
    const parsedReview = makeReview([FIRST_THIRD_POS, MIDDLE_THIRD_POS])
    const followUpParsed = {
      reviewedContent: {
        issues: [
          {
            ref: 1,
            start: FINAL_THIRD_POS,
            end: FINAL_THIRD_END,
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
          issue: 'Orphan',
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
      makeText(TEXT_LENGTH),
      'sys'
    )

    expect(parsedReview.reviewedContent.issues).toHaveLength(MERGED_TOTAL_THREE)
    expect(parsedReview.improvements[THIRD_INDEX_FINAL].ref).toBe(ORPHAN_REF)
  })
})

// ── mergeFollowUp — || [] fallback: no reviewedContent ───────────────────────

describe('BedrockReviewProcessor - mergeFollowUp - no reviewedContent fallback', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('exits early when follow-up has no reviewedContent', async () => {
    const parsedReview = makeReview([FIRST_THIRD_POS, MIDDLE_THIRD_POS])
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'raw' })
    mockParseBedrockResponse.mockReturnValueOnce({ scores: {} })
    const issuesBefore = parsedReview.reviewedContent.issues.length

    await processor.enforceDistribution(
      'rev-no-rc',
      parsedReview,
      makeText(TEXT_LENGTH),
      'sys'
    )

    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore)
  })
})

// ── mergeFollowUp — || [] fallback: no improvements properties ───────────────

describe('BedrockReviewProcessor - mergeFollowUp - no improvements fallback', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('uses || [] when parsedReview has no improvements property', async () => {
    const text = makeText(TEXT_LENGTH)
    const parsedReview = {
      reviewedContent: {
        issues: [
          {
            ref: 1,
            start: FIRST_THIRD_POS_B,
            end: FIRST_THIRD_POS_C,
            type: 'style',
            text: 'x'
          }
        ]
      }
    }
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'fu' })
    mockParseBedrockResponse.mockReturnValueOnce({
      reviewedContent: {
        issues: [
          {
            ref: 1,
            start: FINAL_THIRD_POS,
            end: FINAL_THIRD_END,
            type: 'style',
            text: 'y'
          }
        ]
      },
      improvements: []
    })

    await processor.enforceDistribution(
      'rev-no-imps',
      parsedReview,
      text,
      'sys'
    )

    expect(parsedReview.reviewedContent.issues).toHaveLength(2)
    expect(parsedReview.improvements).toHaveLength(0)
  })

  test('uses || [] when follow-up has no improvements property', async () => {
    const parsedReview = makeReview([FIRST_THIRD_POS, MIDDLE_THIRD_POS])
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'fu' })
    mockParseBedrockResponse.mockReturnValueOnce({
      reviewedContent: {
        issues: [
          {
            ref: 1,
            start: FINAL_THIRD_POS,
            end: FINAL_THIRD_END,
            type: 'style',
            text: 'z'
          }
        ]
      }
    })

    await processor.enforceDistribution(
      'rev-no-fu-imps',
      parsedReview,
      makeText(TEXT_LENGTH),
      'sys'
    )

    expect(parsedReview.reviewedContent.issues).toHaveLength(MERGED_TOTAL_THREE)
    expect(parsedReview.improvements).toHaveLength(2)
  })
})
