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

// Category key constants (lowercase keys used in raw data / CSS classes)
const CATEGORY_PLAIN_ENGLISH_KEY = 'plain-english'
const CATEGORY_UTILISE_TEXT = 'utilise'

// Display name constants (Title Case labels shown in the UI)
const DISPLAY_PLAIN_ENGLISH = 'Plain English'
const DISPLAY_CLARITY = 'Clarity & Structure'
const DISPLAY_GOVUK_STYLE = 'GOV.UK Style Compliance'
const DISPLAY_COMPLETENESS = 'Content Completeness'

// Single-issue fixture data — named to avoid repeated literal duplication
const FIXTURE_ISSUE = {
  start: 4,
  end: 11,
  type: CATEGORY_PLAIN_ENGLISH_KEY,
  text: CATEGORY_UTILISE_TEXT,
  ref: 1
}
const FIXTURE_IMPROVEMENT_ISSUE_TEXT = 'Use simpler word'
const FIXTURE_IMPROVEMENT = {
  severity: 'medium',
  category: CATEGORY_PLAIN_ENGLISH_KEY,
  issue: FIXTURE_IMPROVEMENT_ISSUE_TEXT,
  why: '"utilise" should be "use"',
  current: CATEGORY_UTILISE_TEXT,
  suggested: 'use',
  ref: 1
}

