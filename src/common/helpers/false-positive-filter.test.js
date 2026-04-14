import { describe, it, expect, vi } from 'vitest'

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

import {
  isAcronymFalsePositive,
  isDateFalsePositive,
  filterFalsePositives
} from './false-positive-filter.js'

const NHS_EXPLAINED =
  'National Health Service (NHS) provides care. Contact the NHS.'
const NHS_EXPLAINED_EXT =
  'The National Health Service (NHS) provides healthcare. Register with the NHS.'
const ISSUE_UNEXPLAINED_NHS = 'Unexplained acronym NHS'
const ISSUE_FUTURE_DATE = 'Future date referenced'
const WHY_DATE_FUTURE = 'This date in the future may be wrong'
const CURRENT_MARCH_2025 = 'The deadline was 1 March 2025'
const CATEGORY_PLAIN_ENGLISH = 'Plain English'
const ISSUE_JARGON = 'Use of jargon'
const WHY_COMPLEX = 'Complex word'
const TYPE_PLAIN_ENGLISH = 'plain-english'

describe('isAcronymFalsePositive - basic', () => {
  it('returns false when originalText is empty', () => {
    const imp = {
      issue: 'Unexplained acronym',
      why: 'IPAFFS is jargon',
      current: 'IPAFFS'
    }
    expect(isAcronymFalsePositive(imp, '')).toBe(false)
  })

  it('returns false when the issue is not about acronyms', () => {
    const imp = {
      issue: 'Passive voice',
      why: 'Sentence is unclear',
      current: 'The form was submitted by the user'
    }
    expect(isAcronymFalsePositive(imp, 'some text')).toBe(false)
  })

  it('detects FP when Full Name (ACRONYM) pattern exists', () => {
    const imp = {
      issue: 'Unexplained acronym IPAFFS',
      why: 'The acronym IPAFFS may not be understood',
      current: 'You must register on IPAFFS'
    }
    const orig =
      'Import of Products, Animals, Food and Feed System (IPAFFS) is the UK system.'
    expect(isAcronymFalsePositive(imp, orig)).toBe(true)
  })

  it('detects FP when ACRONYM (Full Name) pattern exists', () => {
    const imp = {
      issue: 'Unexplained acronym MMO',
      why: 'The acronym MMO is jargon',
      current: 'Contact the MMO for guidance'
    }
    const orig = 'MMO (Marine Management Organisation) is responsible.'
    expect(isAcronymFalsePositive(imp, orig)).toBe(true)
  })

  it('returns false when acronym is genuinely unexplained', () => {
    const imp = {
      issue: 'Unexplained acronym DEFRA',
      why: 'The acronym DEFRA is not explained',
      current: 'Contact DEFRA'
    }
    expect(isAcronymFalsePositive(imp, 'Contact DEFRA.')).toBe(false)
  })
})

describe('isAcronymFalsePositive - keyword variants', () => {
  it('detects FP with keyword jargon', () => {
    const imp = {
      issue: 'Technical jargon',
      why: 'NHS is jargon that users may not understand',
      current: 'Register with the NHS'
    }
    expect(isAcronymFalsePositive(imp, NHS_EXPLAINED_EXT)).toBe(true)
  })

  it('detects FP with keyword not defined', () => {
    const imp = {
      issue: 'Acronym not defined',
      why: 'EU is used without definition',
      current: 'EU regulations apply'
    }
    expect(
      isAcronymFalsePositive(imp, 'EU (European Union) regulations apply.')
    ).toBe(true)
  })

  it('returns false when only some acronyms explained', () => {
    const imp = {
      issue: 'Unexplained acronyms',
      why: 'Multiple acronyms need explanation',
      current: 'Contact the MMO and APHA'
    }
    const orig = 'MMO (Marine Management Organisation) handles marine. APHA.'
    expect(isAcronymFalsePositive(imp, orig)).toBe(false)
  })

  it('returns false when no acronyms in CURRENT', () => {
    const imp = {
      issue: 'Unexplained term',
      why: 'Technical term is jargon',
      current: 'Use the online service'
    }
    expect(isAcronymFalsePositive(imp, 'Use the service.')).toBe(false)
  })

  it('falls back to issue field when current empty', () => {
    const imp = {
      issue: ISSUE_UNEXPLAINED_NHS,
      why: 'NHS is jargon',
      current: ''
    }
    expect(isAcronymFalsePositive(imp, NHS_EXPLAINED)).toBe(true)
  })
})

