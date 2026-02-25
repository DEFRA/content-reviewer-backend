import { describe, test, expect, beforeEach, vi } from 'vitest'
import { parseBedrockResponse } from './review-parser.js'

// Test constants
const TEST_CATEGORY_CLARITY = 'Clarity'
const TEST_CATEGORY_ACCURACY = 'Accuracy'
const TEST_CATEGORY_GRAMMAR = 'Grammar'
const TEST_SCORE_4 = 4
const TEST_SCORE_3 = 3
const TEST_SCORE_5 = 5
const TEST_NOTE_GOOD = 'Good overall clarity'
const TEST_NOTE_EXCELLENT = 'Excellent accuracy'
const TEST_NOTE_MINOR = 'Minor grammar issues'
const TEST_ISSUE_CATEGORY = 'Spelling'
const TEST_ISSUE_TEXT = 'Word misspelled here'
const TEST_SEVERITY_HIGH = 'high'
const TEST_SEVERITY_MEDIUM = 'medium'
const TEST_IMPROVEMENT_CATEGORY = 'Terminology'
const TEST_IMPROVEMENT_ISSUE = 'Incorrect term used'
const TEST_IMPROVEMENT_WHY = 'Should use standard terminology'
const TEST_IMPROVEMENT_CURRENT = 'wrong term'
const TEST_IMPROVEMENT_SUGGESTED = 'correct term'

const mockLoggerInfo = vi.fn()
const mockLoggerWarn = vi.fn()
const mockLoggerError = vi.fn()

vi.mock('./logging/logger.js', () => ({
  createLogger: () => ({
    info: (...args) => mockLoggerInfo(...args),
    warn: (...args) => mockLoggerWarn(...args),
    error: (...args) => mockLoggerError(...args)
  })
}))

describe('parseBedrockResponse - marker-based format - scores', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should parse complete marker-based response with all sections', () => {
    const bedrockResponse = `
[SCORES]
${TEST_CATEGORY_CLARITY}: ${TEST_SCORE_4}/5 - ${TEST_NOTE_GOOD}
${TEST_CATEGORY_ACCURACY}: ${TEST_SCORE_5}/5 - ${TEST_NOTE_EXCELLENT}
[/SCORES]

[REVIEWED_CONTENT]
This is sample text [ISSUE:${TEST_ISSUE_CATEGORY}]${TEST_ISSUE_TEXT}[/ISSUE] with an issue.
[/REVIEWED_CONTENT]

[IMPROVEMENTS]
[PRIORITY:${TEST_SEVERITY_HIGH}]
CATEGORY: ${TEST_IMPROVEMENT_CATEGORY}
ISSUE: ${TEST_IMPROVEMENT_ISSUE}
WHY: ${TEST_IMPROVEMENT_WHY}
CURRENT: ${TEST_IMPROVEMENT_CURRENT}
SUGGESTED: ${TEST_IMPROVEMENT_SUGGESTED}
[/IMPROVEMENTS]
`

    const result = parseBedrockResponse(bedrockResponse)

    expect(result.scores).toHaveProperty(TEST_CATEGORY_CLARITY)
    expect(result.scores[TEST_CATEGORY_CLARITY].score).toBe(TEST_SCORE_4)
    expect(result.scores[TEST_CATEGORY_CLARITY].note).toBe(TEST_NOTE_GOOD)
    expect(result.scores[TEST_CATEGORY_ACCURACY].score).toBe(TEST_SCORE_5)
    expect(result.reviewedContent.issues).toHaveLength(1)
    expect(result.reviewedContent.issues[0].category).toBe(TEST_ISSUE_CATEGORY)
    expect(result.reviewedContent.issues[0].text).toBe(TEST_ISSUE_TEXT)
    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].severity).toBe(TEST_SEVERITY_HIGH)
    expect(result.improvements[0].category).toBe(TEST_IMPROVEMENT_CATEGORY)
  })

  test('Should parse scores section only', () => {
    const bedrockResponse = `
[SCORES]
${TEST_CATEGORY_CLARITY}: ${TEST_SCORE_4}/5 - ${TEST_NOTE_GOOD}
${TEST_CATEGORY_GRAMMAR}: ${TEST_SCORE_3}/5 - ${TEST_NOTE_MINOR}
[/SCORES]
`

    const result = parseBedrockResponse(bedrockResponse)

    expect(Object.keys(result.scores)).toHaveLength(2)
    expect(result.scores[TEST_CATEGORY_CLARITY].score).toBe(TEST_SCORE_4)
    expect(result.scores[TEST_CATEGORY_GRAMMAR].score).toBe(TEST_SCORE_3)
    expect(result.reviewedContent.issues).toHaveLength(0)
    expect(result.improvements).toHaveLength(0)
  })
})

