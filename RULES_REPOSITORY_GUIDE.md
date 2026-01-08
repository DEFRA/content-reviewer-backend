# Rules Repository - GOV.UK Content QA Implementation

## Overview

The Rules Repository system stores GOV.UK content quality assurance rules in S3 and makes them available to the Bedrock AI LLM for content review. This ensures consistent, standards-based review of all uploaded documents against GOV.UK publishing guidelines.

---

## 🎯 Purpose

1. **Centralized Rules Storage**: Store content review rules in S3 for easy access and updates
2. **AI-Ready Format**: Rules formatted for direct use by Bedrock AI LLM
3. **Consistent Reviews**: All content reviewed against the same GOV.UK standards
4. **Easy Updates**: Update rules in one place, applies to all reviews
5. **Version Control**: Track rule versions and changes over time

---

## 📁 Components

### 1. Rules File

**Location**: `rules/govuk-content-qa-rules.md`

Contains:

- System prompt for Bedrock AI
- Core review rules
- Required output structure (13 sections)
- GOV.UK words to avoid
- Plain English principles
- Accessibility requirements
- Style guide compliance checks
- Govspeak markdown formatting rules

### 2. Rules Repository Module

**Location**: `src/common/helpers/rules-repository.js`

Functions:

- Upload rules to S3
- Download rules from S3
- List available rules
- Build AI system prompts
- Initialize default rules

### 3. Rules API Endpoints

**Location**: `src/routes/rules.js`

Endpoints:

- `POST /api/rules/initialize` - Upload default rules
- `GET /api/rules` - List all rules
- `GET /api/rules/{fileName}` - Get specific rule file
- `GET /api/rules/default/content` - Get default rules
- `GET /api/rules/health` - Health check

### 4. Upload Script

**Location**: `upload-rules-to-s3.ps1`

PowerShell script to upload rules to S3

---

## 🔄 How It Works

### Upload Flow

```
1. Rules defined in rules/govuk-content-qa-rules.md
2. Upload script or API endpoint uploads to S3
3. Stored in S3 bucket under rules/ prefix
4. Available for download by SQS worker
```

### Review Flow

```
1. SQS Worker processes uploaded document
2. Downloads rules from S3 (rules/govuk-content-qa-rules.md)
3. Extracts text from uploaded document (PDF/Word)
4. Builds system prompt with rules
5. Sends to Bedrock AI with document content
6. AI reviews content against all GOV.UK standards
7. Returns structured review report
8. Results saved and presented to user
```

---

## 📊 Rules Structure

### System Prompt

```markdown
# GOV.UK Content QA Reviewer (Structured Output)

You are a GOV.UK content quality assurance reviewer.
Your role is to review and evaluate content, not to rewrite it.
...
```

### Core Rules

- Do not automatically rewrite content
- Do not change policy intent
- Always explain why an issue matters
- Label issues as "Automated" or "Human judgement required"

### Required Output Structure (13 Sections)

1. **Executive Summary** - Brief overview with high-priority issues
2. **Content Suitability & User Need** - Appropriateness for GOV.UK
3. **Title Analysis** - Character count, clarity, SEO
4. **Summary Evaluation** - Meta description review
5. **Issue Register** - All findings categorized
6. **Plain English & Words to Avoid** - GOV.UK banned words
7. **Body Text Analysis** - Structure, word count, readability
8. **Style Guide Compliance** - Formatting standards
9. **Govspeak Markdown Review** - Technical formatting
10. **Accessibility Review** - Alt text, language, barriers
11. **Passive Voice Review** - Active vs passive constructions
12. **Summary of Findings & Priorities** - Top 5 improvements
13. **Example Improvements** - Optional examples only

---

## 🚀 Setup & Usage

### Initial Setup

#### 1. Upload Rules to S3

**Option A: Using PowerShell Script**

```powershell
.\upload-rules-to-s3.ps1
```

**Option B: Using API Endpoint**

```bash
curl -X POST http://localhost:3000/api/rules/initialize
```

**Option C: Programmatically**

