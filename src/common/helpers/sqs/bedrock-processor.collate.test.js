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

const CANONICAL_TEXT = 'full document text'

const SCORE_KEY_PLAIN_ENGLISH = 'plain english'
const SCORE_KEY_GOVUK = 'gov.uk style compliance'

const SCORE_A = 6
const SCORE_B = 8
const SCORE_AVG_AB = Math.round((SCORE_A + SCORE_B) / 2) // 7
const SCORE_LOW = 4
const SCORE_HIGH = 9
const SCORE_MID = 7

const INPUT_TOKENS_DEFAULT = 100
const OUTPUT_TOKENS_DEFAULT = 50
const TOTAL_TOKENS_DEFAULT = 150
const BEDROCK_DURATION_DEFAULT = 1000

const INPUT_TOKENS_A = 300
const OUTPUT_TOKENS_A = 100
const TOTAL_TOKENS_A = 400
const INPUT_TOKENS_B = 200
const OUTPUT_TOKENS_B = 80
const TOTAL_TOKENS_B = 280

const DURATION_3000 = 3000
const DURATION_5000 = 5000
const DURATION_8000 = 8000

const PLAIN_SCORE_CAPTION = 'a'

// ─── Shared helper ───────────────────────────────────────────────────────────

function makeChunkResult({
  plainEnglishScore,
  plainEnglishNote,
  govUkScore,
  govUkNote,
  improvements = [],
  issues = [],
  inputTokens = INPUT_TOKENS_DEFAULT,
  outputTokens = OUTPUT_TOKENS_DEFAULT,
  totalTokens = TOTAL_TOKENS_DEFAULT,
  bedrockDuration = BEDROCK_DURATION_DEFAULT
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
        [SCORE_KEY_PLAIN_ENGLISH]: {
          score: plainEnglishScore,
          note: plainEnglishNote
        },
        [SCORE_KEY_GOVUK]: { score: govUkScore, note: govUkNote }
      },
      improvements,
      reviewedContent: { issues }
    },
    parseDuration: 10,
    finalReviewContent: 'raw'
  }
}

// ─── collateChunkResults — score averaging ───────────────────────────────────

