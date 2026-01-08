# Bedrock AI Integration - Quick Reference

## Overview

This guide shows how to integrate AWS Bedrock AI with the rules repository for GOV.UK content review.

---

## 🎯 Integration Point

**Location**: `src/common/helpers/sqs-worker.js`
**Method**: `processContentReview()`
**Step**: AI Review (Step 4)

---

## 📋 What's Already Implemented

✅ Rules repository (`rules-repository.js`)
✅ Rules uploaded to S3 (`rules/govuk-content-qa-rules.md`)
✅ Rules loaded in SQS worker
✅ Status tracking for review process
✅ System prompt builder

---

## 🔧 What Needs Implementation

Your colleague needs to implement:

1. **Text Extraction** (Step 2) - Extract text from PDF/Word
2. **Bedrock AI Call** (Step 4) - Send to AI with rules
3. **Response Parsing** (Step 4) - Structure the AI response
4. **Results Storage** (Step 5) - Save to database

---

## 💻 Code Template

### Step 1: Install AWS Bedrock SDK

```bash
npm install @aws-sdk/client-bedrock-runtime
```

### Step 2: Import Bedrock Client

```javascript
import {
  BedrockRuntimeClient,
  InvokeModelCommand
} from '@aws-sdk/client-bedrock-runtime'
```

### Step 3: Initialize Client

```javascript
// In SQSWorker constructor
this.bedrockClient = new BedrockRuntimeClient({
  region: config.get('bedrock.region') || 'us-east-1'
})
```

### Step 4: Replace TODO in sqs-worker.js

Replace this section (lines ~298-330):

```javascript
// Step 3: Load GOV.UK content review rules from S3
await reviewStatusTracker.updateStatus(
  uploadId,
  'reviewing',
  'Loading content review rules',
  70
)

let reviewRules
try {
  reviewRules = await rulesRepository.getDefaultRules()
  logger.info(
    { uploadId, rulesLength: reviewRules.length },
    'Review rules loaded from S3'
  )
} catch (error) {
  logger.error(
    { uploadId, error: error.message },
    'Failed to load review rules, using fallback'
  )
  reviewRules = 'GOV.UK Content QA Rules - fallback mode'
}

// Step 4: AI Review with GOV.UK rules
await reviewStatusTracker.updateStatus(
  uploadId,
  'reviewing',
  'AI content review in progress against GOV.UK standards',
  75
)

// TODO: Your colleague will implement this
// Build the system prompt with rules
const systemPrompt = rulesRepository.buildSystemPrompt(reviewRules)

// Call Bedrock AI
const aiResponse = await this.callBedrockAI(systemPrompt, extractedContent)

// Parse the response
const reviewResult = this.parseAIResponse(aiResponse)
```

### Step 5: Implement callBedrockAI Method

Add this method to the SQSWorker class:

```javascript
/**
 * Call AWS Bedrock AI for content review
 * @param {string} systemPrompt - System prompt with GOV.UK rules
 * @param {string} documentContent - Extracted document text
 * @returns {Promise<Object>} AI response
 */
async callBedrockAI(systemPrompt, documentContent) {
  try {
    const modelId = 'anthropic.claude-3-5-sonnet-20241022-v2:0'

    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 8000,
      temperature: 0.3,  // Lower temperature for more consistent reviews
      system: systemPrompt,  // ← GOV.UK rules included here
      messages: [
        {
          role: 'user',
          content: `Please review the following content against GOV.UK standards:\n\n${documentContent}`
        }
      ]
    }

    const command = new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload)
    })

    const response = await this.bedrockClient.send(command)
    const responseBody = JSON.parse(new TextDecoder().decode(response.body))

    logger.info(
      {
        modelId,
        inputTokens: responseBody.usage?.input_tokens,
        outputTokens: responseBody.usage?.output_tokens
      },
      'Bedrock AI response received'
    )

    return responseBody
  } catch (error) {
    logger.error(
      { error: error.message, stack: error.stack },
      'Bedrock AI call failed'
    )
    throw error
  }
}
```

### Step 6: Implement parseAIResponse Method

```javascript
/**
 * Parse Bedrock AI response into structured review result
 * @param {Object} aiResponse - Raw Bedrock response
 * @returns {Object} Structured review result
 */
parseAIResponse(aiResponse) {
  try {
    // Extract the AI's review from the response
    const reviewText = aiResponse.content?.[0]?.text || ''

    // Parse the structured output
    // The AI follows the 13-section structure defined in rules

    return {
      status: 'completed',
      reviewText,
      summary: this.extractSection(reviewText, 'Executive Summary'),
      contentSuitability: this.extractSection(reviewText, 'Content Suitability & User Need'),
      titleAnalysis: this.extractSection(reviewText, 'Title Analysis'),
      summaryEvaluation: this.extractSection(reviewText, 'Summary (Meta Description) Evaluation'),
      issueRegister: this.extractSection(reviewText, 'Issue Register'),
      plainEnglishReview: this.extractSection(reviewText, 'Plain English & "Words to Avoid" Review'),
      bodyTextAnalysis: this.extractSection(reviewText, 'Body Text Analysis'),
      styleGuideCompliance: this.extractSection(reviewText, 'Style Guide Compliance'),
      govspeakReview: this.extractSection(reviewText, 'Govspeak Markdown Review'),
      accessibilityReview: this.extractSection(reviewText, 'Accessibility Review'),
      passiveVoiceReview: this.extractSection(reviewText, 'Passive Voice Review'),
      summaryOfFindings: this.extractSection(reviewText, 'Summary of Findings & Priorities'),
      exampleImprovements: this.extractSection(reviewText, 'Example Improvements'),
      metadata: {
        inputTokens: aiResponse.usage?.input_tokens,
        outputTokens: aiResponse.usage?.output_tokens,
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0'
      },
      processedAt: new Date().toISOString()
    }
  } catch (error) {
    logger.error(
      { error: error.message },
      'Failed to parse AI response'
    )
    throw error
  }
}

/**
 * Extract a specific section from the AI review text
 * @param {string} text - Full review text
 * @param {string} sectionName - Name of section to extract
 * @returns {string} Section content
 */
extractSection(text, sectionName) {
  const regex = new RegExp(`###?\\s*\\d*\\.?\\s*${sectionName}[\\s\\S]*?(?=###?\\s*\\d|\$)`, 'i')
  const match = text.match(regex)
  return match ? match[0].trim() : ''
}
```

---

## 📝 Example Usage

### Full Implementation

```javascript
// In processContentReview method:

