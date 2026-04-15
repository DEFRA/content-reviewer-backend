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
import {
  SAMPLE_SCORE_LINE,
  SAMPLE_SCORE_LINE_2,
  SAMPLE_PLAIN_TEXT,
  SCORE_CLARITY,
  SCORE_STRUCTURE,
  SCORE_MAX,
  CATEGORY_CLARITY,
  buildMarkerResponse
} from './review-parser-test-helpers.js'

// ============ parseBedrockResponse - marker-based ============

describe('parseBedrockResponse - marker-based format', () => {
  it('parses scores section correctly', () => {
    const response = buildMarkerResponse({
      scores: `${SAMPLE_SCORE_LINE}\n${SAMPLE_SCORE_LINE_2}`
    })

    const result = parseBedrockResponse(response)

    expect(result.scores).toHaveProperty('Clarity')
    expect(result.scores.Clarity.score).toBe(SCORE_CLARITY)
    expect(result.scores.Clarity.note).toBe('Needs improvement')
  })

  it('parses multiple scores', () => {
    const response = buildMarkerResponse({
      scores: `${SAMPLE_SCORE_LINE}\n${SAMPLE_SCORE_LINE_2}`
    })

    const result = parseBedrockResponse(response)

    expect(result.scores).toHaveProperty('Structure')
    expect(result.scores.Structure.score).toBe(SCORE_STRUCTURE)
  })

  it('parses reviewed content plain text', () => {
    const response = buildMarkerResponse({
      content: 'This is reviewed content without issues.'
    })

    const result = parseBedrockResponse(response)

    expect(result.reviewedContent.plainText).toBe(
      'This is reviewed content without issues.'
    )
  })

  it('extracts issues from reviewed content', () => {
    const issueContent =
      'Some text [ISSUE:Clarity]This is unclear.[/ISSUE] more text'
    const response = buildMarkerResponse({ content: issueContent })

    const result = parseBedrockResponse(response)

    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].category).toBe('Clarity')
    expect(result.reviewedContent.issues[0].text).toBe('This is unclear.')
  })

  it('extracts multiple issues from content', () => {
    const issueContent =
      '[ISSUE:Clarity]First issue.[/ISSUE] text [ISSUE:Structure]Second issue.[/ISSUE]'
    const response = buildMarkerResponse({ content: issueContent })

    const result = parseBedrockResponse(response)

    expect(result.reviewedContent.issues).toHaveLength(2)
  })

  it('removes issue markers from plain text', () => {
    const issueContent = 'Before [ISSUE:Clarity]marked text[/ISSUE] after'
    const response = buildMarkerResponse({ content: issueContent })

    const result = parseBedrockResponse(response)

    expect(result.reviewedContent.plainText).not.toContain('[ISSUE:')
    expect(result.reviewedContent.plainText).not.toContain('[/ISSUE]')
    expect(result.reviewedContent.plainText).toContain('Before')
    expect(result.reviewedContent.plainText).toContain('after')
  })

  it('parses improvements section', () => {
    const improvements = [
      'PRIORITY:high]',
      CATEGORY_CLARITY,
      'ISSUE: Unclear heading',
      'WHY: Hard to understand',
      'CURRENT: Old text',
      'SUGGESTED: New text'
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response)

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].category).toBe('Clarity')
    expect(result.improvements[0].issue).toBe('Unclear heading')
    expect(result.improvements[0].why).toBe('Hard to understand')
  })

  it('returns empty improvements for malformed blocks', () => {
    const improvements = 'PRIORITY:high]\nno valid fields here\n'
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response)

    expect(result.improvements).toEqual([])
  })
})

describe('parseBedrockResponse - marker-based empty sections', () => {
  it('returns empty scores when scores section is empty', () => {
    const response = buildMarkerResponse({ scores: '' })

    const result = parseBedrockResponse(response)

    expect(result.scores).toEqual({})
  })

  it('returns empty issues when content has no issue markers', () => {
    const response = buildMarkerResponse({
      content: 'Plain content, no markers.'
    })

    const result = parseBedrockResponse(response)

    expect(result.reviewedContent.issues).toEqual([])
  })
})

// ============ parseBedrockResponse - plain text format ============

describe('parseBedrockResponse - plain text format', () => {
  it('returns reviewedContent with plain text when no markers present', () => {
    const result = parseBedrockResponse(SAMPLE_PLAIN_TEXT)

    expect(result.reviewedContent.plainText).toBe(SAMPLE_PLAIN_TEXT)
  })

  it('returns empty issues when no markers present', () => {
    const result = parseBedrockResponse(SAMPLE_PLAIN_TEXT)

    expect(result.reviewedContent.issues).toEqual([])
  })

  it('returns empty improvements for plain text', () => {
    const result = parseBedrockResponse(SAMPLE_PLAIN_TEXT)

    expect(result.improvements).toEqual([])
  })

  it('parses score lines from plain text', () => {
    const plainTextWithScores = [
      'Here is my assessment:',
      'Clarity: 4/5 - Good plain English',
      'Structure: 3/5 - Could be better organised'
    ].join('\n')

    const result = parseBedrockResponse(plainTextWithScores)

    expect(result.scores).toHaveProperty('Clarity')
    expect(result.scores.Clarity.score).toBe(4)
  })

  it('ignores lines without score pattern', () => {
    const plainText = 'This is a great piece of content. No scores here.'

    const result = parseBedrockResponse(plainText)

    expect(Object.keys(result.scores)).toHaveLength(0)
  })

  it('handles score with em-dash separator', () => {
    const plainText = 'Clarity: 5/5 – Excellent plain English'

    const result = parseBedrockResponse(plainText)

    expect(result.scores).toHaveProperty('Clarity')
    expect(result.scores.Clarity.score).toBe(SCORE_MAX)
  })
})

// ============ parseBedrockResponse - fallback ============

describe('parseBedrockResponse - fallback behaviour', () => {
  it('falls back to fallbackRawResponse when parsed result is empty', () => {
    const emptyResponse = ''
    const fallback = `${SAMPLE_SCORE_LINE}\n`

    const result = parseBedrockResponse(emptyResponse, fallback)

    expect(result.scores).toHaveProperty('Clarity')
  })

  it('does not apply fallback when primary result has content', () => {
    const response = buildMarkerResponse({
      scores: SAMPLE_SCORE_LINE
    })

    const result = parseBedrockResponse(response, 'fallback content')

    expect(result.scores).toHaveProperty('Clarity')
  })

  it('applies marker-based fallback when fallback contains markers', () => {
    const emptyResponse = ''
    const fallbackWithMarkers = buildMarkerResponse({
      scores: SAMPLE_SCORE_LINE
    })

    const result = parseBedrockResponse(emptyResponse, fallbackWithMarkers)

    expect(result.scores).toHaveProperty('Clarity')
  })

  it('returns error fallback on thrown exception', () => {
    const result = parseBedrockResponse(null)

    expect(result.scores).toEqual({})
    expect(result.reviewedContent).toBeDefined()
    expect(result.improvements).toEqual([])
  })
})
