import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

import { resultEnvelopeStore } from './result-envelope.js'

// ── Shared constants ──────────────────────────────────────────────────────────

const REVIEW_ID = 'review_test-uuid-1234'
const SCORE_80 = 80
const SCORE_60 = 60
const SCORE_40 = 40
const SCORE_20 = 20
const SCORE_100 = 100
const TOKEN_999 = 999
const GOVUK_NOTE = 'Mostly compliant'

// Single-issue fixture data — named to avoid repeated literal duplication
const FIXTURE_ISSUE = {
  start: 4,
  end: 11,
  type: 'plain-english',
  text: 'utilise',
  ref: 1
}
const FIXTURE_IMPROVEMENT_ISSUE_TEXT = 'Use simpler word'
const FIXTURE_IMPROVEMENT = {
  severity: 'medium',
  category: 'plain-english',
  issue: FIXTURE_IMPROVEMENT_ISSUE_TEXT,
  why: '"utilise" should be "use"',
  current: 'utilise',
  suggested: 'use',
  ref: 1
}

function makeParsedReview(overrides = {}) {
  return {
    scores: {
      'Plain English': { score: 4, note: 'Good use of plain language' },
      'Clarity & Structure': { score: 3, note: 'Could be clearer' },
      Accessibility: { score: 5, note: 'Excellent' },
      'GovUK Style Compliance': { score: 4, note: GOVUK_NOTE },
      'Content Completeness': { score: 3, note: 'Missing some details' }
    },
    reviewedContent: { issues: [FIXTURE_ISSUE] },
    improvements: [FIXTURE_IMPROVEMENT],
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── _mapScores ────────────────────────────────────────────────────────────────

describe('_mapScores', () => {
  it('maps all five canonical categories and scales 0-5 to 0-100', () => {
    const raw = {
      'Plain English': { score: 4, note: 'Good' },
      'Clarity & Structure': { score: 3, note: 'OK' },
      Accessibility: { score: 5, note: 'Excellent' },
      'GovUK Style Compliance': { score: 2, note: 'Needs work' },
      'Content Completeness': { score: 1, note: 'Incomplete' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    expect(result.plainEnglish).toBe(SCORE_80)
    expect(result.clarity).toBe(SCORE_60)
    expect(result.accessibility).toBe(SCORE_100)
    expect(result.govukStyle).toBe(SCORE_40)
    expect(result.completeness).toBe(SCORE_20)
  })

  it('stores note strings alongside scaled values', () => {
    const raw = {
      'Plain English': { score: 3, note: 'Average' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    expect(result.plainEnglishNote).toBe('Average')
  })

  it('computes overall as the average of non-zero scores', () => {
    const raw = {
      'Plain English': { score: 4, note: '' },
      'Clarity & Structure': { score: 2, note: '' },
      Accessibility: { score: 0, note: '' },
      'GOV.UK Style Compliance': { score: 0, note: '' },
      'Content Completeness': { score: 0, note: '' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    // Only plainEnglish (80) and clarity (40) are non-zero → average = 60
    expect(result.overall).toBe(SCORE_60)
  })

  it('returns all zeros when scores object is empty', () => {
    const result = resultEnvelopeStore._mapScores({})
    expect(result.plainEnglish).toBe(0)
    expect(result.clarity).toBe(0)
    expect(result.overall).toBe(0)
  })

  it('maps GOV.UK Style Compliance key as output by Bedrock prompt template', () => {
    const raw = {
      'GOV.UK Style Compliance': { score: 3, note: GOVUK_NOTE }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    expect(result.govukStyle).toBe(SCORE_60)
    expect(result.govukStyleNote).toBe(GOVUK_NOTE)
  })

  it('falls back to legacy key aliases (style, tone)', () => {
    const raw = {
      Style: { score: 3, note: '' },
      Tone: { score: 4, note: '' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    expect(result.govukStyle).toBe(SCORE_60)
    expect(typeof result.clarity).toBe('number')
  })

  it('populates legacy style and tone fields for backwards compatibility', () => {
    const raw = {
      'Plain English': { score: 3, note: '' },
      'Clarity & Structure': { score: 4, note: '' },
      Accessibility: { score: 3, note: '' },
      'GOV.UK Style Compliance': { score: 5, note: '' },
      'Content Completeness': { score: 2, note: '' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    expect(result.style).toBe(result.govukStyle)
    expect(result.tone).toBe(result.clarity)
  })
})

// ── buildStubEnvelope ─────────────────────────────────────────────────────────

describe('buildStubEnvelope', () => {
  it('returns an envelope with the given status', () => {
    const stub = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'pending')
    expect(stub.status).toBe('pending')
    expect(stub.documentId).toBe(REVIEW_ID)
  })

  it('has empty arrays for annotatedSections, issues and improvements', () => {
    const stub = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'processing')
    expect(stub.annotatedSections).toEqual([])
    expect(stub.issues).toEqual([])
    expect(stub.improvements).toEqual([])
  })

  it('has all score fields set to 0', () => {
    const stub = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'failed')
    expect(stub.scores.plainEnglish).toBe(0)
    expect(stub.scores.clarity).toBe(0)
    expect(stub.scores.overall).toBe(0)
  })

  it('sets processedAt to null and tokenUsed to 0', () => {
    const stub = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'pending')
    expect(stub.processedAt).toBeNull()
    expect(stub.tokenUsed).toBe(0)
  })
})

// ── buildEnvelope ─────────────────────────────────────────────────────────────

const CANONICAL_TEXT_BUILD =
  'The department should utilise all resources available.'
const BEDROCK_USAGE = { totalTokens: 500, inputTokens: 400, outputTokens: 100 }

describe('buildEnvelope — shape and status', () => {
  it('returns a completed envelope with documentId and status', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      BEDROCK_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.documentId).toBe(REVIEW_ID)
    expect(envelope.status).toBe('completed')
  })

  it('includes issueCount matching the number of valid issues', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      BEDROCK_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(typeof envelope.issueCount).toBe('number')
    expect(envelope.issueCount).toBeGreaterThanOrEqual(0)
  })

  it('includes annotatedSections derived from canonicalText', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      BEDROCK_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(Array.isArray(envelope.annotatedSections)).toBe(true)
  })

  it('stores canonicalText on the envelope', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      BEDROCK_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.canonicalText).toBe(CANONICAL_TEXT_BUILD)
  })

  it('accepts a custom status parameter', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      BEDROCK_USAGE,
      CANONICAL_TEXT_BUILD,
      'failed'
    )
    expect(envelope.status).toBe('failed')
  })
})

describe('buildEnvelope — token and edge cases', () => {
  it('uses tokenUsed from bedrockUsage.totalTokens', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      { totalTokens: TOKEN_999 },
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.tokenUsed).toBe(TOKEN_999)
  })

  it('defaults tokenUsed to 0 when bedrockUsage is null', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      null,
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.tokenUsed).toBe(0)
  })

  it('handles empty canonicalText gracefully', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview({ reviewedContent: { issues: [] }, improvements: [] }),
      BEDROCK_USAGE,
      ''
    )
    expect(envelope.annotatedSections).toEqual([])
    expect(envelope.issueCount).toBe(0)
  })
})

