import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

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

// Rate limiter must be mocked so performChunkedReview does not hit the real
// singleton or block on token budget during unit tests.
const mockAcquire = vi.fn().mockResolvedValue(undefined)
vi.mock('./token-rate-limiter.js', () => ({
  getTokenRateLimiter: vi.fn(() => ({ acquire: mockAcquire }))
}))

// ─── Test constants ──────────────────────────────────────────────────────────

const CONFIG_CHUNK_SIZE_KEY = 'bedrock.chunkSizeChars'
const CONFIG_MAX_TOKENS_KEY = 'bedrock.maxTokensPerChunk'

const DEFAULT_CHUNK_SIZE = 25_000
const DEFAULT_MAX_TOKENS_PER_CHUNK = 4_096
const SMALL_CHUNK_SIZE = 10

const INPUT_TOKENS_DEFAULT = 100
const OUTPUT_TOKENS_DEFAULT = 50
const TOTAL_TOKENS_DEFAULT = 150
const BEDROCK_DURATION_DEFAULT = 1000
const PARSE_DURATION_DEFAULT = 5

const PARSE_DURATION_C1 = 30
const PARSE_DURATION_C2 = 20

// Chunk indices and offsets used in multi-chunk tests
const CHUNK_INDEX_1 = 1
const CHUNK_INDEX_2 = 2
const CHUNK_INDEX_3 = 3
const CHUNK_OFFSET_0 = 0
const CHUNK_OFFSET_10 = 10
const CHUNK_OFFSET_20 = 20
// 'hello world!' splits at the space → chunk 2 starts at char 6
const HELLO_WORLD_CHUNK2_OFFSET = 6
const EXPECTED_THREE_CHUNKS = 3

// ─── Shared helpers ───────────────────────────────────────────────────────────

function setupDefaultConfig() {
  mockConfigGet.mockImplementation((key) => {
    const values = {
      [CONFIG_CHUNK_SIZE_KEY]: DEFAULT_CHUNK_SIZE,
      [CONFIG_MAX_TOKENS_KEY]: DEFAULT_MAX_TOKENS_PER_CHUNK,
      'bedrock.maxTokensPerMinute': 45_000,
      'bedrock.systemPromptOverheadTokens': 4_000
    }
    return values[key] ?? undefined
  })
}

function setupSmallChunkConfig() {
  mockConfigGet.mockImplementation((key) => {
    const values = {
      [CONFIG_CHUNK_SIZE_KEY]: SMALL_CHUNK_SIZE,
      [CONFIG_MAX_TOKENS_KEY]: DEFAULT_MAX_TOKENS_PER_CHUNK,
      'bedrock.maxTokensPerMinute': 45_000,
      'bedrock.systemPromptOverheadTokens': 4_000
    }
    return values[key] ?? undefined
  })
}

function makeProcessChunkResult(
  index,
  startOffset,
  finalReviewContent = 'raw'
) {
  return {
    chunk: { index, startOffset, text: 'chunk' },
    bedrockResult: {
      bedrockResponse: {
        usage: {
          inputTokens: INPUT_TOKENS_DEFAULT,
          outputTokens: OUTPUT_TOKENS_DEFAULT,
          totalTokens: TOTAL_TOKENS_DEFAULT
        },
        stopReason: 'end_turn'
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
    finalReviewContent
  }
}

// ─── performChunkedReview — below threshold (single call) ────────────────────

describe('BedrockReviewProcessor - performChunkedReview - below threshold', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultConfig()
    processor = new BedrockReviewProcessor()
  })

  test('calls performBedrockReview directly without chunking for short text', async () => {
    const shortText = 'x'.repeat(DEFAULT_CHUNK_SIZE - 1)
    const bedrockResult = {
      bedrockResponse: {
        content: 'ok',
        usage: {
          inputTokens: INPUT_TOKENS_DEFAULT,
          outputTokens: OUTPUT_TOKENS_DEFAULT,
          totalTokens: TOTAL_TOKENS_DEFAULT
        }
      },
      bedrockDuration: BEDROCK_DURATION_DEFAULT
    }
    const parseResult = {
      parsedReview: { scores: {}, improvements: [] },
      parseDuration: PARSE_DURATION_DEFAULT,
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
      bedrockDuration: BEDROCK_DURATION_DEFAULT
    }
    const parseResult = {
      parsedReview: {},
      parseDuration: PARSE_DURATION_DEFAULT,
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
      bedrockDuration: BEDROCK_DURATION_DEFAULT
    }
    const parseResult = {
      parsedReview: {},
      parseDuration: PARSE_DURATION_DEFAULT,
      finalReviewContent: 'ok'
    }

    processor.performBedrockReview = vi.fn().mockResolvedValue(bedrockResult)
    processor.parseBedrockResponseData = vi.fn().mockResolvedValue(parseResult)
    processor.processChunk = vi.fn()

    await processor.performChunkedReview('r', shortText)

    expect(processor.processChunk).not.toHaveBeenCalled()
  })
})

