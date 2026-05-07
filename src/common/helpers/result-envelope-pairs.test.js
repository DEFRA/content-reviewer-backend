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
const TYPE_PLAIN = 'plain-english'
const TYPE_GOVUK = 'govuk-style'
const TYPE_CLARITY = 'clarity'

// Text used across all pairing tests
// "utilise"      → offsets 22–29, ref 1
// "going forward" → offsets 44–57, ref 2
const PAIR_TEXT =
  'The department should utilise all resources going forward today.'
const UTILISE_START = 22
const UTILISE_END = 29
const FORWARD_START = 44
const FORWARD_END = 57
const OVERLAP_MID_END = 35
const OVERLAP_MID_START = 30
const OVERLAP_FAR_END = 45
const UNMATCHED_REF = 99
const ANNOTATE_TEXT = 'The department should utilise all resources.'
const ANNOTATE_UTILISE_START = 22
const ANNOTATE_UTILISE_END = 29
const ANNOTATE_ALL_START = 30
const ANNOTATE_ALL_END = 33
const ANNOTATE_ISSUE_START = 34
const ANNOTATE_THE_END = 3
const ANNOTATE_SECTION_COUNT = 3
const INVALID_ISSUE_START = 50
const INVALID_ISSUE_END = 40
const MISMATCH_UTILISE_START = 22
const MISMATCH_UTILISE_END = 29
const MISMATCH_FORWARD_START = 44
const MISMATCH_FORWARD_END = 57
const MISMATCH_TOKENS = 300
const MISMATCH_UNMATCHED_REF = 5

// Reusable improvement objects for mismatch tests
const IMP_UTILISE_REF1 = {
  severity: 'high',
  category: TYPE_PLAIN,
  issue: 'Use simpler word',
  why: 'plain language',
  current: 'utilise',
  suggested: 'use',
  ref: 1
}
const IMP_FORWARD_REF2 = {
  severity: 'medium',
  category: TYPE_GOVUK,
  issue: 'Words to avoid',
  why: 'GOV.UK style',
  current: 'going forward',
  suggested: 'in future',
  ref: 2
}
const IMP_UTILISE_NO_REF = {
  severity: 'high',
  category: TYPE_PLAIN,
  issue: 'Use simpler word',
  why: 'plain language',
  current: 'utilise',
  suggested: 'use'
}
const IMP_FORWARD_NO_REF = {
  severity: 'medium',
  category: TYPE_GOVUK,
  issue: 'Words to avoid',
  why: 'GOV.UK style',
  current: 'going forward',
  suggested: 'in future'
}

// ── Outer-scope factory helpers ───────────────────────────────────────────────

function makeIssue(start, end, ref, type = TYPE_PLAIN) {
  return {
    issueId: `issue-${ref}`,
    start: start,
    end: end,
    category: type,
    severity: 'medium',
    why: '',
    suggested: '',
    evidence: PAIR_TEXT.slice(start, end),
    chunkIdx: 0,
    ref
  }
}

function makeImprovement(ref, severity = 'medium') {
  return {
    issueId: `issue-orphan-${ref}`,
    severity,
    category: TYPE_PLAIN,
    issue: `Issue ${ref}`,
    why: `Why ${ref}`,
    current: `current ${ref}`,
    suggested: `suggested ${ref}`,
    ref
  }
}

function makeIssueNoRef(start, end, type = TYPE_PLAIN) {
  return {
    issueId: `issue-noref-${start}`,
    start: start,
    end: end,
    category: type,
    severity: 'medium',
    why: '',
    suggested: '',
    evidence: PAIR_TEXT.slice(start, end),
    chunkIdx: 0
  }
}

function makeImprovementNoRef(label, severity = 'medium') {
  return {
    issueId: `orphan-${label}`,
    severity,
    category: TYPE_PLAIN,
    issue: label,
    why: `Why ${label}`,
    current: `current ${label}`,
    suggested: `suggested ${label}`
  }
}