function makeParsedReview(overrides = {}) {
  return {
    scores: {
      [DISPLAY_PLAIN_ENGLISH]: { score: 4, note: 'Good use of plain language' },
      [DISPLAY_CLARITY]: { score: 3, note: 'Could be clearer' },
      Accessibility: { score: 5, note: 'Excellent' },
      'GovUK Style Compliance': { score: 4, note: GOVUK_NOTE },
      [DISPLAY_COMPLETENESS]: { score: 3, note: 'Missing some details' }
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
      [DISPLAY_PLAIN_ENGLISH]: { score: 4, note: 'Good' },
      [DISPLAY_CLARITY]: { score: 3, note: 'OK' },
      Accessibility: { score: 5, note: 'Excellent' },
      'GovUK Style Compliance': { score: 2, note: 'Needs work' },
      [DISPLAY_COMPLETENESS]: { score: 1, note: 'Incomplete' }
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
      [DISPLAY_PLAIN_ENGLISH]: { score: 3, note: 'Average' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    expect(result.plainEnglishNote).toBe('Average')
  })

  it('computes overall as the average of non-zero scores', () => {
    const raw = {
      [DISPLAY_PLAIN_ENGLISH]: { score: 4, note: '' },
      [DISPLAY_CLARITY]: { score: 2, note: '' },
      Accessibility: { score: 0, note: '' },
      [DISPLAY_GOVUK_STYLE]: { score: 0, note: '' },
      [DISPLAY_COMPLETENESS]: { score: 0, note: '' }
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
      [DISPLAY_GOVUK_STYLE]: { score: 3, note: GOVUK_NOTE }
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
      [DISPLAY_PLAIN_ENGLISH]: { score: 3, note: '' },
      [DISPLAY_CLARITY]: { score: 4, note: '' },
      Accessibility: { score: 3, note: '' },
      [DISPLAY_GOVUK_STYLE]: { score: 5, note: '' },
      [DISPLAY_COMPLETENESS]: { score: 2, note: '' }
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

// ── _findNearestOccurrence ────────────────────────────────────────────────────

describe('_findNearestOccurrence', () => {
  it('returns null when searchText is empty', () => {
    expect(
      resultEnvelopeStore._findNearestOccurrence('', 'some text', 5)
    ).toBeNull()
  })

  it('returns null when canonicalText is empty', () => {
    expect(resultEnvelopeStore._findNearestOccurrence('word', '', 5)).toBeNull()
  })

  it('returns null when text is not found', () => {
    expect(
      resultEnvelopeStore._findNearestOccurrence('missing', 'hello world', 5)
    ).toBeNull()
  })

  it('returns the single occurrence when text appears once', () => {
    const result = resultEnvelopeStore._findNearestOccurrence(
      CATEGORY_UTILISE_TEXT,
      'The department should utilise all resources.',
      0
    )
    expect(result).toEqual({ start: 22, end: 29 })
  })

  it('picks the occurrence nearest the hint midpoint for duplicate text', () => {
    const text = 'use good words and use plain words here'
    // "use" at 0 (mid=1.5) and 19 (mid=20.5); hintMid=26.5 → pick 19
    const result = resultEnvelopeStore._findNearestOccurrence('use', text, 26.5)
    expect(result).toEqual({ start: 19, end: 22 })
  })
})

// ── _resolveIssuePosition ────────────────────────────────────────────────────

const RESOLVE_TEXT = 'The department should utilise all resources available.'
// "utilise" in RESOLVE_TEXT: start=22, end=29
const RESOLVE_CORRECT_START = 22
const RESOLVE_CORRECT_END = 29
const RESOLVE_WRONG_START = 5
const RESOLVE_WRONG_END = 12

describe('_resolveIssuePosition', () => {
  it('returns unchanged offsets when slice already matches issueText', () => {
    const result = resultEnvelopeStore._resolveIssuePosition(
      RESOLVE_CORRECT_START,
      RESOLVE_CORRECT_END,
      CATEGORY_UTILISE_TEXT,
      RESOLVE_TEXT
    )
    expect(result.start).toBe(RESOLVE_CORRECT_START)
    expect(result.end).toBe(RESOLVE_CORRECT_END)
  })

  it('finds correct position via issueText search when offset is wrong', () => {
    const result = resultEnvelopeStore._resolveIssuePosition(
      RESOLVE_WRONG_START,
      RESOLVE_WRONG_END,
      CATEGORY_UTILISE_TEXT,
      RESOLVE_TEXT
    )
    expect(result.start).toBe(RESOLVE_CORRECT_START)
    expect(result.end).toBe(RESOLVE_CORRECT_END)
  })

  it('uses fallbackText when issueText is not found in canonicalText', () => {
    // issueText is wrong/absent but improvement.current contains the verbatim phrase
    const result = resultEnvelopeStore._resolveIssuePosition(
      0,
      5,
      'xyzzy-not-present',
      RESOLVE_TEXT,
      CATEGORY_UTILISE_TEXT // fallbackText = improvement.current
    )
    expect(result.start).toBe(RESOLVE_CORRECT_START)
    expect(result.end).toBe(RESOLVE_CORRECT_END)
  })

  it('returns original offsets when both issueText and fallbackText are not found', () => {
    const result = resultEnvelopeStore._resolveIssuePosition(
      0,
      5,
      'xyzzy-not-present',
      RESOLVE_TEXT,
      'also-not-present'
    )
    expect(result.start).toBe(0)
    expect(result.end).toBe(5)
  })

  it('returns original offsets when issueText is empty and no fallback provided', () => {
    const result = resultEnvelopeStore._resolveIssuePosition(
      5,
      10,
      '',
      RESOLVE_TEXT
    )
    expect(result.start).toBe(5)
    expect(result.end).toBe(10)
  })

  it('picks the occurrence nearest the hint midpoint for duplicate text', () => {
    const text = 'use good words and use plain words here'
    const result = resultEnvelopeStore._resolveIssuePosition(
      25,
      28,
      'use',
      text
    )
    expect(result.start).toBe(19)
    expect(result.end).toBe(22)
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
    expect(SNAP_TEXT.slice(result.start, result.end)).toBe(
      CATEGORY_UTILISE_TEXT
    )
  })

  it('expands start left to word boundary when offset lands mid-word', () => {
    const result = resultEnvelopeStore._snapToWordBoundary(
      SNAP_TEXT,
      UTILISE_MID,
      UTILISE_END
    )
    expect(result.start).toBeLessThanOrEqual(UTILISE_START)
    expect(SNAP_TEXT.slice(result.start, result.end)).toContain(
      CATEGORY_UTILISE_TEXT
    )
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

// ── normalizeCategoryDisplay via _mapImprovement ───────────────────────────────

const CATEGORY_NORMALIZATION_USAGE = {
  totalTokens: 100,
  inputTokens: 80,
  outputTokens: 20
}

describe('buildEnvelope — category normalization in improvements', () => {
  function buildReviewWithCategory(categoryRaw) {
    return {
      scores: {},
      reviewedContent: {
        issues: [
          {
            start: 22,
            end: 29,
            type: CATEGORY_PLAIN_ENGLISH_KEY,
            text: CATEGORY_UTILISE_TEXT
          }
        ]
      },
      improvements: [
        {
          severity: 'medium',
          category: categoryRaw,
          issue: 'Issue title',
          why: 'Explanation',
          current: CATEGORY_UTILISE_TEXT,
          suggested: 'New text',
          ref: undefined
        }
      ]
    }
  }

  it('normalizes plain-english key to "Plain English" display name', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      buildReviewWithCategory(CATEGORY_PLAIN_ENGLISH_KEY),
      CATEGORY_NORMALIZATION_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.improvements[0].category).toBe(DISPLAY_PLAIN_ENGLISH)
  })

  it('normalizes "plain english" key to "Plain English" display name', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      buildReviewWithCategory('plain english'),
      CATEGORY_NORMALIZATION_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.improvements[0].category).toBe(DISPLAY_PLAIN_ENGLISH)
  })

  it('normalizes clarity key to "Clarity & Structure"', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      buildReviewWithCategory('clarity'),
      CATEGORY_NORMALIZATION_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.improvements[0].category).toBe(DISPLAY_CLARITY)
  })

  it('normalizes govuk-style key to "GOV.UK Style Compliance"', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      buildReviewWithCategory('govuk-style'),
      CATEGORY_NORMALIZATION_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.improvements[0].category).toBe(DISPLAY_GOVUK_STYLE)
  })

  it('normalizes completeness key to "Content Completeness"', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      buildReviewWithCategory('completeness'),
      CATEGORY_NORMALIZATION_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.improvements[0].category).toBe(DISPLAY_COMPLETENESS)
  })

  it('normalizes accessibility key to "Accessibility"', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      buildReviewWithCategory('accessibility'),
      CATEGORY_NORMALIZATION_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.improvements[0].category).toBe('Accessibility')
  })

  it('passes through unknown category values unchanged', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      buildReviewWithCategory('custom-category'),
      CATEGORY_NORMALIZATION_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.improvements[0].category).toBe('custom-category')
  })

  it('returns empty string for null category', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      buildReviewWithCategory(null),
      CATEGORY_NORMALIZATION_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.improvements[0].category).toBe('')
  })
})

