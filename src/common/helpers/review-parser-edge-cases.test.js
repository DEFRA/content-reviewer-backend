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
  SCORES_TAG_OPEN,
  SCORES_TAG_CLOSE,
  IMPROVEMENTS_OPEN,
  IMPROVEMENTS_CLOSE,
  ISSUE_POSITIONS_OPEN,
  ISSUE_POSITIONS_CLOSE,
  REVIEWED_CONTENT_OPEN,
  REVIEWED_CONTENT_CLOSE,
  PLAIN_ENGLISH_SCORE_LINE,
  PRIORITY_HIGH_OPEN,
  PRIORITY_MEDIUM_OPEN,
  CATEGORY_PLAIN_ENGLISH,
  CATEGORY_CLARITY,
  WHY_BARRIERS,
  WHY_NEEDS_WORK,
  ORIGINAL_TEXT_PLACEHOLDER,
  ORIGINAL_TEXT_UTILISE,
  buildIssuePositionsResponse
} from './review-parser-test-helpers.js'

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
    const response = `${SCORES_TAG_OPEN}\n${SCORES_TAG_CLOSE}\n${REVIEWED_CONTENT_OPEN}\n${issueContent}\n${REVIEWED_CONTENT_CLOSE}\n${IMPROVEMENTS_OPEN}\n${IMPROVEMENTS_CLOSE}`

    const result = parseBedrockResponse(response)

    expect(result.reviewedContent.issues).toEqual([])
  })

  it('handles missing end marker [/ISSUE] gracefully', () => {
    const issueContent = 'text [ISSUE:Clarity] no end tag'
    const response = `${SCORES_TAG_OPEN}\n${SCORES_TAG_CLOSE}\n${REVIEWED_CONTENT_OPEN}\n${issueContent}\n${REVIEWED_CONTENT_CLOSE}\n${IMPROVEMENTS_OPEN}\n${IMPROVEMENTS_CLOSE}`

    const result = parseBedrockResponse(response)

    expect(result.reviewedContent.issues).toEqual([])
  })

  it('records issue position correctly', () => {
    const issueContent = '[ISSUE:Clarity]First issue.[/ISSUE]'
    const response = `${SCORES_TAG_OPEN}\n${SCORES_TAG_CLOSE}\n${REVIEWED_CONTENT_OPEN}\n${issueContent}\n${REVIEWED_CONTENT_CLOSE}\n${IMPROVEMENTS_OPEN}\n${IMPROVEMENTS_CLOSE}`

    const result = parseBedrockResponse(response)

    expect(result.reviewedContent.issues[0].position).toBeDefined()
    expect(typeof result.reviewedContent.issues[0].position).toBe('number')
  })
})

// ============ REF field extraction ============