describe('isDateFalsePositive - basic', () => {
  it('returns false when issue is not about dates', () => {
    const imp = {
      issue: 'Passive voice used',
      why: 'The sentence is unclear',
      current: 'Submitted on 1 March 2025'
    }
    expect(isDateFalsePositive(imp)).toBe(false)
  })

  it('detects FP for past D Month YYYY date', () => {
    const imp = {
      issue: ISSUE_FUTURE_DATE,
      why: WHY_DATE_FUTURE,
      current: CURRENT_MARCH_2025
    }
    expect(isDateFalsePositive(imp)).toBe(true)
  })

  it('detects FP for past date with ordinal suffix', () => {
    const imp = {
      issue: 'Future date used',
      why: 'This date in the future may become outdated',
      current: 'Submit by 15th January 2025'
    }
    expect(isDateFalsePositive(imp)).toBe(true)
  })

  it('detects FP for past ISO date', () => {
    const imp = {
      issue: 'Future date reference',
      why: 'Date in the future needs checking',
      current: 'Effective from 2025-01-15'
    }
    expect(isDateFalsePositive(imp)).toBe(true)
  })

  it('detects FP for past DD/MM/YYYY date', () => {
    const imp = {
      issue: 'Future date',
      why: 'This date in the future should be reviewed',
      current: 'Due on 15/03/2025'
    }
    expect(isDateFalsePositive(imp)).toBe(true)
  })

  it('returns false for genuinely future date', () => {
    const imp = {
      issue: ISSUE_FUTURE_DATE,
      why: 'This date in the future may be speculative',
      current: 'The deadline is 1 March 2099'
    }
    expect(isDateFalsePositive(imp)).toBe(false)
  })
})

describe('isDateFalsePositive - edge cases', () => {
  it('returns false when no date found in text', () => {
    const imp = {
      issue: 'Future date issue',
      why: 'Date in the future is referenced',
      current: 'The deadline is next year'
    }
    expect(isDateFalsePositive(imp)).toBe(false)
  })

  it('detects FP for Month YYYY format past', () => {
    const imp = {
      issue: 'Future date',
      why: WHY_DATE_FUTURE,
      current: 'Published in January 2024'
    }
    expect(isDateFalsePositive(imp)).toBe(true)
  })

  it('falls back to issue field when current empty', () => {
    const imp = {
      issue: 'Future date: 1 January 2020',
      why: 'Date in the future is wrong',
      current: ''
    }
    expect(isDateFalsePositive(imp)).toBe(true)
  })

  it('detects FP with keyword not yet passed', () => {
    const imp = {
      issue: 'Date has not yet passed',
      why: 'The date 5 June 2024 has not yet passed',
      current: 'Changes take effect on 5 June 2024'
    }
    expect(isDateFalsePositive(imp)).toBe(true)
  })
})

describe('filterFalsePositives - pass-through', () => {
  it('keeps non-false-positive improvements', () => {
    const imps = [
      {
        ref: 1,
        severity: 'high',
        category: CATEGORY_PLAIN_ENGLISH,
        issue: ISSUE_JARGON,
        why: WHY_COMPLEX,
        current: 'utilise',
        suggested: 'use'
      }
    ]
    const iss = [
      { ref: 1, start: 10, end: 17, type: TYPE_PLAIN_ENGLISH, text: 'utilise' }
    ]
    const result = filterFalsePositives(imps, iss, 'You should utilise.')
    expect(result.improvements).toHaveLength(1)
    expect(result.issues).toHaveLength(1)
  })

  it('returns all items when no FPs found', () => {
    const imps = [
      {
        ref: 1,
        severity: 'high',
        category: CATEGORY_PLAIN_ENGLISH,
        issue: 'Complex word',
        why: 'Jargon used',
        current: 'utilise',
        suggested: 'use'
      },
      {
        ref: 2,
        severity: 'medium',
        category: 'Clarity',
        issue: 'Passive voice',
        why: 'Unclear who acts',
        current: 'was done',
        suggested: 'we did'
      }
    ]
    const iss = [
      { ref: 1, start: 0, end: 7, type: TYPE_PLAIN_ENGLISH, text: 'utilise' },
      { ref: 2, start: 20, end: 28, type: 'clarity', text: 'was done' }
    ]
    const result = filterFalsePositives(imps, iss, 'utilise. was done.')
    expect(result.improvements).toHaveLength(2)
    expect(result.issues).toHaveLength(2)
  })

  it('handles empty arrays', () => {
    const result = filterFalsePositives([], [], 'some text')
    expect(result.improvements).toEqual([])
    expect(result.issues).toEqual([])
  })
})

