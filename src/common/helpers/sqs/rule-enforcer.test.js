import { describe, test, expect, vi } from 'vitest'
import { enforceMandatoryRules } from './rule-enforcer.js'

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

const PLEASE_SENTENCE = 'Please complete the form.'
const CATEGORY_PLAIN_ENGLISH = 'Plain English'
const EXISTING_REF = 5

function makeReview(improvements = [], issues = []) {
  return {
    scores: {},
    improvements,
    reviewedContent: { plainText: '', issues }
  }
}

describe('enforceMandatoryRules — empty/absent input', () => {
  test('returns parsedReview unchanged when canonicalText is empty string', () => {
    const review = makeReview()
    expect(enforceMandatoryRules(review, '')).toBe(review)
  })

  test('returns parsedReview unchanged when canonicalText is null', () => {
    const review = makeReview()
    expect(enforceMandatoryRules(review, null)).toBe(review)
  })
})

describe('enforceMandatoryRules — "please" rule — injection', () => {
  test('injects improvement when "please" is at the start of a sentence', () => {
    const result = enforceMandatoryRules(makeReview(), PLEASE_SENTENCE)

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].current).toBe(PLEASE_SENTENCE)
    expect(result.improvements[0].suggested).toBe('Complete the form.')
    expect(result.improvements[0].category).toBe(CATEGORY_PLAIN_ENGLISH)
  })

  test('injects improvement when "please" is mid-sentence', () => {
    const text = 'If you have questions, please contact us.'
    const result = enforceMandatoryRules(makeReview(), text)

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].current).toBe(text)
    expect(result.improvements[0].suggested).toBe(
      'If you have questions, contact us.'
    )
  })

  test('adds matching issue with correct positions', () => {
    const result = enforceMandatoryRules(makeReview(), PLEASE_SENTENCE)

    expect(result.reviewedContent.issues).toHaveLength(1)
    const issue = result.reviewedContent.issues[0]
    expect(issue.start).toBe(0)
    expect(issue.end).toBe(PLEASE_SENTENCE.length)
    expect(issue.type).toBe('plain-english')
    expect(issue.ref).toBe(result.improvements[0].ref)
  })

  test('assigns ref one higher than existing improvements', () => {
    const existing = {
      severity: 'high',
      category: CATEGORY_PLAIN_ENGLISH,
      issue: 'Long sentence',
      why: 'Too long',
      current: 'This is a long sentence.',
      suggested: 'Shorten this.',
      ref: EXISTING_REF
    }
    const result = enforceMandatoryRules(
      makeReview([existing]),
      PLEASE_SENTENCE
    )

    const injected = result.improvements.find((imp) =>
      imp.current.includes('Please')
    )
    expect(injected.ref).toBe(EXISTING_REF + 1)
  })
})

describe('enforceMandatoryRules — "please" rule — no injection', () => {
  test('does not inject when "please" is already flagged by an existing improvement', () => {
    const existing = {
      severity: 'medium',
      category: CATEGORY_PLAIN_ENGLISH,
      issue: 'Use of please',
      why: 'Direct language',
      current: PLEASE_SENTENCE,
      suggested: 'Complete the form.',
      ref: 1
    }
    const result = enforceMandatoryRules(
      makeReview([existing]),
      PLEASE_SENTENCE
    )

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0]).toBe(existing)
  })

  test('does not inject when text contains no "please"', () => {
    const text = 'Complete the form and submit it.'
    const review = makeReview()
    const result = enforceMandatoryRules(review, text)

    expect(result.improvements).toHaveLength(0)
    expect(result).toBe(review)
  })
})

describe('enforceMandatoryRules — "Government" capitalisation rule — injection', () => {
  test('injects improvement for mid-sentence "Government"', () => {
    const text = 'The Government has announced new policies.'
    const result = enforceMandatoryRules(makeReview(), text)

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].current).toBe('Government')
    expect(result.improvements[0].suggested).toBe('government')
    expect(result.improvements[0].category).toBe('GOV.UK Style Compliance')
  })

  test('adds matching issue with correct positions', () => {
    const text = 'The Government has announced new policies.'
    const result = enforceMandatoryRules(makeReview(), text)

    const issue = result.reviewedContent.issues[0]
    const expectedStart = text.indexOf('Government')
    expect(issue.start).toBe(expectedStart)
    expect(issue.end).toBe(expectedStart + 'Government'.length)
    expect(issue.type).toBe('govuk-style')
  })

  test('only injects for the first occurrence', () => {
    const text =
      'The Government announced it. The Government confirmed it later.'
    const result = enforceMandatoryRules(makeReview(), text)

    const injected = result.improvements.filter(
      (imp) => imp.current === 'Government'
    )
    expect(injected).toHaveLength(1)
    expect(injected[0].start).toBe(text.indexOf('Government'))
  })
})

describe('enforceMandatoryRules — "Government" capitalisation rule — no injection', () => {
  test('does not inject when "Government" starts the sentence', () => {
    const text = 'Government is responsible for policy decisions.'
    const result = enforceMandatoryRules(makeReview(), text)

    expect(result.improvements).toHaveLength(0)
  })

  test('does not inject for "Welsh Government"', () => {
    const text = 'This is a Welsh Government initiative.'
    const result = enforceMandatoryRules(makeReview(), text)

    expect(result.improvements).toHaveLength(0)
  })

  test('does not inject when "Government" follows a full stop', () => {
    const text = 'Policy ended. Government will now lead.'
    const result = enforceMandatoryRules(makeReview(), text)

    expect(result.improvements).toHaveLength(0)
  })

  test('does not inject when "Government" is already flagged', () => {
    const existing = {
      severity: 'medium',
      category: 'GOV.UK Style Compliance',
      issue: 'Capitalisation',
      why: 'Sentence case required',
      current: 'a Government policy',
      suggested: 'a government policy',
      ref: 2
    }
    const text = 'The Government announced new policies.'
    const result = enforceMandatoryRules(makeReview([existing]), text)

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0]).toBe(existing)
  })
})

describe('enforceMandatoryRules — combined rules', () => {
  test('injects both improvements when both are missed', () => {
    const text = 'Please complete the form. The Government will review it.'
    const result = enforceMandatoryRules(makeReview(), text)

    expect(result.improvements).toHaveLength(2)
    expect(result.reviewedContent.issues).toHaveLength(2)

    const pleaseImp = result.improvements.find((imp) =>
      imp.current.toLowerCase().includes('please')
    )
    const govImp = result.improvements.find(
      (imp) => imp.current === 'Government'
    )
    expect(pleaseImp).toBeDefined()
    expect(govImp).toBeDefined()
  })

  test('returns original reference when nothing is injected', () => {
    const text = 'Complete the form and submit it.'
    const review = makeReview()
    const result = enforceMandatoryRules(review, text)

    expect(result).toBe(review)
  })
})
