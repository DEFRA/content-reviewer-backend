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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a canonical text of exactly `length` characters. */
const makeText = (length) => 'a'.repeat(length)

/** Build a parsedReview with issues at given character offsets. */
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
  scores: { clarity: 3 }
})

// ── enforceDistribution — skip conditions ────────────────────────────────────

describe('BedrockReviewProcessor - enforceDistribution - skip conditions', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('skips when document is shorter than 300 chars', async () => {
    const parsedReview = makeReview([10, 50])
    const shortText = makeText(299)

    await processor.enforceDistribution(
      'rev-1',
      parsedReview,
      shortText,
      'sys-prompt'
    )

    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  test('skips when parsedReview has no issues', async () => {
    const parsedReview = makeReview([]) // empty issues
    const text = makeText(600)

    await processor.enforceDistribution('rev-2', parsedReview, text, 'sys')

    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  test('skips when reviewedContent is absent', async () => {
    const parsedReview = { improvements: [], scores: {} } // no reviewedContent
    const text = makeText(600)

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
    // 900-char doc → thirds are 0-299, 300-599, 600-899
    const text = makeText(900)
    const parsedReview = makeReview([50, 350, 650]) // one issue per third

    await processor.enforceDistribution('rev-4', parsedReview, text, 'sys')

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 'rev-4' }),
      expect.stringContaining('All thirds covered')
    )
  })
})

// ── enforceDistribution — missing thirds ──────────────────────────────────────

describe('BedrockReviewProcessor - enforceDistribution - missing thirds', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('fires follow-up for one missing third and merges result', async () => {
    // 900-char doc — issue only in first and middle thirds; final third empty
    const text = makeText(900)
    const parsedReview = makeReview([50, 350])

    const followUpParsed = {
      reviewedContent: {
        issues: [{ ref: 1, start: 700, end: 710, type: 'style', text: 'x' }]
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
    // Merged issue should be renumbered to ref=3 (after existing refs 1,2)
    const mergedIssues = parsedReview.reviewedContent.issues
    expect(mergedIssues).toHaveLength(3)
    expect(mergedIssues[2].ref).toBe(3)
    expect(mergedIssues[2].start).toBe(700)
    // Merged improvement should also be renumbered
    expect(parsedReview.improvements).toHaveLength(3)
    expect(parsedReview.improvements[2].ref).toBe(3)
  })

  test('fires follow-up calls in parallel for multiple missing thirds', async () => {
    // 900-char doc — only the first third has an issue
    const text = makeText(900)
    const parsedReview = makeReview([50])

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
      .mockReturnValueOnce(makeFollowUpParsed(350))
      .mockReturnValueOnce(makeFollowUpParsed(700))

    await processor.enforceDistribution('rev-6', parsedReview, text, 'sys')

    expect(mockSendMessage).toHaveBeenCalledTimes(2)
    expect(parsedReview.reviewedContent.issues).toHaveLength(3)
  })

  test('skips a third when follow-up Bedrock call fails', async () => {
    const text = makeText(900)
    const parsedReview = makeReview([50, 350]) // final third missing

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
    const text = makeText(900)
    const parsedReview = makeReview([50, 350])

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
    const text = makeText(900)
    const parsedReview = makeReview([50, 350])

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
      makeText(900),
      0,
      900,
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
      makeText(900),
      1,
      900,
      'sys'
    )

    expect(result).toBeNull()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ thirdIndex: 1, blocked: true }),
      expect.stringContaining('second third')
    )
  })

  test('logs the correct third name for index 2 (third)', async () => {
    const parsedResult = {
      reviewedContent: { issues: [] },
      improvements: []
    }
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'c' })
    mockParseBedrockResponse.mockReturnValueOnce(parsedResult)

    await processor.performFollowUpForThird(
      'rev-fu-3',
      makeText(900),
      2,
      900,
      'sys'
    )

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ thirdName: 'third', thirdIndex: 2 }),
      expect.stringContaining('third third')
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
    const originalText = makeText(900)
    const parsedReview = makeReview([50, 350, 700]) // all thirds covered

    mockParseBedrockResponse.mockReturnValueOnce(parsedReview)
    mockGetSystemPrompt.mockResolvedValueOnce('sys-prompt')

    const bedrockResult = { bedrockResponse: { content: 'raw' } }

    const result = await processor.parseBedrockResponseData(
      'rev-dist-1',
      bedrockResult,
      originalText
    )

    // enforceDistribution was called — it loaded the system prompt
    expect(mockGetSystemPrompt).toHaveBeenCalled()
    expect(result.parsedReview).toEqual(parsedReview)
  })

  test('skips enforceDistribution when originalText is empty', async () => {
    const parsedReview = makeReview([50])
    mockParseBedrockResponse.mockReturnValueOnce(parsedReview)

    const bedrockResult = { bedrockResponse: { content: 'raw' } }

    await processor.parseBedrockResponseData('rev-dist-2', bedrockResult, '')

    // getSystemPrompt is only called inside enforceDistribution path
    expect(mockGetSystemPrompt).not.toHaveBeenCalled()
  })

  test('skips enforceDistribution when reviewedContent is absent', async () => {
    const parsedReview = { scores: {}, improvements: [] }
    mockParseBedrockResponse.mockReturnValueOnce(parsedReview)

    const bedrockResult = { bedrockResponse: { content: 'raw' } }

    await processor.parseBedrockResponseData(
      'rev-dist-3',
      bedrockResult,
      makeText(900)
    )

    expect(mockGetSystemPrompt).not.toHaveBeenCalled()
  })
})

