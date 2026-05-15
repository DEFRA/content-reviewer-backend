import { describe, test, expect, beforeEach, vi } from 'vitest'

import { BedrockReviewProcessor } from './bedrock-processor.js'

// ─── Shared mocks ────────────────────────────────────────────────────────────

const mockConfigGet = vi.fn()

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
  config: {
    get: (...args) => mockConfigGet(...args)
  }
}))

// ─── Test constants ──────────────────────────────────────────────────────────

const CONFIG_CHUNK_SIZE_KEY = 'bedrock.chunkSizeChars'
const CONFIG_MAX_TOKENS_KEY = 'bedrock.maxTokens'

const DEFAULT_CHUNK_SIZE = 25_000
const DEFAULT_MAX_TOKENS = 8_192

const CHUNK_OFFSET_1000 = 1000
const REF_OFFSET_2000 = 2000

// Offsets within the chunk used in the offset-adjustment test
const ISSUE_START = 2
const ISSUE_END = 7
const IMP_START = 5
const IMP_END = 10

function setupDefaultConfig() {
  mockConfigGet.mockImplementation((key) => {
    if (key === CONFIG_CHUNK_SIZE_KEY) {
      return DEFAULT_CHUNK_SIZE
    }
    if (key === CONFIG_MAX_TOKENS_KEY) {
      return DEFAULT_MAX_TOKENS
    }
    return undefined
  })
}

// ─── Minimal parsedResult factory ────────────────────────────────────────────

function makeEmptyParsedResult(overrides = {}) {
  return {
    parsedReview: {
      scores: {},
      improvements: [],
      reviewedContent: { issues: [] },
      ...overrides.parsedReview
    },
    parseDuration: 10,
    finalReviewContent: 'ok',
    ...overrides
  }
}

// ─── processChunk — Bedrock call and parsing ─────────────────────────────────

describe('BedrockReviewProcessor - processChunk - Bedrock call and parsing', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultConfig()
    processor = new BedrockReviewProcessor()
  })

  test('calls performBedrockReview with chunkReviewId and chunk text', async () => {
    const chunk = { text: 'chunk text', startOffset: 0, index: 2 }
    const bedrockResult = {
      bedrockResponse: { content: 'response', usage: {} },
      bedrockDuration: 500
    }
    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi
      .fn()
      .mockResolvedValue(makeEmptyParsedResult())

    await processor.processChunk('review-abc', chunk)

    expect(processor.performBedrockReview).toHaveBeenCalledWith(
      'review-abc_chunk_2',
      'chunk text'
    )
  })

  test('calls parseBedrockResponseData with chunkReviewId and chunk text', async () => {
    const chunk = { text: 'some chunk', startOffset: 500, index: 3 }
    const bedrockResult = {
      bedrockResponse: { content: 'parsed', usage: {} },
      bedrockDuration: 300
    }
    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi
      .fn()
      .mockResolvedValue(makeEmptyParsedResult())

    await processor.processChunk('review-xyz', chunk)

    expect(processor.parseBedrockResponseData).toHaveBeenCalledWith(
      'review-xyz_chunk_3',
      bedrockResult,
      'some chunk'
    )
  })
})

// ─── processChunk — offset and ref adjustment ────────────────────────────────

describe('BedrockReviewProcessor - processChunk - offset and ref adjustment', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultConfig()
    processor = new BedrockReviewProcessor()
  })

  test('adjusts offsets by chunkStartOffset', async () => {
    const chunk = {
      text: 'chunk content',
      startOffset: CHUNK_OFFSET_1000,
      index: 1
    }
    const bedrockResult = {
      bedrockResponse: { content: 'review', usage: { inputTokens: 50 } },
      bedrockDuration: 800
    }
    const parsedResult = {
      parsedReview: {
        scores: {},
        improvements: [{ start: IMP_START, end: IMP_END, suggestion: 'fix' }],
        reviewedContent: {
          issues: [{ start: ISSUE_START, end: ISSUE_END, text: 'issue' }]
        }
      },
      parseDuration: 15,
      finalReviewContent: 'review'
    }
    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parsedResult)

    const result = await processor.processChunk('r1', chunk)

    expect(result.parsedReview.improvements[0].start).toBe(
      CHUNK_OFFSET_1000 + IMP_START
    )
    expect(result.parsedReview.improvements[0].end).toBe(
      CHUNK_OFFSET_1000 + IMP_END
    )
    expect(result.parsedReview.reviewedContent.issues[0].start).toBe(
      CHUNK_OFFSET_1000 + ISSUE_START
    )
    expect(result.parsedReview.reviewedContent.issues[0].end).toBe(
      CHUNK_OFFSET_1000 + ISSUE_END
    )
  })

  test('offsets refs by (chunk.index - 1) * 1000 to prevent cross-chunk collisions', async () => {
    // chunk.index = 3 → refOffset = 2000
    const refImp = 1
    const refIssue = 2
    const chunk = { text: 'chunk text', startOffset: 0, index: 3 }
    const bedrockResult = {
      bedrockResponse: { content: 'ok', usage: {} },
      bedrockDuration: 200
    }
    const parsedResult = {
      parsedReview: {
        scores: {},
        improvements: [{ ref: refImp, start: 0, end: 5 }],
        reviewedContent: { issues: [{ ref: refIssue, start: 10, end: 20 }] }
      },
      parseDuration: 5,
      finalReviewContent: 'ok'
    }
    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parsedResult)

    const result = await processor.processChunk('r', chunk)

    expect(result.parsedReview.improvements[0].ref).toBe(
      REF_OFFSET_2000 + refImp
    )
    expect(result.parsedReview.reviewedContent.issues[0].ref).toBe(
      REF_OFFSET_2000 + refIssue
    )
  })

  test('does not offset refs for chunk.index = 1 (refOffset = 0)', async () => {
    const originalRef = 1
    const chunk = { text: 'chunk text', startOffset: 0, index: 1 }
    const parsedResult = {
      parsedReview: {
        scores: {},
        improvements: [{ ref: originalRef, start: 0, end: 5 }],
        reviewedContent: { issues: [{ ref: originalRef, start: 0, end: 5 }] }
      },
      parseDuration: 5,
      finalReviewContent: 'ok'
    }
    processor.performBedrockReview = vi.fn().mockResolvedValue({
      bedrockResponse: { content: 'ok', usage: {} },
      bedrockDuration: 200
    })
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parsedResult)

    const result = await processor.processChunk('r', chunk)

    expect(result.parsedReview.improvements[0].ref).toBe(originalRef)
    expect(result.parsedReview.reviewedContent.issues[0].ref).toBe(originalRef)
  })
})

// ─── processChunk — result shape and errors ──────────────────────────────────

describe('BedrockReviewProcessor - processChunk - result shape and errors', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultConfig()
    processor = new BedrockReviewProcessor()
  })

  test('returns chunk, bedrockResult, parsedReview, parseDuration, finalReviewContent', async () => {
    const chunk = { text: 'hello', startOffset: 0, index: 1 }
    const bedrockResult = {
      bedrockResponse: { content: 'ok', usage: {} },
      bedrockDuration: 200
    }
    const parsedResult = makeEmptyParsedResult({
      parseDuration: 8,
      finalReviewContent: 'ok'
    })

    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parsedResult)

    const result = await processor.processChunk('r', chunk)

    expect(result.chunk).toBe(chunk)
    expect(result.bedrockResult).toBe(bedrockResult)
    expect(result.parseDuration).toBe(8)
    expect(result.finalReviewContent).toBe('ok')
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
})
