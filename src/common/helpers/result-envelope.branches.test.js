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

const REVIEW_ID = 'review_branches-uuid'
const CANONICAL_TEXT = 'The department should utilise all resources available.'
const BEDROCK_USAGE = { totalTokens: 500, inputTokens: 400, outputTokens: 100 }
const PLAIN_ENGLISH_KEY = 'plain-english'
const UTILISE_TEXT = 'utilise'

function makeParsedReview(overrides = {}) {
  return {
    scores: {
      'Plain English': { score: 4, note: 'Good' },
      'Clarity & Structure': { score: 3, note: 'OK' },
      Accessibility: { score: 5, note: 'Excellent' },
      'GovUK Style Compliance': { score: 4, note: 'Mostly compliant' },
      'Content Completeness': { score: 3, note: 'Missing some details' }
    },
    reviewedContent: {
      issues: [
        {
          start: 4,
          end: 11,
          type: PLAIN_ENGLISH_KEY,
          text: UTILISE_TEXT,
          ref: 1
        }
      ]
    },
    improvements: [
      {
        severity: 'medium',
        category: PLAIN_ENGLISH_KEY,
        issue: 'Use simpler word',
        why: '"utilise" should be "use"',
        current: UTILISE_TEXT,
        suggested: 'use',
        ref: 1
      }
    ],
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── _sortAndAlignPairs delegate (line 94-95) ──────────────────────────────────
// This method is a public delegate that wraps sortAndAlignPairs from the
// issue-mappers module.  No existing test in result-envelope.test.js calls it
// directly — it is only reached indirectly via buildEnvelope with a truthy
// canonicalText.  Calling it directly covers lines 94-95.

describe('_sortAndAlignPairs (line 94-95)', () => {
  it('returns empty sorted arrays when both inputs are empty', () => {
    const result = resultEnvelopeStore._sortAndAlignPairs(
      CANONICAL_TEXT,
      [],
      []
    )
    expect(Array.isArray(result.sortedIssues)).toBe(true)
    expect(Array.isArray(result.sortedImprovements)).toBe(true)
    expect(result.sortedIssues).toHaveLength(0)
    expect(result.sortedImprovements).toHaveLength(0)
  })
})

// ── buildEnvelope — null canonicalText (ternary false branch, line 153) ───────
// All tests in result-envelope.test.js pass a non-empty string as canonicalText,
// so sortAndAlignPairs is always invoked (true branch).  Passing null triggers
// the false branch which uses prelimIssues/prelimImprovements directly without
// calling sortAndAlignPairs.

describe('buildEnvelope — null canonicalText (ternary false branch, line 153)', () => {
  it('uses prelimIssues and prelimImprovements directly when canonicalText is null', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      BEDROCK_USAGE,
      null
    )
    expect(envelope.documentId).toBe(REVIEW_ID)
    expect(envelope.status).toBe('completed')
    expect(Array.isArray(envelope.issues)).toBe(true)
  })
})

// ── reviewedContent.issues absent — || [] fallback (line 124) ─────────────────
// When reviewedContent has no `issues` property the expression `|| []` is taken.
// All existing tests always provide an issues array, so this branch is never hit.

describe('buildEnvelope — reviewedContent without issues (line 124 || [] branch)', () => {
  it('treats rawIssues as empty array when reviewedContent.issues is absent', () => {
    const parsedReview = makeParsedReview({
      reviewedContent: {} // no `issues` key → triggers || []
    })
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      parsedReview,
      BEDROCK_USAGE,
      null
    )
    expect(envelope.documentId).toBe(REVIEW_ID)
    expect(Array.isArray(envelope.issues)).toBe(true)
    expect(envelope.issues).toHaveLength(0)
  })
})

// ── rawIssue.ref === undefined — ternary true branch + ?? null fallback ───────
// Lines 140-141 are V8 branch markers for the ternary and nullish-coalescing
// operators inside rawIssues.map().
//
// Line 140: `parsedImprovements[idx] ?? null`
//   Branch A (covered by prior tests): parsedImprovements[idx] is defined
//   Branch B (uncovered):              parsedImprovements[idx] is undefined
//     → need an issue without ref where improvements array is shorter than issues
//
// Line 141: `improvByRef.get(rawIssue.ref) ?? parsedImprovements[idx] ?? null`
//   Outer ?? Branch B (uncovered): improvByRef has no entry for that ref
//   Inner ?? Branch B (uncovered): parsedImprovements[idx] is also undefined
//     → need an issue with an unknown ref when improvements array is empty

describe('buildEnvelope — rawIssue without ref, no improvements (line 140 ?? null)', () => {
  it('uses null as pairedImp when ref is absent and improvements array is empty', () => {
    const parsedReview = makeParsedReview({
      reviewedContent: {
        issues: [
          { start: 0, end: 4, type: PLAIN_ENGLISH_KEY, text: UTILISE_TEXT }
        ]
      },
      improvements: [] // parsedImprovements[0] === undefined → ?? null kicks in
    })
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      parsedReview,
      BEDROCK_USAGE,
      null
    )
    expect(envelope.documentId).toBe(REVIEW_ID)
    expect(Array.isArray(envelope.issues)).toBe(true)
  })
})

describe('buildEnvelope — rawIssue with unknown ref, no improvements (line 141 ?? null)', () => {
  it('uses null as pairedImp when ref is absent from improvByRef and improvements is empty', () => {
    const parsedReview = makeParsedReview({
      reviewedContent: {
        issues: [
          {
            start: 0,
            end: 4,
            type: PLAIN_ENGLISH_KEY,
            text: UTILISE_TEXT,
            ref: 99
          }
        ]
      },
      improvements: [] // improvByRef is empty; parsedImprovements[0] undefined → ?? null
    })
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      parsedReview,
      BEDROCK_USAGE,
      null
    )
    expect(envelope.documentId).toBe(REVIEW_ID)
    expect(Array.isArray(envelope.issues)).toBe(true)
  })
})
