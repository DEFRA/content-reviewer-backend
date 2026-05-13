import { describe, test, expect, beforeEach, vi } from 'vitest'

import { BedrockReviewProcessor } from './bedrock-processor.js'

// ─── Shared mocks ────────────────────────────────────────────────────────────

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  })
}))

vi.mock('../bedrock-client.js', () => ({
  bedrockClient: { sendMessage: vi.fn() }
}))

vi.mock('../prompt-manager.js', () => ({
  promptManager: { getSystemPrompt: vi.fn() }
}))

vi.mock('../review-parser.js', () => ({
  parseBedrockResponse: vi.fn()
}))

vi.mock('../../../config.js', () => ({
  config: { get: vi.fn() }
}))

// ─── Test constants ──────────────────────────────────────────────────────────

const CHUNK_SIZE_4 = 4
const CHUNK_SIZE_5 = 5
const CHUNK_SIZE_8 = 8
const CHUNK_SIZE_LARGE = 100

const OFFSET_50 = 50
const OFFSET_100 = 100
const OFFSET_200 = 200
const OFFSET_500 = 500

const REF_OFFSET_1000 = 1000
const REF_OFFSET_2000 = 2000

const ISSUE_OFFSET_START = 5
const ISSUE_OFFSET_END = 10

// ─── splitIntoChunks ─────────────────────────────────────────────────────────

describe('BedrockReviewProcessor - splitIntoChunks', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('returns single chunk when text length equals chunkSize', () => {
    const text = 'hello world'
    const result = processor.splitIntoChunks(text, text.length)
    expect(result).toEqual([{ text, startOffset: 0, index: 1 }])
  })

  test('returns single chunk when text length is less than chunkSize', () => {
    const text = 'short text'
    const result = processor.splitIntoChunks(text, CHUNK_SIZE_LARGE)
    expect(result).toEqual([{ text, startOffset: 0, index: 1 }])
  })

  test('splits text into multiple chunks respecting chunkSize', () => {
    // 15 chars total, chunkSize=5 → 3 chunks
    const text = 'aaaa bbbb cccc'
    const result = processor.splitIntoChunks(text, CHUNK_SIZE_5)
    expect(result.length).toBeGreaterThan(1)
    // All chunk texts concatenated should equal the original
    expect(result.map((c) => c.text).join('')).toBe(text)
  })

  test('snaps split point to last whitespace to avoid cutting mid-word', () => {
    // 'hello world foo' with chunkSize=8 — would cut at index 8 ('hello wo'),
    // but last space before index 8 is at index 5 → chunk1 should be 'hello '
    const text = 'hello world foo'
    const result = processor.splitIntoChunks(text, CHUNK_SIZE_8)
    expect(result[0].text).toBe('hello ')
  })

  test('assigns correct startOffset to each chunk', () => {
    const text = 'aa bb cc dd ee'
    const result = processor.splitIntoChunks(text, CHUNK_SIZE_5)
    let expectedOffset = 0
    for (const chunk of result) {
      expect(chunk.startOffset).toBe(expectedOffset)
      expectedOffset += chunk.text.length
    }
  })

  test('assigns sequential 1-based index to each chunk', () => {
    const text = 'aa bb cc dd ee'
    const result = processor.splitIntoChunks(text, CHUNK_SIZE_5)
    result.forEach((chunk, i) => {
      expect(chunk.index).toBe(i + 1)
    })
  })

  test('falls back to hard cut when no whitespace is found in the window', () => {
    // No spaces — must still split at exactly chunkSize
    const text = 'abcdefghij'
    const result = processor.splitIntoChunks(text, CHUNK_SIZE_4)
    expect(result[0].text).toBe('abcd')
    expect(result[0].startOffset).toBe(0)
    expect(result[1].text).toBe('efgh')
    expect(result[1].startOffset).toBe(CHUNK_SIZE_4)
    expect(result[2].text).toBe('ij')
    expect(result[2].startOffset).toBe(CHUNK_SIZE_4 * 2)
  })
})