describe('parseBedrockResponse - marker-based format - issues', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should parse reviewed content with multiple issues', () => {
    const bedrockResponse = `
[REVIEWED_CONTENT]
First [ISSUE:Grammar]error one[/ISSUE] and second [ISSUE:Spelling]error two[/ISSUE].
[/REVIEWED_CONTENT]
`

    const result = parseBedrockResponse(bedrockResponse)

    expect(result.reviewedContent.issues).toHaveLength(2)
    expect(result.reviewedContent.issues[0].category).toBe('Grammar')
    expect(result.reviewedContent.issues[0].text).toBe('error one')
    expect(result.reviewedContent.issues[1].category).toBe('Spelling')
    expect(result.reviewedContent.issues[1].text).toBe('error two')
    expect(result.reviewedContent.plainText).toBe(
      'First error one and second error two.'
    )
  })

  test('Should remove issue markers from plain text', () => {
    const bedrockResponse = `
[REVIEWED_CONTENT]
Text with [ISSUE:Error]marked issue[/ISSUE] should be clean.
[/REVIEWED_CONTENT]
`

    const result = parseBedrockResponse(bedrockResponse)

    expect(result.reviewedContent.plainText).toBe(
      'Text with marked issue should be clean.'
    )
    expect(result.reviewedContent.plainText).not.toContain('[ISSUE:')
    expect(result.reviewedContent.plainText).not.toContain('[/ISSUE]')
  })
})

describe('parseBedrockResponse - marker-based format - improvements', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should parse improvements section with multiple priorities', () => {
    const bedrockResponse = `
[IMPROVEMENTS]
[PRIORITY:${TEST_SEVERITY_HIGH}]
CATEGORY: Critical Issue
ISSUE: Major problem
WHY: Needs immediate fix
CURRENT: bad
SUGGESTED: good

[PRIORITY:${TEST_SEVERITY_MEDIUM}]
CATEGORY: Minor Issue
ISSUE: Small problem
WHY: Should improve
CURRENT: okay
SUGGESTED: better
[/IMPROVEMENTS]
`

    const result = parseBedrockResponse(bedrockResponse)

    expect(result.improvements).toHaveLength(2)
    expect(result.improvements[0].severity).toBe(TEST_SEVERITY_HIGH)
    expect(result.improvements[0].category).toBe('Critical Issue')
    expect(result.improvements[1].severity).toBe(TEST_SEVERITY_MEDIUM)
    expect(result.improvements[1].category).toBe('Minor Issue')
  })
})