// Step 2: Extract text from document
const extractedContent = await this.extractTextFromDocument(
  messageBody.s3Bucket,
  messageBody.s3Key
)

// Step 3: Load rules
const reviewRules = await rulesRepository.getDefaultRules()
const systemPrompt = rulesRepository.buildSystemPrompt(reviewRules)

// Step 4: Call Bedrock AI
const aiResponse = await this.callBedrockAI(systemPrompt, extractedContent)

// Step 5: Parse response
const reviewResult = this.parseAIResponse(aiResponse)

// Step 6: Mark as completed
await reviewStatusTracker.markCompleted(uploadId, reviewResult)
```

---

## 🔧 Configuration

Add to `src/config.js`:

```javascript
bedrock: {
  doc: 'AWS Bedrock configuration',
  format: Object,
  default: {
    region: 'us-east-1',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    maxTokens: 8000,
    temperature: 0.3
  },
  env: 'BEDROCK'
}
```

Add to environment variables:

```bash
# .env or compose/aws.env
AWS_REGION=us-east-1
BEDROCK_REGION=us-east-1
```

---

## 📊 Expected AI Response Format

The AI will return structured output following the 13 sections:

```markdown
### 1. Executive Summary

Overall assessment: This document contains several GOV.UK style issues...

High-priority issues:

1. Title exceeds 65 character limit (currently 78 characters)
2. Use of "facilitate" in paragraph 2 (line 15)
3. Several passive voice sentences
4. Missing alt text for 2 images
5. Govspeak formatting errors in headings

Blockers: Title must be shortened before publication

### 2. Content Suitability & User Need

This content appears appropriate for GOV.UK as it provides...

### 3. Title Analysis

- Current title: "How to facilitate the implementation of robust governance..."
- Character count: 78 (EXCEEDS LIMIT by 13 characters)
- Issues: Contains "facilitate" and "robust" (words to avoid)
- Suggestion: "How to set up governance frameworks"

...

### 12. Summary of Findings & Priorities

Top 5 priorities:

1. Shorten title to under 65 characters
2. Remove all instances of "words to avoid"
3. Convert passive sentences to active voice
4. Add alt text to images
5. Fix Govspeak heading levels

Risks if not addressed:

- Poor search engine visibility
- Accessibility barriers
- Reduced user trust
```

---

## 🧪 Testing

### Test with Sample Document

```javascript
// Test system prompt
const rules = await rulesRepository.getDefaultRules()
const prompt = rulesRepository.buildSystemPrompt(rules)
console.log(prompt) // Should show full GOV.UK rules

// Test Bedrock call
const testContent = 'This document will facilitate the implementation...'
const response = await callBedrockAI(prompt, testContent)
console.log(response) // Should show structured review
```

---

## 📚 Resources

### AWS Bedrock Documentation

- [Bedrock User Guide](https://docs.aws.amazon.com/bedrock/)
- [Claude Models on Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-claude.html)
- [Invoke Model API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html)

### GOV.UK Standards

- [Content Design Manual](https://www.gov.uk/guidance/content-design)
- [Style Guide](https://www.gov.uk/guidance/style-guide)
- [Accessibility](https://www.gov.uk/guidance/accessibility-requirements-for-public-sector-websites-and-apps)

---

## ✅ Implementation Checklist

- [ ] Install @aws-sdk/client-bedrock-runtime
- [ ] Initialize BedrockRuntimeClient
- [ ] Implement extractTextFromDocument (PDF/Word)
- [ ] Implement callBedrockAI method
- [ ] Implement parseAIResponse method
- [ ] Implement extractSection helper
- [ ] Add Bedrock config to config.js
- [ ] Test with sample document
- [ ] Handle errors and retries
- [ ] Log token usage for cost tracking

---

## 🎉 Summary

**What's Ready:**

- ✅ GOV.UK rules defined and in S3
- ✅ Rules loaded automatically by worker
- ✅ System prompt builder ready
- ✅ Status tracking integrated
- ✅ Code structure in place

**What's Needed:**

- ⏳ Text extraction (PDF/Word → text)
- ⏳ Bedrock AI integration
- ⏳ Response parsing
- ⏳ Results storage

**Estimated Effort**: 4-6 hours for full implementation

---

_This template provides everything needed for your colleague to integrate Bedrock AI with the GOV.UK content review rules!_