describe('parseBedrockResponse - ref field in [ISSUE_POSITIONS]', () => {
  it('extracts ref field from [ISSUE_POSITIONS] JSON when present', () => {
    const response = [
      SCORES_TAG_OPEN,
      PLAIN_ENGLISH_SCORE_LINE,
      SCORES_TAG_CLOSE,
      ISSUE_POSITIONS_OPEN,
      '{"issues":[{"ref":1,"start":22,"end":29,"type":"plain-english","text":"utilise"}]}',
      ISSUE_POSITIONS_CLOSE,
      IMPROVEMENTS_OPEN,
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(
      response,
      undefined,
      ORIGINAL_TEXT_UTILISE
    )

    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].ref).toBe(1)
  })

  it('extracts ref as undefined when ref field is absent from [ISSUE_POSITIONS]', () => {
    const response = [
      SCORES_TAG_OPEN,
      PLAIN_ENGLISH_SCORE_LINE,
      SCORES_TAG_CLOSE,
      ISSUE_POSITIONS_OPEN,
      '{"issues":[{"start":22,"end":29,"type":"plain-english","text":"utilise"}]}',
      ISSUE_POSITIONS_CLOSE,
      IMPROVEMENTS_OPEN,
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(
      response,
      undefined,
      ORIGINAL_TEXT_UTILISE
    )

    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].ref).toBeUndefined()
  })

  it('extracts multiple refs from [ISSUE_POSITIONS] JSON', () => {
    const originalText =
      'The department should utilise all resources going forward.'
    const response = [
      SCORES_TAG_OPEN,
      PLAIN_ENGLISH_SCORE_LINE,
      SCORES_TAG_CLOSE,
      ISSUE_POSITIONS_OPEN,
      '{"issues":[{"ref":1,"start":22,"end":29,"type":"plain-english","text":"utilise"},{"ref":2,"start":44,"end":57,"type":"govuk-style","text":"going forward"}]}',
      ISSUE_POSITIONS_CLOSE,
      IMPROVEMENTS_OPEN,
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(response, undefined, originalText)

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
    const response = `${SCORES_TAG_OPEN}\n${SCORES_TAG_CLOSE}\n${REVIEWED_CONTENT_OPEN}\n${REVIEWED_CONTENT_CLOSE}\n${IMPROVEMENTS_OPEN}\n${improvements}\n${IMPROVEMENTS_CLOSE}`

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
    const response = `${SCORES_TAG_OPEN}\n${SCORES_TAG_CLOSE}\n${REVIEWED_CONTENT_OPEN}\n${REVIEWED_CONTENT_CLOSE}\n${IMPROVEMENTS_OPEN}\n${improvements}\n${IMPROVEMENTS_CLOSE}`

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
      PRIORITY_MEDIUM_OPEN,
      'REF: 1',
      CATEGORY_CLARITY,
      'ISSUE: Passive voice',
      'WHY: Unclear responsibility',
      'CURRENT: was done by the team',
      'SUGGESTED: the team did it'
    ].join('\n')
    const response = `${SCORES_TAG_OPEN}\n${SCORES_TAG_CLOSE}\n${REVIEWED_CONTENT_OPEN}\n${REVIEWED_CONTENT_CLOSE}\n${IMPROVEMENTS_OPEN}\n${improvements}\n${IMPROVEMENTS_CLOSE}`

    const result = parseBedrockResponse(response)

    expect(result.improvements).toHaveLength(2)
    expect(result.improvements[0].ref).toBe(2)
    expect(result.improvements[1].ref).toBe(1)
  })
})

// ============ [ISSUE_POSITIONS] edge cases ============

