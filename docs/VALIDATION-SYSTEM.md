# Response Validation System

## Overview

The validation system ensures that LLM responses meet all required standards for completeness, structure, and data quality. It implements a hybrid pre/post-processing approach with three validation levels.

## Architecture

```
User Input
    ↓
LLM (with structured prompt)
    ↓
Raw Response (Markdown + JSON)
    ↓
Validation Layer
    ├─ Parse markdown & JSON
    ├─ Validate structure
    ├─ Check completeness
    ├─ Verify data quality
    └─ Cross-validate
    ↓
Decision Point
    ├─ PASS (100%) → Send to frontend
    ├─ WARN (90-99%) → Send with warning
    └─ FAIL (<90%) → Retry once, then send/error
    ↓
Frontend Display
```

## Validation Levels

### Level 1: Critical (MUST PASS)
**These cause FAIL status and trigger retry:**

- ✅ All 11 sections present in markdown
- ✅ JSON metadata block present and parseable
- ✅ All required data points exist
- ✅ Summary of Findings has all 6 components
- ✅ Overall Assessment has content (50+ chars)

**Action:** Auto-retry once with specific instructions. If still fails, return error or partial results with warning.

---

### Level 2: Important (WARN if fails)
**These cause WARN status but don't block:**

- ⚠️ Character counts within reasonable ranges
- ⚠️ All priority categories have content or explicit "None"
- ⚠️ Top 3 improvements are specific
- ⚠️ Issue counts match between JSON and markdown

**Action:** Display results but show warning banner to user.

---

### Level 3: Quality (LOG only)
**These are logged but don't affect status:**

- 📊 Markdown formatting consistency
- 📊 Examples provided for flagged issues
- 📊 Constructive tone maintained
- 📊 Specific quotes from original content

**Action:** Log for monitoring and prompt improvement.

---

## Required Sections (All 11 Mandatory)

1. Content Suitability Assessment
2. Title Analysis
3. Summary Evaluation
4. Body Text Analysis
5. Style Guide Compliance
6. Govspeak Markdown Analysis
7. Accessibility Checks
8. User Experience Assessment
9. Passive Voice Review
10. GOV.UK Words to Avoid Review
11. Summary of Findings

**All sections must be present, even if no issues found.**

---

## Required Data Points

The JSON metadata must include:

```javascript
{
  "validation_metadata": {
    "sections_completed": ["...", "..."], // All 11 section names
    "data_points": {
      "title_character_count": 0,         // 0-200
      "summary_character_count": 0,       // 0-500
      "forbidden_words_count": 0,         // 0+
      "body_word_count": 0,               // 0+
      "passive_sentences_count": 0        // 0+
    },
    "issue_counts": {
      "critical": 0,
      "high": 0,
      "medium": 0,
      "low": 0,
      "total": 0                          // Sum of above
    },
    "completeness_score": 100             // Always 100 if complete
  }
}
```

---

## Summary of Findings Requirements

Must contain all 6 components:

1. **Critical Issues:** List (can be "None")
2. **High Priority:** List (can be "None")
3. **Medium Priority:** List (can be "None")
4. **Low Priority:** List (can be "None")
5. **Overall Assessment:** Paragraph (50+ characters)
6. **Top 3 Improvements:** List (always present, even for perfect content)

---

## Usage

### Basic Validation

```javascript
const { validateResponse } = require('./utils/responseValidator');

const llmResponse = await getLLMResponse(userInput);
const validationResult = validateResponse(llmResponse);

if (validationResult.level === 'pass') {
  // Send to frontend
  return { success: true, response: llmResponse };
}

if (validationResult.level === 'warn') {
  // Send with warning
  return { 
    success: true, 
    response: llmResponse,
    warning: 'Response may have minor issues'
  };
}

if (validationResult.level === 'fail') {
  // Retry or error
  console.error('Validation failed:', validationResult.errors);
}
```

### With Auto-Retry

```javascript
const { validateResponse, generateRetryPrompt } = require('./utils/responseValidator');

let llmResponse = await getLLMResponse(userInput);
let validationResult = validateResponse(llmResponse);

// Retry once if failed
if (validationResult.level === 'fail' && validationResult.completeness < 90) {
  const retryPrompt = generateRetryPrompt(validationResult, userInput);
  llmResponse = await getLLMResponse(retryPrompt);
  validationResult = validateResponse(llmResponse);
}

return {
  success: validationResult.level !== 'fail',
  response: llmResponse,
  validation: validationResult
};
```

---

## Testing

### Run Validation Tests

```bash
node backend/utils/validationTests.js
```

This runs the test suite with mock responses:
- ✅ Complete and valid response
- ❌ Incomplete response (missing sections)
- ❌ Invalid JSON structure
- ✅ Retry prompt generation

