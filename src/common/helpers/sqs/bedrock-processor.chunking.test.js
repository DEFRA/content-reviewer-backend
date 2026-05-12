import { describe, test, expect, beforeEach, vi } from 'vitest'

import { BedrockReviewProcessor } from './bedrock-processor.js'

// ─── Shared mock fns ────────────────────────────────────────────────────────

const mockLoggerInfo = vi.fn()
const mockLoggerError = vi.fn()
const mockGetSystemPrompt = vi.fn()
const mockSendMessage = vi.fn()
const mockParseBedrockResponse = vi.fn()
const mockConfigGet = vi.fn()

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: (...args) => mockLoggerInfo(...args),
    error: (...args) => mockLoggerError(...args),
    warn: vi.fn()
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

vi.mock('../../../config.js', () => ({
  config: {
    get: (...args) => mockConfigGet(...args)
  }
}))

// Default config values used by the chunking code
const DEFAULT_CHUNK_SIZE = 25_000
const DEFAULT_MAX_TOKENS_PER_CHUNK = 4_096

function setupDefaultConfig() {
  mockConfigGet.mockImplementation((key) => {
    if (key === 'bedrock.chunkSizeChars') return DEFAULT_CHUNK_SIZE
    if (key === 'bedrock.maxTokensPerChunk') return DEFAULT_MAX_TOKENS_PER_CHUNK
    return undefined
  })
}

// ─── splitIntoChunks ────────────────────────────────────────────────────────

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
    const result = processor.splitIntoChunks(text, 100)
    expect(result).toEqual([{ text, startOffset: 0, index: 1 }])
  })

  test('splits text into multiple chunks respecting chunkSize', () => {
    // 15 chars total, chunkSize=5 → 3 chunks
    const text = 'aaaa bbbb cccc'
    const result = processor.splitIntoChunks(text, 5)
    expect(result.length).toBeGreaterThan(1)
    // All chunk texts concatenated should equal the original
    expect(result.map((c) => c.text).join('')).toBe(text)
  })

  test('snaps split point to last whitespace to avoid cutting mid-word', () => {
    // 'hello world foo' with chunkSize=8 — would cut at index 8 ('hello wo'),
    // but last space before index 8 is at index 5 → chunk1 should be 'hello '
    const text = 'hello world foo'
    const result = processor.splitIntoChunks(text, 8)
    // First chunk must end at a space boundary (not mid-word)
    const firstChunk = result[0].text
    expect(firstChunk).toBe('hello ')
  })

  test('assigns correct startOffset to each chunk', () => {
    const text = 'aa bb cc dd ee'
    const result = processor.splitIntoChunks(text, 5)
    let expectedOffset = 0
    for (const chunk of result) {
      expect(chunk.startOffset).toBe(expectedOffset)
      expectedOffset += chunk.text.length
    }
  })

  test('assigns sequential 1-based index to each chunk', () => {
    const text = 'aa bb cc dd ee'
    const result = processor.splitIntoChunks(text, 5)
    result.forEach((chunk, i) => {
      expect(chunk.index).toBe(i + 1)
    })
  })

  test('falls back to hard cut when no whitespace is found in the window', () => {
    // No spaces — must still split at exactly chunkSize
    const text = 'abcdefghij'
    const result = processor.splitIntoChunks(text, 4)
    expect(result[0].text).toBe('abcd')
    expect(result[0].startOffset).toBe(0)
    expect(result[1].text).toBe('efgh')
    expect(result[1].startOffset).toBe(4)
    expect(result[2].text).toBe('ij')
    expect(result[2].startOffset).toBe(8)
  })
})

// ─── adjustChunkOffsets ─────────────────────────────────────────────────────