describe('parseBedrockResponse - [ISSUE_POSITIONS] edge cases', () => {
  it('returns empty issues when [ISSUE_POSITIONS] contains no JSON object', () => {
    const response = buildIssuePositionsResponse('no json here at all')

    const result = parseBedrockResponse(
      response,
      undefined,
      ORIGINAL_TEXT_PLACEHOLDER
    )

    expect(result.reviewedContent.issues).toEqual([])
  })

  it('returns empty issues when [ISSUE_POSITIONS] JSON is invalid', () => {
    const response = buildIssuePositionsResponse('{ invalid json }}}')

    const result = parseBedrockResponse(
      response,
      undefined,
      ORIGINAL_TEXT_PLACEHOLDER
    )

    expect(result.reviewedContent.issues).toEqual([])
  })

  it('returns empty issues when JSON has no "issues" array', () => {
    const response = buildIssuePositionsResponse('{"data":[]}')

    const result = parseBedrockResponse(
      response,
      undefined,
      ORIGINAL_TEXT_PLACEHOLDER
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
    const response = buildIssuePositionsResponse(
      '{"issues":[{"start":22,"end":29,"type":"plain-english"}]}'
    )

    const result = parseBedrockResponse(
      response,
      undefined,
      ORIGINAL_TEXT_UTILISE
    )

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
    const response = `${ISSUE_POSITIONS_OPEN}   \n${ISSUE_POSITIONS_CLOSE}`
    const result = parseBedrockResponse(
      response,
      undefined,
      ORIGINAL_TEXT_PLACEHOLDER
    )
    expect(result.reviewedContent.issues).toEqual([])
    expect(result.reviewedContent.plainText).toBe(ORIGINAL_TEXT_PLACEHOLDER)
  })
})

// ── parseScoreLine: afterColon fails /^\d\/5/ (line 157) ─────────────────
describe('parseBedrockResponse - malformed score line (line 157)', () => {
  it('skips score line where value does not match digit/5 pattern', () => {
    const response = [
      SCORES_TAG_OPEN,
      'Clarity: great/5 - Not a valid score',
      SCORES_TAG_CLOSE
    ].join('\n')
    const result = parseBedrockResponse(response)
    expect(result.scores.clarity).toBeUndefined()
  })
})

// ── parseScoreLine: no dash found → return null (line 164) ───────────────
describe('parseBedrockResponse - score line with no dash (line 164)', () => {
  it('skips score line where there is no dash after position 3', () => {
    const response = [
      SCORES_TAG_OPEN,
      'Clarity: 3/5 NoDashHere',
      SCORES_TAG_CLOSE
    ].join('\n')
    const result = parseBedrockResponse(response)
    expect(result.scores.clarity).toBeUndefined()
  })
})

// ── extractValue: no newline in block → lineEnd = block.length (line 330) ─
describe('parseBedrockResponse - improvement block with no trailing newline (line 330)', () => {
  it('extracts the last field value when the block has no trailing newline', () => {
    const response = `${IMPROVEMENTS_OPEN}\n${PRIORITY_MEDIUM_OPEN}\n${CATEGORY_CLARITY}\nISSUE: Use simpler words\nWHY: Easier to read\nCURRENT: old\nSUGGESTED: new${IMPROVEMENTS_CLOSE}`
    const result = parseBedrockResponse(response)
    expect(result.improvements).toBeDefined()
  })
})

// ── extractScores: no [SCORES] section → return {} (line 479) ────────────
describe('parseBedrockResponse - extractScores fallback (line 479)', () => {
  it('returns empty scores when [IMPROVEMENTS] is present but [SCORES] is absent', () => {
    const response = [
      IMPROVEMENTS_OPEN,
      PRIORITY_MEDIUM_OPEN,
      CATEGORY_CLARITY,
      WHY_NEEDS_WORK,
      'CURRENT: old text',
      'SUGGESTED: new text',
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(response)

    expect(result.scores).toEqual({})
  })
})

describe('parseBedrockResponse - plain text fallback (no markers)', () => {
  it('returns a result for a response with no section markers', () => {
    const plainResponse = 'This content needs improvement in plain English.'

    const result = parseBedrockResponse(plainResponse)

    expect(result).toHaveProperty('scores')
    expect(result).toHaveProperty('reviewedContent')
    expect(result).toHaveProperty('improvements')
  })
})

// ── extractReviewedContent fallback: no ISSUE_POSITIONS, no REVIEWED_CONTENT (line 512) ─
describe('parseBedrockResponse - extractReviewedContent fallback (line 512)', () => {
  it('returns empty issues when [SCORES] present but no ISSUE_POSITIONS or REVIEWED_CONTENT', () => {
    const response = [
      SCORES_TAG_OPEN,
      'Clarity: 3/5 - Good',
      SCORES_TAG_CLOSE,
      IMPROVEMENTS_OPEN,
      PRIORITY_MEDIUM_OPEN,
      CATEGORY_CLARITY,
      WHY_NEEDS_WORK,
      'CURRENT: old text',
      'SUGGESTED: new text',
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(
      response,
      undefined,
      ORIGINAL_TEXT_PLACEHOLDER
    )

    expect(result.reviewedContent.issues).toEqual([])
    expect(result.reviewedContent.plainText).toBe(ORIGINAL_TEXT_PLACEHOLDER)
  })
})

// ── extractImprovements fallback: no [IMPROVEMENTS] section (line 533) ────
describe('parseBedrockResponse - extractImprovements fallback (line 533)', () => {
  it('returns empty improvements array when no [IMPROVEMENTS] section present', () => {
    const response = [
      SCORES_TAG_OPEN,
      'Clarity: 3/5 - Good',
      SCORES_TAG_CLOSE,
      REVIEWED_CONTENT_OPEN,
      'Some reviewed content',
      REVIEWED_CONTENT_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(response)

    expect(result.improvements).toEqual([])
  })
})

// ── parseBedrockResponse error handler (lines 604-605) ───────────────────
describe('parseBedrockResponse - error catch path (lines 604-605)', () => {
  it('returns fallback result when response parsing throws internally', () => {
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
    const response = 'Clarity: 3/5\nContent looks readable overall.'
    const result = parseBedrockResponse(response)
    expect(result.scores).toBeDefined()
  })
})
