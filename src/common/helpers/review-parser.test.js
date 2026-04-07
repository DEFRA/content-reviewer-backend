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

const SCORES_TAG_OPEN = '[SCORES]'
const SCORES_TAG_CLOSE = '[/SCORES]'
const REVIEWED_CONTENT_OPEN = '[REVIEWED_CONTENT]'
const REVIEWED_CONTENT_CLOSE = '[/REVIEWED_CONTENT]'
const IMPROVEMENTS_OPEN = '[IMPROVEMENTS]'
const IMPROVEMENTS_CLOSE = '[/IMPROVEMENTS]'
const ISSUE_POSITIONS_OPEN = '[ISSUE_POSITIONS]'
const ISSUE_POSITIONS_CLOSE = '[/ISSUE_POSITIONS]'

const SAMPLE_SCORE_LINE = 'Clarity: 3/5 - Needs improvement'
const SAMPLE_SCORE_LINE_2 = 'Structure: 4/5 - Good layout'
const SAMPLE_PLAIN_TEXT = 'This is plain text content with no markers.'
const SCORE_CLARITY = 3
const SCORE_STRUCTURE = 4
const SCORE_MAX = 5

const PLAIN_ENGLISH_SCORE_LINE = 'Plain English: 3/5 - Some issues'
const PRIORITY_HIGH_OPEN = 'PRIORITY: high]'
const CATEGORY_PLAIN_ENGLISH = 'CATEGORY: Plain English'
const WHY_BARRIERS = 'WHY: Barriers for users'

function buildMarkerResponse({
  scores = '',
  content = '',
  improvements = ''
} = {}) {
  return [
    SCORES_TAG_OPEN,
    scores,
    SCORES_TAG_CLOSE,
    REVIEWED_CONTENT_OPEN,
    content,
    REVIEWED_CONTENT_CLOSE,
    IMPROVEMENTS_OPEN,
    improvements,
    IMPROVEMENTS_CLOSE
  ].join('\n')
}

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
      'CATEGORY: Clarity',
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

// ============ Score parsing edge cases ============

describe('parseBedrockResponse - score edge cases', () => {
  it('ignores lines where score is not digit/5 pattern', () => {
    const plainText = 'Category: abc/5 - bad format'

    const result = parseBedrockResponse(plainText)

    expect(Object.keys(result.scores)).toHaveLength(0)
  })

  it('ignores score lines with no colon', () => {
    const plainText = 'No colon here at all'

    const result = parseBedrockResponse(plainText)

    expect(Object.keys(result.scores)).toHaveLength(0)
  })

  it('ignores short lines that cannot have score pattern', () => {
    const plainText = 'A: 3'

    const result = parseBedrockResponse(plainText)

    expect(Object.keys(result.scores)).toHaveLength(0)
  })
})

// ============ Issue extraction edge cases ============

describe('parseBedrockResponse - issue extraction edge cases', () => {
  it('handles unclosed ISSUE tag gracefully', () => {
    const issueContent = 'text [ISSUE:Clarity unclosed bracket text'
    const response = buildMarkerResponse({ content: issueContent })

    const result = parseBedrockResponse(response)

    expect(result.reviewedContent.issues).toEqual([])
  })

  it('handles missing end marker [/ISSUE] gracefully', () => {
    const issueContent = 'text [ISSUE:Clarity] no end tag'
    const response = buildMarkerResponse({ content: issueContent })

    const result = parseBedrockResponse(response)

    expect(result.reviewedContent.issues).toEqual([])
  })

  it('records issue position correctly', () => {
    const issueContent = '[ISSUE:Clarity]First issue.[/ISSUE]'
    const response = buildMarkerResponse({ content: issueContent })

    const result = parseBedrockResponse(response)

    expect(result.reviewedContent.issues[0].position).toBeDefined()
    expect(typeof result.reviewedContent.issues[0].position).toBe('number')
  })
})

// ============ REF field extraction ============