// ─── adjustChunkOffsets — offset application ─────────────────────────────────

describe('BedrockReviewProcessor - adjustChunkOffsets - offset application', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('returns parsedReview unchanged when chunkStartOffset is 0', () => {
    const parsedReview = {
      scores: { 'plain english': { score: 7, note: 'ok' } },
      improvements: [{ start: 10, end: 20, suggestion: 'fix this' }],
      reviewedContent: { issues: [{ start: 5, end: 15, text: 'issue' }] }
    }
    const result = processor.adjustChunkOffsets(parsedReview, 0)
    expect(result).toBe(parsedReview) // exact same reference
  })

  test('adds chunkStartOffset to all issue start/end values', () => {
    const issueAStart = 10
    const issueAEnd = 20
    const issueBStart = 30
    const issueBEnd = 40
    const parsedReview = {
      reviewedContent: {
        issues: [
          { start: issueAStart, end: issueAEnd, text: 'issue A' },
          { start: issueBStart, end: issueBEnd, text: 'issue B' }
        ]
      },
      improvements: []
    }
    const result = processor.adjustChunkOffsets(parsedReview, OFFSET_100)
    expect(result.reviewedContent.issues[0].start).toBe(
      OFFSET_100 + issueAStart
    )
    expect(result.reviewedContent.issues[0].end).toBe(OFFSET_100 + issueAEnd)
    expect(result.reviewedContent.issues[1].start).toBe(
      OFFSET_100 + issueBStart
    )
    expect(result.reviewedContent.issues[1].end).toBe(OFFSET_100 + issueBEnd)
  })

  test('adds chunkStartOffset to all improvement start/end values', () => {
    const impAStart = 5
    const impAEnd = 15
    const impBStart = 50
    const impBEnd = 60
    const parsedReview = {
      reviewedContent: { issues: [] },
      improvements: [
        { start: impAStart, end: impAEnd, suggestion: 'improve A' },
        { start: impBStart, end: impBEnd, suggestion: 'improve B' }
      ]
    }
    const result = processor.adjustChunkOffsets(parsedReview, OFFSET_200)
    expect(result.improvements[0].start).toBe(OFFSET_200 + impAStart)
    expect(result.improvements[0].end).toBe(OFFSET_200 + impAEnd)
    expect(result.improvements[1].start).toBe(OFFSET_200 + impBStart)
    expect(result.improvements[1].end).toBe(OFFSET_200 + impBEnd)
  })

  test('handles missing start/end on improvements by treating them as 0', () => {
    const parsedReview = {
      reviewedContent: { issues: [] },
      improvements: [{ suggestion: 'no offsets' }]
    }
    const result = processor.adjustChunkOffsets(parsedReview, OFFSET_50)
    expect(result.improvements[0].start).toBe(OFFSET_50)
    expect(result.improvements[0].end).toBe(OFFSET_50)
  })
})

// ─── adjustChunkOffsets — edge cases ─────────────────────────────────────────

describe('BedrockReviewProcessor - adjustChunkOffsets - edge cases', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('handles empty issues and improvements arrays without error', () => {
    const parsedReview = {
      reviewedContent: { issues: [] },
      improvements: []
    }
    const result = processor.adjustChunkOffsets(parsedReview, OFFSET_100)
    expect(result.reviewedContent.issues).toEqual([])
    expect(result.improvements).toEqual([])
  })

  test('handles missing reviewedContent gracefully', () => {
    const impStart = 10
    const impEnd = 20
    const parsedReview = {
      improvements: [{ start: impStart, end: impEnd }]
    }
    const result = processor.adjustChunkOffsets(parsedReview, OFFSET_100)
    expect(result.reviewedContent.issues).toEqual([])
    expect(result.improvements[0].start).toBe(OFFSET_100 + impStart)
  })

  test('handles missing improvements property gracefully', () => {
    const parsedReview = {
      reviewedContent: {
        issues: [
          { start: ISSUE_OFFSET_START, end: ISSUE_OFFSET_END, text: 'issue' }
        ]
      }
    }
    const result = processor.adjustChunkOffsets(parsedReview, OFFSET_100)
    expect(result.improvements).toEqual([])
    expect(result.reviewedContent.issues[0].start).toBe(
      OFFSET_100 + ISSUE_OFFSET_START
    )
  })
})