// ── buildStubEnvelope (replaces saveStatus) ───────────────────────────────────

describe('buildStubEnvelope — additional', () => {
  it('builds a stub envelope with the given status', () => {
    const result = resultEnvelopeStore.buildStubEnvelope(
      REVIEW_ID,
      'processing'
    )
    expect(result.status).toBe('processing')
  })

  it('builds a failed stub envelope with zero issueCount', () => {
    const result = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'failed')
    expect(result.status).toBe('failed')
    expect(result.issueCount).toBe(0)
  })
})

// ── _hasRefFields ─────────────────────────────────────────────────────────────

describe('_hasRefFields', () => {
  it('returns true when all issues and at least one improvement have ref', () => {
    const issues = [
      { ref: 1, absStart: 0, absEnd: 5 },
      { ref: 2, absStart: 10, absEnd: 15 }
    ]
    const improvements = [
      { ref: 1, severity: 'high' },
      { ref: 2, severity: 'medium' }
    ]
    expect(resultEnvelopeStore._hasRefFields(issues, improvements)).toBe(true)
  })

  it('returns false when issues array is empty', () => {
    expect(resultEnvelopeStore._hasRefFields([], [{ ref: 1 }])).toBe(false)
  })

  it('returns false when any issue is missing ref', () => {
    const issues = [
      { ref: 1, absStart: 0, absEnd: 5 },
      { absStart: 10, absEnd: 15 }
    ]
    const improvements = [{ ref: 1 }]
    expect(resultEnvelopeStore._hasRefFields(issues, improvements)).toBe(false)
  })

  it('returns false when all improvements are missing ref', () => {
    const issues = [{ ref: 1, absStart: 0, absEnd: 5 }]
    const improvements = [{ severity: 'high' }]
    expect(resultEnvelopeStore._hasRefFields(issues, improvements)).toBe(false)
  })

  it('returns false when improvements array is empty', () => {
    const issues = [{ ref: 1, absStart: 0, absEnd: 5 }]
    expect(resultEnvelopeStore._hasRefFields(issues, [])).toBe(false)
  })

  it('returns true when only one improvement has ref among several', () => {
    const issues = [{ ref: 1, absStart: 0, absEnd: 5 }]
    const improvements = [{ severity: 'high' }, { ref: 1, severity: 'medium' }]
    expect(resultEnvelopeStore._hasRefFields(issues, improvements)).toBe(true)
  })

  it('returns false when issue ref is Number.NaN', () => {
    const issues = [{ ref: Number.NaN, absStart: 0, absEnd: 5 }]
    const improvements = [{ ref: 1 }]
    expect(resultEnvelopeStore._hasRefFields(issues, improvements)).toBe(false)
  })
})

