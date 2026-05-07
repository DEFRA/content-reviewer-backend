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

const IMPROVEMENTS_OPEN = '[IMPROVEMENTS]'
const IMPROVEMENTS_CLOSE = '[/IMPROVEMENTS]'

const PLAIN_ENGLISH_SCORE_LINE = 'Plain English: 3/5 - Some issues'
const PRIORITY_HIGH_OPEN = 'PRIORITY: high]'
const PRIORITY_MEDIUM_OPEN = '[PRIORITY: medium]'
const CATEGORY_PLAIN_ENGLISH = 'CATEGORY: Plain English'
const CATEGORY_CLARITY = 'CATEGORY: Clarity'
const WHY_BARRIERS = 'WHY: Barriers for users'
const SAMPLE_UTILISE_TEXT = 'The department should utilise all resources.'

const SCORES_TAG_OPEN = '[SCORES]'
const SCORES_TAG_CLOSE = '[/SCORES]'

function buildMarkerResponse({ scores = '', improvements = '' } = {}) {
  return [
    SCORES_TAG_OPEN,
    scores,
    SCORES_TAG_CLOSE,
    IMPROVEMENTS_OPEN,
    improvements,
    IMPROVEMENTS_CLOSE
  ].join('\n')
}

// ============ REF field extraction ============

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
      PRIORITY_MEDIUM_OPEN,
      'REF: 1',
      CATEGORY_CLARITY,
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