// ── _buildAnnotatedSections — dual-text (displayText) ────────────────────────

describe('_buildAnnotatedSections — no issues', () => {
  it('returns a single plain section covering the whole text', () => {
    const sections = resultEnvelopeStore._buildAnnotatedSections(
      'Hello world',
      []
    )
    expect(sections).toEqual([
      { text: 'Hello world', issueIdx: null, category: null }
    ])
  })

  it('returns empty array for empty canonicalText', () => {
    const sections = resultEnvelopeStore._buildAnnotatedSections('', [])
    expect(sections).toEqual([])
  })

  it('returns empty array when canonicalText is null', () => {
    const sections = resultEnvelopeStore._buildAnnotatedSections(null, [])
    expect(sections).toEqual([])
  })
})

describe('_buildAnnotatedSections — single issue, no displayText', () => {
  it('splits into [plain, highlight, plain] for a mid-string issue', () => {
    const text = 'The department should utilise all resources.'
    // "utilise" = chars 22–29
    const issues = [{ absStart: 22, absEnd: 29, category: 'plain-english' }]
    const sections = resultEnvelopeStore._buildAnnotatedSections(text, issues)
    expect(sections).toHaveLength(3)
    expect(sections[0]).toEqual({
      text: 'The department should ',
      issueIdx: null,
      category: null
    })
    expect(sections[1]).toEqual({
      text: 'utilise',
      issueIdx: 0,
      category: 'plain-english'
    })
    expect(sections[2]).toEqual({
      text: ' all resources.',
      issueIdx: null,
      category: null
    })
  })

  it('produces only [highlight, plain] when issue starts at offset 0', () => {
    const text = 'utilise all resources.'
    const issues = [{ absStart: 0, absEnd: 7, category: 'clarity' }]
    const sections = resultEnvelopeStore._buildAnnotatedSections(text, issues)
    expect(sections).toHaveLength(2)
    expect(sections[0]).toEqual({
      text: 'utilise',
      issueIdx: 0,
      category: 'clarity'
    })
    expect(sections[1]).toEqual({
      text: ' all resources.',
      issueIdx: null,
      category: null
    })
  })

  it('produces only [plain, highlight] when issue ends at text end', () => {
    const text = 'All resources utilise'
    const issues = [{ absStart: 14, absEnd: 21, category: 'plain-english' }]
    const sections = resultEnvelopeStore._buildAnnotatedSections(text, issues)
    expect(sections).toHaveLength(2)
    expect(sections[0]).toEqual({
      text: 'All resources ',
      issueIdx: null,
      category: null
    })
    expect(sections[1]).toEqual({
      text: 'utilise',
      issueIdx: 0,
      category: 'plain-english'
    })
  })
})