describe('BedrockReviewProcessor - adjustChunkOffsets', () => {
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
    const parsedReview = {
      reviewedContent: {
        issues: [
          { start: 10, end: 20, text: 'issue A' },
          { start: 30, end: 40, text: 'issue B' }
        ]
      },
      improvements: []
    }
    const result = processor.adjustChunkOffsets(parsedReview, 100)
    expect(result.reviewedContent.issues[0].start).toBe(110)
    expect(result.reviewedContent.issues[0].end).toBe(120)
    expect(result.reviewedContent.issues[1].start).toBe(130)
    expect(result.reviewedContent.issues[1].end).toBe(140)
  })

  test('adds chunkStartOffset to all improvement start/end values', () => {
    const parsedReview = {
      reviewedContent: { issues: [] },
      improvements: [
        { start: 5, end: 15, suggestion: 'improve A' },
        { start: 50, end: 60, suggestion: 'improve B' }
      ]
    }
    const result = processor.adjustChunkOffsets(parsedReview, 200)
    expect(result.improvements[0].start).toBe(205)
    expect(result.improvements[0].end).toBe(215)
    expect(result.improvements[1].start).toBe(250)
    expect(result.improvements[1].end).toBe(260)
  })

  test('handles missing start/end on improvements by treating them as 0', () => {
    const parsedReview = {
      reviewedContent: { issues: [] },
      improvements: [{ suggestion: 'no offsets' }]
    }
    const result = processor.adjustChunkOffsets(parsedReview, 50)
    expect(result.improvements[0].start).toBe(50)
    expect(result.improvements[0].end).toBe(50)
  })

  test('handles empty issues and improvements arrays without error', () => {
    const parsedReview = {
      reviewedContent: { issues: [] },
      improvements: []
    }
    const result = processor.adjustChunkOffsets(parsedReview, 100)
    expect(result.reviewedContent.issues).toEqual([])
    expect(result.improvements).toEqual([])
  })

  test('handles missing reviewedContent gracefully', () => {
    const parsedReview = {
      improvements: [{ start: 10, end: 20 }]
    }
    const result = processor.adjustChunkOffsets(parsedReview, 100)
    expect(result.reviewedContent.issues).toEqual([])
    expect(result.improvements[0].start).toBe(110)
  })
})

// ─── collateChunkResults ────────────────────────────────────────────────────

