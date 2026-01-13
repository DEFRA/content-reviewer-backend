# CDP Environment Variables Configuration

## Overview

This document specifies the environment variables required for the Content Reviewer AI backend service to function in the CDP environment.

## Required Environment Variables

### 1. AWS SQS Configuration (CONFIRMED)

```bash
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status
```

**Details:**

- Queue Name: `content_review_status`
- Region: `eu-west-2`
- ARN: `arn:aws:sqs:eu-west-2:332499610595:content_review_status`

**Purpose:** Used for async review job processing. The backend submits review jobs to this queue, and the SQS worker processes them.

---

### 2. MongoDB Configuration (PENDING - Request from Colleague)

**Required variables:**

```bash
MONGODB_URI=mongodb://[host]:[port]/content-reviewer
MONGODB_DB_NAME=content-reviewer
```

**What to request from your colleague:**

- MongoDB connection string (URI)
- Database name (if different from `content-reviewer`)
- Any authentication credentials if needed
- MongoDB instance hostname/IP and port

**Purpose:** Stores review results, history, and metadata for all content reviews.

---

### 3. AWS S3 Configuration (Check if Already Set)

**Expected variables (may already be configured via CDP IAM):**

```bash
S3_BUCKET=cdp-content-reviewer-uploads
```

**Purpose:** Stores uploaded files (PDF, DOCX) before processing.

**Note:** If not set, the backend will use the default bucket name `cdp-content-reviewer-uploads`. Verify this bucket exists in your AWS account.

---

### 4. Alternative: Mock Mode (For Testing Only)

If MongoDB is not yet available, you can test with mock mode:

```bash
MOCK_MONGODB=true
```

**⚠️ WARNING:** This stores reviews in memory only (lost on restart). Use ONLY for initial testing.

---

## Complete Environment Variable List

### For Production (Full Deployment)

```bash
# MongoDB (REQUIRED - pending details)
MONGODB_URI=mongodb://[TBD]:[TBD]/content-reviewer
MONGODB_DB_NAME=content-reviewer

# SQS (CONFIRMED)
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status

# S3 (Optional - defaults to cdp-content-reviewer-uploads)
S3_BUCKET=cdp-content-reviewer-uploads

# AWS Region (if not auto-detected)
AWS_REGION=eu-west-2
```

### For Testing (Without MongoDB)

```bash
# Mock Mode
MOCK_MONGODB=true

# SQS (CONFIRMED)
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status

# S3 (Optional)
S3_BUCKET=cdp-content-reviewer-uploads

# AWS Region
AWS_REGION=eu-west-2
```

---

## How to Add Environment Variables in CDP

### Method 1: CDP Portal (Web UI)

1. Log in to CDP Portal
2. Navigate to your service: `content-reviewer-backend`
3. Go to **Configuration** → **Environment Variables**
4. Add each variable:
   - Click **Add Variable**
   - Enter **Key** (e.g., `SQS_QUEUE_URL`)
   - Enter **Value** (e.g., `https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status`)
   - Save
5. **Redeploy** the service to apply changes

### Method 2: CDP CLI (Command Line)

```bash
# Add SQS Queue URL
cdp env set SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status

# Add MongoDB URI (once received)
cdp env set MONGODB_URI=mongodb://[host]:[port]/content-reviewer
cdp env set MONGODB_DB_NAME=content-reviewer

# Redeploy
cdp service redeploy content-reviewer-backend
```

### Method 3: Configuration File (if supported)

Update your service's `app-config.yaml` or equivalent:

```yaml
environment:
  SQS_QUEUE_URL: https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status
  MONGODB_URI: mongodb://[host]:[port]/content-reviewer
  MONGODB_DB_NAME: content-reviewer
  AWS_REGION: eu-west-2
```

---

## IAM Permissions Required

Ensure the CDP service role has these permissions:

### SQS Permissions

```json
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
```

### S3 Permissions

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::cdp-content-reviewer-uploads/*"
}
```

### Bedrock Permissions (Already Working)

```json
{
  "Effect": "Allow",
  "Action": ["bedrock:InvokeModel"],
  "Resource": "arn:aws:bedrock:eu-west-2::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0"
}
```

---

## Verification Steps

After adding environment variables and redeploying:

### 1. Run the Test Script

```powershell
.\test-cdp-no-mongodb.ps1
```

### 2. Expected Results (With MongoDB)

```
✅ TEST 1: Health Check - PASS
✅ TEST 2: Bedrock Integration - PASS
✅ TEST 3: Review Endpoints Registration - PASS
✅ TEST 4: Worker Status - PASS
✅ TEST 5: Submit Text Review - PASS (returns reviewId)
```

### 3. Check Logs

```bash
# View backend logs in CDP
cdp logs content-reviewer-backend --tail 100

# Look for:
# - "MongoDB connected successfully"
# - "SQS worker started"
# - "Review queued successfully"
```

---

## Troubleshooting

### Error: "cannot find configuration param 'mongodb.uri'"

**Solution:** Add `MONGODB_URI` environment variable and redeploy.

### Error: "Failed to connect to MongoDB"

**Possible causes:**

- Wrong MongoDB URI
- Network/firewall blocking connection
- MongoDB not running
- Authentication failed

**Solution:** Verify MongoDB URI, credentials, and network access.

### Error: "SQS queue not found"

**Solution:** Verify `SQS_QUEUE_URL` is correct and the service has IAM permissions.

### Reviews not processing

**Check:**

1. SQS worker is running (check logs for "SQS worker started")
2. Messages are being sent to queue (check SQS in AWS Console)
3. Worker can access Bedrock (should already work based on tests)
4. MongoDB is accessible (worker needs to save results)

---

## Current Status

| Component             | Status     | Notes                                   |
| --------------------- | ---------- | --------------------------------------- |
| Backend Deployment    | ✅ Working | Deployed successfully to CDP            |
| Bedrock Integration   | ✅ Working | Claude responding correctly             |
| Review Endpoints      | ✅ Working | Routes registered and accessible        |
| SQS Configuration     | ⚠️ Pending | URL confirmed, needs to be added to CDP |
| MongoDB Configuration | ⚠️ Pending | Waiting for connection details          |
| S3 Configuration      | ❓ Unknown | May already be configured via IAM       |

---

## Next Actions

1. ✅ **SQS Queue URL confirmed** - Ready to add to CDP
2. ⏳ **Waiting for MongoDB details** from colleague
3. ⏳ **Add environment variables** to CDP once MongoDB details received
4. ⏳ **Redeploy service** to apply configuration
5. ⏳ **Run test script** to verify full functionality

---

## Contact

**For MongoDB Details:**

- Contact: [Your colleague's name/team]
- What to request: MongoDB URI, database name, credentials (if required)

**For CDP Configuration:**

- CDP Portal: [Your CDP portal URL]
- CDP Support: [Support contact]

**For Questions:**

- Backend Developer: [Your name/team]
- AWS Resources: Platform team

---

## References

- SQS Queue: `content_review_status`
- SQS URL: `https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status`
- Service Name: `content-reviewer-backend`
- Test Script: `test-cdp-no-mongodb.ps1`
- Backend Docs: `ASYNC-REVIEW-SYSTEM.md`, `CDP-TESTING-GUIDE.md`

---

**Last Updated:** January 13, 2026