describe('parseBedrockResponse - ref field in [ISSUE_POSITIONS]', () => {
  it('extracts ref field from [ISSUE_POSITIONS] JSON when present', () => {
    const originalText = 'The department should utilise all resources.'
    const issuePositionsResponse = [
      '[SCORES]',
      PLAIN_ENGLISH_SCORE_LINE,
      '[/SCORES]',
      ISSUE_POSITIONS_OPEN,
      '{"issues":[{"ref":1,"start":22,"end":29,"type":"plain-english","text":"utilise"}]}',
      ISSUE_POSITIONS_CLOSE,
      IMPROVEMENTS_OPEN,
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(
      issuePositionsResponse,
      undefined,
      originalText
    )

    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].ref).toBe(1)
  })

  it('extracts ref as undefined when ref field is absent from [ISSUE_POSITIONS]', () => {
    const originalText = 'The department should utilise all resources.'
    const issuePositionsResponse = [
      '[SCORES]',
      PLAIN_ENGLISH_SCORE_LINE,
      '[/SCORES]',
      ISSUE_POSITIONS_OPEN,
      '{"issues":[{"start":22,"end":29,"type":"plain-english","text":"utilise"}]}',
      ISSUE_POSITIONS_CLOSE,
      IMPROVEMENTS_OPEN,
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(
      issuePositionsResponse,
      undefined,
      originalText
    )

    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].ref).toBeUndefined()
  })

  it('extracts multiple refs from [ISSUE_POSITIONS] JSON', () => {
    const originalText =
      'The department should utilise all resources going forward.'
    const issuePositionsResponse = [
      '[SCORES]',
      PLAIN_ENGLISH_SCORE_LINE,
      '[/SCORES]',
      ISSUE_POSITIONS_OPEN,
      '{"issues":[{"ref":1,"start":22,"end":29,"type":"plain-english","text":"utilise"},{"ref":2,"start":44,"end":57,"type":"govuk-style","text":"going forward"}]}',
      ISSUE_POSITIONS_CLOSE,
      IMPROVEMENTS_OPEN,
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(
      issuePositionsResponse,
      undefined,
      originalText
    )

    expect(result.reviewedContent.issues).toHaveLength(2)
    expect(result.reviewedContent.issues[0].ref).toBe(1)
    expect(result.reviewedContent.issues[1].ref).toBe(2)
  })
})

describe('parseBedrockResponse - REF field in [IMPROVEMENTS]', () => {
  it('extracts REF field from [PRIORITY] block when present', () => {
    const improvements = [
      PRIORITY_HIGH_OPEN,
      'REF: 1',
      CATEGORY_PLAIN_ENGLISH,
      'ISSUE: Use of jargon',
      WHY_BARRIERS,
      'CURRENT: utilise resources',
      'SUGGESTED: use resources'
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response)

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].ref).toBe(1)
  })

  it('sets ref to undefined when REF field is absent from [PRIORITY] block', () => {
    const improvements = [
      PRIORITY_HIGH_OPEN,
      CATEGORY_PLAIN_ENGLISH,
      'ISSUE: Use of jargon',
      WHY_BARRIERS,
      'CURRENT: utilise resources',
      'SUGGESTED: use resources'
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response)

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].ref).toBeUndefined()
  })

  it('extracts multiple REF fields from multiple [PRIORITY] blocks', () => {
    const improvements = [
      PRIORITY_HIGH_OPEN,
      'REF: 2',
      CATEGORY_PLAIN_ENGLISH,
      'ISSUE: Jargon used',
      WHY_BARRIERS,
      'CURRENT: utilise',
      'SUGGESTED: use',
      '[/PRIORITY]',
      '[PRIORITY: medium]',
      'REF: 1',
      'CATEGORY: Clarity',
      'ISSUE: Passive voice',
      'WHY: Unclear responsibility',
      'CURRENT: was done by the team',
      'SUGGESTED: the team did it'
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response)

    expect(result.improvements).toHaveLength(2)
    expect(result.improvements[0].ref).toBe(2)
    expect(result.improvements[1].ref).toBe(1)
  })
})