describe('BedrockReviewProcessor - collateChunkResults', () => {
  let processor
  const CANONICAL_TEXT = 'full document text'

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  function makeChunkResult({
    plainEnglishScore,
    plainEnglishNote,
    govUkScore,
    govUkNote,
    improvements = [],
    issues = [],
    inputTokens = 100,
    outputTokens = 50,
    totalTokens = 150,
    bedrockDuration = 1000
  }) {
    return {
      chunk: { index: 1, startOffset: 0 },
      bedrockResult: {
        bedrockResponse: {
          usage: { inputTokens, outputTokens, totalTokens },
          stopReason: 'end_turn'
        },
        bedrockDuration
      },
      parsedReview: {
        scores: {
          'plain english': { score: plainEnglishScore, note: plainEnglishNote },
          'gov.uk style compliance': { score: govUkScore, note: govUkNote }
        },
        improvements,
        reviewedContent: { issues }
      },
      parseDuration: 10,
      finalReviewContent: 'raw'
    }
  }

  test('averages scores across all chunks', () => {
    const results = [
      makeChunkResult({
        plainEnglishScore: 6,
        plainEnglishNote: 'needs work',
        govUkScore: 8,
        govUkNote: 'good'
      }),
      makeChunkResult({
        plainEnglishScore: 8,
        plainEnglishNote: 'ok',
        govUkScore: 6,
        govUkNote: 'improve'
      })
    ]
    const { combinedParsedReview } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    expect(combinedParsedReview.scores['plain english'].score).toBe(7) // (6+8)/2
    expect(combinedParsedReview.scores['gov.uk style compliance'].score).toBe(7) // (8+6)/2
  })

  test('uses note from the lowest-scoring chunk', () => {
    const results = [
      makeChunkResult({
        plainEnglishScore: 4,
        plainEnglishNote: 'poor',
        govUkScore: 9,
        govUkNote: 'great'
      }),
      makeChunkResult({
        plainEnglishScore: 8,
        plainEnglishNote: 'fine',
        govUkScore: 7,
        govUkNote: 'ok'
      })
    ]
    const { combinedParsedReview } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    // plain english: lowest is score 4, note 'poor'
    expect(combinedParsedReview.scores['plain english'].note).toBe('poor')
    // gov.uk: lowest is score 7, note 'ok'
    expect(combinedParsedReview.scores['gov.uk style compliance'].note).toBe(
      'ok'
    )
  })

  test('sums token usage across all chunks', () => {
    const results = [
      makeChunkResult({
        plainEnglishScore: 7,
        plainEnglishNote: 'a',
        govUkScore: 7,
        govUkNote: 'a',
        inputTokens: 300,
        outputTokens: 100,
        totalTokens: 400
      }),
      makeChunkResult({
        plainEnglishScore: 7,
        plainEnglishNote: 'a',
        govUkScore: 7,
        govUkNote: 'a',
        inputTokens: 200,
        outputTokens: 80,
        totalTokens: 280
      })
    ]
    const { combinedBedrockResult } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    expect(combinedBedrockResult.bedrockResponse.usage.inputTokens).toBe(500)
    expect(combinedBedrockResult.bedrockResponse.usage.outputTokens).toBe(180)
    expect(combinedBedrockResult.bedrockResponse.usage.totalTokens).toBe(680)
  })

  test('takes the max bedrockDuration across chunks (wall-clock time)', () => {
    const results = [
      makeChunkResult({
        plainEnglishScore: 7,
        plainEnglishNote: 'a',
        govUkScore: 7,
        govUkNote: 'a',
        bedrockDuration: 5000
      }),
      makeChunkResult({
        plainEnglishScore: 7,
        plainEnglishNote: 'a',
        govUkScore: 7,
        govUkNote: 'a',
        bedrockDuration: 8000
      }),
      makeChunkResult({
        plainEnglishScore: 7,
        plainEnglishNote: 'a',
        govUkScore: 7,
        govUkNote: 'a',
        bedrockDuration: 3000
      })
    ]
    const { combinedBedrockResult } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    expect(combinedBedrockResult.bedrockDuration).toBe(8000)
  })

  test('merges improvements from all chunks', () => {
    const imp1 = { start: 10, end: 20, suggestion: 'fix A' }
    const imp2 = { start: 500, end: 510, suggestion: 'fix B' }
    const results = [
      makeChunkResult({
        plainEnglishScore: 7,
        plainEnglishNote: 'a',
        govUkScore: 7,
        govUkNote: 'a',
        improvements: [imp1]
      }),
      makeChunkResult({
        plainEnglishScore: 7,
        plainEnglishNote: 'a',
        govUkScore: 7,
        govUkNote: 'a',
        improvements: [imp2]
      })
    ]
    const { combinedParsedReview } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    expect(combinedParsedReview.improvements).toHaveLength(2)
    expect(combinedParsedReview.improvements).toContain(imp1)
    expect(combinedParsedReview.improvements).toContain(imp2)
  })

  test('merges issues from all chunks', () => {
    const issue1 = { start: 5, end: 10, text: 'issue A' }
    const issue2 = { start: 600, end: 620, text: 'issue B' }
    const results = [
      makeChunkResult({
        plainEnglishScore: 7,
        plainEnglishNote: 'a',
        govUkScore: 7,
        govUkNote: 'a',
        issues: [issue1]
      }),
      makeChunkResult({
        plainEnglishScore: 7,
        plainEnglishNote: 'a',
        govUkScore: 7,
        govUkNote: 'a',
        issues: [issue2]
      })
    ]
    const { combinedParsedReview } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    expect(combinedParsedReview.reviewedContent.issues).toHaveLength(2)
  })

  test('uses canonicalText as plainText in combined reviewedContent', () => {
    const results = [
      makeChunkResult({
        plainEnglishScore: 7,
        plainEnglishNote: 'a',
        govUkScore: 7,
        govUkNote: 'a'
      })
    ]
    const { combinedParsedReview } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    expect(combinedParsedReview.reviewedContent.plainText).toBe(CANONICAL_TEXT)
  })

  test('skips score keys where no chunk has data', () => {
    const results = [
      {
        chunk: { index: 1, startOffset: 0 },
        bedrockResult: {
          bedrockResponse: { usage: {}, stopReason: 'end_turn' },
          bedrockDuration: 100
        },
        parsedReview: {
          scores: {},
          improvements: [],
          reviewedContent: { issues: [] }
        },
        parseDuration: 5,
        finalReviewContent: ''
      }
    ]
    const { combinedParsedReview } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    expect(combinedParsedReview.scores['plain english']).toBeUndefined()
    expect(
      combinedParsedReview.scores['gov.uk style compliance']
    ).toBeUndefined()
  })
})

