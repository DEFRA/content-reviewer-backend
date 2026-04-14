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
  PRIORITY_MEDIUM_OPEN,
  ACCESSIBILITY_SCORE_LINE,
  COMPLETENESS_SCORE_LINE
} from './review-parser-test-helpers.js'

// ============ False-positive filtering integration tests ============

describe('parseBedrockResponse - acronym false-positive filtering', () => {
  it('removes improvement for acronym that is explained in originalText', () => {
    const originalText =
      'Import of Products, Animals, Food and Feed System (IPAFFS) is used by importers. You must register on IPAFFS before importing.'

    const improvements = [
      PRIORITY_MEDIUM_OPEN,
      'REF: 1',
      'CATEGORY: Accessibility',
      'ISSUE: Unexplained acronym IPAFFS',
      'WHY: The acronym IPAFFS may not be understood by all users',
      'CURRENT: You must register on IPAFFS',
      'SUGGESTED: You must register on the Import of Products, Animals, Food and Feed System (IPAFFS)'
    ].join('\n')

    const issuePositions =
      '{"issues":[{"ref":1,"start":80,"end":86,"type":"accessibility","text":"IPAFFS"}]}'

    const response = [
      SCORES_TAG_OPEN,
      ACCESSIBILITY_SCORE_LINE,
      SCORES_TAG_CLOSE,
      ISSUE_POSITIONS_OPEN,
      issuePositions,
      ISSUE_POSITIONS_CLOSE,
      IMPROVEMENTS_OPEN,
      improvements,
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(response, undefined, originalText)

    expect(result.improvements).toHaveLength(0)
    expect(result.reviewedContent.issues).toHaveLength(0)
  })

  it('keeps improvement for acronym that is genuinely unexplained', () => {
    const originalText =
      'You must register on DEFRA before importing any products.'

    const improvements = [
      PRIORITY_MEDIUM_OPEN,
      'REF: 1',
      'CATEGORY: Accessibility',
      'ISSUE: Unexplained acronym DEFRA',
      'WHY: The acronym DEFRA is not explained anywhere',
      'CURRENT: register on DEFRA',
      'SUGGESTED: register on the Department for Environment, Food and Rural Affairs (DEFRA)'
    ].join('\n')

    const issuePositions =
      '{"issues":[{"ref":1,"start":21,"end":26,"type":"accessibility","text":"DEFRA"}]}'

    const response = [
      SCORES_TAG_OPEN,
      ACCESSIBILITY_SCORE_LINE,
      SCORES_TAG_CLOSE,
      ISSUE_POSITIONS_OPEN,
      issuePositions,
      ISSUE_POSITIONS_CLOSE,
      IMPROVEMENTS_OPEN,
      improvements,
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(response, undefined, originalText)

    expect(result.improvements).toHaveLength(1)
    expect(result.reviewedContent.issues).toHaveLength(1)
  })
})

describe('parseBedrockResponse - date false-positive filtering', () => {
  it('removes improvement for past date flagged as future', () => {
    const originalText = 'The regulation came into effect on 1 March 2025.'

    const improvements = [
      PRIORITY_MEDIUM_OPEN,
      'REF: 1',
      'CATEGORY: Completeness',
      'ISSUE: Future date referenced',
      'WHY: This date in the future may become outdated',
      'CURRENT: The regulation came into effect on 1 March 2025',
      'SUGGESTED: Verify that this date is still accurate'
    ].join('\n')

    const issuePositions =
      '{"issues":[{"ref":1,"start":35,"end":47,"type":"completeness","text":"1 March 2025"}]}'

    const response = [
      SCORES_TAG_OPEN,
      COMPLETENESS_SCORE_LINE,
      SCORES_TAG_CLOSE,
      ISSUE_POSITIONS_OPEN,
      issuePositions,
      ISSUE_POSITIONS_CLOSE,
      IMPROVEMENTS_OPEN,
      improvements,
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(response, undefined, originalText)

    expect(result.improvements).toHaveLength(0)
    expect(result.reviewedContent.issues).toHaveLength(0)
  })

  it('keeps improvement for genuinely future date', () => {
    const originalText = 'The new rules take effect on 1 March 2099.'

    const improvements = [
      PRIORITY_MEDIUM_OPEN,
      'REF: 1',
      'CATEGORY: Completeness',
      'ISSUE: Future date referenced',
      'WHY: This date in the future may become outdated',
      'CURRENT: The new rules take effect on 1 March 2099',
      'SUGGESTED: Review whether this date is still accurate'
    ].join('\n')

    const issuePositions =
      '{"issues":[{"ref":1,"start":29,"end":41,"type":"completeness","text":"1 March 2099"}]}'

    const response = [
      SCORES_TAG_OPEN,
      COMPLETENESS_SCORE_LINE,
      SCORES_TAG_CLOSE,
      ISSUE_POSITIONS_OPEN,
      issuePositions,
      ISSUE_POSITIONS_CLOSE,
      IMPROVEMENTS_OPEN,
      improvements,
      IMPROVEMENTS_CLOSE
    ].join('\n')

    const result = parseBedrockResponse(response, undefined, originalText)

    expect(result.improvements).toHaveLength(1)
    expect(result.reviewedContent.issues).toHaveLength(1)
  })
})