function makeMismatchReview(overrides = {}) {
  return {
    scores: {},
    reviewedContent: { issues: [] },
    improvements: [],
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

const STUB_ISSUE_TEXT = 'Issue identified'

// ── _buildAnnotatedSections ───────────────────────────────────────────────────

describe('_buildAnnotatedSections — basic structure', () => {
  it('returns empty array for empty canonicalText', () => {
    const result = resultEnvelopeStore._buildAnnotatedSections('', [])
    expect(result).toEqual([])
  })

  it('returns single plain section when no issues', () => {
    const sections = resultEnvelopeStore._buildAnnotatedSections(
      ANNOTATE_TEXT,
      []
    )
    expect(sections).toHaveLength(1)
    expect(sections[0].issueIdx).toBeNull()
    expect(sections[0].text).toBe(ANNOTATE_TEXT)
  })

  it('splits text into plain + highlight + plain sections', () => {
    const issues = [
      {
        start: ANNOTATE_UTILISE_START,
        end: ANNOTATE_UTILISE_END,
        category: TYPE_PLAIN,
        issueId: 'id-1',
        chunkIdx: 0
      }
    ]
    const sections = resultEnvelopeStore._buildAnnotatedSections(
      ANNOTATE_TEXT,
      issues
    )
    expect(sections).toHaveLength(ANNOTATE_SECTION_COUNT)
    expect(sections[0].issueIdx).toBeNull()
    expect(sections[1].issueIdx).toBe(0)
    expect(sections[1].text).toBe('utilise')
    expect(sections[2].issueIdx).toBeNull()
  })
})

describe('_buildAnnotatedSections — edge positions', () => {
  it('assigns sequential issueIdx values (0, 1, 2…)', () => {
    const issues = [
      {
        start: ANNOTATE_UTILISE_START,
        end: ANNOTATE_UTILISE_END,
        category: TYPE_PLAIN,
        issueId: 'a',
        chunkIdx: 0
      },
      {
        start: ANNOTATE_ALL_START,
        end: ANNOTATE_ALL_END,
        category: TYPE_CLARITY,
        issueId: 'b',
        chunkIdx: 1
      }
    ]
    const sections = resultEnvelopeStore._buildAnnotatedSections(
      ANNOTATE_TEXT,
      issues
    )
    const highlighted = sections.filter((s) => s.issueIdx !== null)
    expect(highlighted[0].issueIdx).toBe(0)
    expect(highlighted[1].issueIdx).toBe(1)
  })

  it('handles issue at start of text (no leading plain section)', () => {
    const issues = [
      {
        start: 0,
        end: ANNOTATE_THE_END,
        category: TYPE_PLAIN,
        issueId: 'a',
        chunkIdx: 0
      }
    ]
    const sections = resultEnvelopeStore._buildAnnotatedSections(
      ANNOTATE_TEXT,
      issues
    )
    expect(sections[0].issueIdx).toBe(0)
    expect(sections[0].text).toBe('The')
  })

  it('handles issue at end of text (no trailing plain section)', () => {
    const issues = [
      {
        start: ANNOTATE_ISSUE_START,
        end: ANNOTATE_TEXT.length,
        category: TYPE_CLARITY,
        issueId: 'a',
        chunkIdx: 0
      }
    ]
    const sections = resultEnvelopeStore._buildAnnotatedSections(
      ANNOTATE_TEXT,
      issues
    )
    const last = sections.at(-1)
    expect(last.issueIdx).toBe(0)
  })
})

// ── buildEnvelope — mismatch scenarios ───────────────────────────────────────

const MISMATCH_CANONICAL =
  'The department should utilise all resources going forward today.'
const MISMATCH_USAGE = { totalTokens: MISMATCH_TOKENS }

describe('buildEnvelope — mismatch: improvements with empty current are filtered', () => {
  it('discards improvements with empty current field', () => {
    const unmatchedImp = {
      severity: 'low',
      category: 'completeness',
      issue: 'Missing contact',
      why: 'users need a contact',
      current: '',
      suggested: 'Add contact details',
      ref: MISMATCH_UNMATCHED_REF
    }
    const review = makeMismatchReview({
      improvements: [IMP_UTILISE_REF1, unmatchedImp]
    })

    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      review,
      MISMATCH_USAGE,
      MISMATCH_CANONICAL
    )

    expect(envelope.improvements).toHaveLength(1)
    expect(envelope.improvements[0].issue).toBe('Use simpler word')
  })
})

describe('buildEnvelope — mismatch: more issues than improvements', () => {
  it('drops issue when no matching improvement exists (ref-based)', () => {
    const review = makeMismatchReview({
      reviewedContent: {
        issues: [
          {
            start: MISMATCH_UTILISE_START,
            end: MISMATCH_UTILISE_END,
            type: TYPE_PLAIN,
            text: 'utilise',
            ref: 1
          },
          {
            start: MISMATCH_FORWARD_START,
            end: MISMATCH_FORWARD_END,
            type: TYPE_GOVUK,
            text: 'going forward',
            ref: 2
          }
        ]
      },
      improvements: [IMP_UTILISE_REF1]
    })

    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      review,
      MISMATCH_USAGE,
      MISMATCH_CANONICAL
    )

    expect(envelope.issueCount).toBe(1)
    expect(envelope.improvements).toHaveLength(1)
    expect(
      envelope.improvements.find((imp) => imp.issue === STUB_ISSUE_TEXT)
    ).toBeUndefined()
  })

  it('drops issue when no matching improvement exists (index fallback)', () => {
    const review = makeMismatchReview({
      reviewedContent: {
        issues: [
          {
            start: MISMATCH_UTILISE_START,
            end: MISMATCH_UTILISE_END,
            type: TYPE_PLAIN,
            text: 'utilise'
          },
          {
            start: MISMATCH_FORWARD_START,
            end: MISMATCH_FORWARD_END,
            type: TYPE_GOVUK,
            text: 'going forward'
          }
        ]
      },
      improvements: [IMP_UTILISE_NO_REF]
    })

    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      review,
      MISMATCH_USAGE,
      MISMATCH_CANONICAL
    )

    expect(envelope.issueCount).toBe(1)
    expect(envelope.improvements).toHaveLength(1)
    expect(envelope.improvements[0].issue).toBe('Use simpler word')
  })
})