describe('filterFalsePositives - acronym removal', () => {
  it('removes acronym FP and its linked issue', () => {
    const imps = [
      {
        ref: 1,
        severity: 'medium',
        category: 'Accessibility',
        issue: 'Unexplained acronym IPAFFS',
        why: 'The acronym is not explained',
        current: 'Register on IPAFFS',
        suggested: 'Register on the system'
      },
      {
        ref: 2,
        severity: 'high',
        category: CATEGORY_PLAIN_ENGLISH,
        issue: 'Use of jargon word',
        why: WHY_COMPLEX,
        current: 'utilise',
        suggested: 'use'
      }
    ]
    const iss = [
      { ref: 1, start: 50, end: 56, type: 'accessibility', text: 'IPAFFS' },
      {
        ref: 2,
        start: 100,
        end: 107,
        type: TYPE_PLAIN_ENGLISH,
        text: 'utilise'
      }
    ]
    const orig = 'Import of Products (IPAFFS). utilise.'

    const result = filterFalsePositives(imps, iss, orig)

    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].ref).toBe(2)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].ref).toBe(2)
  })
})

describe('filterFalsePositives - keeps unlinked issues', () => {
  it('keeps issues without refs when improvements removed', () => {
    const imps = [
      {
        ref: 1,
        severity: 'medium',
        category: 'Accessibility',
        issue: ISSUE_UNEXPLAINED_NHS,
        why: 'Not explained',
        current: 'Contact the NHS',
        suggested: 'Contact the National Health Service'
      }
    ]
    const iss = [
      { ref: 1, start: 12, end: 15, type: 'accessibility', text: 'NHS' },
      { start: 50, end: 57, type: TYPE_PLAIN_ENGLISH, text: 'utilise' }
    ]
    const result = filterFalsePositives(imps, iss, NHS_EXPLAINED)

    expect(result.improvements).toHaveLength(0)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].text).toBe('utilise')
  })
})

describe('filterFalsePositives - no ref field', () => {
  it('handles improvements without ref field', () => {
    const imps = [
      {
        severity: 'medium',
        category: 'Accessibility',
        issue: ISSUE_UNEXPLAINED_NHS,
        why: 'Not explained',
        current: 'Contact the NHS',
        suggested: 'Contact the National Health Service'
      }
    ]
    const iss = [{ start: 12, end: 15, type: 'accessibility', text: 'NHS' }]
    const result = filterFalsePositives(imps, iss, NHS_EXPLAINED)

    expect(result.improvements).toHaveLength(0)
    expect(result.issues).toHaveLength(1)
  })
})

describe('filterFalsePositives - date removal', () => {
  it('removes date FP and its linked issue', () => {
    const imps = [
      {
        ref: 1,
        severity: 'medium',
        category: 'Completeness',
        issue: ISSUE_FUTURE_DATE,
        why: WHY_DATE_FUTURE,
        current: CURRENT_MARCH_2025,
        suggested: 'Review the date'
      }
    ]
    const iss = [
      { ref: 1, start: 17, end: 30, type: 'completeness', text: '1 March 2025' }
    ]
    const result = filterFalsePositives(imps, iss, CURRENT_MARCH_2025)

    expect(result.improvements).toHaveLength(0)
    expect(result.issues).toHaveLength(0)
  })
})