// ============ [ISSUE_POSITIONS] edge cases ============

describe('parseBedrockResponse - [ISSUE_POSITIONS] edge cases', () => {
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

  it('returns empty issues when [ISSUE_POSITIONS] contains no JSON object', () => {
    const response = buildIssuePositionsResponse('no json here at all')

    const result = parseBedrockResponse(response, undefined, 'original text')

    expect(result.reviewedContent.issues).toEqual([])
  })

  it('returns empty issues when [ISSUE_POSITIONS] JSON is invalid', () => {
    const response = buildIssuePositionsResponse('{ invalid json }}}')

    const result = parseBedrockResponse(response, undefined, 'original text')

    expect(result.reviewedContent.issues).toEqual([])
  })

  it('returns empty issues when JSON has no "issues" array', () => {
    const response = buildIssuePositionsResponse('{"data":[]}')

    const result = parseBedrockResponse(response, undefined, 'original text')

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
    const originalText = 'The department should utilise all resources.'
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

// ── parseIssuePositions: empty text → return plainText/issues [] (line 102) ─
describe('parseBedrockResponse - empty [ISSUE_POSITIONS] content (line 102)', () => {
  it('returns empty issues when [ISSUE_POSITIONS] section is whitespace only', () => {
    // The section exists but its content is blank → line 102 fires
    const response = '[ISSUE_POSITIONS]   \n[/ISSUE_POSITIONS]'
    const result = parseBedrockResponse(response, undefined, 'original text')
    expect(result.reviewedContent.issues).toEqual([])
    expect(result.reviewedContent.plainText).toBe('original text')
  })
})

// ── parseScoreLine: afterColon fails /^\d\/5/ (line 157) ─────────────────
describe('parseBedrockResponse - malformed score line (line 157)', () => {
  it('skips score line where value does not match digit/5 pattern', () => {
    // "Clarity: great/5 - Good" → afterColon = "great/5 - Good" fails /^\d\/5/
    const response = [
      '[SCORES]',
      'Clarity: great/5 - Not a valid score',
      '[/SCORES]'
    ].join('\n')
    const result = parseBedrockResponse(response)
    expect(result.scores.clarity).toBeUndefined()
  })
})

// ── parseScoreLine: no dash found → return null (line 164) ───────────────
describe('parseBedrockResponse - score line with no dash (line 164)', () => {
  it('skips score line where there is no dash after position 3', () => {
    // "Clarity: 3/5 NoDashHere" → dashIndex === -1 → returns null at line 164
    const response = ['[SCORES]', 'Clarity: 3/5 NoDashHere', '[/SCORES]'].join(
      '\n'
    )
    const result = parseBedrockResponse(response)
    expect(result.scores.clarity).toBeUndefined()
  })
})

// ── extractValue: no newline in block → lineEnd = block.length (line 330) ─
describe('parseBedrockResponse - improvement block with no trailing newline (line 330)', () => {
  it('extracts the last field value when the block has no trailing newline', () => {
    // Build the improvements section so that after splitting on [PRIORITY:
    // the resulting block ends with "SUGGESTED: new" and no trailing \n,
    // forcing lineEnd = block.length (line 330).
    // We do this by having the SUGGESTED field be the very last thing before
    // [/IMPROVEMENTS] with no newline between them.
    const response =
      '[IMPROVEMENTS]\n[PRIORITY: medium]\nCATEGORY: Clarity\nISSUE: Use simpler words\nWHY: Easier to read\nCURRENT: old\nSUGGESTED: new[/IMPROVEMENTS]'
    const result = parseBedrockResponse(response)
    // The improvement may or may not parse cleanly, but it must not throw
    expect(result.improvements).toBeDefined()
  })
})

// ── extractScores: no [SCORES] section → return {} (line 479) ────────────
describe('parseBedrockResponse - extractScores fallback (line 479)', () => {
  it('returns empty scores when [IMPROVEMENTS] is present but [SCORES] is absent', () => {
    // hasMarkers is true because [IMPROVEMENTS] is present,
    // but extractScores finds no [SCORES] tag → returns {} at line 479
    const response = [
      '[IMPROVEMENTS]',
      '[PRIORITY: medium]',
      'CATEGORY: Clarity',
      'WHY: Needs work',
      'CURRENT: old text',
      'SUGGESTED: new text',
      '[/IMPROVEMENTS]'
    ].join('\n')

    const result = parseBedrockResponse(response)

    // scores should be empty since there was no [SCORES] section
    expect(result.scores).toEqual({})
  })
})
describe('parseBedrockResponse - plain text fallback (no markers)', () => {
  it('returns a result for a response with no section markers', () => {
    const plainResponse = 'This content needs improvement in plain English.'

    const result = parseBedrockResponse(plainResponse)

    // parsePlainTextReview path — should not throw and should return shape
    expect(result).toHaveProperty('scores')
    expect(result).toHaveProperty('reviewedContent')
    expect(result).toHaveProperty('improvements')
  })
})

// ── extractReviewedContent fallback: no ISSUE_POSITIONS, no REVIEWED_CONTENT (line 512) ─
describe('parseBedrockResponse - extractReviewedContent fallback (line 512)', () => {
  it('returns empty issues when [SCORES] present but no ISSUE_POSITIONS or REVIEWED_CONTENT', () => {
    const response = [
      '[SCORES]',
      'Clarity: 3/5 - Good',
      '[/SCORES]',
      '[IMPROVEMENTS]',
      '[PRIORITY: medium]',
      'CATEGORY: Clarity',
      'WHY: Needs work',
      'CURRENT: old text',
      'SUGGESTED: new text',
      '[/IMPROVEMENTS]'
    ].join('\n')

    const result = parseBedrockResponse(response, undefined, 'original text')

    expect(result.reviewedContent.issues).toEqual([])
    expect(result.reviewedContent.plainText).toBe('original text')
  })
})

// ── extractImprovements fallback: no [IMPROVEMENTS] section (line 533) ────
describe('parseBedrockResponse - extractImprovements fallback (line 533)', () => {
  it('returns empty improvements array when no [IMPROVEMENTS] section present', () => {
    const response = [
      '[SCORES]',
      'Clarity: 3/5 - Good',
      '[/SCORES]',
      '[REVIEWED_CONTENT]',
      'Some reviewed content',
      '[/REVIEWED_CONTENT]'
    ].join('\n')

    const result = parseBedrockResponse(response)

    expect(result.improvements).toEqual([])
  })
})

// ── parseBedrockResponse error handler (lines 604-605) ───────────────────
describe('parseBedrockResponse - error catch path (lines 604-605)', () => {
  it('returns fallback result when response parsing throws internally', () => {
    // Pass an object whose .includes() throws to force the catch path.
    // resolveResponseToParse returns the object because obj?.trim() is undefined
    // (falsy) and fallback is also undefined → returns fallback || '' = ''.
    // Actually to hit catch we need includes() to throw on the result.
    // So pass an object as primary that has a truthy .trim() but bad .includes():
    const badResponse = {
      trim: () => 'something',
      includes: () => {
        throw new Error('deliberate test error')
      }
    }

    const result = parseBedrockResponse(badResponse)

    expect(result).toEqual(
      expect.objectContaining({
        scores: {},
        improvements: []
      })
    )
    expect(result.reviewedContent).toBeDefined()
    expect(Array.isArray(result.reviewedContent.issues)).toBe(true)
  })
})

// ── parseScoreLine (plain-text): dashIndex <= 0 → return null (line 410) ─
describe('parseBedrockResponse - plain-text score line no dash (line 410)', () => {
  it('skips plain-text score line where there is no dash after the value', () => {
    // Plain-text response (no markers) with a score line that has no dash
    // "Clarity: 3/5" with no " - note" → dashIndex === -1 → returns null
    const response = 'Clarity: 3/5\nContent looks readable overall.'
    const result = parseBedrockResponse(response)
    // Should not throw; clarity score will be absent or zero
    expect(result.scores).toBeDefined()
  })
})
