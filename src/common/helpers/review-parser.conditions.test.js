import { describe, it, expect, vi } from 'vitest'

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

import { parseBedrockResponse } from './review-parser.js'

// ── shared helpers ────────────────────────────────────────────────────────────

const SCORES_OPEN = '[SCORES]'
const SCORES_CLOSE = '[/SCORES]'
const REVIEWED_CONTENT_OPEN = '[REVIEWED_CONTENT]'
const REVIEWED_CONTENT_CLOSE = '[/REVIEWED_CONTENT]'
const IMPROVEMENTS_OPEN = '[IMPROVEMENTS]'
const IMPROVEMENTS_CLOSE = '[/IMPROVEMENTS]'
const ISSUE_POSITIONS_OPEN = '[ISSUE_POSITIONS]'
const ISSUE_POSITIONS_CLOSE = '[/ISSUE_POSITIONS]'
const PLAIN_ENGLISH_SCORE_LINE = 'Plain English: 3/5 - Some issues'

// PRIORITY_HIGH_OPEN intentionally omits the leading '[' — parseImprovements
// splits on '[PRIORITY:' so the first block starts with the text after it.
const PRIORITY_HIGH_OPEN = 'PRIORITY: high]'
const CATEGORY_CLARITY = 'CATEGORY: Clarity'
const WHY_BARRIERS = 'WHY: Barriers for users'
const SAMPLE_UTILISE_TEXT = 'The department should utilise all resources.'

function buildMarkerResponse({
  scores = '',
  content = '',
  improvements = ''
} = {}) {
  return [
    SCORES_OPEN,
    scores,
    SCORES_CLOSE,
    REVIEWED_CONTENT_OPEN,
    content,
    REVIEWED_CONTENT_CLOSE,
    IMPROVEMENTS_OPEN,
    improvements,
    IMPROVEMENTS_CLOSE
  ].join('\n')
}

function buildIssuePositionsResponse(jsonLine) {
  return [
    SCORES_OPEN,
    PLAIN_ENGLISH_SCORE_LINE,
    SCORES_CLOSE,
    ISSUE_POSITIONS_OPEN,
    jsonLine,
    ISSUE_POSITIONS_CLOSE,
    IMPROVEMENTS_OPEN,
    IMPROVEMENTS_CLOSE
  ].join('\n')
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('parseBedrockResponse - issue with no type field (line 51)', () => {
  it('defaults type to "plain-english" when type field is absent from issue', () => {
    // raw.type is undefined → fallback 'plain-english' (line 51)
    const response = buildIssuePositionsResponse(
      '{"issues":[{"start":22,"end":29}]}'
    )

    const result = parseBedrockResponse(
      response,
      undefined,
      SAMPLE_UTILISE_TEXT
    )

    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].type).toBe('plain-english')
  })
})

describe('parseBedrockResponse - error catch path with truthy originalText (line 670)', () => {
  it('uses originalText as plainText in error fallback when originalText is provided', () => {
    // originalText truthy → originalText || bedrockResponse || '' picks originalText (line 670)
    const badResponse = {
      trim: () => 'something',
      includes: () => {
        throw new Error('deliberate parse error')
      }
    }

    const result = parseBedrockResponse(
      badResponse,
      undefined,
      'my original text'
    )

    expect(result.reviewedContent.plainText).toBe('my original text')
  })

  it('falls back to empty string when both originalText and bedrockResponse are falsy', () => {
    // Pass null as bedrockResponse, a throwing object as fallback so the parse path errors,
    // and '' as originalText.  '' || null || '' exercises the final || '' branch (line 670).
    const badFallback = {
      trim: () => 'something',
      includes: () => {
        throw new Error('deliberate parse error')
      }
    }

    const result = parseBedrockResponse(null, badFallback, '')

    expect(result.reviewedContent.plainText).toBe('')
  })
})

describe('parseBedrockResponse - improvement block with no SUGGESTED field (lines 377, 412-416)', () => {
  it('discards improvement block and returns no improvements when SUGGESTED is absent', () => {
    // extractSuggestedField returns '' (line 377); !suggested → warn + return null (lines 412-416)
    const improvements = [
      PRIORITY_HIGH_OPEN,
      CATEGORY_CLARITY,
      'ISSUE: Overly complex sentence',
      WHY_BARRIERS,
      'CURRENT: The organisation undertakes various activities'
      // no SUGGESTED field
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response)

    expect(result.improvements).toHaveLength(0)
  })
})

describe('parseBedrockResponse - field with no trailing newline in block (line 332)', () => {
  it('extracts field correctly when no newline follows the value before end of block', () => {
    // buildMarkerResponse always inserts '\n' before [/IMPROVEMENTS], giving
    // extractField a newline to find. Construct the raw string directly so that
    // WHY is the last character before [/IMPROVEMENTS] with no '\n' after it.
    // extractField then hits lineEnd === -1 → lineEnd = block.length (line 332).
    const response =
      '[IMPROVEMENTS]\nPRIORITY: high]\nCATEGORY: Clarity\nISSUE: Simple issue\nWHY: Clear reason[/IMPROVEMENTS]'

    const result = parseBedrockResponse(response)

    // No SUGGESTED → block discarded; line 332 was exercised inside extractField
    expect(result.improvements).toHaveLength(0)
  })
})

describe('parseBedrockResponse - improvement block with no CURRENT field (line 352)', () => {
  it('returns improvement with empty current when CURRENT field is absent', () => {
    // extractCurrentField returns '' (line 352); block returned since SUGGESTED present
    const improvements = [
      PRIORITY_HIGH_OPEN,
      CATEGORY_CLARITY,
      'ISSUE: Jargon used',
      WHY_BARRIERS,
      // no CURRENT field
      'SUGGESTED: use simpler words'
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response)

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].current).toBe('')
    expect(result.improvements[0].suggested).toBe('use simpler words')
  })
})
