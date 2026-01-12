# Async Review System Implementation

## Overview

The ContentReviewerAI backend now supports **asynchronous review processing** using a queue-based architecture. This design solves the nginx timeout issue and provides a better user experience with status tracking and review history.

## Architecture

```
┌─────────────┐
│   Frontend  │
│   (React)   │
└──────┬──────┘
       │
       │ POST /api/review/file or /api/review/text
       │ (returns immediately with reviewId)
       ▼
┌─────────────────────────────────────┐
│         Backend API Server          │
│  ┌────────────────────────────────┐ │
│  │  1. Create Review Record       │ │
│  │     (MongoDB: content_reviews) │ │
│  │  2. Upload File to S3 (if any) │ │
│  │  3. Queue Job in SQS           │ │
│  │  4. Return reviewId + status   │ │
│  └────────────────────────────────┘ │
└─────────────────────────────────────┘
       │
       │ SQS Message
       ▼
┌─────────────────────────────────────┐
│         SQS Worker Process          │
│  ┌────────────────────────────────┐ │
│  │  1. Download file from S3      │ │
│  │  2. Extract text (PDF/DOCX)    │ │
│  │  3. Send to Bedrock with       │ │
│  │     system prompt              │ │
│  │  4. Save result to MongoDB     │ │
│  └────────────────────────────────┘ │
└─────────────────────────────────────┘
       │
       │ Review Result Stored
       ▼
┌─────────────────────────────────────┐
│            MongoDB                   │
│     (content_reviews collection)     │
└─────────────────────────────────────┘
       │
       │ GET /api/review/:id (polling)
       │ GET /api/reviews (history)
       ▼
┌─────────────┐
│   Frontend  │
│  (displays  │
│   results)  │
└─────────────┘
```

## Key Components

### 1. Review Repository (`review-repository.js`)

MongoDB repository for managing review records.

**Schema:**

```javascript
{
  _id: "review_1234567890_uuid",  // Timestamp-based ID
  status: "pending|processing|completed|failed",
  sourceType: "file|text",
  fileName: "document.pdf",
  fileSize: 123456,
  mimeType: "application/pdf",
  s3Key: "uploads/review_1234567890_uuid/document.pdf",
  textContent: null,  // For text reviews
  result: { ... },    // Bedrock response
  error: null,
  createdAt: Date,
  updatedAt: Date,
  processingStartedAt: Date,
  processingCompletedAt: Date,
  bedrockUsage: { inputTokens, outputTokens, totalTokens }
}
```

**Key Methods:**

- `createReview(reviewData)` - Create new review record
- `getReview(reviewId)` - Get review by ID
- `updateReviewStatus(reviewId, status, additionalData)` - Update status
- `saveReviewResult(reviewId, result, usage)` - Save completed review
- `saveReviewError(reviewId, error)` - Save failed review
- `getAllReviews(limit, skip)` - Get review history

### 2. Text Extractor (`text-extractor.js`)

Extracts text from uploaded files using:

- **pdf-parse** for PDF files
- **mammoth** for DOCX files
- Direct UTF-8 decoding for plain text

**Features:**

- Automatic text extraction based on MIME type
- Text cleaning (normalize whitespace, line endings)
- Text statistics (word count, line count, etc.)
- Preview generation

### 3. Review Routes (`review.js`)

RESTful API endpoints for async review processing.

#### `POST /api/review/file`

Submit a file for review.

**Request:**

- Content-Type: `multipart/form-data`
- Body: `file` (PDF or DOCX)

**Response (202 Accepted):**

```json
{
  "success": true,
  "reviewId": "review_1234567890_uuid",
  "status": "pending",
  "message": "Review queued for processing"
}
```

#### `POST /api/review/text`

Submit text content for review.

**Request:**

```json
{
  "content": "Your content here...",
  "title": "Optional title"
}
```

**Response (202 Accepted):**

```json
{
  "success": true,
  "reviewId": "review_1234567890_uuid",
  "status": "pending",
  "message": "Review queued for processing"
}
```

#### `GET /api/review/:id`

Get review status and result.

**Response (200 OK):**

```json
{
  "success": true,
  "review": {
    "id": "review_1234567890_uuid",
    "status": "completed",
    "sourceType": "file",
    "fileName": "document.pdf",
    "fileSize": 123456,
    "createdAt": "2024-01-01T12:00:00Z",
    "updatedAt": "2024-01-01T12:01:30Z",
    "result": {
      "reviewContent": "...",
      "guardrailAssessment": {...},
      "completedAt": "2024-01-01T12:01:30Z"
    },
    "error": null,
    "processingTime": 30000
  }
}
```

#### `GET /api/reviews`

Get review history (all reviews, most recent first).

**Query Parameters:**

- `limit` (default: 50, max: 100)
- `skip` (default: 0, for pagination)

**Response (200 OK):**