// ── _snapToWordBoundary ───────────────────────────────────────────────────────

const SNAP_TEXT = 'The department should utilise all resources.'
// Character offsets for "utilise" within SNAP_TEXT: start=22, end=29
const UTILISE_START = 22
const UTILISE_END = 29
const UTILISE_MID = 24
const UTILISE_MID_END = 26
const SHORT_TEXT_END = 5
const TRAILING_SPACE_END = 7

describe('_snapToWordBoundary', () => {
  it('returns unchanged offsets when already on word boundaries', () => {
    const result = resultEnvelopeStore._snapToWordBoundary(
      SNAP_TEXT,
      UTILISE_START,
      UTILISE_END
    )
    expect(SNAP_TEXT.slice(result.start, result.end)).toBe('utilise')
  })

  it('expands start left to word boundary when offset lands mid-word', () => {
    const result = resultEnvelopeStore._snapToWordBoundary(
      SNAP_TEXT,
      UTILISE_MID,
      UTILISE_END
    )
    expect(result.start).toBeLessThanOrEqual(UTILISE_START)
    expect(SNAP_TEXT.slice(result.start, result.end)).toContain('utilise')
  })

  it('expands end right to word boundary when offset lands mid-word', () => {
    const result = resultEnvelopeStore._snapToWordBoundary(
      SNAP_TEXT,
      UTILISE_START,
      UTILISE_MID_END
    )
    expect(result.end).toBeGreaterThanOrEqual(UTILISE_END)
  })

  it('does not expand beyond string boundaries', () => {
    const text = 'short'
    const result = resultEnvelopeStore._snapToWordBoundary(
      text,
      0,
      SHORT_TEXT_END
    )
    expect(result.start).toBe(0)
    expect(result.end).toBe(SHORT_TEXT_END)
  })

  it('trims trailing whitespace from expanded span', () => {
    const text = 'word   nextword'
    const result = resultEnvelopeStore._snapToWordBoundary(
      text,
      0,
      TRAILING_SPACE_END
    )
    expect(text[result.end - 1]).not.toBe(' ')
  })

  it('trims leading whitespace from expanded span', () => {
    const text = '   word'
    const result = resultEnvelopeStore._snapToWordBoundary(
      text,
      0,
      TRAILING_SPACE_END
    )
    expect(text[result.start]).not.toBe(' ')
  })
})