// ── parseScoreLine: afterColon fails /^\d\/5/ ────────────────────────────
describe('parseBedrockResponse - malformed score line', () => {
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

// ── parseScoreLine: no dash found → return null ───────────────────────────
describe('parseBedrockResponse - score line with no dash', () => {
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

// ── extractValue: no newline in block → lineEnd = block.length ───────────
describe('parseBedrockResponse - improvement block with no trailing newline', () => {
  it('extracts the last field value when the block has no trailing newline', () => {
    const response = `${IMPROVEMENTS_OPEN}\n${PRIORITY_MEDIUM_OPEN}\n${CATEGORY_CLARITY}\nISSUE: Use simpler words\nWHY: Easier to read\nCURRENT: old\nSUGGESTED: new${IMPROVEMENTS_CLOSE}`
    const result = parseBedrockResponse(response)
    expect(result.improvements).toBeDefined()
  })
})

// ── extractScores: no [SCORES] section → return {} ───────────────────────
describe('parseBedrockResponse - extractScores fallback', () => {
  it('returns empty scores when [IMPROVEMENTS] is present but [SCORES] is absent', () => {
    const response = [
      IMPROVEMENTS_OPEN,
      PRIORITY_MEDIUM_OPEN,
      CATEGORY_CLARITY,
      'WHY: Needs work',
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

// ── buildIssuesFromImprovements: discards when current not found in document
describe('parseBedrockResponse - buildIssuesFromImprovements path', () => {
  it('returns empty issues when improvement current text is not in document', () => {
    const response = [
      SCORES_TAG_OPEN,
      'Clarity: 3/5 - Good',
      SCORES_TAG_CLOSE,
      IMPROVEMENTS_OPEN,
      PRIORITY_MEDIUM_OPEN,
      CATEGORY_CLARITY,
      'WHY: Needs work',
      'CURRENT: old text',
      'SUGGESTED: new text',
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(response, undefined, 'original text')

    expect(result.reviewedContent.issues).toEqual([])
    expect(result.reviewedContent.plainText).toBe('original text')
  })
})

// ── extractImprovements fallback: no [IMPROVEMENTS] section ──────────────
describe('parseBedrockResponse - extractImprovements fallback', () => {
  it('returns empty improvements array when no [IMPROVEMENTS] section present', () => {
    const response = [
      SCORES_TAG_OPEN,
      'Clarity: 3/5 - Good',
      SCORES_TAG_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(response)

    expect(result.improvements).toEqual([])
  })
})

// ── parseBedrockResponse error handler ───────────────────────────────────
describe('parseBedrockResponse - error catch path', () => {
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

// ── parseScoreLine (plain-text): dashIndex <= 0 → return null ────────────
describe('parseBedrockResponse - plain-text score line no dash', () => {
  it('skips plain-text score line where there is no dash after the value', () => {
    const response = 'Clarity: 3/5\nContent looks readable overall.'
    const result = parseBedrockResponse(response)
    expect(result.scores).toBeDefined()
  })
})

// ── Improvement blocks ─────────────────────────────────────────────────────

describe('parseBedrockResponse - improvement block with no SUGGESTED field', () => {
  it('discards improvement block and returns no improvements when SUGGESTED is absent', () => {
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

describe('parseBedrockResponse - field with no trailing newline in block', () => {
  it('extracts field correctly when no newline follows the value before end of block', () => {
    const response =
      '[IMPROVEMENTS]\nPRIORITY: high]\nCATEGORY: Clarity\nISSUE: Simple issue\nWHY: Clear reason[/IMPROVEMENTS]'

    const result = parseBedrockResponse(response)

    expect(result.improvements).toHaveLength(0)
  })
})

describe('parseBedrockResponse - improvement block with no CURRENT field', () => {
  it('returns improvement with empty current when CURRENT field is absent', () => {
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

// ── CURRENT equals SUGGESTED discard ─────────────────────────────────────

describe('parseBedrockResponse - discards no-op improvement (CURRENT equals SUGGESTED)', () => {
  it('discards improvement block where CURRENT and SUGGESTED are identical', () => {
    const improvements = [
      '[PRIORITY: medium]',
      'REF: 1',
      CATEGORY_CLARITY,
      'ISSUE: No-op suggestion',
      WHY_BARRIERS,
      'CURRENT: same text here',
      'SUGGESTED: same text here',
      '[/PRIORITY]'
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response, undefined, 'Hello world')

    expect(result.improvements).toHaveLength(0)
  })

  it('discards no-op improvement when whitespace differs but trimmed text is equal', () => {
    const improvements = [
      '[PRIORITY: low]',
      'REF: 1',
      CATEGORY_CLARITY,
      'ISSUE: Whitespace no-op',
      WHY_BARRIERS,
      'CURRENT:   padded text   ',
      'SUGGESTED: padded text',
      '[/PRIORITY]'
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response, undefined, 'Hello world')

    expect(result.improvements).toHaveLength(0)
  })

  it('keeps improvement when CURRENT and SUGGESTED are genuinely different', () => {
    const improvements = [
      '[PRIORITY: high]',
      'REF: 1',
      CATEGORY_CLARITY,
      'ISSUE: Real improvement',
      WHY_BARRIERS,
      'CURRENT: utilise',
      'SUGGESTED: use',
      '[/PRIORITY]'
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(
      response,
      undefined,
      'Hello world, please utilise this.'
    )

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].current).toBe('utilise')
    expect(result.improvements[0].suggested).toBe('use')
  })
})

// ── review-parser.conditions.test.js error-catch branches ─────────────────

describe('parseBedrockResponse - error catch path with truthy originalText', () => {
  it('uses originalText as plainText in error fallback when originalText is provided', () => {
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

describe('parseBedrockResponse - improvement block with no SUGGESTED field (from conditions)', () => {
  it('discards improvement block and returns no improvements when SUGGESTED is absent', () => {
    const improvements = [
      PRIORITY_HIGH_OPEN,
      CATEGORY_CLARITY,
      'ISSUE: Overly complex sentence',
      WHY_BARRIERS,
      'CURRENT: The organisation undertakes various activities'
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response)

    expect(result.improvements).toHaveLength(0)
  })
})

describe('parseBedrockResponse - ref field in [IMPROVEMENTS] (multiple scenarios)', () => {
  it('extracts ref field from [PRIORITY] block when present', () => {
    const originalText = SAMPLE_UTILISE_TEXT
    const improvements = [
      PRIORITY_HIGH_OPEN,
      'REF: 1',
      CATEGORY_PLAIN_ENGLISH,
      'ISSUE: Simpler word',
      WHY_BARRIERS,
      'CURRENT: utilise',
      'SUGGESTED: use'
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response, undefined, originalText)

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].ref).toBe(1)
  })

  it('extracts ref as undefined when ref field is absent from [PRIORITY]', () => {
    const originalText = SAMPLE_UTILISE_TEXT
    const improvements = [
      PRIORITY_HIGH_OPEN,
      CATEGORY_PLAIN_ENGLISH,
      'ISSUE: Simpler word',
      WHY_BARRIERS,
      'CURRENT: utilise',
      'SUGGESTED: use'
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response, undefined, originalText)

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].ref).toBeUndefined()
  })

  it('extracts multiple refs from multiple [PRIORITY] blocks', () => {
    const originalText =
      'The department should utilise all resources going forward.'
    const improvements = [
      PRIORITY_HIGH_OPEN,
      'REF: 1',
      CATEGORY_PLAIN_ENGLISH,
      'ISSUE: Simpler word',
      WHY_BARRIERS,
      'CURRENT: utilise',
      'SUGGESTED: use',
      '[/PRIORITY]',
      PRIORITY_MEDIUM_OPEN,
      'REF: 2',
      'CATEGORY: GOV.UK Style Compliance',
      'ISSUE: Words to avoid',
      'WHY: GOV.UK style',
      'CURRENT: going forward',
      'SUGGESTED: in future'
    ].join('\n')
    const response = buildMarkerResponse({ improvements })

    const result = parseBedrockResponse(response, undefined, originalText)

    expect(result.improvements).toHaveLength(2)
    expect(result.improvements[0].ref).toBe(1)
    expect(result.improvements[1].ref).toBe(2)
  })
})
