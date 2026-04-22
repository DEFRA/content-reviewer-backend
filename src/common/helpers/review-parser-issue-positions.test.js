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

// ============ CONSTANTS ============

const PLAIN_ENGLISH_SCORE_LINE = 'Plain English: 3/5 - Some issues'
const ISSUE_POSITIONS_OPEN = '[ISSUE_POSITIONS]'
const ISSUE_POSITIONS_CLOSE = '[/ISSUE_POSITIONS]'
const IMPROVEMENTS_OPEN = '[IMPROVEMENTS]'
const IMPROVEMENTS_CLOSE = '[/IMPROVEMENTS]'
const ORIGINAL_TEXT_DEFAULT = 'original text'
const SAMPLE_UTILISE_TEXT = 'The department should utilise all resources.'

function buildIssuePositionsResponse(jsonLine) {
  return [
    '[SCORES]',
    PLAIN_ENGLISH_SCORE_LINE,
    '[/SCORES]',
    ISSUE_POSITIONS_OPEN,
    jsonLine,
    ISSUE_POSITIONS_CLOSE,
    IMPROVEMENTS_OPEN,
    IMPROVEMENTS_CLOSE
  ].join('\n')
}

// ============ [ISSUE_POSITIONS] edge cases ============

describe('parseBedrockResponse - [ISSUE_POSITIONS] edge cases', () => {
  it('returns empty issues when [ISSUE_POSITIONS] contains no JSON object', () => {
    const response = buildIssuePositionsResponse('no json here at all')
    const result = parseBedrockResponse(
      response,
      undefined,
      ORIGINAL_TEXT_DEFAULT
    )
    expect(result.reviewedContent.issues).toEqual([])
  })

  it('returns empty issues when [ISSUE_POSITIONS] JSON is invalid', () => {
    const response = buildIssuePositionsResponse('{ invalid json }}}')
    const result = parseBedrockResponse(
      response,
      undefined,
      ORIGINAL_TEXT_DEFAULT
    )
    expect(result.reviewedContent.issues).toEqual([])
  })

  it('returns empty issues when JSON has no "issues" array', () => {
    const response = buildIssuePositionsResponse('{"data":[]}')
    const result = parseBedrockResponse(
      response,
      undefined,
      ORIGINAL_TEXT_DEFAULT
    )
    expect(result.reviewedContent.issues).toEqual([])
  })

  it('skips issues with invalid (negative) start offsets', () => {
    const response = buildIssuePositionsResponse(
      '{"issues":[{"start":-1,"end":5,"type":"plain-english","text":"word"}]}'
    )
    const result = parseBedrockResponse(response, undefined, 'some text here')
    expect(result.reviewedContent.issues).toEqual([])
  })

  it('skips issues where end <= start', () => {
    const response = buildIssuePositionsResponse(
      '{"issues":[{"start":10,"end":5,"type":"plain-english","text":"word"}]}'
    )
    const result = parseBedrockResponse(response, undefined, 'some text here')
    expect(result.reviewedContent.issues).toEqual([])
  })

  it('resolves text from originalText slice when text field is missing', () => {
    const originalText = SAMPLE_UTILISE_TEXT
    const response = buildIssuePositionsResponse(
      '{"issues":[{"start":22,"end":29,"type":"plain-english"}]}'
    )
    const result = parseBedrockResponse(response, undefined, originalText)
    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].text).toBe('utilise')
  })

  it('slices from start to end of originalText when end exceeds its length', () => {
    const originalText = 'Short text'
    const response = buildIssuePositionsResponse(
      '{"issues":[{"start":6,"end":9999,"type":"plain-english"}]}'
    )
    const result = parseBedrockResponse(response, undefined, originalText)
    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].text).toBe('text')
  })

  it('returns empty issues when text cannot be resolved and originalText is missing', () => {
    const response = buildIssuePositionsResponse(
      '{"issues":[{"start":0,"end":5,"type":"plain-english"}]}'
    )
    const result = parseBedrockResponse(response, undefined, '')
    expect(result.reviewedContent.issues).toEqual([])
  })
})

// ============ indexOf-based offset resolution ============

describe('parseBedrockResponse - indexOf-based offset resolution', () => {
  it('uses indexOf to find actual position when model offsets are wrong', () => {
    // Model hallucinated start=1000,end=1007 but "utilise" is actually at offset 22
    const originalText = SAMPLE_UTILISE_TEXT
    const response = buildIssuePositionsResponse(
      '{"issues":[{"ref":1,"start":1000,"end":1007,"type":"plain-english","text":"utilise"}]}'
    )
    const result = parseBedrockResponse(response, undefined, originalText)
    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].start).toBe(
      originalText.indexOf('utilise')
    )
    expect(result.reviewedContent.issues[0].end).toBe(
      originalText.indexOf('utilise') + 'utilise'.length
    )
    expect(result.reviewedContent.issues[0].text).toBe('utilise')
  })

  it('discards issue when text field is not found in originalText', () => {
    const originalText = 'Some completely different content here.'
    const response = buildIssuePositionsResponse(
      '{"issues":[{"ref":1,"start":0,"end":7,"type":"plain-english","text":"utilise"}]}'
    )
    const result = parseBedrockResponse(response, undefined, originalText)
    expect(result.reviewedContent.issues).toEqual([])
  })
})

// ============ Empty [ISSUE_POSITIONS] content ============

describe('parseBedrockResponse - empty [ISSUE_POSITIONS] content (line 102)', () => {
  it('returns empty issues when [ISSUE_POSITIONS] section is whitespace only', () => {
    const response = '[ISSUE_POSITIONS]   \n[/ISSUE_POSITIONS]'
    const result = parseBedrockResponse(
      response,
      undefined,
      ORIGINAL_TEXT_DEFAULT
    )
    expect(result.reviewedContent.issues).toEqual([])
    expect(result.reviewedContent.plainText).toBe(ORIGINAL_TEXT_DEFAULT)
  })
})

// ============ Score line edge cases ============

describe('parseBedrockResponse - malformed score line (line 157)', () => {
  it('skips score line where value does not match digit/5 pattern', () => {
    const response = [
      '[SCORES]',
      'Clarity: great/5 - Not a valid score',
      '[/SCORES]'
    ].join('\n')
    const result = parseBedrockResponse(response)
    expect(result.scores.clarity).toBeUndefined()
  })
})

describe('parseBedrockResponse - score line with no dash (line 164)', () => {
  it('skips score line where there is no dash after position 3', () => {
    const response = ['[SCORES]', 'Clarity: 3/5 NoDashHere', '[/SCORES]'].join(
      '\n'
    )
    const result = parseBedrockResponse(response)
    expect(result.scores.clarity).toBeUndefined()
  })
})
