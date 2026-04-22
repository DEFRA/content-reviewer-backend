import { describe, it, expect } from 'vitest'
import { parseBedrockResponse } from './review-parser.js'

// Helpers to build a minimal [ISSUE_POSITIONS] response
function buildResponse(issues) {
  return `[ISSUE_POSITIONS]\n${JSON.stringify({ issues })}\n[/ISSUE_POSITIONS]`
}

const SHORT_SENTENCE = 'The quick brown fox jumps.'
const QUICK_START = 4
const QUICK_END = 9
const PADDING_SHORT = 50
const PADDING_OVER_WINDOW = 2000
const INNER_TEXT = 'important text here'
const INNER_START = 50
const INNER_END = 69

describe('review-parser - fuzzy offset correction', () => {
  it('accepts exact offsets without correction', () => {
    const response = buildResponse([
      { start: QUICK_START, end: QUICK_END, text: 'quick', ref: 1 }
    ])

    const result = parseBedrockResponse(response, null, SHORT_SENTENCE)

    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].start).toBe(QUICK_START)
    expect(result.reviewedContent.issues[0].end).toBe(QUICK_END)
    expect(result.reviewedContent.issues[0].text).toBe('quick')
  })

  it('corrects offsets when model states wrong start/end but text is present nearby', () => {
    // Model says start=100,end=105 but "quick" is at 4-9
    const response = buildResponse([
      { start: 100, end: 105, text: 'quick', ref: 1 }
    ])

    const result = parseBedrockResponse(response, null, SHORT_SENTENCE)

    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].start).toBe(QUICK_START)
    expect(result.reviewedContent.issues[0].end).toBe(QUICK_END)
    expect(result.reviewedContent.issues[0].text).toBe('quick')
  })

  it('discards issue when text cannot be found anywhere in originalText', () => {
    const response = buildResponse([
      { start: 0, end: 7, text: 'missing', ref: 1 }
    ])

    const result = parseBedrockResponse(response, null, SHORT_SENTENCE)

    expect(result.reviewedContent.issues).toHaveLength(0)
  })

  it('corrects offsets when text is found at a different position within the fuzzy window', () => {
    // text starts at position 50; model claims it is at 10
    const originalText = `${'A'.repeat(PADDING_SHORT)}${INNER_TEXT}${'A'.repeat(PADDING_SHORT)}`
    const response = buildResponse([
      { start: 10, end: 29, text: INNER_TEXT, ref: 1 }
    ])

    const result = parseBedrockResponse(response, null, originalText)

    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].start).toBe(INNER_START)
    expect(result.reviewedContent.issues[0].end).toBe(INNER_END)
  })

  it('discards issue when text is further away than the fuzzy window', () => {
    // text "needle" is at 2000 but model states start=0; window is 1000 chars
    const originalText = `${'A'.repeat(PADDING_OVER_WINDOW)}needle`
    const response = buildResponse([
      { start: 0, end: 6, text: 'needle', ref: 1 }
    ])

    const result = parseBedrockResponse(response, null, originalText)

    expect(result.reviewedContent.issues).toHaveLength(0)
  })
})
