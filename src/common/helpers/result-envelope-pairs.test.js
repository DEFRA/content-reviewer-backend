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
    absStart: start,
    absEnd: end,
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
    absStart: start,
    absEnd: end,
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

// ── _sortAndAlignPairs — ref-based matching ───────────────────────────────────

const STUB_ISSUE_TEXT = 'Issue identified'

describe('_sortAndAlignPairs — ref-based (1:1 and ordering)', () => {
  it('matches issues to improvements by ref (1:1 aligned)', () => {
    const issues = [
      makeIssue(UTILISE_START, UTILISE_END, 1),
      makeIssue(FORWARD_START, FORWARD_END, 2)
    ]
    const improvements = [makeImprovement(1), makeImprovement(2)]
    const { sortedIssues, sortedImprovements } =
      resultEnvelopeStore._sortAndAlignPairs(PAIR_TEXT, issues, improvements)

    expect(sortedIssues).toHaveLength(2)
    expect(sortedImprovements).toHaveLength(2)
    expect(sortedImprovements[0].issueId).toBe(sortedIssues[0].issueId)
    expect(sortedImprovements[1].issueId).toBe(sortedIssues[1].issueId)
  })

  it('matches improvements to correct issues when refs are out of order', () => {
    const issues = [
      makeIssue(UTILISE_START, UTILISE_END, 2),
      makeIssue(FORWARD_START, FORWARD_END, 1)
    ]
    const improvements = [makeImprovement(1, 'high'), makeImprovement(2, 'low')]
    const { sortedIssues, sortedImprovements } =
      resultEnvelopeStore._sortAndAlignPairs(PAIR_TEXT, issues, improvements)

    expect(sortedIssues).toHaveLength(2)
    expect(sortedImprovements).toHaveLength(2)
    expect(sortedImprovements.every((imp) => !imp.unmatched)).toBe(true)
  })

  it('sorts issues by absStart (text order)', () => {
    const issues = [
      makeIssue(FORWARD_START, FORWARD_END, 2),
      makeIssue(UTILISE_START, UTILISE_END, 1)
    ]
    const improvements = [makeImprovement(1), makeImprovement(2)]
    const { sortedIssues } = resultEnvelopeStore._sortAndAlignPairs(
      PAIR_TEXT,
      issues,
      improvements
    )
    expect(sortedIssues[0].absStart).toBeLessThan(sortedIssues[1].absStart)
  })

  it('assigns sequential chunkIdx starting at 0', () => {
    const issues = [
      makeIssue(UTILISE_START, UTILISE_END, 1),
      makeIssue(FORWARD_START, FORWARD_END, 2)
    ]
    const improvements = [makeImprovement(1), makeImprovement(2)]
    const { sortedIssues } = resultEnvelopeStore._sortAndAlignPairs(
      PAIR_TEXT,
      issues,
      improvements
    )
    expect(sortedIssues[0].chunkIdx).toBe(0)
    expect(sortedIssues[1].chunkIdx).toBe(1)
  })
})

describe('_sortAndAlignPairs — ref-based (mismatch cases)', () => {
  it('discards improvement when its ref has no matching issue', () => {
    const issues = [makeIssue(UTILISE_START, UTILISE_END, 1)]
    const improvements = [makeImprovement(1), makeImprovement(UNMATCHED_REF)]
    const { sortedIssues, sortedImprovements } =
      resultEnvelopeStore._sortAndAlignPairs(PAIR_TEXT, issues, improvements)

    expect(sortedIssues).toHaveLength(1)
    expect(sortedImprovements).toHaveLength(1)
    expect(sortedImprovements[0].ref).toBe(1)
  })

  it('drops issue when no paired improvement exists', () => {
    const issues = [makeIssue(UTILISE_START, UTILISE_END, 1)]
    const improvements = [makeImprovement(UNMATCHED_REF)]
    const { sortedIssues, sortedImprovements } =
      resultEnvelopeStore._sortAndAlignPairs(PAIR_TEXT, issues, improvements)

    expect(sortedIssues).toHaveLength(0)
    expect(sortedImprovements).toHaveLength(0)
  })

  it('drops overlapping issue spans', () => {
    const issues = [
      makeIssue(UTILISE_START, OVERLAP_MID_END, 1),
      makeIssue(OVERLAP_MID_START, OVERLAP_FAR_END, 2)
    ]
    const improvements = [makeImprovement(1), makeImprovement(2)]
    const { sortedIssues } = resultEnvelopeStore._sortAndAlignPairs(
      PAIR_TEXT,
      issues,
      improvements
    )
    expect(sortedIssues).toHaveLength(1)
  })
})

// ── _sortAndAlignPairs — index-based fallback ─────────────────────────────────