// ─── processChunk ───────────────────────────────────────────────────────────

describe('BedrockReviewProcessor - processChunk', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultConfig()
    processor = new BedrockReviewProcessor()
  })

  test('calls performBedrockReview with chunkReviewId and maxTokensPerChunk', async () => {
    const chunk = { text: 'chunk text', startOffset: 0, index: 2 }
    const bedrockResult = {
      bedrockResponse: { content: 'response', usage: {} },
      bedrockDuration: 500
    }
    const parsedResult = {
      parsedReview: {
        scores: {},
        improvements: [],
        reviewedContent: { issues: [] }
      },
      parseDuration: 10,
      finalReviewContent: 'response'
    }

    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parsedResult)

    await processor.processChunk('review-abc', chunk)

    expect(processor.performBedrockReview).toHaveBeenCalledWith(
      'review-abc_chunk_2',
      'chunk text',
      DEFAULT_MAX_TOKENS_PER_CHUNK
    )
  })

  test('calls parseBedrockResponseData with chunkReviewId and chunk text', async () => {
    const chunk = { text: 'some chunk', startOffset: 500, index: 3 }
    const bedrockResult = {
      bedrockResponse: { content: 'parsed', usage: {} },
      bedrockDuration: 300
    }
    const parsedResult = {
      parsedReview: {
        scores: {},
        improvements: [],
        reviewedContent: { issues: [] }
      },
      parseDuration: 5,
      finalReviewContent: 'parsed'
    }

    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parsedResult)

    await processor.processChunk('review-xyz', chunk)

    expect(processor.parseBedrockResponseData).toHaveBeenCalledWith(
      'review-xyz_chunk_3',
      bedrockResult,
      'some chunk'
    )
  })

  test('adjusts offsets by chunkStartOffset and returns combined result', async () => {
    const chunk = { text: 'chunk content', startOffset: 1000, index: 1 }
    const bedrockResult = {
      bedrockResponse: { content: 'review', usage: { inputTokens: 50 } },
      bedrockDuration: 800
    }
    const parsedResult = {
      parsedReview: {
        scores: {},
        improvements: [{ start: 5, end: 10, suggestion: 'fix' }],
        reviewedContent: { issues: [{ start: 2, end: 7, text: 'issue' }] }
      },
      parseDuration: 15,
      finalReviewContent: 'review'
    }

    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parsedResult)

    const result = await processor.processChunk('r1', chunk)

    // Offsets must be adjusted by chunkStartOffset (1000)
    expect(result.parsedReview.improvements[0].start).toBe(1005)
    expect(result.parsedReview.improvements[0].end).toBe(1010)
    expect(result.parsedReview.reviewedContent.issues[0].start).toBe(1002)
    expect(result.parsedReview.reviewedContent.issues[0].end).toBe(1007)
  })

  test('propagates error from performBedrockReview', async () => {
    const chunk = { text: 'text', startOffset: 0, index: 1 }
    processor.performBedrockReview = vi
      .fn()
      .mockRejectedValue(new Error('Bedrock timeout'))

    await expect(processor.processChunk('r-fail', chunk)).rejects.toThrow(
      'Bedrock timeout'
    )
  })

  test('returns chunk, bedrockResult, parsedReview, parseDuration, finalReviewContent', async () => {
    const chunk = { text: 'hello', startOffset: 0, index: 1 }
    const bedrockResult = {
      bedrockResponse: { content: 'ok', usage: {} },
      bedrockDuration: 200
    }
    const parsedResult = {
      parsedReview: {
        scores: {},
        improvements: [],
        reviewedContent: { issues: [] }
      },
      parseDuration: 8,
      finalReviewContent: 'ok'
    }

    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parsedResult)

    const result = await processor.processChunk('r', chunk)

    expect(result.chunk).toBe(chunk)
    expect(result.bedrockResult).toBe(bedrockResult)
    expect(result.parseDuration).toBe(8)
    expect(result.finalReviewContent).toBe('ok')
  })
})