describe('buildEnvelope — mismatch: annotatedSections integrity', () => {
  it('annotatedSections issueIdx values are 1:1 with matched improvements', () => {
    const review = makeMismatchReview({
      reviewedContent: {
        issues: [
          {
            start: MISMATCH_UTILISE_START,
            end: MISMATCH_UTILISE_END,
            type: TYPE_PLAIN,
            text: 'utilise',
            ref: 1
          }
        ]
      },
      improvements: [IMP_UTILISE_REF1]
    })

    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      review,
      MISMATCH_USAGE,
      MISMATCH_CANONICAL
    )

    const highlighted = envelope.annotatedSections.filter(
      (s) => s.issueIdx !== null
    )
    for (const section of highlighted) {
      expect(section.issueIdx).toBeGreaterThanOrEqual(0)
      expect(section.issueIdx).toBeLessThan(envelope.improvements.length)
      expect(envelope.improvements[section.issueIdx]).toBeDefined()
    }
  })

  it('handles entirely empty parsedReview gracefully', () => {
    const review = {
      scores: {},
      reviewedContent: { issues: [] },
      improvements: []
    }
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      review,
      MISMATCH_USAGE,
      MISMATCH_CANONICAL
    )
    expect(envelope.issueCount).toBe(0)
    expect(envelope.improvements).toHaveLength(0)
    expect(envelope.annotatedSections).toHaveLength(1)
    expect(envelope.annotatedSections[0].issueIdx).toBeNull()
  })
})
