// Shared constants and helpers for review-parser test files

export const SCORES_TAG_OPEN = '[SCORES]'
export const SCORES_TAG_CLOSE = '[/SCORES]'
export const REVIEWED_CONTENT_OPEN = '[REVIEWED_CONTENT]'
export const REVIEWED_CONTENT_CLOSE = '[/REVIEWED_CONTENT]'
export const IMPROVEMENTS_OPEN = '[IMPROVEMENTS]'
export const IMPROVEMENTS_CLOSE = '[/IMPROVEMENTS]'
export const ISSUE_POSITIONS_OPEN = '[ISSUE_POSITIONS]'
export const ISSUE_POSITIONS_CLOSE = '[/ISSUE_POSITIONS]'

export const SAMPLE_SCORE_LINE = 'Clarity: 3/5 - Needs improvement'
export const SAMPLE_SCORE_LINE_2 = 'Structure: 4/5 - Good layout'
export const SAMPLE_PLAIN_TEXT = 'This is plain text content with no markers.'
export const SCORE_CLARITY = 3
export const SCORE_STRUCTURE = 4
export const SCORE_MAX = 5

export const PLAIN_ENGLISH_SCORE_LINE = 'Plain English: 3/5 - Some issues'
export const PRIORITY_HIGH_OPEN = 'PRIORITY: high]'
export const PRIORITY_MEDIUM_OPEN = '[PRIORITY: medium]'
export const CATEGORY_PLAIN_ENGLISH = 'CATEGORY: Plain English'
export const CATEGORY_CLARITY = 'CATEGORY: Clarity'
export const WHY_BARRIERS = 'WHY: Barriers for users'
export const WHY_NEEDS_WORK = 'WHY: Needs work'
export const ORIGINAL_TEXT_PLACEHOLDER = 'original text'
export const ORIGINAL_TEXT_UTILISE =
  'The department should utilise all resources.'
export const ACCESSIBILITY_SCORE_LINE = 'Accessibility: 3/5 - Some issues found'
export const COMPLETENESS_SCORE_LINE = 'Completeness: 4/5 - Mostly complete'

export function buildMarkerResponse({
  scores = '',
  content = '',
  improvements = ''
} = {}) {
  return [
    SCORES_TAG_OPEN,
    scores,
    SCORES_TAG_CLOSE,
    REVIEWED_CONTENT_OPEN,
    content,
    REVIEWED_CONTENT_CLOSE,
    IMPROVEMENTS_OPEN,
    improvements,
    IMPROVEMENTS_CLOSE
  ].join('\n')
}

export function buildIssuePositionsResponse(jsonLine) {
  return [
    SCORES_TAG_OPEN,
    PLAIN_ENGLISH_SCORE_LINE,
    SCORES_TAG_CLOSE,
    ISSUE_POSITIONS_OPEN,
    jsonLine,
    ISSUE_POSITIONS_CLOSE,
    IMPROVEMENTS_OPEN,
    IMPROVEMENTS_CLOSE
  ].join('\n')
}