// ── mergeFollowUp — ref renumbering edge cases ────────────────────────────────

describe('BedrockReviewProcessor - mergeFollowUp ref renumbering', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('renumbers follow-up refs starting after the max existing ref', async () => {
    // 900-char doc — only first third has issues (refs 1,2,3)
    const text = makeText(900)
    const parsedReview = makeReview([10, 20, 30]) // refs 1,2,3

    const followUpParsed = {
      reviewedContent: {
        issues: [
          { ref: 1, start: 400, end: 410, type: 'style', text: 'x' },
          { ref: 2, start: 700, end: 710, type: 'style', text: 'y' }
        ]
      },
      improvements: [
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
    }

    // Two follow-up calls: middle and final thirds
    mockSendMessage
      .mockResolvedValueOnce({ success: true, content: 'fu1' })
      .mockResolvedValueOnce({ success: true, content: 'fu2' })

    // Return split results across the two calls
    mockParseBedrockResponse
      .mockReturnValueOnce({
        reviewedContent: { issues: [followUpParsed.reviewedContent.issues[0]] },
        improvements: [followUpParsed.improvements[0]]
      })
      .mockReturnValueOnce({
        reviewedContent: { issues: [followUpParsed.reviewedContent.issues[1]] },
        improvements: [followUpParsed.improvements[1]]
      })

    await processor.enforceDistribution('rev-ref-1', parsedReview, text, 'sys')

    const allIssues = parsedReview.reviewedContent.issues
    const allImprovements = parsedReview.improvements

    // Original 3 + 2 merged = 5
    expect(allIssues).toHaveLength(5)

    // First merged issue should be ref=4, second ref=5
    expect(allIssues[3].ref).toBe(4)
    expect(allIssues[4].ref).toBe(5)

    // Improvements should mirror the same renumbering
    expect(allImprovements[3].ref).toBe(4)
    expect(allImprovements[4].ref).toBe(5)
  })

  test('handles follow-up improvements with undefined ref', async () => {
    const text = makeText(900)
    const parsedReview = makeReview([50, 350]) // final third missing

    const followUpParsed = {
      reviewedContent: {
        issues: [
          { ref: undefined, start: 700, end: 710, type: 'style', text: 'z' }
        ]
      },
      improvements: [
        {
          ref: undefined,
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

    // Issue should still be merged even when ref is undefined
    expect(parsedReview.reviewedContent.issues).toHaveLength(3)
    // Improvement ref should remain undefined when it had no ref to remap
    expect(parsedReview.improvements[2].ref).toBeUndefined()
  })

  // ── L103: iss.ref ?? 0 fallback when existing issue has nullish ref ──────────

  test('uses ?? 0 fallback in maxRef reduce when existing issue has null ref (L103)', async () => {
    const text = makeText(900)
    // Existing parsedReview whose issues have ref: null — exercises iss.ref ?? 0
    const parsedReview = {
      reviewedContent: {
        issues: [{ ref: null, start: 10, end: 20, type: 'style', text: 'x' }]
      },
      improvements: [],
      scores: {}
    }

    const followUpParsed = {
      reviewedContent: {
        issues: [{ ref: 1, start: 700, end: 710, type: 'style', text: 'y' }]
      },
      improvements: []
    }

    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'fu' })
    mockParseBedrockResponse.mockReturnValueOnce(followUpParsed)

    // Middle third also missing — need issue only in first third
    // But the single existing issue (start=10) covers only the first third, so
    // second and third thirds are missing; we only care that mergeFollowUp runs
    // and hits the ?? 0 path while computing maxRef from the null-ref issue.
    // Provide a second follow-up result for the second-third call.
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

    // The follow-up issue (ref=1 in follow-up) should be renumbered to 1
    // because maxRef from existing issues is 0 (null ?? 0 = 0) + 0 + 1 = 1
    const merged = parsedReview.reviewedContent.issues
    expect(merged.length).toBeGreaterThan(1)
    expect(merged[merged.length - 1].ref).toBe(1)
  })

  // ── L117-119: refMap.get(imp.ref) ?? imp.ref fallback ────────────────────────

  test('falls back to imp.ref when improvement ref is absent from refMap (L117-119)', async () => {
    const text = makeText(900)
    const parsedReview = makeReview([50, 350]) // final third missing; existing refs 1,2

    // Follow-up issue has ref=1 → refMap will contain { 1 → 3 }
    // Follow-up improvement has ref=99 → refMap.get(99) is undefined → ?? imp.ref keeps 99
    const followUpParsed = {
      reviewedContent: {
        issues: [{ ref: 1, start: 700, end: 710, type: 'style', text: 'z' }]
      },
      improvements: [
        {
          ref: 99,
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

    // Issue merged and renumbered to 3
    expect(parsedReview.reviewedContent.issues).toHaveLength(3)
    // Improvement ref=99 not in refMap → kept as 99 via ?? imp.ref fallback
    const mergedImp = parsedReview.improvements[2]
    expect(mergedImp.ref).toBe(99)
  })
})

// ── mergeFollowUp — || [] fallback branches ───────────────────────────────────

describe('BedrockReviewProcessor - mergeFollowUp || [] fallback branches', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  // ── L94: followUp.reviewedContent?.issues || [] fallback ──────────────────────

  test('mergeFollowUp exits early via || [] when follow-up has no reviewedContent (L94)', async () => {
    const text = makeText(900)
    const parsedReview = makeReview([50, 350]) // final third missing

    // Follow-up result has no reviewedContent → followUp.reviewedContent?.issues || []
    // evaluates to [] via the || [] branch, then returns early (no merge)
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'raw' })
    mockParseBedrockResponse.mockReturnValueOnce({ scores: {} })

    const issuesBefore = parsedReview.reviewedContent.issues.length
    await processor.enforceDistribution('rev-no-rc', parsedReview, text, 'sys')

    // No issues merged because follow-up had no reviewedContent
    expect(parsedReview.reviewedContent.issues).toHaveLength(issuesBefore)
  })

  // ── L100: parsedReview.improvements || [] fallback ────────────────────────────

  test('mergeFollowUp uses || [] when parsedReview has no improvements property (L100)', async () => {
    const text = makeText(900)
    // parsedReview without improvements property → L100: parsedReview.improvements || []
    const parsedReview = {
      reviewedContent: {
        issues: [{ ref: 1, start: 10, end: 20, type: 'style', text: 'x' }]
      }
      // no improvements property
    }

    const followUpParsed = {
      reviewedContent: {
        issues: [{ ref: 1, start: 700, end: 710, type: 'style', text: 'y' }]
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

    // Issue merged; improvements built from [] (fallback) + follow-up's []
    expect(parsedReview.reviewedContent.issues).toHaveLength(2)
    expect(parsedReview.improvements).toHaveLength(0)
  })

  // ── L117: followUp.improvements || [] fallback ────────────────────────────────

  test('mergeFollowUp uses || [] when follow-up has no improvements property (L117)', async () => {
    const text = makeText(900)
    const parsedReview = makeReview([50, 350]) // final third missing

    // Follow-up has reviewedContent.issues but NO improvements property
    // → L117: (followUp.improvements || []).map(...) hits the || [] branch
    const followUpParsed = {
      reviewedContent: {
        issues: [{ ref: 1, start: 700, end: 710, type: 'style', text: 'z' }]
      }
      // no improvements property
    }

    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'fu' })
    mockParseBedrockResponse.mockReturnValueOnce(followUpParsed)

    await processor.enforceDistribution(
      'rev-no-fu-imps',
      parsedReview,
      text,
      'sys'
    )

    // Issue merged; zero improvements added (follow-up had none)
    expect(parsedReview.reviewedContent.issues).toHaveLength(3)
    expect(parsedReview.improvements).toHaveLength(2) // original 2, no new ones
  })
})

// ── performFollowUpForThird — ?? 0 fallback when reviewedContent absent ───────

describe('BedrockReviewProcessor - performFollowUpForThird - ?? 0 issueCount fallback (L345)', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('uses ?? 0 when parsed result has no reviewedContent (L345)', async () => {
    // parseBedrockResponse returns an object without reviewedContent — exercises
    // parsed.reviewedContent?.issues?.length ?? 0 falling through to ?? 0
    const parsedNoContent = { improvements: [], scores: {} }
    mockSendMessage.mockResolvedValueOnce({ success: true, content: 'raw' })
    mockParseBedrockResponse.mockReturnValueOnce(parsedNoContent)

    const result = await processor.performFollowUpForThird(
      'rev-no-content',
      makeText(900),
      2,
      900,
      'sys'
    )

    // Should still return the parsed object (not null)
    expect(result).toEqual(parsedNoContent)
    // Logger info should report issueCount of 0 (from ?? 0 fallback)
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ issueCount: 0 }),
      expect.any(String)
    )
  })
})