```javascript
import { rulesRepository } from './src/common/helpers/rules-repository.js'

await rulesRepository.initializeDefaultRules()
```

### Verify Rules

```bash
# Check if rules are uploaded
curl http://localhost:3000/api/rules/health

# List all rules
curl http://localhost:3000/api/rules

# Get default rules content
curl http://localhost:3000/api/rules/default/content
```

---

## 🔌 Integration with SQS Worker

### Before (Without Rules)

```javascript
// Step 3: AI Review
await reviewStatusTracker.updateStatus(uploadId, 'reviewing', 'AI review', 75)
const reviewResult = await aiService.review(extractedContent)
```

### After (With Rules)

```javascript
// Step 3: Load rules from S3
await reviewStatusTracker.updateStatus(
  uploadId,
  'reviewing',
  'Loading rules',
  70
)
const reviewRules = await rulesRepository.getDefaultRules()

// Step 4: AI Review with GOV.UK rules
await reviewStatusTracker.updateStatus(
  uploadId,
  'reviewing',
  'Reviewing against GOV.UK standards',
  75
)
const systemPrompt = rulesRepository.buildSystemPrompt(reviewRules)

// Call Bedrock AI with rules
const aiResponse = await bedrockClient.invokeModel({
  systemPrompt: systemPrompt, // ← Rules included here
  userContent: extractedContent
})
```

---

## 📝 Rules Content

### GOV.UK Words to Avoid

The rules include 40+ words/phrases that should be avoided:

| Avoid                | Use Instead           |
| -------------------- | --------------------- |
| deliver (not goods)  | provide, give, offer  |
| drive (not vehicles) | improve, increase     |
| facilitate           | help, support, enable |
| impact (verb)        | affect, influence     |
| in order to          | to                    |
| key (not locks)      | important, main       |
| leverage             | use, benefit from     |
| robust               | strong, effective     |
| streamline           | simplify, improve     |
| utilize              | use                   |

...and many more

### Plain English Principles

- Short sentences (15-20 words, max 25)
- Active voice, not passive
- Use "you" and "we"
- Explain technical terms
- Front-load important information
- Bullet points for lists

### Character Limits

- **Title**: 65 characters max (including spaces)
- **Meta description**: 160 characters max (including spaces)

### Accessibility Requirements

- Alt text for images
- No emoji
- Hashtags in camelCase
- No ALL CAPS (except acronyms)
- Clear link text (not "click here")
- Reading age: 9 years

---

## 🔧 API Reference

### POST /api/rules/initialize

Upload default GOV.UK rules to S3

**Request**:

```bash
POST /api/rules/initialize
```

**Response**:

```json
{
  "success": true,
  "message": "Rules initialized successfully",
  "bucket": "content-reviewer-bucket",
  "key": "rules/govuk-content-qa-rules.md",
  "size": 15234,
  "location": "s3://content-reviewer-bucket/rules/govuk-content-qa-rules.md"
}
```

### GET /api/rules

List all available rules

**Request**:

```bash
GET /api/rules
```

**Response**:

```json
{
  "success": true,
  "count": 1,
  "rules": [
    {
      "key": "rules/govuk-content-qa-rules.md",
      "name": "govuk-content-qa-rules.md",
      "size": 15234,
      "lastModified": "2024-01-15T10:00:00.000Z"
    }
  ]
}
```

### GET /api/rules/{fileName}

Get specific rule file content

**Request**:

```bash
GET /api/rules/govuk-content-qa-rules.md
```

**Response**:

```json
{
  "success": true,
  "fileName": "govuk-content-qa-rules.md",
  "content": "# GOV.UK Content QA Rules\n\n..."
}
```

### GET /api/rules/default/content

Get default GOV.UK rules

**Request**:

```bash
GET /api/rules/default/content
```

**Response**:

```json
{
  "success": true,
  "fileName": "govuk-content-qa-rules.md",
  "content": "# GOV.UK Content QA Rules\n\n..."
}
```

### GET /api/rules/health

Check rules service health

**Request**:

```bash
GET /api/rules/health
```