// ─── performChunkedReview ───────────────────────────────────────────────────

describe('BedrockReviewProcessor - performChunkedReview - below threshold (single call)', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultConfig()
    processor = new BedrockReviewProcessor()
  })

  test('calls performBedrockReview directly without chunking for short text', async () => {
    const shortText = 'x'.repeat(100) // well below 25,000
    const bedrockResult = {
      bedrockResponse: {
        content: 'ok',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      },
      bedrockDuration: 300
    }
    const parseResult = {
      parsedReview: { scores: {}, improvements: [] },
      parseDuration: 5,
      finalReviewContent: 'ok'
    }

    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parseResult)

    const result = await processor.performChunkedReview('r1', shortText)

    expect(processor.performBedrockReview).toHaveBeenCalledOnce()
    expect(processor.performBedrockReview).toHaveBeenCalledWith('r1', shortText)
    expect(result.parsedReview).toBe(parseResult.parsedReview)
    expect(result.bedrockResult).toBe(bedrockResult)
  })

  test('returns single-element chunks array for below-threshold text', async () => {
    const shortText = 'short'
    const bedrockResult = {
      bedrockResponse: { content: 'ok', usage: {} },
      bedrockDuration: 100
    }
    const parseResult = {
      parsedReview: {},
      parseDuration: 2,
      finalReviewContent: 'ok'
    }

    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parseResult)

    const result = await processor.performChunkedReview('r', shortText)

    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0]).toEqual({
      index: 1,
      startOffset: 0,
      rawResponse: 'ok'
    })
  })

  test('does NOT call processChunk for below-threshold text', async () => {
    const shortText = 'brief'
    const bedrockResult = {
      bedrockResponse: { content: 'ok', usage: {} },
      bedrockDuration: 50
    }
    const parseResult = {
      parsedReview: {},
      parseDuration: 1,
      finalReviewContent: 'ok'
    }

    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parseResult)
    processor.processChunk = vi.fn()

    await processor.performChunkedReview('r', shortText)

    expect(processor.processChunk).not.toHaveBeenCalled()
  })
})

