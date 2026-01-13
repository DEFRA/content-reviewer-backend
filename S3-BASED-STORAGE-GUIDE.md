# S3-Based Review Storage Guide

## Overview

Instead of MongoDB, we're using **Amazon S3** to store review results. This is simpler, more cost-effective, and aligns with serverless best practices.

## Architecture

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   User      │─────▶│  Backend    │─────▶│     SQS     │─────▶│   Worker    │
│  (Frontend) │      │   API       │      │    Queue    │      │   Process   │
└─────────────┘      └─────────────┘      └─────────────┘      └──────┬──────┘
                            │                                           │
                            │                                           ▼
                            │                                    ┌─────────────┐
                            │                                    │   Bedrock   │
                            │                                    │     AI      │
                            │                                    └──────┬──────┘
                            │                                           │
                            ▼                                           ▼
                     ┌──────────────────────────────────────────────────────┐
                     │                    Amazon S3                          │
                     │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
                     │  │   Uploaded  │  │   Review    │  │   Review    │ │
                     │  │    Files    │  │   Results   │  │   Results   │ │
                     │  │  (PDF/DOCX) │  │  (JSON #1)  │  │  (JSON #2)  │ │
                     │  └─────────────┘  └─────────────┘  └─────────────┘ │
                     └──────────────────────────────────────────────────────┘
```

## S3 Bucket Structure

```
s3://cdp-content-reviewer-uploads/
├── uploads/                          # Uploaded files (existing)
│   ├── upload_123_abc.pdf
│   ├── upload_456_def.docx
│   └── ...
└── reviews/                          # Review results (NEW)
    ├── 2026/
    │   ├── 01/
    │   │   ├── 13/
    │   │   │   ├── review_1736784000000_uuid1.json
    │   │   │   ├── review_1736784100000_uuid2.json
    │   │   │   └── ...
    │   │   ├── 14/
    │   │   │   └── ...
    │   │   └── ...
    │   └── ...
    └── ...
```

## Review JSON Structure

Each review is stored as a JSON file in S3:

```json
{
  "id": "review_1736784000000_abc123",
  "status": "completed",
  "createdAt": "2026-01-13T10:00:00.000Z",
  "updatedAt": "2026-01-13T10:00:15.000Z",
  "sourceType": "file",
  "fileName": "document.pdf",
  "fileSize": 245678,
  "mimeType": "application/pdf",
  "s3Key": "uploads/upload_123_abc.pdf",
  "textContent": null,
  "result": {
    "overallAssessment": "This content meets GOV.UK standards...",
    "issues": [
      {
        "category": "Clarity",
        "severity": "minor",
        "description": "Consider simplifying paragraph 3",
        "suggestion": "Break into shorter sentences"
      }
    ],
    "strengths": ["Clear headings", "Good use of bullet points"],
    "recommendations": [
      "Add a summary at the beginning",
      "Use more active voice"
    ]
  },
  "error": null,
  "processingStartedAt": "2026-01-13T10:00:01.000Z",
  "processingCompletedAt": "2026-01-13T10:00:15.000Z",
  "bedrockUsage": {
    "inputTokens": 1234,
    "outputTokens": 567,
    "totalTokens": 1801
  }
}
```

## Environment Variables (Updated)

### Required:

```bash
# S3 Bucket (ONE bucket for both uploads and results)
S3_BUCKET=cdp-content-reviewer-uploads

# SQS Queue
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status

# AWS Region
AWS_REGION=eu-west-2
```

### NOT Required (Removed):

```bash
# ❌ MONGODB_URI - Not needed anymore
# ❌ MONGODB_DB_NAME - Not needed anymore
# ❌ MOCK_MONGODB - Not needed anymore
```

## IAM Permissions Required

The CDP service role needs these S3 permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::cdp-content-reviewer-uploads/*",
        "arn:aws:s3:::cdp-content-reviewer-uploads"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:eu-west-2:332499610595:content_review_status"
    },
    {
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": "arn:aws:bedrock:eu-west-2::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0"
    }
  ]
}
```

## Code Changes Required

### 1. Update `review-repository.js` import:

**Option A: Replace the file** (Recommended)

```bash
# Backup current file
mv src/common/helpers/review-repository.js src/common/helpers/review-repository-mongodb.js.backup

# Use S3 version
mv src/common/helpers/review-repository-s3.js src/common/helpers/review-repository.js
```

**Option B: Update imports** (if you want to keep both)
Update all files that import review-repository to use the S3 version:

- `src/routes/review.js`
- `src/common/helpers/sqs-worker.js`

Change:

```javascript
import { reviewRepository } from '../common/helpers/review-repository.js'
```

To:

```javascript
import { reviewRepository } from '../common/helpers/review-repository-s3.js'
```

### 2. Update `config.js`:

Remove MongoDB configuration section and ensure S3 is configured:

```javascript
// S3 Configuration
s3: {
  bucket: {
    doc: 'S3 bucket for uploads and review results',
    format: String,
    default: 'cdp-content-reviewer-uploads',
    env: 'S3_BUCKET'
  }
}

// Remove or comment out:
// mongodb: { ... }
```

## Advantages of S3-Based Approach

✅ **Simpler Architecture**

- No database to manage
- No connection pooling
- No schema migrations

✅ **Cost-Effective**

- Pay only for storage used
- No database instance costs
- S3 is very cheap for moderate usage

✅ **Scalable**

- S3 handles unlimited scale automatically
- No database connection limits
- No database sizing concerns

✅ **Durable**

- 99.999999999% (11 9's) durability
- Automatic replication across AZs
- Built-in versioning available

✅ **Serverless-Friendly**

- Perfect for serverless architectures
- No warm-up time
- No connection management

## Limitations & Trade-offs

⚠️ **Query Capabilities**

- No complex queries (but we don't need them)
- Limited filtering (by date/prefix)
- No full-text search (but we can list and filter in memory)

⚠️ **Consistency**

- Eventually consistent reads
- Small delay possible after write (~1 second)

⚠️ **Performance**

- Listing many objects can be slow
- Need pagination for large result sets
- Consider caching for frequently accessed reviews

## Migration from MongoDB (If Needed)

If you ever need to migrate TO MongoDB later:

1. Keep the same interface (method names)
2. Write a migration script to copy from S3 to MongoDB
3. Switch the import statement
4. No frontend changes needed!

## Testing

Use the updated test script:

```powershell
.\test-cdp-s3-based.ps1
```

Expected results:

```
✅ Health check - PASS
✅ Bedrock integration - PASS
✅ Submit text review - PASS (no MongoDB needed!)
✅ Get review status - PASS
✅ Get review history - PASS
```

## Next Steps

1. ✅ Review this document
2. 📝 Update environment variables in CDP (remove MongoDB, keep S3)
3. 🔄 Replace `review-repository.js` with S3 version
4. 🚀 Redeploy the service
5. ✅ Run tests to verify

## Questions?

**Q: What if S3 bucket doesn't exist?**  
A: Create it or use existing `cdp-content-reviewer-uploads` bucket

**Q: What about search/filtering?**  
A: For MVP, list recent reviews and filter in memory. Can add ElasticSearch later if needed.

**Q: How to handle cleanup?**  
A: Use S3 lifecycle policies to auto-delete old reviews after 30/60/90 days

**Q: What about backups?**  
A: S3 is already backed up. Can enable versioning for extra safety.

**Q: Performance concerns?**  
A: For moderate usage (<1000 reviews/day), S3 is perfectly fine. Can add caching layer later if needed.

---

**Last Updated:** January 13, 2026  
**Status:** Ready to implement - No MongoDB needed! 🎉