describe('_buildAnnotatedSections — with displayText (URL sources)', () => {
  it('uses displayText for plain spans and canonicalText for highlighted spans', () => {
    // canonicalText has Markdown links stripped; displayText has them intact
    const canonicalText = 'See the guidance for details.'
    const displayText =
      'See [the guidance](https://www.gov.uk/guidance) for details.'
    // Issue covers "the guidance" in canonicalText (chars 4–16)
    const issues = [{ absStart: 4, absEnd: 16, category: 'clarity' }]

    const sections = resultEnvelopeStore._buildAnnotatedSections(
      canonicalText,
      issues,
      displayText
    )

    // Plain span before the highlight — should come from displayText (just "See ")
    expect(sections[0].text).toBe('See ')
    expect(sections[0].issueIdx).toBeNull()

    // Highlighted span — must use canonicalText (clean prose, no URL shown)
    expect(sections[1].text).toBe('the guidance')
    expect(sections[1].issueIdx).toBe(0)
    expect(sections[1].text).not.toContain('https://')

    // Plain span after the highlight — from displayText
    expect(sections[2].text).toBe(' for details.')
    expect(sections[2].issueIdx).toBeNull()
  })

  it('preserves a Markdown link that falls entirely in a plain span before the highlight', () => {
    const canonicalText = 'Visit the site and use plain words.'
    // displayText has a link around "the site" (chars 6–14 in canonicalText)
    const displayText =
      'Visit [the site](https://example.com) and use plain words.'
    // "plain words" in canonicalText: starts at 23, ends at 34
    const issues = [{ absStart: 23, absEnd: 34, category: 'plain-english' }]

    const sections = resultEnvelopeStore._buildAnnotatedSections(
      canonicalText,
      issues,
      displayText
    )

    // Pre-highlight plain span should contain the Markdown link
    expect(sections[0].text).toContain('[the site](https://example.com)')
    // Highlighted span must be clean prose
    expect(sections[1].text).toBe('plain words')
    expect(sections[1].text).not.toContain('https://')
  })

  it('preserves a Markdown link that falls entirely in a plain span after the highlight', () => {
    const canonicalText = 'Use simple words and visit the site.'
    const displayText =
      'Use simple words and visit [the site](https://example.com).'
    // Issue covers "simple words" (chars 4–16)
    const issues = [{ absStart: 4, absEnd: 16, category: 'plain-english' }]

    const sections = resultEnvelopeStore._buildAnnotatedSections(
      canonicalText,
      issues,
      displayText
    )

    // Post-highlight plain span should contain the Markdown link
    const lastSection = sections[sections.length - 1]
    expect(lastSection.text).toContain('[the site](https://example.com)')
    expect(lastSection.issueIdx).toBeNull()
  })

  it('does not show raw URLs in highlighted spans even when displayText has a link there', () => {
    const canonicalText = 'Read more about planning permission here.'
    // displayText has a Markdown link around "planning permission" (chars 16–35 in canonicalText)
    const displayText =
      'Read more about [planning permission](https://www.gov.uk/planning) here.'
    // "planning permission" starts at 16, ends at 35
    const issues = [{ absStart: 16, absEnd: 35, category: 'govuk-style' }]

    const sections = resultEnvelopeStore._buildAnnotatedSections(
      canonicalText,
      issues,
      displayText
    )

    const highlight = sections.find((s) => s.issueIdx === 0)
    expect(highlight).toBeDefined()
    expect(highlight.text).toBe('planning permission')
    expect(highlight.text).not.toContain('https://')
    expect(highlight.text).not.toContain('(https://')
  })

  it('falls back to canonicalText for all spans when displayText is null', () => {
    const canonicalText = 'The department should utilise all resources.'
    const issues = [{ absStart: 22, absEnd: 29, category: 'plain-english' }]

    const sections = resultEnvelopeStore._buildAnnotatedSections(
      canonicalText,
      issues,
      null
    )

    const plain = sections.filter((s) => s.issueIdx === null)
    // All plain spans come from canonicalText directly
    plain.forEach((s) => {
      expect(canonicalText).toContain(s.text)
    })
  })

  it('falls back to canonicalText for all spans when displayText is undefined', () => {
    const canonicalText = 'The department should utilise all resources.'
    const issues = [{ absStart: 22, absEnd: 29, category: 'plain-english' }]
    // Calling without the third argument
    const sections = resultEnvelopeStore._buildAnnotatedSections(
      canonicalText,
      issues
    )
    const highlight = sections.find((s) => s.issueIdx === 0)
    expect(highlight.text).toBe('utilise')
  })

  it('handles multiple plain spans all with Markdown links', () => {
    // canonicalText: "Apply online and check your eligibility before you start."
    // displayText: "Apply [online](url1) and check [your eligibility](url2) before you start."
    const canonicalText =
      'Apply online and check your eligibility before you start.'
    const displayText =
      'Apply [online](https://a.com) and check [your eligibility](https://b.com) before you start.'
    // Issue: "before you start" (chars 39–55 in canonicalText — adjust to actual)
    const beforeIdx = canonicalText.indexOf('before you start')
    const issues = [
      {
        absStart: beforeIdx,
        absEnd: beforeIdx + 16,
        category: 'clarity'
      }
    ]

    const sections = resultEnvelopeStore._buildAnnotatedSections(
      canonicalText,
      issues,
      displayText
    )

    // Plain span before issue should contain both links
    const prePlain = sections.find(
      (s) => s.issueIdx === null && sections.indexOf(s) === 0
    )
    expect(prePlain.text).toContain('[online](https://a.com)')
    expect(prePlain.text).toContain('[your eligibility](https://b.com)')

    // Highlighted span should be clean
    const highlight = sections.find((s) => s.issueIdx === 0)
    expect(highlight.text).toBe('before you start')
    expect(highlight.text).not.toContain('https://')
  })
})

