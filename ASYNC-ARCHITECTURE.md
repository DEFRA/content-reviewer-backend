# Async Content Review Architecture

This document describes the asynchronous content review workflow implemented in the ContentReviewerAI application.

## Overview

The application uses an **async job pattern** to handle content review processing:

1. **Upload** → File uploaded to S3
2. **Submit Job** → Message sent to SQS queue
3. **Process** → SQS worker extracts text and calls Bedrock
4. **Store Result** → Review stored in S3
5. **Poll & Display** → Frontend polls for completion and shows results

## Architecture Components

### 1. File Upload (CDP Uploader Integration)

- User uploads PDF/Word document via CDP Uploader
- File stored in S3 bucket
- Upload ID (jobId) generated
- Message sent to SQS queue for processing

### 2. SQS Worker (`sqs-worker.js`)

**Location:** `backend/src/common/helpers/sqs-worker.js`

The SQS worker continuously polls the queue for new review jobs:

```javascript
// Key responsibilities:
- Poll SQS queue for messages
- Download file from S3
- Extract text (PDF/Word)
- Call Bedrock for content review
- Store results in S3
- Delete processed message from queue
```

**Key Features:**

- Supports PDF extraction (via LangChain PDFLoader)
- Supports Word extraction (via mammoth)
- Handles Bedrock mock mode for testing
- Stores both success and error results
- Automatic retry on failure (via SQS visibility timeout)

### 3. Text Extraction Services

#### PDF Service (`pdf-service.js`)

- Uses LangChain `PDFLoader` for robust PDF text extraction
- Creates temporary files for processing
- Handles cleanup automatically
- Logs extraction metrics (word count, duration)

#### Word Service (`word-service.js`)

- Uses `mammoth` for .doc/.docx extraction
- Extracts plain text from Word documents
- Supports both old (.doc) and new (.docx) formats
- Handles cleanup automatically

### 4. Results Storage (`results-storage.js`)

**Location:** `backend/src/common/helpers/results-storage.js`

Stores and retrieves review results in S3:

```javascript
// Result structure in S3:
{
  jobId: "upload-id",
  status: "completed" | "failed",
  result: {
    filename: "document.pdf",
    review: "AI review content...",
    usage: { input_tokens: 1000, output_tokens: 500 },
    processedAt: "2024-01-01T00:00:00Z"
  },
  completedAt: "2024-01-01T00:00:00Z"
}
```

**S3 Storage Pattern:**

- Results stored at: `s3://{bucket}/content-results/{jobId}.json`
- Supports mock mode for local development
- In-memory storage in mock mode

### 5. Results API (`routes/results.js`)

**Location:** `backend/src/routes/results.js`

REST API for polling and retrieving results:

#### GET `/api/results/{jobId}`

Returns complete review result or processing status:

```json
{
  "success": true,
  "status": "completed" | "processing" | "failed",
  "jobId": "upload-id",
  "result": { ... },
  "completedAt": "2024-01-01T00:00:00Z"
}
```

#### GET `/api/results/{jobId}/status`

Lightweight status check (faster, less data):

```json
{
  "success": true,
  "jobId": "upload-id",
  "ready": true,
  "status": "completed" | "processing"
}
```

### 6. Frontend Polling (`review-result.njk`)

**Location:** `frontend/src/server/upload/review-result.njk`

The frontend polls for result completion:

```javascript
// Polling configuration:
- Poll interval: 2 seconds
- Max attempts: 60 (2 minutes total)
- Auto-stops when result is ready
- Shows error if timeout or failure
```

**User Experience:**

1. Upload completes → Redirect to review page
2. Shows "Processing" animation while polling
3. Result appears automatically when ready
4. Displays review content with formatting
5. Shows mock warning if applicable

## Configuration

### Environment Variables

```bash
# S3 Configuration
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
UPLOAD_S3_PATH=content-uploads
RESULTS_S3_PATH=content-results

# SQS Configuration
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/...
SQS_QUEUE_NAME=content_review_status
SQS_VISIBILITY_TIMEOUT=300

# Bedrock Configuration
ENABLE_BEDROCK=true
MOCK_BEDROCK=false
BEDROCK_REGION=eu-west-2
BEDROCK_MODEL_ID=anthropic.claude-3-sonnet-20240229-v1:0

# Mock Mode (Development)
MOCK_S3_UPLOAD=true  # Use mock S3 operations
```

### Config Values (`config.js`)

```javascript
results: {
  s3Path: {
    doc: 'S3 path prefix for review results',
    default: 'content-results',
    env: 'RESULTS_S3_PATH'
  }
}
```

## Development Mode

### Mock Mode Features

When running locally without AWS:

1. **Mock S3 Operations:**
   - File downloads return dummy content
   - Results stored in memory (Map)
   - No actual S3 API calls