```json
{
  "success": true,
  "reviews": [
    {
      "id": "review_1234567890_uuid",
      "status": "completed",
      "sourceType": "file",
      "fileName": "document.pdf",
      "fileSize": 123456,
      "createdAt": "2024-01-01T12:00:00Z",
      "updatedAt": "2024-01-01T12:01:30Z",
      "hasResult": true,
      "hasError": false,
      "processingTime": 30000
    }
  ],
  "pagination": {
    "total": 150,
    "limit": 50,
    "skip": 0,
    "returned": 50
  }
}
```

### 4. SQS Worker (`sqs-worker.js`)

Background worker that processes review jobs from SQS queue.

**Processing Flow:**

1. Poll SQS queue for messages
2. Parse message (file or text review)
3. Update review status to "processing"
4. For file reviews:
   - Download file from S3
   - Extract text using text-extractor
5. For text reviews:
   - Use text content directly
6. Send to Bedrock with system prompt
7. Save result to MongoDB
8. Delete SQS message (job complete)

**Error Handling:**

- Failed reviews marked as "failed" in MongoDB
- SQS message visibility timeout allows retries
- Detailed error logging

### 5. System Prompt (`docs/system-prompt.md`)

Comprehensive prompt that defines the AI reviewer's role and behavior:

- GOV.UK content expert persona
- Review focus areas (clarity, structure, accessibility, style, user needs)
- Structured output format
- Constructive feedback guidelines

## Frontend Integration

The frontend should:

1. **Submit Review:**

   ```javascript
   const response = await fetch('/api/review/file', {
     method: 'POST',
     body: formData
   })
   const { reviewId } = await response.json()
   ```

2. **Poll for Status:**

   ```javascript
   const pollReview = async (reviewId) => {
     const response = await fetch(`/api/review/${reviewId}`)
     const { review } = await response.json()

     if (review.status === 'pending' || review.status === 'processing') {
       // Still processing, poll again after delay
       setTimeout(() => pollReview(reviewId), 2000)
     } else if (review.status === 'completed') {
       // Display result
       displayReview(review.result)
     } else {
       // Handle error
       displayError(review.error)
     }
   }
   ```

3. **Show Review History:**
   ```javascript
   const response = await fetch('/api/reviews?limit=50')
   const { reviews } = await response.json()
   displayReviewList(reviews)
   ```

## Configuration

Required config values (already in `config.js`):

```javascript
{
  // MongoDB
  mongodb: {
    uri: process.env.MONGODB_URI,
    databaseName: 'content_reviewer'
  },

  // S3
  upload: {
    s3Bucket: process.env.S3_BUCKET,
    s3Region: 'eu-west-2',
    maxFileSize: 10485760, // 10MB
    allowedMimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ]
  },

  // SQS
  sqs: {
    queueUrl: process.env.SQS_QUEUE_URL,
    region: 'eu-west-2',
    maxMessages: 10,
    waitTimeSeconds: 20,
    visibilityTimeout: 300 // 5 minutes
  },

  // Bedrock
  bedrock: {
    enabled: true,
    inferenceProfileArn: process.env.BEDROCK_INFERENCE_PROFILE_ARN,
    guardrailArn: process.env.BEDROCK_GUARDRAIL_ARN,
    region: 'eu-west-2',
    maxTokens: 4096,
    temperature: 0.7
  }
}
```

## Benefits of Async Architecture

1. **No Timeout Issues:** Review endpoint returns immediately, nginx timeout not a problem
2. **Better UX:** Users can track review progress, see history
3. **Scalability:** Worker can be scaled independently
4. **Reliability:** Failed reviews can be retried automatically
5. **Monitoring:** Easy to track review metrics (processing time, success rate)
6. **Cost Tracking:** Bedrock usage tracked per review

## Testing the System

### 1. Test File Upload Review:

```bash
curl -X POST http://localhost:3001/api/review/file \
  -F "file=@test-document.pdf"
```

### 2. Test Text Review:

```bash
curl -X POST http://localhost:3001/api/review/text \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Your content to review...",
    "title": "Test Content"
  }'
```

### 3. Check Review Status:

```bash
curl http://localhost:3001/api/review/{reviewId}
```

### 4. Get Review History:

```bash
curl http://localhost:3001/api/reviews?limit=10
```

## Monitoring

Key metrics to monitor:

- **Queue depth:** Number of pending reviews in SQS
- **Processing time:** Average time from queue to completion
- **Success rate:** Percentage of completed vs failed reviews
- **Bedrock costs:** Total tokens used per day/week
- **Error types:** Common failure reasons

## Next Steps

1. **Frontend Integration:** Update React frontend to use new async endpoints
2. **Status Polling:** Implement polling mechanism with exponential backoff
3. **Review History UI:** Display review history with filters
4. **Error Handling:** Better error messages for users
5. **Notifications:** Optional webhook/email when review completes
6. **Cleanup:** Scheduled job to delete old reviews (>90 days)

## Migration from Sync to Async

The old sync endpoints (`POST /api/review`, `POST /api/chat`) are still available for backward compatibility but should be migrated to the new async endpoints.

**Old (sync):**

- `POST /api/review` - Returns review immediately (times out)

**New (async):**

- `POST /api/review/file` - Queues review, returns reviewId
- `GET /api/review/:id` - Poll for result
- `GET /api/reviews` - View history