describe('BedrockReviewProcessor - performChunkedReview - above threshold (multi-chunk)', () => {
  let processor

  const SMALL_CHUNK_SIZE = 10 // force chunking even with short text

  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigGet.mockImplementation((key) => {
      if (key === 'bedrock.chunkSizeChars') return SMALL_CHUNK_SIZE
      if (key === 'bedrock.maxTokensPerChunk')
        return DEFAULT_MAX_TOKENS_PER_CHUNK
      return undefined
    })
    processor = new BedrockReviewProcessor()
  })

  function makeProcessChunkResult(
    index,
    startOffset,
    finalReviewContent = 'raw'
  ) {
    return {
      chunk: { index, startOffset, text: 'chunk' },
      bedrockResult: {
        bedrockResponse: {
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          stopReason: 'end_turn'
        },
        bedrockDuration: 1000
      },
      parsedReview: {
        scores: {
          'plain english': { score: 7, note: 'ok' },
          'gov.uk style compliance': { score: 8, note: 'good' }
        },
        improvements: [],
        reviewedContent: { issues: [] }
      },
      parseDuration: 5,
      finalReviewContent
    }
  }

  test('calls processChunk once per chunk in parallel', async () => {
    // text length=30, chunkSize=10 → 3 chunks
    const longText = 'aaaa bbbbb cccc ddddd eeeee ff'
    const chunkResults = [
      makeProcessChunkResult(1, 0),
      makeProcessChunkResult(2, 10),
      makeProcessChunkResult(3, 20)
    ]

    processor.processChunk = vi
      .fn()
      .mockResolvedValueOnce(chunkResults[0])
      .mockResolvedValueOnce(chunkResults[1])
      .mockResolvedValueOnce(chunkResults[2])

    await processor.performChunkedReview('r', longText)

    expect(processor.processChunk).toHaveBeenCalledTimes(3)
    expect(processor.processChunk).toHaveBeenCalledWith(
      'r',
      expect.objectContaining({ index: 1 })
    )
    expect(processor.processChunk).toHaveBeenCalledWith(
      'r',
      expect.objectContaining({ index: 2 })
    )
    expect(processor.processChunk).toHaveBeenCalledWith(
      'r',
      expect.objectContaining({ index: 3 })
    )
  })

  test('returns combined parsedReview and bedrockResult from collateChunkResults', async () => {
    const longText = 'aaa bbb ccc ddd eee fff ggg'
    const chunkResult = makeProcessChunkResult(1, 0)

    processor.processChunk = vi.fn().mockResolvedValue(chunkResult)

    const result = await processor.performChunkedReview('r', longText)

    expect(result.parsedReview).toBeDefined()
    expect(result.bedrockResult).toBeDefined()
    expect(result.chunks).toBeDefined()
  })

  test('includes per-chunk data in chunks array for debug artefact', async () => {
    // 'hello world!' = 12 chars → exactly 2 chunks with chunkSize=10
    // chunk1='hello '(0-6), chunk2='world!'(6-12)
    const longText = 'hello world!'
    const chunkResult1 = makeProcessChunkResult(1, 0, 'response-chunk-1')
    const chunkResult2 = makeProcessChunkResult(2, 6, 'response-chunk-2')

    processor.processChunk = vi
      .fn()
      .mockResolvedValueOnce(chunkResult1)
      .mockResolvedValueOnce(chunkResult2)

    const result = await processor.performChunkedReview('r', longText)

    expect(result.chunks.length).toBeGreaterThan(1)
    const chunkIndexes = result.chunks.map((c) => c.index)
    expect(chunkIndexes).toContain(1)
    expect(chunkIndexes).toContain(2)
    result.chunks.forEach((c) => {
      expect(c).toHaveProperty('index')
      expect(c).toHaveProperty('startOffset')
      expect(c).toHaveProperty('rawResponse')
    })
  })

  test('sums parseDuration across all chunks', async () => {
    // 'hello world!' = 12 chars → exactly 2 chunks with chunkSize=10
    const longText = 'hello world!'
    const c1 = { ...makeProcessChunkResult(1, 0), parseDuration: 30 }
    const c2 = { ...makeProcessChunkResult(2, 6), parseDuration: 20 }

    processor.processChunk = vi
      .fn()
      .mockResolvedValueOnce(c1)
      .mockResolvedValueOnce(c2)

    const result = await processor.performChunkedReview('r', longText)

    expect(result.parseDuration).toBe(50)
  })
})

describe('BedrockReviewProcessor - performChunkedReview - failure propagation', () => {
  let processor

  const SMALL_CHUNK_SIZE = 10

  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigGet.mockImplementation((key) => {
      if (key === 'bedrock.chunkSizeChars') return SMALL_CHUNK_SIZE
      if (key === 'bedrock.maxTokensPerChunk')
        return DEFAULT_MAX_TOKENS_PER_CHUNK
      return undefined
    })
    processor = new BedrockReviewProcessor()
  })

  test('rejects the entire review when any chunk fails', async () => {
    const longText = 'aa bb cc dd ee ff gg hh ii jj'
    const successResult = {
      chunk: { index: 1, startOffset: 0 },
      bedrockResult: {
        bedrockResponse: { usage: {}, stopReason: 'end_turn' },
        bedrockDuration: 100
      },
      parsedReview: {
        scores: {},
        improvements: [],
        reviewedContent: { issues: [] }
      },
      parseDuration: 5,
      finalReviewContent: 'ok'
    }

    processor.processChunk = vi
      .fn()
      .mockResolvedValueOnce(successResult)
      .mockRejectedValueOnce(new Error('Bedrock chunk 2 failed'))

    await expect(
      processor.performChunkedReview('r-fail', longText)
    ).rejects.toThrow('Bedrock chunk 2 failed')
  })

  test('rejects immediately when first chunk fails', async () => {
    const longText = 'aa bb cc dd ee ff gg hh ii jj'

    processor.processChunk = vi
      .fn()
      .mockRejectedValue(new Error('chunk timeout'))

    await expect(
      processor.performChunkedReview('r-timeout', longText)
    ).rejects.toThrow('chunk timeout')
  })
})