2. **Mock Bedrock:**
   - Returns sample GOV.UK review
   - No actual Bedrock API calls
   - Simulates token usage

3. **Mock SQS (Optional):**
   - Can test with LocalStack
   - Or use real SQS in dev

### Testing Locally

```bash
# 1. Start backend with mock mode
cd backend
npm run dev

# 2. Upload a test document
# Visit http://localhost:3000/upload

# 3. Backend will process automatically
# Check logs for SQS worker activity

# 4. Frontend polls for results
# Visit http://localhost:3000/upload/review/{jobId}
```

## Production Deployment

### Prerequisites

1. **AWS Resources:**
   - S3 bucket for uploads and results
   - SQS queue for job processing
   - Bedrock access with appropriate model
   - IAM roles with proper permissions

2. **Environment Setup:**

   ```bash
   MOCK_S3_UPLOAD=false
   MOCK_BEDROCK=false
   AWS_REGION=eu-west-2
   ```

3. **IAM Permissions:**
   - `s3:GetObject` - Download uploaded files
   - `s3:PutObject` - Store results
   - `sqs:ReceiveMessage` - Poll queue
   - `sqs:DeleteMessage` - Remove processed jobs
   - `bedrock:InvokeModel` - Call Bedrock AI

### Scaling Considerations

1. **SQS Worker:**
   - Runs as singleton in each backend instance
   - Automatically scales with backend pods
   - Configure `SQS_MAX_MESSAGES` for batch size
   - Adjust `SQS_VISIBILITY_TIMEOUT` based on job duration

2. **Bedrock Timeouts:**
   - Connection timeout: 10 seconds
   - Socket timeout: 5 minutes
   - Handles large documents gracefully

3. **Result Storage:**
   - Results stored indefinitely in S3
   - Consider lifecycle policies for cleanup
   - Can add expiration metadata

## Error Handling

### SQS Worker Errors

```javascript
// Automatic retry via visibility timeout
// If processing fails:
1. Error logged
2. Error result stored in S3
3. Message returned to queue (after visibility timeout)
4. Retries with exponential backoff (SQS default)
5. After max retries → moves to DLQ (if configured)
```

### Frontend Error States

- **Timeout:** Job took too long (>2 minutes)
- **Failed:** Job failed with error message
- **Network Error:** Can't reach results API

All errors show user-friendly message with retry option.

## Monitoring

### Key Metrics

1. **SQS Worker Status:**
   - `GET /sqs-worker/status` - Check if worker is running
   - Monitor queue depth in CloudWatch
   - Track processing time per job

2. **Bedrock Usage:**
   - Token consumption (input/output)
   - Request latency
   - Error rates

3. **S3 Storage:**
   - Result file count
   - Storage size
   - Access patterns

### Logging

All components use structured logging:

```javascript
logger.info(
  {
    jobId: 'xxx',
    filename: 'doc.pdf',
    textLength: 1000,
    duration: 5000
  },
  'Content review completed'
)
```

## Future Enhancements

1. **WebSocket Support:**
   - Real-time updates instead of polling
   - Reduces server load
   - Better UX

2. **Result Expiration:**
   - Auto-delete old results
   - S3 lifecycle policies
   - Configurable retention

3. **Batch Processing:**
   - Process multiple files in one job
   - Comparison between versions
   - Bulk review operations

4. **Notifications:**
   - Email when review complete
   - SNS integration
   - Webhook callbacks

5. **Additional File Types:**
   - HTML extraction
   - Markdown processing
   - Excel/CSV support

## Troubleshooting

### Worker Not Processing

```bash
# Check worker status
curl http://localhost:3001/sqs-worker/status

# Check SQS queue
aws sqs get-queue-attributes --queue-url $QUEUE_URL

# Check backend logs
docker logs content-reviewer-backend
```

### Results Not Found

```bash
# Check if result exists in S3
aws s3 ls s3://$BUCKET/content-results/

# Check backend logs for processing errors
grep "jobId.*xxx" backend.log

# Verify job was submitted to queue
aws sqs receive-message --queue-url $QUEUE_URL
```

### Bedrock Errors

```bash
# Test Bedrock connectivity
node backend/test-bedrock.js

# Check Bedrock permissions
aws bedrock list-foundation-models

# Verify guardrails (if configured)
aws bedrock get-guardrail --guardrail-id xxx
```

## Related Documentation

- [BEDROCK-INTEGRATION.md](./BEDROCK-INTEGRATION.md) - Bedrock setup and configuration
- [USER_GUIDE.md](./USER_GUIDE.md) - End-user documentation
- [AWS-ARCHITECTURE.md](./AWS-ARCHITECTURE.md) - Overall AWS architecture