describe('_sortAndAlignPairs — index-based fallback (1:1 and empty)', () => {
  it('pairs issues and improvements by index when no refs present', () => {
    const issues = [
      makeIssueNoRef(UTILISE_START, UTILISE_END),
      makeIssueNoRef(FORWARD_START, FORWARD_END)
    ]
    const improvements = [makeImprovementNoRef('A'), makeImprovementNoRef('B')]
    const { sortedIssues, sortedImprovements } =
      resultEnvelopeStore._sortAndAlignPairs(PAIR_TEXT, issues, improvements)

    expect(sortedIssues).toHaveLength(2)
    expect(sortedImprovements).toHaveLength(2)
    expect(sortedImprovements.every((imp) => !imp.unmatched)).toBe(true)
  })

  it('handles empty issues and improvements gracefully', () => {
    const { sortedIssues, sortedImprovements } =
      resultEnvelopeStore._sortAndAlignPairs(PAIR_TEXT, [], [])
    expect(sortedIssues).toHaveLength(0)
    expect(sortedImprovements).toHaveLength(0)
  })

  it('filters out issues with invalid offsets', () => {
    const issues = [
      makeIssueNoRef(UTILISE_START, UTILISE_END),
      { ...makeIssueNoRef(INVALID_ISSUE_START, INVALID_ISSUE_END) }
    ]
    const improvements = [makeImprovementNoRef('A'), makeImprovementNoRef('B')]
    const { sortedIssues, sortedImprovements } =
      resultEnvelopeStore._sortAndAlignPairs(PAIR_TEXT, issues, improvements)

    expect(sortedIssues).toHaveLength(1)
    expect(sortedImprovements.length).toBeGreaterThanOrEqual(1)
  })
})

describe('_sortAndAlignPairs — index-based fallback (mismatch cases)', () => {
  it('discards excess improvements when improvements > issues', () => {
    const issues = [makeIssueNoRef(UTILISE_START, UTILISE_END)]
    const improvements = [
      makeImprovementNoRef('A'),
      makeImprovementNoRef('B'),
      makeImprovementNoRef('C')
    ]
    const { sortedIssues, sortedImprovements } =
      resultEnvelopeStore._sortAndAlignPairs(PAIR_TEXT, issues, improvements)

    expect(sortedIssues).toHaveLength(1)
    expect(sortedImprovements).toHaveLength(1)
    expect(sortedImprovements[0].issue).toBe('A')
  })

  it('drops issue when paired improvement is missing', () => {
    const issues = [
      makeIssueNoRef(UTILISE_START, UTILISE_END),
      makeIssueNoRef(FORWARD_START, FORWARD_END)
    ]
    const improvements = [makeImprovementNoRef('A')]
    const { sortedIssues, sortedImprovements } =
      resultEnvelopeStore._sortAndAlignPairs(PAIR_TEXT, issues, improvements)

    expect(sortedIssues).toHaveLength(1)
    expect(sortedImprovements).toHaveLength(1)
    expect(sortedImprovements[0].issue).toBe('A')
  })
})

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
        absStart: ANNOTATE_UTILISE_START,
        absEnd: ANNOTATE_UTILISE_END,
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
        absStart: ANNOTATE_UTILISE_START,
        absEnd: ANNOTATE_UTILISE_END,
        category: TYPE_PLAIN,
        issueId: 'a',
        chunkIdx: 0
      },
      {
        absStart: ANNOTATE_ALL_START,
        absEnd: ANNOTATE_ALL_END,
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
        absStart: 0,
        absEnd: ANNOTATE_THE_END,
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
        absStart: ANNOTATE_ISSUE_START,
        absEnd: ANNOTATE_TEXT.length,
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

describe('buildEnvelope — mismatch: more improvements than issues', () => {
  it('discards unmatched improvements when improvements > issues (ref-based)', () => {
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
      improvements: [IMP_UTILISE_REF1, IMP_FORWARD_REF2]
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

  it('discards unmatched improvements when improvements > issues (index fallback)', () => {
    const review = makeMismatchReview({
      reviewedContent: {
        issues: [
          {
            start: MISMATCH_UTILISE_START,
            end: MISMATCH_UTILISE_END,
            type: TYPE_PLAIN,
            text: 'utilise'
          }
        ]
      },
      improvements: [IMP_UTILISE_NO_REF, IMP_FORWARD_NO_REF]
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
      envelope.improvements.find((imp) => imp.unmatched === true)
    ).toBeUndefined()
  })

  it('discards improvements with no matching issue (ref-based)', () => {
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
    expect(
      envelope.improvements.filter((imp) => imp.unmatched === true)
    ).toHaveLength(0)
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