### Test Output

```
========================================
VALIDATION SYSTEM TEST SUITE
========================================

TEST 1: Complete and valid response
-----------------------------------
Valid: true
Level: pass
Completeness: 100%
Errors: 0
Warnings: 0
✅ Expected: PASS

TEST 2: Incomplete response (missing sections)
----------------------------------------------
Valid: false
Level: fail
Completeness: 27%
Errors: [ 'Missing required sections: ...' ]
Missing sections: [ 'Content Suitability Assessment', ... ]
❌ Expected: FAIL

[...]
```

---

## Integration Guide

### Step 1: Update System Prompt
The system prompt in `docs/system-prompt.md` has been updated to:
- Require all 11 sections explicitly
- Request JSON metadata at the end
- Show examples of "no issues found" format

### Step 2: Implement in Controller
The `chatController.js` now:
- Validates every LLM response
- Auto-retries once if validation fails critically
- Returns validation metadata to frontend

### Step 3: Connect Your LLM
Replace the `getLLMResponse()` function in `chatController.js`:

```javascript
async function getLLMResponse(message) {
  // Example: OpenAI
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ]
  });
  return response.choices[0].message.content;
}
```

### Step 4: Enhance Frontend
Use the validation metadata in your UI:
- Show completeness score
- Display issue count badges
- Filter by priority level
- Show warning banners if validation warned/failed

---

## Error Handling

### Scenario 1: No JSON Block Found
```
Error: "No JSON metadata block found in response"
Action: Return error to user, log for investigation
```

### Scenario 2: Invalid JSON
```
Error: "Invalid JSON: Unexpected token..."
Action: Return error, log raw response for debugging
```

### Scenario 3: Missing Sections
```
Error: "Missing required sections: Accessibility Checks, Passive Voice Review"
Action: Auto-retry with specific instructions
```

### Scenario 4: Out of Range Data
```
Warning: "title_character_count (300) out of range [0, 200]"
Action: Accept but warn user, log for prompt tuning
```

---

## Monitoring & Improvement

### Key Metrics to Track

1. **Validation Pass Rate**
   - % of responses that pass on first attempt
   - Target: >95%

2. **Retry Success Rate**
   - % of retries that pass validation
   - Target: >80%

3. **Common Failures**
   - Which sections are most often missing?
   - Which data points are most often invalid?
   - Use to refine system prompt

4. **Completeness Distribution**
   - How many responses at 100%, 90-99%, <90%?
   - Helps identify systematic issues

### Logging

```javascript
// Log validation results for analysis
console.log('Validation Result:', {
  level: validationResult.level,
  completeness: validationResult.completeness,
  errors: validationResult.errors.length,
  warnings: validationResult.warnings.length,
  timestamp: new Date().toISOString()
});
```

---

## Future Enhancements

### Phase 1 (Current)
✅ Basic validation (sections, JSON, data points)
✅ Auto-retry logic
✅ Mock response testing

### Phase 2 (Planned)
- [ ] Semantic validation (are responses actually helpful?)
- [ ] Response quality scoring (beyond completeness)
- [ ] A/B testing different prompt variations
- [ ] Response caching for similar content

### Phase 3 (Advanced)
- [ ] Machine learning to predict validation failures
- [ ] Automatic prompt optimization based on failure patterns
- [ ] User feedback integration into validation scores
- [ ] Multi-LLM fallback system

---

## Troubleshooting

### Issue: Validation always fails
**Check:**
1. Is the system prompt being sent to the LLM?
2. Is the LLM response being truncated?
3. Are you using a model with sufficient context window?
4. Check validation test suite: `node backend/utils/validationTests.js`

### Issue: JSON parsing fails
**Check:**
1. LLM might be escaping backticks
2. Response might be truncated mid-JSON
3. Try with different temperature/top_p settings
4. Increase max_tokens if response is cut off

### Issue: Sections not detected
**Check:**
1. Regex in `validateSections()` might need adjustment
2. LLM might use slightly different heading format
3. Check exact spacing around `##` in markdown
4. Review raw response to see actual format

---

## Files Reference

| File | Purpose |
|------|---------|
| `backend/utils/responseValidator.js` | Core validation logic |
| `backend/utils/validationTests.js` | Test suite and mock responses |
| `backend/controllers/chatController.js` | Integration with chat API |
| `docs/system-prompt.md` | Updated LLM system prompt |
| `docs/prompt-examples.md` | Example outputs with JSON |

---

## Support

For questions or issues with the validation system:
1. Check the test suite output
2. Review validation logs in console
3. Examine raw LLM responses
4. Verify system prompt is being sent correctly

**Remember:** The validation system is designed to ensure quality, but it's a tool to help - not a blocker. Use warnings and logs to continuously improve the system over time.