// ─── applyChunkRefOffset — ref offsetting ────────────────────────────────────

describe('BedrockReviewProcessor - applyChunkRefOffset - ref offsetting', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('offsets ref on all improvements by refOffset', () => {
    const refA = 1
    const refB = 2
    const parsedReview = {
      improvements: [
        { ref: refA, suggestion: 'a' },
        { ref: refB, suggestion: 'b' }
      ],
      reviewedContent: { issues: [] }
    }
    const result = processor.applyChunkRefOffset(parsedReview, REF_OFFSET_1000)
    expect(result.improvements[0].ref).toBe(REF_OFFSET_1000 + refA)
    expect(result.improvements[1].ref).toBe(REF_OFFSET_1000 + refB)
  })

  test('offsets ref on all issues by refOffset', () => {
    const refA = 3
    const refB = 5
    const parsedReview = {
      improvements: [],
      reviewedContent: {
        issues: [
          { ref: refA, start: 10, end: 20 },
          { ref: refB, start: 30, end: 40 }
        ]
      }
    }
    const result = processor.applyChunkRefOffset(parsedReview, REF_OFFSET_2000)
    expect(result.reviewedContent.issues[0].ref).toBe(REF_OFFSET_2000 + refA)
    expect(result.reviewedContent.issues[1].ref).toBe(REF_OFFSET_2000 + refB)
  })

  test('leaves ref undefined when it was undefined', () => {
    const parsedReview = {
      improvements: [{ suggestion: 'no ref' }],
      reviewedContent: { issues: [{ start: 0, end: 5 }] }
    }
    const result = processor.applyChunkRefOffset(parsedReview, REF_OFFSET_1000)
    expect(result.improvements[0].ref).toBeUndefined()
    expect(result.reviewedContent.issues[0].ref).toBeUndefined()
  })
})

// ─── applyChunkRefOffset — immutability and edge cases ───────────────────────

describe('BedrockReviewProcessor - applyChunkRefOffset - immutability and edge cases', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('does not mutate original parsedReview', () => {
    const originalRef = 1
    const parsedReview = {
      improvements: [{ ref: originalRef }],
      reviewedContent: { issues: [{ ref: originalRef }] }
    }
    processor.applyChunkRefOffset(parsedReview, OFFSET_500)
    expect(parsedReview.improvements[0].ref).toBe(originalRef)
    expect(parsedReview.reviewedContent.issues[0].ref).toBe(originalRef)
  })

  test('handles empty improvements and issues without error', () => {
    const parsedReview = {
      improvements: [],
      reviewedContent: { issues: [] }
    }
    const result = processor.applyChunkRefOffset(parsedReview, REF_OFFSET_1000)
    expect(result.improvements).toEqual([])
    expect(result.reviewedContent.issues).toEqual([])
  })

  test('handles missing improvements property gracefully', () => {
    const parsedReview = {
      reviewedContent: { issues: [{ ref: 1, start: 0, end: 5 }] }
    }
    const result = processor.applyChunkRefOffset(parsedReview, REF_OFFSET_1000)
    expect(result.improvements).toEqual([])
    expect(result.reviewedContent.issues[0].ref).toBe(REF_OFFSET_1000 + 1)
  })

  test('handles missing reviewedContent property gracefully', () => {
    const parsedReview = {
      improvements: [{ ref: 2, start: 0, end: 5 }]
    }
    const result = processor.applyChunkRefOffset(parsedReview, REF_OFFSET_1000)
    expect(result.reviewedContent.issues).toEqual([])
    expect(result.improvements[0].ref).toBe(REF_OFFSET_1000 + 2)
  })
})