describe('BedrockReviewProcessor - collateChunkResults - score averaging', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('averages scores across all chunks', () => {
    const results = [
      makeChunkResult({
        plainEnglishScore: SCORE_A,
        plainEnglishNote: 'needs work',
        govUkScore: SCORE_B,
        govUkNote: 'good'
      }),
      makeChunkResult({
        plainEnglishScore: SCORE_B,
        plainEnglishNote: 'ok',
        govUkScore: SCORE_A,
        govUkNote: 'improve'
      })
    ]
    const { combinedParsedReview } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    expect(combinedParsedReview.scores[SCORE_KEY_PLAIN_ENGLISH].score).toBe(
      SCORE_AVG_AB
    )
    expect(combinedParsedReview.scores[SCORE_KEY_GOVUK].score).toBe(
      SCORE_AVG_AB
    )
  })

  test('uses note from the lowest-scoring chunk', () => {
    const results = [
      makeChunkResult({
        plainEnglishScore: SCORE_LOW,
        plainEnglishNote: 'poor',
        govUkScore: SCORE_HIGH,
        govUkNote: 'great'
      }),
      makeChunkResult({
        plainEnglishScore: SCORE_B,
        plainEnglishNote: 'fine',
        govUkScore: SCORE_MID,
        govUkNote: 'ok'
      })
    ]
    const { combinedParsedReview } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    // plain english: lowest is SCORE_LOW, note 'poor'
    expect(combinedParsedReview.scores[SCORE_KEY_PLAIN_ENGLISH].note).toBe(
      'poor'
    )
    // gov.uk: lowest is SCORE_MID, note 'ok'
    expect(combinedParsedReview.scores[SCORE_KEY_GOVUK].note).toBe('ok')
  })

  test('collates scores correctly when LLM returns capitalized keys', () => {
    // LLM often returns "Plain English" (Title Case) — collateChunkResults must
    // normalise to lowercase before lookup so scores are not silently dropped.
    const results = [
      {
        chunk: { index: 1, startOffset: 0 },
        bedrockResult: {
          bedrockResponse: { usage: {}, stopReason: 'end_turn' },
          bedrockDuration: BEDROCK_DURATION_DEFAULT
        },
        parsedReview: {
          scores: {
            'Plain English': { score: SCORE_LOW, note: 'wordy' },
            'GOV.UK Style Compliance': { score: 3, note: 'needs work' }
          },
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
    expect(combinedParsedReview.scores[SCORE_KEY_PLAIN_ENGLISH].score).toBe(
      SCORE_LOW
    )
    expect(combinedParsedReview.scores[SCORE_KEY_GOVUK].score).toBe(3)
  })

  test('skips score keys where no chunk has data', () => {
    const results = [
      {
        chunk: { index: 1, startOffset: 0 },
        bedrockResult: {
          bedrockResponse: { usage: {}, stopReason: 'end_turn' },
          bedrockDuration: BEDROCK_DURATION_DEFAULT
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
    expect(combinedParsedReview.scores[SCORE_KEY_PLAIN_ENGLISH]).toBeUndefined()
    expect(combinedParsedReview.scores[SCORE_KEY_GOVUK]).toBeUndefined()
  })
})

// ─── collateChunkResults — token usage ───────────────────────────────────────

describe('BedrockReviewProcessor - collateChunkResults - token usage', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('sums token usage across all chunks', () => {
    const results = [
      makeChunkResult({
        plainEnglishScore: SCORE_MID,
        plainEnglishNote: PLAIN_SCORE_CAPTION,
        govUkScore: SCORE_MID,
        govUkNote: PLAIN_SCORE_CAPTION,
        inputTokens: INPUT_TOKENS_A,
        outputTokens: OUTPUT_TOKENS_A,
        totalTokens: TOTAL_TOKENS_A
      }),
      makeChunkResult({
        plainEnglishScore: SCORE_MID,
        plainEnglishNote: PLAIN_SCORE_CAPTION,
        govUkScore: SCORE_MID,
        govUkNote: PLAIN_SCORE_CAPTION,
        inputTokens: INPUT_TOKENS_B,
        outputTokens: OUTPUT_TOKENS_B,
        totalTokens: TOTAL_TOKENS_B
      })
    ]
    const { combinedBedrockResult } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    expect(combinedBedrockResult.bedrockResponse.usage.inputTokens).toBe(
      INPUT_TOKENS_A + INPUT_TOKENS_B
    )
    expect(combinedBedrockResult.bedrockResponse.usage.outputTokens).toBe(
      OUTPUT_TOKENS_A + OUTPUT_TOKENS_B
    )
    expect(combinedBedrockResult.bedrockResponse.usage.totalTokens).toBe(
      TOTAL_TOKENS_A + TOTAL_TOKENS_B
    )
  })

  test('takes the max bedrockDuration across chunks (wall-clock time)', () => {
    const results = [
      makeChunkResult({
        plainEnglishScore: SCORE_MID,
        plainEnglishNote: PLAIN_SCORE_CAPTION,
        govUkScore: SCORE_MID,
        govUkNote: PLAIN_SCORE_CAPTION,
        bedrockDuration: DURATION_5000
      }),
      makeChunkResult({
        plainEnglishScore: SCORE_MID,
        plainEnglishNote: PLAIN_SCORE_CAPTION,
        govUkScore: SCORE_MID,
        govUkNote: PLAIN_SCORE_CAPTION,
        bedrockDuration: DURATION_8000
      }),
      makeChunkResult({
        plainEnglishScore: SCORE_MID,
        plainEnglishNote: PLAIN_SCORE_CAPTION,
        govUkScore: SCORE_MID,
        govUkNote: PLAIN_SCORE_CAPTION,
        bedrockDuration: DURATION_3000
      })
    ]
    const { combinedBedrockResult } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    expect(combinedBedrockResult.bedrockDuration).toBe(DURATION_8000)
  })
})

// ─── collateChunkResults — merging improvements and issues ───────────────────

describe('BedrockReviewProcessor - collateChunkResults - merging', () => {
  let processor

  beforeEach(() => {
    vi.clearAllMocks()
    processor = new BedrockReviewProcessor()
  })

  test('merges improvements from all chunks', () => {
    const imp1 = { start: 10, end: 20, suggestion: 'fix A' }
    const imp2 = { start: 500, end: 510, suggestion: 'fix B' }
    const results = [
      makeChunkResult({
        plainEnglishScore: SCORE_MID,
        plainEnglishNote: PLAIN_SCORE_CAPTION,
        govUkScore: SCORE_MID,
        govUkNote: PLAIN_SCORE_CAPTION,
        improvements: [imp1]
      }),
      makeChunkResult({
        plainEnglishScore: SCORE_MID,
        plainEnglishNote: PLAIN_SCORE_CAPTION,
        govUkScore: SCORE_MID,
        govUkNote: PLAIN_SCORE_CAPTION,
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
        plainEnglishScore: SCORE_MID,
        plainEnglishNote: PLAIN_SCORE_CAPTION,
        govUkScore: SCORE_MID,
        govUkNote: PLAIN_SCORE_CAPTION,
        issues: [issue1]
      }),
      makeChunkResult({
        plainEnglishScore: SCORE_MID,
        plainEnglishNote: PLAIN_SCORE_CAPTION,
        govUkScore: SCORE_MID,
        govUkNote: PLAIN_SCORE_CAPTION,
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
        plainEnglishScore: SCORE_MID,
        plainEnglishNote: PLAIN_SCORE_CAPTION,
        govUkScore: SCORE_MID,
        govUkNote: PLAIN_SCORE_CAPTION
      })
    ]
    const { combinedParsedReview } = processor.collateChunkResults(
      results,
      CANONICAL_TEXT
    )
    expect(combinedParsedReview.reviewedContent.plainText).toBe(CANONICAL_TEXT)
  })
})
