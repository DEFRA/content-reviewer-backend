import { describe, test, expect, beforeEach, vi } from 'vitest'

import { BedrockReviewProcessor } from './bedrock-processor.js'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockConfigGet = vi.fn()
const mockAcquire = vi.fn().mockResolvedValue(undefined)
const mockRelease = vi.fn()

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
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
  config: { get: (...args) => mockConfigGet(...args) }
}))

vi.mock('./token-rate-limiter.js', () => ({
  getTokenRateLimiter: vi.fn(() => ({
    acquire: mockAcquire,
    release: mockRelease
  }))
}))

// ─── Constants ────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4
const DEFAULT_OVERHEAD_TOKENS = 4_000
const DEFAULT_MAX_TOKENS = 8_192
const DEFAULT_MAX_TOKENS_PER_MINUTE = 45_000
const DEFAULT_CHUNK_SIZE = 25_000
const SMALL_CHUNK_SIZE = 10

const BEDROCK_DURATION_DEFAULT = 500
const PARSE_DURATION_DEFAULT = 5
const INPUT_TOKENS_DEFAULT = 100
const OUTPUT_TOKENS_DEFAULT = 50
const TOTAL_TOKENS_DEFAULT = 150

// ─── Config helpers ───────────────────────────────────────────────────────────

function setupConfig(chunkSize = DEFAULT_CHUNK_SIZE) {
  mockConfigGet.mockImplementation((key) => {
    const values = {
      'bedrock.chunkSizeChars': chunkSize,
      'bedrock.maxTokens': DEFAULT_MAX_TOKENS,
      'bedrock.maxTokensPerMinute': DEFAULT_MAX_TOKENS_PER_MINUTE,
      'bedrock.systemPromptOverheadTokens': DEFAULT_OVERHEAD_TOKENS
    }
    return values[key] ?? undefined
  })
}

// ─── Chunk result factory ─────────────────────────────────────────────────────

function makeChunkResult(index, startOffset) {
  return {
    chunk: { index, startOffset, text: 'x'.repeat(10) },
    bedrockResult: {
      bedrockResponse: {
        usage: {
          inputTokens: INPUT_TOKENS_DEFAULT,
          outputTokens: OUTPUT_TOKENS_DEFAULT,
          totalTokens: TOTAL_TOKENS_DEFAULT
        }
      },
      bedrockDuration: BEDROCK_DURATION_DEFAULT
    },
    parsedReview: {
      scores: {
        'plain english': { score: 7, note: 'ok' },
        'gov.uk style compliance': { score: 8, note: 'good' }
      },
      improvements: [],
      reviewedContent: { issues: [] }
    },
    parseDuration: PARSE_DURATION_DEFAULT,
    finalReviewContent: 'raw'
  }
}

// ─── _estimateChunkTokens ─────────────────────────────────────────────────────

describe('BedrockReviewProcessor - _estimateChunkTokens', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    setupConfig()
    processor = new BedrockReviewProcessor()
  })

  test('returns content tokens + overhead + max output tokens', () => {
    // textLength=4000 → ceil(4000/4)=1000 content tokens
    // 1000 + 4000 + 8192 = 13192
    expect(processor._estimateChunkTokens(4000)).toBe(13192)
  })

  test('rounds up content tokens for non-divisible text lengths', () => {
    // textLength=5 → ceil(5/4)=2 content tokens
    // 2 + 4000 + 8192 = 12194
    expect(processor._estimateChunkTokens(5)).toBe(12194)
  })

  test('returns only overhead + max output for zero-length text', () => {
    // ceil(0/4)=0 → 0 + 4000 + 8192 = 12192
    expect(processor._estimateChunkTokens(0)).toBe(12192)
  })

  test('scales linearly with text length for a typical 25k-char chunk', () => {
    // 25000/4=6250 content + 4000 overhead + 8192 output = 18442
    expect(processor._estimateChunkTokens(DEFAULT_CHUNK_SIZE)).toBe(
      Math.ceil(DEFAULT_CHUNK_SIZE / CHARS_PER_TOKEN) +
        DEFAULT_OVERHEAD_TOKENS +
        DEFAULT_MAX_TOKENS
    )
  })
})

// ─── performChunkedReview — rate limiter acquire (single-chunk path) ──────────

