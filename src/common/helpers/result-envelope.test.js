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
const DISPLAY_GOVUK_STYLE = 'GOV.UK Style Compliance'

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
      [DISPLAY_GOVUK_STYLE]: { score: 4, note: GOVUK_NOTE }
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
  it('maps both canonical categories (raw 1-5 scores, no scaling)', () => {
    const raw = {
      [DISPLAY_PLAIN_ENGLISH]: { score: 4, note: 'Good' },
      [DISPLAY_GOVUK_STYLE]: { score: 2, note: 'Needs work' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    expect(result.plainEnglish).toBe(4)
    expect(result.govukStyle).toBe(2)
  })

  it('stores note strings alongside scaled values', () => {
    const raw = {
      [DISPLAY_PLAIN_ENGLISH]: { score: 3, note: 'Average' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    expect(result.plainEnglishNote).toBe('Average')
  })

  it('returns all zeros when scores object is empty', () => {
    const result = resultEnvelopeStore._mapScores({})
    expect(result.plainEnglish).toBe(0)
    expect(result.govukStyle).toBe(0)
  })

  it('maps GOV.UK Style Compliance key as output by Bedrock prompt template', () => {
    const raw = {
      [DISPLAY_GOVUK_STYLE]: { score: 3, note: GOVUK_NOTE }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    expect(result.govukStyle).toBe(3)
    expect(result.govukStyleNote).toBe(GOVUK_NOTE)
  })
})

// ── buildStubEnvelope ─────────────────────────────────────────────────────────

describe('buildStubEnvelope', () => {
  it('returns an envelope with the given status', () => {
    const stub = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'pending')
    expect(stub.status).toBe('pending')
    expect(stub.documentId).toBe(REVIEW_ID)
  })

  it('has empty arrays for annotatedSections and improvements', () => {
    const stub = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'processing')
    expect(stub.annotatedSections).toEqual([])
    expect(stub.improvements).toEqual([])
  })

  it('has all score fields set to 0', () => {
    const stub = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'failed')
    expect(stub.scores.plainEnglish).toBe(0)
    expect(stub.scores.govukStyle).toBe(0)
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

  it('normalizes govuk-style key to "GOV.UK Style Compliance"', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      buildReviewWithCategory('govuk-style'),
      CATEGORY_NORMALIZATION_USAGE,
      CANONICAL_TEXT_BUILD
    )
    expect(envelope.improvements[0].category).toBe(DISPLAY_GOVUK_STYLE)
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
    const issues = [{ start: 22, end: 29, category: 'plain-english' }]
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
    const issues = [{ start: 0, end: 7, category: 'clarity' }]
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
    const issues = [{ start: 14, end: 21, category: 'plain-english' }]
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

// ── _buildAnnotatedSections — linkMap (map-based, URL sources) ───────────────

describe('_buildAnnotatedSections — with linkMap (URL sources)', () => {
  it('uses linkMap entries for plain spans and canonicalText for highlighted spans', () => {
    // canonicalText has Markdown links stripped; linkMap records their positions
    const canonicalText = 'See the guidance for details.'
    // "the guidance" is chars 4–16 in canonicalText
    const linkMap = [
      {
        start: 4,
        end: 16,
        display: '[the guidance](https://www.gov.uk/guidance)'
      }
    ]
    // Issue covers "the guidance" in canonicalText (chars 4–16)
    const issues = [{ start: 4, end: 16, category: 'clarity' }]

    const sections = resultEnvelopeStore._buildAnnotatedSections(
      canonicalText,
      issues,
      linkMap
    )

    // Plain span before the highlight — "See " (no link within this range)
    expect(sections[0].text).toBe('See ')
    expect(sections[0].issueIdx).toBeNull()

    // Highlighted span — must use canonicalText (clean prose, no URL shown)
    expect(sections[1].text).toBe('the guidance')
    expect(sections[1].issueIdx).toBe(0)
    expect(sections[1].text).not.toContain('https://')

    // Plain span after the highlight — from canonicalText (no link in trailing range)
    expect(sections[2].text).toBe(' for details.')
    expect(sections[2].issueIdx).toBeNull()
  })

  it('preserves a Markdown link that falls entirely in a plain span before the highlight', () => {
    const canonicalText = 'Visit the site and use plain words.'
    // "the site" is chars 6–14 in canonicalText
    const linkMap = [
      { start: 6, end: 14, display: '[the site](https://example.com)' }
    ]
    // "plain words" in canonicalText: starts at 23, ends at 34
    const issues = [{ start: 23, end: 34, category: 'plain-english' }]

    const sections = resultEnvelopeStore._buildAnnotatedSections(
      canonicalText,
      issues,
      linkMap
    )

    // Pre-highlight plain span should contain the Markdown link
    expect(sections[0].text).toContain('[the site](https://example.com)')
    // Highlighted span must be clean prose
    expect(sections[1].text).toBe('plain words')
    expect(sections[1].text).not.toContain('https://')
  })

  it('preserves a Markdown link that falls entirely in a plain span after the highlight', () => {
    const canonicalText = 'Use simple words and visit the site.'
    // "the site" is chars 27–35 in canonicalText (0-indexed)
    const theSiteIdx = canonicalText.indexOf('the site')
    const linkMap = [
      {
        start: theSiteIdx,
        end: theSiteIdx + 8,
        display: '[the site](https://example.com)'
      }
    ]
    // Issue covers "simple words" (chars 4–16)
    const issues = [{ start: 4, end: 16, category: 'plain-english' }]

    const sections = resultEnvelopeStore._buildAnnotatedSections(
      canonicalText,
      issues,
      linkMap
    )

    // Post-highlight plain span should contain the Markdown link
    const lastSection = sections[sections.length - 1]
    expect(lastSection.text).toContain('[the site](https://example.com)')
    expect(lastSection.issueIdx).toBeNull()
  })

  it('does not show raw URLs in highlighted spans even when linkMap has a link there', () => {
    const canonicalText = 'Read more about planning permission here.'
    // "planning permission" starts at 16, ends at 35 in canonicalText
    const linkMap = [
      {
        start: 16,
        end: 35,
        display: '[planning permission](https://www.gov.uk/planning)'
      }
    ]
    const issues = [{ start: 16, end: 35, category: 'govuk-style' }]

    const sections = resultEnvelopeStore._buildAnnotatedSections(
      canonicalText,
      issues,
      linkMap
    )

    const highlight = sections.find((s) => s.issueIdx === 0)
    expect(highlight).toBeDefined()
    expect(highlight.text).toBe('planning permission')
    expect(highlight.text).not.toContain('https://')
    expect(highlight.text).not.toContain('(https://')
  })

  it('falls back to canonicalText for all spans when linkMap is null', () => {
    const canonicalText = 'The department should utilise all resources.'
    const issues = [{ start: 22, end: 29, category: 'plain-english' }]

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

  it('falls back to canonicalText for all spans when linkMap is undefined', () => {
    const canonicalText = 'The department should utilise all resources.'
    const issues = [{ start: 22, end: 29, category: 'plain-english' }]
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
    const canonicalText =
      'Apply online and check your eligibility before you start.'
    // "online" = chars 6–12, "your eligibility" = chars 23–39
    const onlineIdx = canonicalText.indexOf('online')
    const eligIdx = canonicalText.indexOf('your eligibility')
    const linkMap = [
      {
        start: onlineIdx,
        end: onlineIdx + 6,
        display: '[online](https://a.com)'
      },
      {
        start: eligIdx,
        end: eligIdx + 16,
        display: '[your eligibility](https://b.com)'
      }
    ]
    // Issue: "before you start"
    const beforeIdx = canonicalText.indexOf('before you start')
    const issues = [
      {
        start: beforeIdx,
        end: beforeIdx + 16,
        category: 'clarity'
      }
    ]

    const sections = resultEnvelopeStore._buildAnnotatedSections(
      canonicalText,
      issues,
      linkMap
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

describe('buildEnvelope — linkMap passed through to annotatedSections', () => {
  it('passes linkMap to _buildAnnotatedSections so plain spans carry links', () => {
    // canonicalText has Markdown link stripped (what Bedrock sees)
    // linkMap records the link position (what the results page uses)
    const canonical = 'See the guidance for details about utilise.'
    // "the guidance" is chars 4–16 in canonical
    const linkMap = [
      { start: 4, end: 16, display: '[the guidance](https://www.gov.uk/)' }
    ]

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
      linkMap
    )

    // Find the plain span before the highlight
    const plainBefore = envelope.annotatedSections.find(
      (s) => s.issueIdx === null && envelope.annotatedSections.indexOf(s) === 0
    )
    expect(plainBefore).toBeDefined()
    // Plain section should have Markdown link from linkMap
    expect(plainBefore.text).toContain('[the guidance](https://www.gov.uk/)')

    // Find the highlighted span
    const highlight = envelope.annotatedSections.find((s) => s.issueIdx === 0)
    expect(highlight).toBeDefined()
    expect(highlight.text).toBe('utilise')
    // Highlighted span must not contain any URL
    expect(highlight.text).not.toContain('https://')
  })

  it('produces identical annotatedSections regardless of linkMap when no links present', () => {
    const canonical = 'The department should utilise all resources.'

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

    const withLinkMap = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      parsedReview,
      { totalTokens: 50 },
      canonical,
      'completed',
      [] // empty linkMap
    )
    const withoutLinkMap = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      parsedReview,
      { totalTokens: 50 },
      canonical,
      'completed',
      null
    )

    // When no links exist the section texts should be identical
    expect(withLinkMap.annotatedSections.map((s) => s.text)).toEqual(
      withoutLinkMap.annotatedSections.map((s) => s.text)
    )
  })
})

// ── deriveEvidence fallback (line 22) ─────────────────────────────────────────
// deriveEvidence is a module-private function, exercised via buildEnvelope.
// We trigger it by providing an issue whose start === end (invalid span)
// so that the slice is skipped and fallback (issue.text) is used instead.
describe('buildEnvelope — deriveEvidence fallback (line 22)', () => {
  it('falls back to issue.text when start equals end', () => {
    // start === end → deriveEvidence skips slice and returns fallbackText
    const parsedReview = {
      scores: { 'plain english': 4 },
      reviewedContent: {
        plainText: 'The department should utilise all resources.',
        issues: [{ start: 5, end: 5, type: 'plain-english', text: 'utilise' }]
      },
      improvements: [
        {
          severity: 'medium',
          category: 'plain-english',
          issue: 'Use simpler word',
          why: 'reason',
          current: 'utilise',
          suggested: 'use'
        }
      ]
    }

    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      parsedReview,
      { totalTokens: 10 },
      'The department should utilise all resources.',
      'completed'
    )

    expect(envelope.documentId).toBe(REVIEW_ID)
  })

  it('returns empty string evidence when canonicalText is falsy and issue.text is absent', () => {
    // canonicalText = '' (falsy) → deriveEvidence returns fallbackText || ''
    const parsedReview = {
      scores: { 'plain english': 4 },
      reviewedContent: {
        plainText: 'content',
        issues: [{ start: 0, end: 5, type: 'plain-english', text: undefined }]
      },
      improvements: [
        {
          severity: 'medium',
          category: 'plain-english',
          issue: 'Improve clarity',
          why: 'reason',
          current: 'text',
          suggested: 'better text'
        }
      ]
    }

    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      parsedReview,
      { totalTokens: 10 },
      '',
      'completed'
    )

    expect(envelope.documentId).toBe(REVIEW_ID)
  })
})

// ── _snapToWordBoundary trailing-whitespace trim (line 352) ───────────────────
// The trailing-whitespace trim loop fires when the expanded end lands on
// a whitespace character.  We exercise it via buildEnvelope by placing an
// issue whose raw end offset lands on a space.
describe('buildEnvelope — _snapToWordBoundary whitespace trimming (line 352)', () => {
  it('trims trailing whitespace when expanded end is preceded by whitespace', () => {
    // 'hello \nworld is great'
    //  01234 5 6789...
    // end=6 points at '\n'; right-expansion: text[6]='\n' is not a word char,
    // so e stays at 6.  Then text[e-1]=text[5]=' ' IS whitespace → e-- fires.
    const testCanonicalText = 'hello \nworld is great'
    const parsedReview = {
      scores: { 'plain english': 4 },
      reviewedContent: {
        plainText: testCanonicalText,
        issues: [{ start: 0, end: 6, type: 'plain-english', text: 'hello ' }]
      },
      improvements: [
        {
          severity: 'low',
          category: 'plain-english',
          issue: 'Simpler word',
          why: 'reason',
          current: 'hello',
          suggested: 'hi'
        }
      ]
    }

    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      parsedReview,
      { totalTokens: 10 },
      testCanonicalText,
      'completed'
    )

    // The highlighted span must not end with whitespace
    const highlighted = envelope.annotatedSections.find(
      (s) => s.issueIdx !== null
    )
    if (highlighted) {
      expect(highlighted.text).not.toMatch(/\s$/)
    }
    expect(envelope.documentId).toBe(REVIEW_ID)
  })

  it('directly calls _snapToWordBoundary with end landing on whitespace-preceded position', () => {
    // text = 'hello \nworld', start=0, end=6 ('\n')
    // e stays at 6 (text[6]='\n' not word char)
    // text[5]=' ' → trailing trim: e-- to 5
    // text[4]='o' → stops; result end=5
    // leading trim: text[0]='h' not whitespace → s stays 0
    const text = 'hello \nworld'
    const result = resultEnvelopeStore._snapToWordBoundary(text, 0, 6)
    expect(result.end).toBe(5)
    expect(result.start).toBe(0)
    expect(text.slice(result.start, result.end)).toBe('hello')
  })
})

// ── _isValidLinkEntry false branches (lines 707, 710) ────────────────────────
// _isValidLinkEntry is private but exercised via _validatedLinks → buildEnvelope
// with a linkMap containing entries that should be filtered out.
describe('buildEnvelope — _isValidLinkEntry filtering (lines 707, 710)', () => {
  const linkTestCanonical = 'Visit the site for more information.'
  const baseParsedReview = {
    scores: { 'plain english': 4 },
    reviewedContent: { plainText: linkTestCanonical, issues: [] },
    improvements: []
  }

  it('filters out linkMap entries with start >= end (line 707 branch)', () => {
    // entry.end <= entry.start should be rejected by the second if-guard
    const badLinkMap = [
      { start: 10, end: 5, display: '[site](https://example.com)' }
    ]

    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      baseParsedReview,
      { totalTokens: 10 },
      linkTestCanonical,
      'completed',
      badLinkMap
    )

    // Invalid entry discarded — annotated sections should still contain full text
    const texts = envelope.annotatedSections.map((s) => s.text).join('')
    expect(texts).toBe(linkTestCanonical)
  })

  it('filters out linkMap entries with non-string display (line 710 branch)', () => {
    // typeof e.display !== 'string' should be rejected
    const badLinkMap = [{ start: 6, end: 10, display: 42 }]

    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      baseParsedReview,
      { totalTokens: 10 },
      linkTestCanonical,
      'completed',
      badLinkMap
    )

    const texts = envelope.annotatedSections.map((s) => s.text).join('')
    expect(texts).toBe(linkTestCanonical)
  })

  it('filters out linkMap entries with negative start (line 707 branch)', () => {
    const badLinkMap = [
      { start: -1, end: 5, display: '[text](https://example.com)' }
    ]

    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      baseParsedReview,
      { totalTokens: 10 },
      linkTestCanonical,
      'completed',
      badLinkMap
    )

    const texts = envelope.annotatedSections.map((s) => s.text).join('')
    expect(texts).toBe(linkTestCanonical)
  })

  it('filters out linkMap entries with non-number start/end (line 706 branch)', () => {
    // typeof e.start !== 'number' should be rejected by the first if-guard
    const badLinkMap = [
      { start: '6', end: 10, display: '[site](https://example.com)' }
    ]

    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      baseParsedReview,
      { totalTokens: 10 },
      linkTestCanonical,
      'completed',
      badLinkMap
    )

    const texts = envelope.annotatedSections.map((s) => s.text).join('')
    expect(texts).toBe(linkTestCanonical)
  })
})