describe('parseBedrockResponse - plain text format', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should parse plain text response without markers', () => {
    const bedrockResponse = `
${TEST_CATEGORY_CLARITY}: ${TEST_SCORE_4}/5 - ${TEST_NOTE_GOOD}
${TEST_CATEGORY_ACCURACY}: ${TEST_SCORE_5}/5 - ${TEST_NOTE_EXCELLENT}
`

    const result = parseBedrockResponse(bedrockResponse)

    expect(result.scores[TEST_CATEGORY_CLARITY].score).toBe(TEST_SCORE_4)
    expect(result.scores[TEST_CATEGORY_ACCURACY].score).toBe(TEST_SCORE_5)
    expect(result.reviewedContent.plainText).toContain(TEST_CATEGORY_CLARITY)
    expect(result.reviewedContent.issues).toHaveLength(0)
  })

  test('Should handle mixed content in plain text', () => {
    const bedrockResponse = `
Overall Assessment:
${TEST_CATEGORY_CLARITY}: ${TEST_SCORE_3}/5 - Needs work
Some additional text here.
${TEST_CATEGORY_GRAMMAR}: ${TEST_SCORE_4}/5 - Pretty good
`

    const result = parseBedrockResponse(bedrockResponse)

    expect(Object.keys(result.scores)).toHaveLength(2)
    expect(result.scores[TEST_CATEGORY_CLARITY].score).toBe(TEST_SCORE_3)
    expect(result.scores[TEST_CATEGORY_GRAMMAR].score).toBe(TEST_SCORE_4)
  })

  test('Should handle plain text with no valid scores', () => {
    const bedrockResponse = 'Just some random text without any scores'

    const result = parseBedrockResponse(bedrockResponse)

    expect(Object.keys(result.scores)).toHaveLength(0)
    expect(result.reviewedContent.plainText).toBe(bedrockResponse)
    expect(result.improvements).toHaveLength(0)
  })

  test('Should skip invalid score lines in plain text', () => {
    const bedrockResponse = `
${TEST_CATEGORY_CLARITY}: ${TEST_SCORE_4}/5 - ${TEST_NOTE_GOOD}
Invalid Line: not a score
${TEST_CATEGORY_GRAMMAR}: ${TEST_SCORE_3}/5 - ${TEST_NOTE_MINOR}
Another Invalid: 10/5 - too high
`

    const result = parseBedrockResponse(bedrockResponse)

    expect(Object.keys(result.scores)).toHaveLength(2)
    expect(result.scores[TEST_CATEGORY_CLARITY]).toBeDefined()
    expect(result.scores[TEST_CATEGORY_GRAMMAR]).toBeDefined()
  })
})

describe('parseBedrockResponse - fallback mechanism', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Should use fallback when main response is empty', () => {
    const emptyResponse = ''
    const fallbackResponse = `
[SCORES]
${TEST_CATEGORY_CLARITY}: ${TEST_SCORE_4}/5 - ${TEST_NOTE_GOOD}
[/SCORES]
`

    const result = parseBedrockResponse(emptyResponse, fallbackResponse)

    expect(result.scores[TEST_CATEGORY_CLARITY]).toBeDefined()
    expect(result.scores[TEST_CATEGORY_CLARITY].score).toBe(TEST_SCORE_4)
    expect(mockLoggerWarn).toHaveBeenCalled()
  })

  test('Should use fallback when parsed result has no content', () => {
    const emptyMarkerResponse =
      '[SCORES][/SCORES][REVIEWED_CONTENT][/REVIEWED_CONTENT]'
    const fallbackResponse = `${TEST_CATEGORY_CLARITY}: ${TEST_SCORE_5}/5 - Good`

    const result = parseBedrockResponse(emptyMarkerResponse, fallbackResponse)

    expect(result.scores[TEST_CATEGORY_CLARITY]).toBeDefined()
    expect(mockLoggerWarn).toHaveBeenCalled()
  })

  test('Should not use fallback when main response has content', () => {
    const mainResponse = `
[SCORES]
${TEST_CATEGORY_CLARITY}: ${TEST_SCORE_4}/5 - ${TEST_NOTE_GOOD}
[/SCORES]
`
    const fallbackResponse = `${TEST_CATEGORY_ACCURACY}: ${TEST_SCORE_5}/5 - Different`

    const result = parseBedrockResponse(mainResponse, fallbackResponse)

    expect(result.scores[TEST_CATEGORY_CLARITY]).toBeDefined()
    expect(result.scores[TEST_CATEGORY_ACCURACY]).toBeUndefined()
    expect(mockLoggerWarn).not.toHaveBeenCalled()
  })

  test('Should handle fallback with plain text format', () => {
    const emptyResponse = ''
    const fallbackResponse = `${TEST_CATEGORY_GRAMMAR}: ${TEST_SCORE_3}/5 - Okay`

    const result = parseBedrockResponse(emptyResponse, fallbackResponse)

    expect(result.scores[TEST_CATEGORY_GRAMMAR].score).toBe(TEST_SCORE_3)
  })
})