// ─── performChunkedReview — above threshold (multi-chunk) ────────────────────

describe('BedrockReviewProcessor - performChunkedReview - above threshold', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    setupSmallChunkConfig()
    processor = new BedrockReviewProcessor()
  })

  test('calls processChunk once per chunk sequentially', async () => {
    // text length=30, chunkSize=10 → 3 chunks
    const longText = 'aaaa bbbbb cccc ddddd eeeee ff'
    const chunkResults = [
      makeProcessChunkResult(CHUNK_INDEX_1, CHUNK_OFFSET_0),
      makeProcessChunkResult(CHUNK_INDEX_2, CHUNK_OFFSET_10),
      makeProcessChunkResult(CHUNK_INDEX_3, CHUNK_OFFSET_20)
    ]

    processor.processChunk = vi
      .fn()
      .mockResolvedValueOnce(chunkResults[0])
      .mockResolvedValueOnce(chunkResults[1])
      .mockResolvedValueOnce(chunkResults[2])

    await processor.performChunkedReview('r', longText)

    expect(processor.processChunk).toHaveBeenCalledTimes(EXPECTED_THREE_CHUNKS)
    expect(processor.processChunk).toHaveBeenCalledWith(
      'r',
      expect.objectContaining({ index: CHUNK_INDEX_1 })
    )
    expect(processor.processChunk).toHaveBeenCalledWith(
      'r',
      expect.objectContaining({ index: CHUNK_INDEX_2 })
    )
    expect(processor.processChunk).toHaveBeenCalledWith(
      'r',
      expect.objectContaining({ index: CHUNK_INDEX_3 })
    )
  })

  test('returns combined parsedReview and bedrockResult from collateChunkResults', async () => {
    const longText = 'aaa bbb ccc ddd eee fff ggg'

    processor.processChunk = vi
      .fn()
      .mockResolvedValue(makeProcessChunkResult(CHUNK_INDEX_1, CHUNK_OFFSET_0))

    const result = await processor.performChunkedReview('r', longText)

    expect(result.parsedReview).toBeDefined()
    expect(result.bedrockResult).toBeDefined()
    expect(result.chunks).toBeDefined()
  })

  test('includes per-chunk data in chunks array for debug artefact', async () => {
    // 'hello world!' = 12 chars → exactly 2 chunks with chunkSize=10
    const longText = 'hello world!'
    const chunkResult1 = makeProcessChunkResult(
      CHUNK_INDEX_1,
      CHUNK_OFFSET_0,
      'response-chunk-1'
    )
    const chunkResult2 = makeProcessChunkResult(
      CHUNK_INDEX_2,
      HELLO_WORLD_CHUNK2_OFFSET,
      'response-chunk-2'
    )

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
    const c1 = {
      ...makeProcessChunkResult(CHUNK_INDEX_1, CHUNK_OFFSET_0),
      parseDuration: PARSE_DURATION_C1
    }
    const c2 = {
      ...makeProcessChunkResult(CHUNK_INDEX_2, HELLO_WORLD_CHUNK2_OFFSET),
      parseDuration: PARSE_DURATION_C2
    }

    processor.processChunk = vi
      .fn()
      .mockResolvedValueOnce(c1)
      .mockResolvedValueOnce(c2)

    const result = await processor.performChunkedReview('r', longText)

    expect(result.parseDuration).toBe(PARSE_DURATION_C1 + PARSE_DURATION_C2)
  })
})

// ─── performChunkedReview — failure propagation ───────────────────────────────

describe('BedrockReviewProcessor - performChunkedReview - failure propagation', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    setupSmallChunkConfig()
    processor = new BedrockReviewProcessor()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('rejects the entire review when any chunk fails', async () => {
    const longText = 'aa bb cc dd ee ff gg hh ii jj'
    const successResult = makeProcessChunkResult(1, 0)

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