describe('BedrockReviewProcessor - performChunkedReview - acquire single-chunk path', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    setupConfig() // chunkSize=25000, text will be shorter → single-chunk path
    processor = new BedrockReviewProcessor()
  })

  test('calls acquire once before the single Bedrock request', async () => {
    const shortText = 'brief content'
    const bedrockResult = {
      bedrockResponse: { content: 'ok', usage: {} },
      bedrockDuration: BEDROCK_DURATION_DEFAULT
    }
    const parseResult = {
      parsedReview: {},
      parseDuration: PARSE_DURATION_DEFAULT,
      finalReviewContent: 'ok'
    }

    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parseResult)

    await processor.performChunkedReview('r1', shortText)

    expect(mockAcquire).toHaveBeenCalledOnce()
  })

  test('passes estimated tokens and reviewId to acquire for the single-chunk path', async () => {
    const shortText = 'x'.repeat(400) // 400 chars → ceil(400/4)=100 tokens
    const expectedTokens =
      Math.ceil(400 / CHARS_PER_TOKEN) +
      DEFAULT_OVERHEAD_TOKENS +
      DEFAULT_MAX_TOKENS

    processor.performBedrockReview = vi.fn().mockResolvedValue({
      bedrockResponse: { content: 'ok', usage: {} },
      bedrockDuration: BEDROCK_DURATION_DEFAULT
    })
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue({
      parsedReview: {},
      parseDuration: PARSE_DURATION_DEFAULT,
      finalReviewContent: 'ok'
    })

    await processor.performChunkedReview('r-single', shortText)

    expect(mockAcquire).toHaveBeenCalledWith(expectedTokens, 'r-single')
  })
})

// ─── performChunkedReview — rate limiter acquire (multi-chunk path) ───────────

describe('BedrockReviewProcessor - performChunkedReview - acquire multi-chunk path', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    setupConfig(SMALL_CHUNK_SIZE) // chunkSize=10 → forces chunking
    processor = new BedrockReviewProcessor()
  })

  test('calls acquire once per chunk', async () => {
    // 'hello world!' = 12 chars with chunkSize=10 → 2 chunks
    const text = 'hello world!'
    processor.processChunk = vi
      .fn()
      .mockResolvedValueOnce(makeChunkResult(1, 0))
      .mockResolvedValueOnce(makeChunkResult(2, 6))

    await processor.performChunkedReview('r', text)

    expect(mockAcquire).toHaveBeenCalledTimes(2)
  })

  test('passes normal priority for chunk 1', async () => {
    const text = 'hello world!'
    processor.processChunk = vi
      .fn()
      .mockResolvedValueOnce(makeChunkResult(1, 0))
      .mockResolvedValueOnce(makeChunkResult(2, 6))

    await processor.performChunkedReview('r', text)

    expect(mockAcquire).toHaveBeenNthCalledWith(
      1,
      expect.any(Number),
      'r_chunk_1',
      'normal'
    )
  })

  test('passes high priority for chunks 2 and beyond', async () => {
    // 'aa bb cc dd ee ff gg' = 20 chars with chunkSize=10 → 3 chunks
    // chunk 1: 'aa bb cc ' (snap at space@8 → end=9)
    // chunk 2: 'dd ee ff ' (snap at space@17 → end=18)
    // chunk 3: 'gg'
    const text = 'aa bb cc dd ee ff gg'
    processor.processChunk = vi
      .fn()
      .mockResolvedValueOnce(makeChunkResult(1, 0))
      .mockResolvedValueOnce(makeChunkResult(2, 9))
      .mockResolvedValueOnce(makeChunkResult(3, 18))

    await processor.performChunkedReview('r', text)

    expect(mockAcquire).toHaveBeenNthCalledWith(
      2,
      expect.any(Number),
      'r_chunk_2',
      'high'
    )
    expect(mockAcquire).toHaveBeenNthCalledWith(
      3,
      expect.any(Number),
      'r_chunk_3',
      'high'
    )
  })

  test('passes estimated tokens based on each chunk text length', async () => {
    // Use a text that splits cleanly: 'hello world!' → chunk1='hello ' (6), chunk2='world!' (6)
    const text = 'hello world!'
    processor.processChunk = vi
      .fn()
      .mockResolvedValueOnce(makeChunkResult(1, 0))
      .mockResolvedValueOnce(makeChunkResult(2, 6))

    await processor.performChunkedReview('r-tokens', text)

    // Both acquire calls should have a positive token estimate
    const [firstCall, secondCall] = mockAcquire.mock.calls
    expect(firstCall[0]).toBeGreaterThan(DEFAULT_OVERHEAD_TOKENS) // at least overhead + output
    expect(secondCall[0]).toBeGreaterThan(DEFAULT_OVERHEAD_TOKENS)
  })
})

// ─── performChunkedReview — sequential ordering ───────────────────────────────

describe('BedrockReviewProcessor - performChunkedReview - sequential chunk ordering', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    setupConfig(SMALL_CHUNK_SIZE)
    processor = new BedrockReviewProcessor()
  })

  test('processes chunks in order: acquire chunk N completes before chunk N+1 starts', async () => {
    const text = 'hello world!'
    const callOrder = []

    mockAcquire.mockImplementation(async (_tokens, label) => {
      callOrder.push(`acquire:${label}`)
    })

    processor.processChunk = vi
      .fn()
      .mockImplementation(async (_reviewId, chunk) => {
        callOrder.push(`process:chunk_${chunk.index}`)
        return makeChunkResult(chunk.index, chunk.startOffset)
      })

    await processor.performChunkedReview('r', text)

    expect(callOrder).toEqual([
      'acquire:r_chunk_1',
      'process:chunk_1',
      'acquire:r_chunk_2',
      'process:chunk_2'
    ])
  })
})