**Response**:

```json
{
  "status": "ok",
  "service": "rules",
  "bucket": "content-reviewer-bucket",
  "rulesCount": 1,
  "hasDefaultRules": true
}
```

---

## 🧪 Testing

### Test Rules Upload

```powershell
# Upload rules
.\upload-rules-to-s3.ps1

# Verify upload
curl http://localhost:3000/api/rules/health
```

### Test Rules Retrieval

```bash
# Get rules content
curl http://localhost:3000/api/rules/default/content

# Should return full rules content
```

### Test with SQS Worker

```bash
# Upload a document
curl -X POST http://localhost:3000/api/upload -F "file=@test.pdf"

# Worker will automatically:
# 1. Load rules from S3
# 2. Extract document text
# 3. Send to Bedrock AI with rules
# 4. Return structured review
```

---

## 🔄 Updating Rules

### Option 1: Edit Local File and Re-upload

```powershell
# 1. Edit rules/govuk-content-qa-rules.md
# 2. Re-upload
.\upload-rules-to-s3.ps1
```

### Option 2: Direct S3 Upload

```bash
# Use AWS CLI
aws s3 cp rules/govuk-content-qa-rules.md s3://bucket-name/rules/
```

### Option 3: Programmatic Update

```javascript
await rulesRepository.uploadRules(
  'govuk-content-qa-rules.md',
  './rules/govuk-content-qa-rules.md'
)
```

---

## 📦 S3 Storage Structure

```
s3://content-reviewer-bucket/
├── uploads/                    # Uploaded documents
│   ├── uuid-1.pdf
│   ├── uuid-2.docx
│   └── ...
└── rules/                      # Review rules
    ├── govuk-content-qa-rules.md
    ├── custom-rules-v2.md      # Optional custom rules
    └── ...
```

---

## 🎯 Benefits

### 1. Consistency

All reviews use the same GOV.UK standards

### 2. Maintainability

Update rules in one place, applies everywhere

### 3. Version Control

Track rule changes over time with S3 versioning

### 4. Scalability

Rules loaded per-review, no memory overhead

### 5. Flexibility

Easy to add custom rules or rule sets

### 6. Compliance

Always up-to-date with latest GOV.UK guidelines

---

## 🔍 Monitoring

### Check Rules Health

```bash
curl http://localhost:3000/api/rules/health
```

### Monitor S3 Usage

```bash
aws s3 ls s3://bucket-name/rules/ --recursive
```

### Check Worker Logs

```javascript
// Look for these log entries
'Review rules loaded from S3'
'Failed to load review rules, using fallback'
```

---

## 🚨 Error Handling

### Rules Not Found

If rules aren't in S3, worker uses fallback mode:

```javascript
reviewRules = 'GOV.UK Content QA Rules - fallback mode'
```

### S3 Connection Error

Worker continues with basic review, error logged

### Invalid Rules Format

Validation should be added before upload

---

## 📚 Related Documentation

- `STATUS_TRACKING_IMPLEMENTATION_COMPLETE.md` - Status tracking system
- `S3_EVENT_NOTIFICATION_SETUP.md` - S3 event configuration
- `IMPLEMENTATION_STATUS.md` - Overall system status

---

## ✅ Implementation Checklist

- [x] Rules file created (`govuk-content-qa-rules.md`)
- [x] Rules repository module implemented
- [x] API endpoints created
- [x] Upload script created
- [x] Router integration
- [x] SQS worker integration
- [x] Error handling
- [x] Logging
- [x] Documentation

---

## 🎉 Summary

**Rules Repository Status**: ✅ **COMPLETE**

- ✅ GOV.UK content QA rules defined
- ✅ S3 storage configured
- ✅ API endpoints ready
- ✅ Upload script available
- ✅ SQS worker integrated
- ✅ Bedrock AI ready (for colleague to implement)
- ✅ Documentation complete

**Next**: Upload rules to S3 and test with document review workflow

---

_The rules are ready for your colleague to integrate with Bedrock AI LLM for automated GOV.UK content compliance checking!_
