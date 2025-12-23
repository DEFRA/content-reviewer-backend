/**
 * Test utilities for validation system
 * Use these to test the validation layer before connecting a real LLM
 */

import {
  validateResponse,
  generateRetryPrompt
} from './response-validator.js'

/**
 * Mock LLM response - COMPLETE and VALID
 */
const mockCompleteResponse = `## Content Suitability Assessment

**Appropriateness for GOV.UK:** ✅ Yes, this is appropriate government content.

**User Need:** ✅ Clear user need identified.

**Content Type Appropriateness:** ✅ Appropriate format.

## Title Analysis

**Current title:** "Apply for a business grant"

**Character count:** 27 characters ✅ Under 65-character limit

✅ Clear and specific.

## Summary Evaluation

**Current summary:** "Find out about grants for businesses."

**Character count:** 39 characters ✅ Under 160-character limit

✅ Good summary.

## Body Text Analysis

**Word count:** 150 words

✅ Content is well-structured and clear.

## Style Guide Compliance

✅ **No style guide violations found.** Content follows all GOV.UK conventions.

## Govspeak Markdown Analysis

✅ **Markdown formatting is correct.** All headings and lists properly formatted.

## Accessibility Checks

✅ **No accessibility issues found.** Content is accessible to all users.

## User Experience Assessment

✅ **Good user experience.** Content meets user needs effectively.

## Passive Voice Review

✅ **No passive voice found.** All sentences use active voice.

## GOV.UK Words to Avoid Review

✅ **No forbidden words detected.** Content uses plain English throughout.

## Summary of Findings

**Critical Issues:**
None! 🎉

**High Priority:**
None

**Medium Priority:**
None

**Low Priority:**
None

**Overall Assessment:**

This is excellent content that follows GOV.UK best practices. The title is clear, the summary is concise, and the body text uses plain English. No issues were identified.

**Top 3 Improvements:**
1. Content is already excellent - no improvements needed
2. Maintain this quality for future content
3. Consider this as a model for other pages

---

` +
  '```json' +
  `
{
  "validation_metadata": {
    "sections_completed": [
      "Content Suitability Assessment",
      "Title Analysis",
      "Summary Evaluation",
      "Body Text Analysis",
      "Style Guide Compliance",
      "Govspeak Markdown Analysis",
      "Accessibility Checks",
      "User Experience Assessment",
      "Passive Voice Review",
      "GOV.UK Words to Avoid Review",
      "Summary of Findings"
    ],
    "data_points": {
      "title_character_count": 27,
      "summary_character_count": 39,
      "forbidden_words_count": 0,
      "body_word_count": 150,
      "passive_sentences_count": 0
    },
    "issue_counts": {
      "critical": 0,
      "high": 0,
      "medium": 0,
      "low": 0,
      "total": 0
    },
    "completeness_score": 100
  }
}
` +
  '```'

/**
 * Mock LLM response - INCOMPLETE (missing sections)
 */
const mockIncompleteResponse = `## Title Analysis

**Current title:** "Apply for a business grant"

**Character count:** 27 characters ✅ Under 65-character limit

## Summary Evaluation

**Current summary:** "Find out about grants."

**Character count:** 25 characters ✅ Under 160-character limit

## Summary of Findings

**Critical Issues:**
- Missing several required sections

**Overall Assessment:**

Incomplete analysis provided.

---

` +
  '```json' +
  `
{
  "validation_metadata": {
    "sections_completed": [
      "Title Analysis",
      "Summary Evaluation",
      "Summary of Findings"
    ],
    "data_points": {
      "title_character_count": 27,
      "summary_character_count": 25,
      "forbidden_words_count": 0,
      "body_word_count": 0,
      "passive_sentences_count": 0
    },
    "issue_counts": {
      "critical": 1,
      "high": 0,
      "medium": 0,
      "low": 0,
      "total": 1
    },
    "completeness_score": 27
  }
}
` +
  '```'

/**
 * Mock LLM response - INVALID JSON
 */
const mockInvalidJSONResponse = `## Title Analysis

Some content here.

## Summary of Findings

Some findings here.

---

` +
  '```json' +
  `
{
  "invalid": "json structure"
  missing: "quotes and commas"
}
` +
  '```'

/**
 * Test the validation system
 */
function runValidationTests() {
  console.log('\n========================================')
  console.log('VALIDATION SYSTEM TEST SUITE')
  console.log('========================================\n')

  // Test 1: Complete and valid response
  console.log('TEST 1: Complete and valid response')
  console.log('-----------------------------------')
  const result1 = validateResponse(mockCompleteResponse)
  console.log('Valid:', result1.valid)
  console.log('Level:', result1.level)
  console.log('Completeness:', result1.completeness + '%')
  console.log('Errors:', result1.errors.length, result1.errors)
  console.log('Warnings:', result1.warnings.length)
  console.log('✅ Expected: PASS\n')

  // Test 2: Incomplete response
  console.log('TEST 2: Incomplete response (missing sections)')
  console.log('----------------------------------------------')
  const result2 = validateResponse(mockIncompleteResponse)
  console.log('Valid:', result2.valid)
  console.log('Level:', result2.level)
  console.log('Completeness:', result2.completeness + '%')
  console.log('Errors:', result2.errors)
  console.log(
    'Missing sections:',
    Object.keys(result2.sections).filter((k) => !result2.sections[k])
  )
  console.log('❌ Expected: FAIL\n')

  // Test 3: Invalid JSON
  console.log('TEST 3: Invalid JSON structure')
  console.log('------------------------------')
  try {
    validateResponse(mockInvalidJSONResponse)
    console.log('Should not reach here')
  } catch (error) {
    console.log('Caught error:', error.message)
    console.log('✅ Expected: ERROR\n')
  }

  // Test 4: Retry prompt generation
  console.log('TEST 4: Retry prompt generation')
  console.log('-------------------------------')
  const retryPrompt = generateRetryPrompt(result2, 'Original content here')
  console.log('Retry prompt length:', retryPrompt.length)
  console.log('Contains missing sections:', retryPrompt.includes('Missing Sections'))
  console.log('Contains requirements:', retryPrompt.includes('Requirements'))
  console.log('✅ Generated retry prompt\n')

  console.log('========================================')
  console.log('ALL TESTS COMPLETED')
  console.log('========================================\n')
}

export { mockCompleteResponse, mockIncompleteResponse, mockInvalidJSONResponse, runValidationTests }