describe('buildEnvelope — displayText passed through to annotatedSections', () => {
  it('passes displayText to _buildAnnotatedSections so plain spans carry links', () => {
    // Set up a canonical text with a Markdown link stripped (what Bedrock sees)
    // and a displayText with the link preserved (what the results page shows)
    const canonical = 'See the guidance for details about utilise.'
    const display =
      'See [the guidance](https://www.gov.uk/) for details about utilise.'

    const parsedReview = {
      scores: {},
      reviewedContent: {
        issues: [
          {
            start: 35,
            end: 42,
            type: 'plain-english',
            text: 'utilise',
            ref: 1
          }
        ]
      },
      improvements: [
        {
          severity: 'medium',
          category: 'plain-english',
          issue: 'Use simpler word',
          why: '"utilise" should be "use"',
          current: 'utilise',
          suggested: 'use',
          ref: 1
        }
      ]
    }

    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      parsedReview,
      { totalTokens: 100 },
      canonical,
      'completed',
      display
    )

    // Find the plain span before the highlight
    const plainBefore = envelope.annotatedSections.find(
      (s) => s.issueIdx === null && envelope.annotatedSections.indexOf(s) === 0
    )
    expect(plainBefore).toBeDefined()
    // Plain section should have Markdown link from displayText
    expect(plainBefore.text).toContain('[the guidance](https://www.gov.uk/)')

    // Find the highlighted span
    const highlight = envelope.annotatedSections.find((s) => s.issueIdx === 0)
    expect(highlight).toBeDefined()
    expect(highlight.text).toBe('utilise')
    // Highlighted span must not contain any URL
    expect(highlight.text).not.toContain('https://')
  })

  it('produces identical annotatedSections regardless of displayText when no links present', () => {
    const canonical = 'The department should utilise all resources.'
    // displayText with no Markdown links — should produce same result
    const display = 'The department should utilise all resources.'

    const parsedReview = {
      scores: {},
      reviewedContent: {
        issues: [
          { start: 22, end: 29, type: 'plain-english', text: 'utilise', ref: 1 }
        ]
      },
      improvements: [
        {
          severity: 'medium',
          category: 'plain-english',
          issue: 'Use simpler word',
          why: 'reason',
          current: 'utilise',
          suggested: 'use',
          ref: 1
        }
      ]
    }

    const withDisplay = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      parsedReview,
      { totalTokens: 50 },
      canonical,
      'completed',
      display
    )
    const withoutDisplay = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      parsedReview,
      { totalTokens: 50 },
      canonical,
      'completed',
      null
    )

    // When no Markdown links exist the section texts should be identical
    expect(withDisplay.annotatedSections.map((s) => s.text)).toEqual(
      withoutDisplay.annotatedSections.map((s) => s.text)
    )
  })
})
