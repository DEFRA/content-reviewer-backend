# Complete SQS Integration Guide

## AWS S3 & SQS Integration for DEFRA Content Review Tool

**Last Updated:** January 5, 2026  
**Version:** 1.0  
**Status:** ✅ Production Ready

---

# Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Prerequisites](#prerequisites)
4. [Installation & Setup](#installation--setup)
5. [Configuration](#configuration)
6. [Resources & Files](#resources--files)
7. [Testing Guide](#testing-guide)
8. [User Guide](#user-guide)
9. [API Reference](#api-reference)
10. [Troubleshooting](#troubleshooting)
11. [Production Deployment](#production-deployment)
12. [AI Integration Points](#ai-integration-points)

---

# Executive Summary

This document consolidates all information about the AWS S3 and SQS integration for the DEFRA Content Review Tool. The integration enables:

- ✅ File uploads to AWS S3
- ✅ Message queuing via AWS SQS
- ✅ Background worker processing
- ✅ Ready for AI content review integration
- ✅ Scalable architecture for multiple workers

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure AWS credentials
export AWS_ACCESS_KEY_ID=your_key
export AWS_SECRET_ACCESS_KEY=your_secret

# 3. Start the server
npm run dev

# 4. Test SQS worker
node test-sqs-worker.js
```

---

# Architecture Overview

## System Components

```
┌─────────────┐
│   Frontend  │
│  (Upload)   │
└──────┬──────┘
       │ HTTP POST /api/upload
       ▼
┌─────────────────────────────────┐
│         Backend Server          │
│  ┌──────────────────────────┐  │
│  │   Upload Controller      │  │
│  │  (src/routes/upload.js)  │  │
│  └────────┬─────────────────┘  │
│           │                     │
│           ▼                     │
│  ┌──────────────────────────┐  │
│  │    S3 Uploader Helper    │  │
│  │ (s3-uploader.js)         │  │
│  └────────┬─────────────────┘  │
│           │                     │
└───────────┼─────────────────────┘
            │
            ▼
    ┌──────────────┐
    │   AWS S3     │
    │   Bucket     │
    └──────────────┘
            │
            ▼
    ┌──────────────────────────┐
    │   SQS Client Helper      │
    │   (sqs-client.js)        │
    │   Sends message          │
    └──────────┬───────────────┘
               │
               ▼
    ┌──────────────────────────┐
    │   AWS SQS Queue          │
    │  content_review_status   │
    └──────────┬───────────────┘
               │
               ▼
    ┌──────────────────────────┐
    │   SQS Worker             │
    │   (sqs-worker.js)        │
    │   - Polls queue          │
    │   - Processes messages   │
    │   - Deletes after success│
    └──────────┬───────────────┘
               │
               ▼
    ┌──────────────────────────┐
    │   AI Review Logic        │
    │   (To be implemented)    │
    └──────────────────────────┘
```

## Data Flow

1. **Upload Phase:**
   - User uploads file via frontend
   - Backend receives file and uploads to S3
   - S3 URL is returned to upload controller

2. **Queue Phase:**
   - Upload controller sends message to SQS
   - Message contains: uploadId, filename, S3 location, metadata

3. **Processing Phase:**
   - SQS Worker polls queue (long polling, 20s)
   - Receives messages (batch of up to 10)
   - Processes each message
   - Calls AI review logic (placeholder ready)
   - Deletes message after successful processing

4. **Error Handling:**
   - Failed messages become visible again after 5 minutes
   - Automatic retry mechanism
   - Dead Letter Queue support (optional)

---

# Prerequisites

## Required Software

- **Node.js:** >= v22
- **npm:** >= v11
- **AWS Account:** With S3 and SQS access
- **AWS CLI:** For testing and queue management (optional)

## AWS Resources

### S3 Bucket

- **Name:** `dev-service-optimisation-c63f2`
- **Region:** `eu-west-2`
- **Purpose:** Store uploaded files

### SQS Queue

- **Name:** `content_review_status`
- **URL:** `https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status`
- **Region:** `eu-west-2`
- **Type:** Standard Queue
- **Visibility Timeout:** 300 seconds (5 minutes)
- **Message Retention:** 4 days (default)

## IAM Permissions Required

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::dev-service-optimisation-c63f2",
        "arn:aws:s3:::dev-service-optimisation-c63f2/*"
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
    }
  ]
}
```

---

# Installation & Setup

## 1. Install Dependencies

```bash
cd content-reviewer-backend
npm install
```

**New Dependencies Added:**

- `@aws-sdk/client-s3` - S3 operations
- `@aws-sdk/client-sqs` - SQS operations

## 2. Configure Environment Variables

Create or update `.env` file:

```bash
# AWS Credentials
AWS_ACCESS_KEY_ID=AKIA...your_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=eu-west-2

# S3 Configuration
S3_BUCKET_NAME=dev-service-optimisation-c63f2
S3_REGION=eu-west-2

# SQS Configuration
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status
SQS_QUEUE_NAME=content_review_status
SQS_REGION=eu-west-2

# Optional: For LocalStack or development
# AWS_ENDPOINT=http://localhost:4566
# LOCALSTACK_ENDPOINT=http://localhost:4566

# Optional: Disable worker in development
# SKIP_SQS_WORKER=true
# MOCK_S3_UPLOAD=true
```

## 3. Verify Configuration

```bash
# Test AWS credentials
aws sts get-caller-identity

# Test S3 access
aws s3 ls s3://dev-service-optimisation-c63f2

# Test SQS access
aws sqs get-queue-attributes \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status \
  --attribute-names All
```

---

# Configuration

## Backend Configuration File

**File:** `src/config.js`

```javascript
// S3 Configuration
s3: {
  bucketName: process.env.S3_BUCKET_NAME || 'dev-service-optimisation-c63f2',
  region: process.env.S3_REGION || 'eu-west-2'
},

// SQS Configuration
sqs: {
  queueUrl: process.env.SQS_QUEUE_URL ||
    'https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status',
  queueName: process.env.SQS_QUEUE_NAME || 'content_review_status',
  region: process.env.SQS_REGION || 'eu-west-2',
  maxMessages: parseInt(process.env.SQS_MAX_MESSAGES || '10'),
  waitTimeSeconds: parseInt(process.env.SQS_WAIT_TIME_SECONDS || '20'),
  visibilityTimeout: parseInt(process.env.SQS_VISIBILITY_TIMEOUT || '300')
}
```

## Configuration Parameters

| Parameter                | Default                        | Description                        |
| ------------------------ | ------------------------------ | ---------------------------------- |
| `S3_BUCKET_NAME`         | dev-service-optimisation-c63f2 | S3 bucket for uploads              |
| `S3_REGION`              | eu-west-2                      | AWS region for S3                  |
| `SQS_QUEUE_URL`          | (see above)                    | Full SQS queue URL                 |
| `SQS_QUEUE_NAME`         | content_review_status          | Queue name                         |
| `SQS_REGION`             | eu-west-2                      | AWS region for SQS                 |
| `SQS_MAX_MESSAGES`       | 10                             | Messages per poll                  |
| `SQS_WAIT_TIME_SECONDS`  | 20                             | Long polling duration              |
| `SQS_VISIBILITY_TIMEOUT` | 300                            | Message processing timeout (5 min) |
| `MOCK_S3_UPLOAD`         | false                          | Use mock S3 for testing            |
| `SKIP_SQS_WORKER`        | false                          | Disable SQS worker                 |

---

# Resources & Files

## New Files Created

### Core Integration Files

#### 1. `src/common/helpers/s3-uploader.js`

**Purpose:** Upload files to AWS S3  
**Functions:**

- `uploadToS3(fileBuffer, filename, metadata)` - Upload file to S3
- Handles file naming with timestamps
- Returns S3 location URL

**Usage:**

```javascript
import { uploadToS3 } from './common/helpers/s3-uploader.js'

const s3Location = await uploadToS3(fileBuffer, filename, {
  uploadId: '123',
  originalName: 'document.pdf'
})
```

#### 2. `src/common/helpers/sqs-client.js`

**Purpose:** Send messages to AWS SQS  
**Functions:**

- `sendToQueue(message)` - Send message to SQS queue

**Message Format:**

```javascript
{
  uploadId: 'unique-id',
  messageType: 'CONTENT_REVIEW_REQUEST',
  filename: 'document.pdf',
  s3Location: 's3://bucket/uploads/123_document.pdf',
  uploadedAt: '2026-01-05T10:00:00.000Z',
  metadata: { /* custom metadata */ }
}
```

**Usage:**

```javascript
import { sendToQueue } from './common/helpers/sqs-client.js'

await sendToQueue({
  uploadId: uploadId,
  messageType: 'CONTENT_REVIEW_REQUEST',
  filename: filename,
  s3Location: s3Location
})
```

#### 3. `src/common/helpers/sqs-worker.js`

**Purpose:** Background worker to process SQS messages  
**Key Features:**

- Long polling (20 seconds)
- Batch processing (up to 10 messages)
- Automatic retry on failure
- Message deletion after success
- Status monitoring via `getStatus()`

**Worker Lifecycle:**

```javascript
// Started in src/server.js
sqsWorker.start() // Begin polling

// Automatically polls and processes
// - Receives messages
// - Calls processContentReview()
// - Deletes successful messages
// - Retries failed messages

sqsWorker.stop() // Shutdown gracefully
```

**AI Integration Point:**

```javascript
async processContentReview(messageBody) {
  // TODO: Your colleague implements here
  // 1. Download file from S3
  // 2. Extract text content
  // 3. Send to AI for review
  // 4. Store results
  // 5. Notify user
}
```

### API Route Files

#### 4. `src/routes/upload.js` (Modified)

**Changes:**

- Added SQS message sending after S3 upload
- Integrated S3 uploader helper
- Integrated SQS client helper

**Flow:**

```
1. Receive file upload
2. Upload to S3 → get S3 location
3. Send message to SQS → queue for processing
4. Return response to frontend
```

#### 5. `src/routes/sqs-worker-status.js` (New)

**Purpose:** API endpoint to check SQS worker status  
**Endpoint:** `GET /api/sqs-worker/status`

**Response:**

```json
{
  "status": "success",
  "data": {
    "running": true,
    "queueUrl": "https://sqs...",
    "region": "eu-west-2",
    "maxMessages": 10,
    "waitTimeSeconds": 20,
    "visibilityTimeout": 300,
    "expectedToRun": true,
    "environment": {
      "mockMode": false,
      "skipWorker": false,
      "awsEndpoint": "default"
    }
  }
}
```

### Server Files

#### 6. `src/server.js` (Modified)

**Changes:**

- Import SQS worker
- Start worker on server start (unless in MOCK mode)
- Stop worker on server shutdown
- Error handling for worker startup

### Configuration Files

#### 7. `src/config.js` (Modified)

**Added:**

- S3 configuration section
- SQS configuration section
- Environment variable mappings

### Test Scripts

#### 8. `test-sqs-worker.js`

**Purpose:** Cross-platform Node.js test script  
**Usage:**

```bash
node test-sqs-worker.js
```

**Output:**

- Worker status
- Configuration details
- Health check result

#### 9. `test-sqs-worker.ps1`

**Purpose:** Windows PowerShell test script  
**Usage:**

```powershell
.\test-sqs-worker.ps1
```

**Features:**

- Color-coded output
- Detailed status summary
- Error handling

### Documentation Files

#### 10. `SQS_INTEGRATION.md`

**Contents:**

- Integration overview
- Configuration guide
- Testing instructions
- IAM permissions
- Troubleshooting

#### 11. `TESTING_SQS_WORKER.md`

**Contents:**

- Complete testing guide
- Test scenarios
- Expected outputs
- Troubleshooting steps
- Performance testing

#### 12. `TESTING_QUICK_GUIDE.md`

**Contents:**

- Quick reference card
- Common commands
- Quick troubleshooting
- Status interpretation

#### 13. `SQS_WORKER_TESTING_SUMMARY.md`

**Contents:**

- Implementation summary
- What was added
- Testing methods
- Integration points

#### 14. `COMPLETE_SQS_INTEGRATION_GUIDE.md` (This file)

**Contents:**

- Complete consolidated documentation
- All guides in one place
- Full reference

---

# Testing Guide

## Quick Test Workflow

### Step 1: Start the Server

```bash
npm run dev
```

**Expected Output:**

```
[INFO] Server started at http://localhost:3001
[INFO] Starting SQS worker for content review queue
[INFO] SQS Worker started
```

### Step 2: Test Worker Status

**Option A: Node.js Script**

```bash
node test-sqs-worker.js
```

**Option B: PowerShell Script**

```powershell
.\test-sqs-worker.ps1
```

**Option C: Direct API Call**

```bash
curl http://localhost:3001/api/sqs-worker/status
```

**Expected Response:**

```json
{
  "status": "success",
  "data": {
    "running": true,
    "expectedToRun": true,
    "queueUrl": "https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status",
    "region": "eu-west-2"
  }
}
```

### Step 3: Test File Upload

Create a test file:

```bash
echo "This is a test document for content review." > test.txt
```

Upload the file:

```bash
# Windows PowerShell
curl.exe -X POST http://localhost:3001/api/upload -F "file=@test.txt"

# Linux/Mac
curl -X POST http://localhost:3001/api/upload -F "file=@test.txt"
```

**Expected Response:**

```json
{
  "success": true,
  "uploadId": "abc123",
  "filename": "test.txt",
  "s3Location": "s3://dev-service-optimisation-c63f2/uploads/1704448800000_test.txt",
  "message": "File uploaded and queued for review"
}
```

### Step 4: Monitor Processing

**Check Backend Logs:**

```
[INFO] File uploaded to S3: {...}
[INFO] Message sent to SQS: {...}
[INFO] Received messages from SQS: {"messageCount":1}
[INFO] Processing message: {"messageId":"...","uploadId":"abc123"}
[INFO] Content review requested: {"uploadId":"abc123","filename":"test.txt"}
[INFO] Message processed successfully
```

**Check SQS Queue:**

```bash
aws sqs get-queue-attributes \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status \
  --attribute-names ApproximateNumberOfMessages
```

**Expected:** `ApproximateNumberOfMessages: 0` (all processed)

## Test Scenarios

### Scenario 1: Worker Running and Healthy ✅

**Test:**

```bash
node test-sqs-worker.js
```

**Expected:**

```
✅ SQS Worker is running and healthy!

Summary:
  • Worker Running: ✅ YES
  • Expected to Run: ✅ YES
  • Mock Mode: ✅ NO
```

**Action:** Proceed with file uploads

### Scenario 2: Worker in MOCK Mode ⚠️

**Test:**

```bash
export MOCK_S3_UPLOAD=true
npm run dev
node test-sqs-worker.js
```

**Expected:**

```
⚠️  SQS Worker is not expected to run (MOCK mode)

Summary:
  • Worker Running: ❌ NO
  • Expected to Run: ❌ NO
  • Mock Mode: ⚠️  YES
```

**Action:** This is normal for development without AWS credentials

### Scenario 3: Worker Should Run But Isn't ❌

**Test:**

```bash
node test-sqs-worker.js
```

**Expected:**

```
❌ SQS Worker is not running (check logs for errors)

Summary:
  • Worker Running: ❌ NO
  • Expected to Run: ✅ YES
```

**Actions:**

1. Check AWS credentials are set
2. Check server logs for errors
3. Verify SQS queue URL is correct
4. Check IAM permissions

## Testing Checklist

- [ ] Backend server starts successfully
- [ ] SQS worker starts automatically
- [ ] Worker status endpoint returns `running: true`
- [ ] File upload succeeds
- [ ] File appears in S3 bucket
- [ ] Message sent to SQS queue
- [ ] Worker receives and processes message
- [ ] Message deleted from queue after processing
- [ ] Backend logs show complete workflow
- [ ] No errors in logs

---

# User Guide

## For Developers

### Starting the Application

1. **Set AWS credentials:**

   ```bash
   export AWS_ACCESS_KEY_ID=your_key
   export AWS_SECRET_ACCESS_KEY=your_secret
   ```

2. **Start the server:**

   ```bash
   npm run dev
   ```

3. **Verify worker is running:**
   ```bash
   node test-sqs-worker.js
   ```

### Uploading Files

**Via Frontend:**

1. Navigate to upload page
2. Select file
3. Click upload
4. Wait for confirmation

**Via API:**

```bash
curl -X POST http://localhost:3001/api/upload \
  -F "file=@document.pdf" \
  -F "metadata[key]=value"
```

### Monitoring Processing

**Check Worker Status:**

```bash
curl http://localhost:3001/api/sqs-worker/status
```

**Check Server Logs:**

```bash
npm run dev
# Watch logs for processing messages
```

**Check SQS Queue:**

```bash
aws sqs get-queue-attributes \
  --queue-url YOUR_QUEUE_URL \
  --attribute-names All
```

### Development Modes

**Mock Mode (No AWS):**

```bash
export MOCK_S3_UPLOAD=true
npm run dev
```

- Files stored locally
- SQS worker disabled
- Good for frontend development

**Skip Worker Mode:**

```bash
export SKIP_SQS_WORKER=true
npm run dev
```

- S3 uploads work
- SQS worker disabled
- Good for testing uploads without processing

**LocalStack Mode:**

```bash
export AWS_ENDPOINT=http://localhost:4566
npm run dev
```

- Uses local AWS emulator
- Good for full integration testing

## For AI Integration Developers

### Integration Point

**File:** `src/common/helpers/sqs-worker.js`  
**Method:** `processContentReview(messageBody)`

### Message Structure

When a file is uploaded, you receive:

```javascript
{
  uploadId: "abc123",              // Unique upload identifier
  messageType: "CONTENT_REVIEW_REQUEST",
  filename: "document.pdf",        // Original filename
  s3Location: "s3://bucket/...",  // S3 location
  uploadedAt: "2026-01-05T10:00:00Z",
  metadata: {                      // Optional metadata
    userId: "user123",
    contentType: "application/pdf"
  }
}
```

### Implementation Steps

1. **Download file from S3:**

   ```javascript
   import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

   const s3Client = new S3Client({ region: config.get('s3.region') })
   const command = new GetObjectCommand({
     Bucket: 'dev-service-optimisation-c63f2',
     Key: 'uploads/file.pdf'
   })
   const response = await s3Client.send(command)
   ```

2. **Extract text content:**

   ```javascript
   // Use appropriate library based on file type
   // PDF: pdf-parse, pdfjs-dist
   // Word: mammoth
   // Text: direct read
   ```

3. **Send to AI for review:**

   ```javascript
   const aiResponse = await yourAIService.review({
     content: extractedText,
     context: messageBody.metadata
   })
   ```

4. **Store results:**

   ```javascript
   // Store in MongoDB, S3, or database
   await saveReviewResults({
     uploadId: messageBody.uploadId,
     results: aiResponse,
     processedAt: new Date()
   })
   ```

5. **Notify user (optional):**
   ```javascript
   // Send email, webhook, or update frontend
   await notifyUser({
     uploadId: messageBody.uploadId,
     status: 'completed'
   })
   ```

### Example Implementation

```javascript
async processContentReview(messageBody) {
  logger.info('Starting AI review', { uploadId: messageBody.uploadId })

  try {
    // 1. Download from S3
    const fileBuffer = await this.downloadFromS3(messageBody.s3Location)

    // 2. Extract content
    const content = await this.extractContent(fileBuffer, messageBody.filename)

    // 3. AI Review
    const aiResults = await this.callAIService({
      content: content,
      filename: messageBody.filename,
      metadata: messageBody.metadata
    })

    // 4. Store results
    await this.storeResults({
      uploadId: messageBody.uploadId,
      results: aiResults,
      processedAt: new Date()
    })

    // 5. Notify (optional)
    await this.notifyUser(messageBody.uploadId, aiResults)

    logger.info('AI review completed', {
      uploadId: messageBody.uploadId,
      status: aiResults.status
    })

    return aiResults

  } catch (error) {
    logger.error('AI review failed', {
      uploadId: messageBody.uploadId,
      error: error.message
    })
    throw error  // Message will retry
  }
}
```

### Error Handling

The worker automatically handles:

- **Retries:** Failed messages become visible again after 5 minutes
- **Logging:** All errors are logged with context
- **Message Deletion:** Only deleted after successful processing

You should handle:

- **Invalid file formats:** Return error, log, and delete message
- **AI service errors:** Log and throw to retry
- **Storage errors:** Log and throw to retry

### Testing Your Integration

1. **Add logging:**

   ```javascript
   logger.info('Your integration step', { data })
   ```

2. **Test with small file:**

   ```bash
   curl -X POST http://localhost:3001/api/upload -F "file=@test.txt"
   ```

3. **Monitor logs:**

   ```bash
   npm run dev
   # Watch for your log messages
   ```

4. **Verify results stored:**
   ```bash
   # Check your database/storage
   ```

## For Operations/DevOps

### Environment Setup

**Development:**

```bash
AWS_ACCESS_KEY_ID=dev_key
AWS_SECRET_ACCESS_KEY=dev_secret
S3_BUCKET_NAME=dev-service-optimisation-c63f2
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status
```

**Production:**

```bash
AWS_ACCESS_KEY_ID=prod_key
AWS_SECRET_ACCESS_KEY=prod_secret
S3_BUCKET_NAME=prod-service-optimisation
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/PROD_ACCOUNT/content_review_prod
```

### Monitoring

**Health Checks:**

```bash
# Server health
curl http://localhost:3001/health

# Upload service health
curl http://localhost:3001/api/upload/health

# Worker status
curl http://localhost:3001/api/sqs-worker/status
```

**CloudWatch Metrics (Recommended):**

- SQS: NumberOfMessagesSent
- SQS: NumberOfMessagesReceived
- SQS: ApproximateNumberOfMessagesVisible
- S3: NumberOfObjects
- S3: BucketSizeBytes

**Logs to Monitor:**

```
[INFO] SQS Worker started
[INFO] Received messages from SQS
[INFO] Processing message
[INFO] Message processed successfully
[ERROR] Failed to process message
```

### Scaling

**Horizontal Scaling:**

```bash
# Run multiple worker instances
# Each polls the same queue
# SQS ensures no duplicate processing

# Instance 1
npm run dev

# Instance 2
npm run dev

# Instance 3
npm run dev
```

**Vertical Scaling:**

```bash
# Increase messages per poll
export SQS_MAX_MESSAGES=10

# Increase processing timeout
export SQS_VISIBILITY_TIMEOUT=600  # 10 minutes
```

### Backup & Recovery

**S3 Versioning:**

```bash
aws s3api put-bucket-versioning \
  --bucket dev-service-optimisation-c63f2 \
  --versioning-configuration Status=Enabled
```

**SQS Dead Letter Queue:**

```bash
# Create DLQ
aws sqs create-queue --queue-name content_review_dlq

# Configure main queue to use DLQ
aws sqs set-queue-attributes \
  --queue-url YOUR_QUEUE_URL \
  --attributes RedrivePolicy='{"deadLetterTargetArn":"DLQ_ARN","maxReceiveCount":"3"}'
```

---

# API Reference

## Upload API

### POST /api/upload

Upload a file for content review.

**Request:**

```http
POST /api/upload
Content-Type: multipart/form-data

file: <binary>
metadata[key]: value (optional)
```

**Response:**

```json
{
  "success": true,
  "uploadId": "abc123",
  "filename": "document.pdf",
  "s3Location": "s3://bucket/uploads/123_document.pdf",
  "message": "File uploaded and queued for review"
}
```

**Error Response:**

```json
{
  "success": false,
  "error": "Error message"
}
```

### GET /api/upload/health

Health check for upload service.

**Response:**

```json
{
  "status": "healthy",
  "service": "upload",
  "timestamp": "2026-01-05T10:00:00Z"
}
```

## Worker Status API

### GET /api/sqs-worker/status

Get SQS worker status and configuration.

**Response:**

```json
{
  "status": "success",
  "data": {
    "running": true,
    "queueUrl": "https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status",
    "region": "eu-west-2",
    "maxMessages": 10,
    "waitTimeSeconds": 20,
    "visibilityTimeout": 300,
    "expectedToRun": true,
    "environment": {
      "mockMode": false,
      "skipWorker": false,
      "awsEndpoint": "default"
    }
  }
}
```

## Health Check API

### GET /health

Server health check.

**Response:**

```json
{
  "message": "success"
}
```

---

# Troubleshooting

## Common Issues

### Issue 1: Worker Not Starting

**Symptom:**

```
[ERROR] Failed to start SQS worker - will continue without it
```

**Causes & Solutions:**

1. **Missing AWS Credentials:**

   ```bash
   # Check credentials
   echo $AWS_ACCESS_KEY_ID
   echo $AWS_SECRET_ACCESS_KEY

   # Set credentials
   export AWS_ACCESS_KEY_ID=your_key
   export AWS_SECRET_ACCESS_KEY=your_secret
   ```

2. **Invalid Queue URL:**

   ```bash
   # Verify queue exists
   aws sqs get-queue-attributes --queue-url YOUR_QUEUE_URL

   # Update config
   export SQS_QUEUE_URL=correct_url
   ```

3. **Network/Firewall Issues:**

   ```bash
   # Test connectivity
   curl https://sqs.eu-west-2.amazonaws.com

   # Check proxy settings
   echo $HTTP_PROXY
   echo $HTTPS_PROXY
   ```

### Issue 2: Worker Running But Not Processing

**Symptom:**

- Worker status shows `running: true`
- No "Received messages" logs
- Queue has messages

**Causes & Solutions:**

1. **No Messages in Queue:**

   ```bash
   # Check queue
   aws sqs get-queue-attributes \
     --queue-url YOUR_QUEUE_URL \
     --attribute-names ApproximateNumberOfMessages
   ```

2. **Permissions Issue:**

   ```bash
   # Test receive permission
   aws sqs receive-message --queue-url YOUR_QUEUE_URL

   # Verify IAM permissions include sqs:ReceiveMessage
   ```

3. **Messages in Flight:**

   ```bash
   # Check messages in flight
   aws sqs get-queue-attributes \
     --queue-url YOUR_QUEUE_URL \
     --attribute-names ApproximateNumberOfMessagesNotVisible

   # Wait for visibility timeout to expire (5 minutes default)
   ```

### Issue 3: Upload Fails

**Symptom:**

```
Error uploading file to S3
```

**Causes & Solutions:**

1. **S3 Permissions:**

   ```bash
   # Test put permission
   echo "test" > test.txt
   aws s3 cp test.txt s3://dev-service-optimisation-c63f2/test.txt

   # Verify IAM permissions include s3:PutObject
   ```

2. **Bucket Doesn't Exist:**

   ```bash
   # Check bucket
   aws s3 ls s3://dev-service-optimisation-c63f2

   # Create bucket if needed
   aws s3 mb s3://dev-service-optimisation-c63f2 --region eu-west-2
   ```

3. **File Too Large:**
   ```bash
   # Check file size limits in config
   # Default is usually 5GB for S3
   # May need multipart upload for large files
   ```

### Issue 4: Messages Not Being Deleted

**Symptom:**

- Messages processed successfully
- Same messages reappear after 5 minutes

**Causes & Solutions:**

1. **Delete Permission Missing:**

   ```bash
   # Test delete permission
   aws sqs delete-message \
     --queue-url YOUR_QUEUE_URL \
     --receipt-handle "test"

   # Verify IAM permissions include sqs:DeleteMessage
   ```

2. **Processing Time Too Long:**

   ```bash
   # Increase visibility timeout
   export SQS_VISIBILITY_TIMEOUT=600  # 10 minutes

   # Or configure in AWS console
   ```

3. **Error in processContentReview():**
   ```javascript
   // Check logs for errors
   // Ensure method doesn't throw before completion
   ```

### Issue 5: Mock Mode When You Don't Want It

**Symptom:**

```
Worker Running: NO
Expected to Run: NO
Mock Mode: YES
```

**Solution:**

```bash
# Unset MOCK_S3_UPLOAD
unset MOCK_S3_UPLOAD

# Or set to false
export MOCK_S3_UPLOAD=false

# Restart server
npm run dev
```

## Debugging Commands

### Check Environment

```bash
# Windows PowerShell
Get-ChildItem Env: | Where-Object { $_.Name -like "*AWS*" -or $_.Name -like "*SQS*" -or $_.Name -like "*S3*" }

# Linux/Mac
env | grep -E "AWS|SQS|S3|MOCK|SKIP"
```

### Check AWS Configuration

```bash
# Current identity
aws sts get-caller-identity

# S3 access
aws s3 ls s3://dev-service-optimisation-c63f2

# SQS access
aws sqs list-queues

# Queue attributes
aws sqs get-queue-attributes \
  --queue-url YOUR_QUEUE_URL \
  --attribute-names All
```

### Monitor Queue in Real-Time

```bash
# Watch queue size
watch -n 5 'aws sqs get-queue-attributes --queue-url YOUR_QUEUE_URL --attribute-names ApproximateNumberOfMessages --query "Attributes.ApproximateNumberOfMessages"'
```

### Manual Message Testing

```bash
# Send test message
aws sqs send-message \
  --queue-url YOUR_QUEUE_URL \
  --message-body '{"uploadId":"test123","messageType":"CONTENT_REVIEW_REQUEST","filename":"test.txt","s3Location":"s3://bucket/test.txt"}'

# Receive message
aws sqs receive-message \
  --queue-url YOUR_QUEUE_URL \
  --max-number-of-messages 1

# Delete message
aws sqs delete-message \
  --queue-url YOUR_QUEUE_URL \
  --receipt-handle "RECEIPT_HANDLE_FROM_RECEIVE"
```

---

# Production Deployment

## Pre-Deployment Checklist

- [ ] AWS credentials configured in production environment
- [ ] S3 bucket created and accessible
- [ ] SQS queue created with appropriate settings
- [ ] IAM permissions verified
- [ ] Environment variables set
- [ ] Dead Letter Queue configured (recommended)
- [ ] CloudWatch monitoring set up
- [ ] Backup and versioning enabled on S3
- [ ] Load testing completed
- [ ] Error handling tested
- [ ] Logging configured
- [ ] Alert thresholds defined

## Environment Configuration

### Production Environment Variables

```bash
# AWS Configuration
AWS_ACCESS_KEY_ID=PROD_KEY
AWS_SECRET_ACCESS_KEY=PROD_SECRET
AWS_REGION=eu-west-2

# S3 Configuration
S3_BUCKET_NAME=prod-service-optimisation
S3_REGION=eu-west-2

# SQS Configuration
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/PROD_ACCOUNT/content_review_prod
SQS_QUEUE_NAME=content_review_prod
SQS_REGION=eu-west-2
SQS_MAX_MESSAGES=10
SQS_WAIT_TIME_SECONDS=20
SQS_VISIBILITY_TIMEOUT=300

# Worker Configuration
SKIP_SQS_WORKER=false
MOCK_S3_UPLOAD=false

# Logging
LOG_LEVEL=info
```

## Deployment Steps

### 1. Infrastructure Setup

```bash
# Create production S3 bucket
aws s3 mb s3://prod-service-optimisation --region eu-west-2

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket prod-service-optimisation \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
  --bucket prod-service-optimisation \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# Create SQS queue
aws sqs create-queue \
  --queue-name content_review_prod \
  --attributes VisibilityTimeout=300,MessageRetentionPeriod=345600

# Create Dead Letter Queue
aws sqs create-queue \
  --queue-name content_review_prod_dlq

# Configure DLQ on main queue
aws sqs set-queue-attributes \
  --queue-url PROD_QUEUE_URL \
  --attributes RedrivePolicy='{"deadLetterTargetArn":"DLQ_ARN","maxReceiveCount":"3"}'
```

### 2. Deploy Application

```bash
# Build application
npm run build

# Run tests
npm test

# Deploy (method depends on your infrastructure)
# - Docker: docker build && docker push
# - EC2: scp files and npm install
# - ECS: Update task definition
# - Lambda: Package and deploy

# Start application
npm start
```

### 3. Verify Deployment

```bash
# Check server health
curl https://your-domain.com/health

# Check worker status
curl https://your-domain.com/api/sqs-worker/status

# Test upload
curl -X POST https://your-domain.com/api/upload -F "file=@test.pdf"
```

## Monitoring & Alerts

### CloudWatch Alarms

```bash
# High queue depth
aws cloudwatch put-metric-alarm \
  --alarm-name sqs-high-queue-depth \
  --alarm-description "SQS queue depth is high" \
  --metric-name ApproximateNumberOfMessagesVisible \
  --namespace AWS/SQS \
  --statistic Average \
  --period 300 \
  --threshold 100 \
  --comparison-operator GreaterThanThreshold

# DLQ messages
aws cloudwatch put-metric-alarm \
  --alarm-name sqs-dlq-messages \
  --alarm-description "Messages in DLQ" \
  --metric-name ApproximateNumberOfMessagesVisible \
  --namespace AWS/SQS \
  --statistic Sum \
  --period 300 \
  --threshold 1 \
  --comparison-operator GreaterThanThreshold
```

### Application Logging

Ensure logs include:

- Worker startup/shutdown
- Message processing start/end
- Errors with full context
- Performance metrics

### Metrics to Track

- **Upload Rate:** Files uploaded per hour
- **Processing Rate:** Messages processed per hour
- **Error Rate:** Failed messages per hour
- **Queue Depth:** Messages waiting in queue
- **Processing Time:** Average time per message
- **DLQ Messages:** Messages that failed after retries

## Scaling Strategy

### Horizontal Scaling

```bash
# Run multiple worker instances
# Each instance polls the same queue
# SQS ensures no duplicate processing

# Auto-scaling group (example)
# - Min: 2 instances
# - Max: 10 instances
# - Scale up: Queue depth > 100
# - Scale down: Queue depth < 20
```

### Vertical Scaling

```bash
# Increase instance size for CPU/memory intensive AI processing
# Adjust based on AI model requirements
```

## Backup & Disaster Recovery

### S3 Backup

```bash
# Enable versioning (already done)
# Set up cross-region replication
aws s3api put-bucket-replication \
  --bucket prod-service-optimisation \
  --replication-configuration file://replication.json

# Enable lifecycle policies
aws s3api put-bucket-lifecycle-configuration \
  --bucket prod-service-optimisation \
  --lifecycle-configuration file://lifecycle.json
```

### SQS Backup

- Messages are stored for 4 days by default
- DLQ stores failed messages for investigation
- Consider periodic snapshots of DLQ messages

### Database Backup

- Configure automated backups for MongoDB/database
- Test restore procedures
- Document recovery process

---

# AI Integration Points

## Where to Add AI Logic

**File:** `src/common/helpers/sqs-worker.js`  
**Method:** `processContentReview(messageBody)`  
**Line:** ~169

### Current Implementation (Placeholder)

```javascript
async processContentReview(messageBody) {
  logger.info({
    uploadId: messageBody.uploadId,
    messageType: messageBody.messageType,
    filename: messageBody.filename,
    s3Location: messageBody.s3Location
  }, 'Content review requested')

  // TODO: Your colleague will implement this
  // This is where the AI content review will happen:
  // 1. If file upload: Download file from S3
  // 2. Extract text content from file
  // 3. Send to AI prompt for review
  // 4. Get review results
  // 5. Store results (database/S3)
  // 6. Optionally notify user

  // Simulate processing time
  await this.sleep(1000)

  // Placeholder response
  const reviewResult = {
    uploadId: messageBody.uploadId,
    status: 'pending_ai_integration',
    message: 'File received and queued. AI review integration will be implemented by your colleague.',
    s3Location: messageBody.s3Location,
    processedAt: new Date().toISOString()
  }

  logger.info({ uploadId: messageBody.uploadId, result: reviewResult }, 'Content review placeholder executed')

  return reviewResult
}
```

### Recommended Implementation Pattern

```javascript
async processContentReview(messageBody) {
  const { uploadId, filename, s3Location, metadata } = messageBody

  logger.info({ uploadId, filename }, 'Starting AI content review')

  try {
    // Step 1: Download file from S3
    const fileBuffer = await this.downloadFileFromS3(s3Location)
    logger.info({ uploadId, size: fileBuffer.length }, 'File downloaded from S3')

    // Step 2: Extract text content
    const textContent = await this.extractTextContent(fileBuffer, filename)
    logger.info({ uploadId, contentLength: textContent.length }, 'Text extracted')

    // Step 3: Prepare AI prompt
    const prompt = this.buildAIPrompt(textContent, metadata)

    // Step 4: Call AI service
    const aiResponse = await this.callAIService(prompt)
    logger.info({ uploadId, aiStatus: aiResponse.status }, 'AI review completed')

    // Step 5: Process AI results
    const reviewResults = this.processAIResults(aiResponse, {
      uploadId,
      filename,
      s3Location
    })

    // Step 6: Store results
    await this.storeResults(reviewResults)
    logger.info({ uploadId }, 'Results stored')

    // Step 7: Notify user (optional)
    await this.notifyUser(uploadId, reviewResults)
    logger.info({ uploadId }, 'User notified')

    return reviewResults

  } catch (error) {
    logger.error({
      uploadId,
      error: error.message,
      stack: error.stack
    }, 'AI review failed')

    // Rethrow to trigger retry
    throw error
  }
}

// Helper: Download from S3
async downloadFileFromS3(s3Location) {
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3')

  // Parse S3 location: s3://bucket/key
  const match = s3Location.match(/s3:\/\/([^\/]+)\/(.+)/)
  if (!match) throw new Error('Invalid S3 location')

  const [, bucket, key] = match

  const s3Client = new S3Client({ region: config.get('s3.region') })
  const command = new GetObjectCommand({ Bucket: bucket, Key: key })

  const response = await s3Client.send(command)
  const chunks = []

  for await (const chunk of response.Body) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

// Helper: Extract text from different file types
async extractTextContent(fileBuffer, filename) {
  const ext = filename.split('.').pop().toLowerCase()

  switch (ext) {
    case 'pdf':
      return await this.extractFromPDF(fileBuffer)
    case 'docx':
    case 'doc':
      return await this.extractFromWord(fileBuffer)
    case 'txt':
      return fileBuffer.toString('utf-8')
    default:
      throw new Error(`Unsupported file type: ${ext}`)
  }
}

// Helper: Build AI prompt
buildAIPrompt(content, metadata) {
  return {
    system: 'You are an expert content reviewer. Analyze the following content and provide feedback.',
    user: content,
    context: metadata,
    instructions: [
      'Check for clarity',
      'Check for accuracy',
      'Identify potential issues',
      'Provide specific recommendations'
    ]
  }
}

// Helper: Call your AI service
async callAIService(prompt) {
  // Replace with your actual AI service
  // Examples: OpenAI, Anthropic, AWS Bedrock, Azure OpenAI, etc.

  const response = await fetch('https://your-ai-service.com/api/review', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.AI_API_KEY}`
    },
    body: JSON.stringify(prompt)
  })

  if (!response.ok) {
    throw new Error(`AI service error: ${response.statusText}`)
  }

  return await response.json()
}

// Helper: Process AI results
processAIResults(aiResponse, context) {
  return {
    uploadId: context.uploadId,
    filename: context.filename,
    s3Location: context.s3Location,
    reviewStatus: 'completed',
    score: aiResponse.score,
    feedback: aiResponse.feedback,
    recommendations: aiResponse.recommendations,
    flags: aiResponse.flags || [],
    processedAt: new Date().toISOString(),
    aiModel: aiResponse.model,
    confidence: aiResponse.confidence
  }
}

// Helper: Store results
async storeResults(results) {
  // Option 1: Store in MongoDB
  const db = await this.getDatabase()
  await db.collection('review_results').insertOne(results)

  // Option 2: Store in S3
  const s3Key = `results/${results.uploadId}.json`
  await this.uploadToS3(
    Buffer.from(JSON.stringify(results, null, 2)),
    s3Key
  )

  // Option 3: Store in both
}

// Helper: Notify user
async notifyUser(uploadId, results) {
  // Option 1: Webhook
  await fetch('https://your-app.com/api/webhook/review-complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, results })
  })

  // Option 2: Email
  // await sendEmail({ ... })

  // Option 3: Database update
  // await updateUserNotification({ ... })
}
```

## Required Dependencies for AI Integration

Add to `package.json`:

```json
{
  "dependencies": {
    "pdf-parse": "^1.1.1", // For PDF text extraction
    "mammoth": "^1.6.0", // For Word document extraction
    "openai": "^4.0.0", // If using OpenAI
    "@anthropic-ai/sdk": "^0.9.0" // If using Claude
  }
}
```

## Testing AI Integration

```javascript
// Add tests in sqs-worker.test.js
describe('AI Content Review', () => {
  it('should download file from S3', async () => {
    const buffer = await worker.downloadFileFromS3('s3://bucket/test.pdf')
    expect(buffer).toBeInstanceOf(Buffer)
  })

  it('should extract text from PDF', async () => {
    const text = await worker.extractTextContent(pdfBuffer, 'test.pdf')
    expect(text).toContain('expected content')
  })

  it('should call AI service', async () => {
    const result = await worker.callAIService(mockPrompt)
    expect(result).toHaveProperty('feedback')
  })

  it('should store results', async () => {
    await worker.storeResults(mockResults)
    // Verify storage
  })
})
```

---

# Appendix

## File Structure Summary

```
content-reviewer-backend/
├── src/
│   ├── config.js                          # Configuration (MODIFIED)
│   ├── server.js                          # Server startup (MODIFIED)
│   ├── common/
│   │   └── helpers/
│   │       ├── s3-uploader.js            # S3 upload helper (NEW)
│   │       ├── sqs-client.js             # SQS send helper (NEW)
│   │       └── sqs-worker.js             # SQS worker (NEW)
│   ├── routes/
│   │   ├── upload.js                      # Upload route (MODIFIED)
│   │   └── sqs-worker-status.js          # Status endpoint (NEW)
│   └── plugins/
│       └── router.js                      # Router config (MODIFIED)
├── test-sqs-worker.js                     # Node.js test script (NEW)
├── test-sqs-worker.ps1                    # PowerShell test script (NEW)
├── SQS_INTEGRATION.md                     # Integration guide (NEW)
├── TESTING_SQS_WORKER.md                  # Testing guide (NEW)
├── TESTING_QUICK_GUIDE.md                 # Quick reference (NEW)
├── SQS_WORKER_TESTING_SUMMARY.md          # Summary (NEW)
├── COMPLETE_SQS_INTEGRATION_GUIDE.md      # This file (NEW)
└── package.json                           # Dependencies (MODIFIED)
```

## Environment Variables Reference

| Variable                 | Required | Default                        | Description         |
| ------------------------ | -------- | ------------------------------ | ------------------- |
| `AWS_ACCESS_KEY_ID`      | Yes\*    | -                              | AWS access key      |
| `AWS_SECRET_ACCESS_KEY`  | Yes\*    | -                              | AWS secret key      |
| `AWS_REGION`             | No       | eu-west-2                      | AWS region          |
| `S3_BUCKET_NAME`         | No       | dev-service-optimisation-c63f2 | S3 bucket           |
| `S3_REGION`              | No       | eu-west-2                      | S3 region           |
| `SQS_QUEUE_URL`          | No       | (see config)                   | SQS queue URL       |
| `SQS_QUEUE_NAME`         | No       | content_review_status          | Queue name          |
| `SQS_REGION`             | No       | eu-west-2                      | SQS region          |
| `SQS_MAX_MESSAGES`       | No       | 10                             | Messages per poll   |
| `SQS_WAIT_TIME_SECONDS`  | No       | 20                             | Long polling time   |
| `SQS_VISIBILITY_TIMEOUT` | No       | 300                            | Message timeout     |
| `MOCK_S3_UPLOAD`         | No       | false                          | Mock S3 for testing |
| `SKIP_SQS_WORKER`        | No       | false                          | Disable worker      |
| `AWS_ENDPOINT`           | No       | -                              | LocalStack endpoint |
| `LOCALSTACK_ENDPOINT`    | No       | -                              | LocalStack endpoint |

\*Required unless in MOCK mode

## Quick Command Reference

```bash
# Installation
npm install

# Start server
npm run dev

# Test worker
node test-sqs-worker.js
.\test-sqs-worker.ps1

# Upload file
curl -X POST http://localhost:3001/api/upload -F "file=@test.pdf"

# Check status
curl http://localhost:3001/api/sqs-worker/status

# AWS CLI commands
aws s3 ls s3://dev-service-optimisation-c63f2
aws sqs get-queue-attributes --queue-url QUEUE_URL --attribute-names All
aws sqs receive-message --queue-url QUEUE_URL
aws sqs send-message --queue-url QUEUE_URL --message-body '{"test":"data"}'

# Environment
export AWS_ACCESS_KEY_ID=key
export AWS_SECRET_ACCESS_KEY=secret
export MOCK_S3_UPLOAD=true
export SKIP_SQS_WORKER=true
```

## Support & Contact

For questions or issues:

1. Check this documentation
2. Review error logs
3. Test with `test-sqs-worker.js`
4. Check AWS console for queue/bucket status
5. Contact development team

---

**End of Complete SQS Integration Guide**

Last updated: January 5, 2026  
Version: 1.0
