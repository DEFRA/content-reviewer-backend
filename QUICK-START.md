# Quick Start Guide - Async Review System

## Prerequisites

- Node.js 24+ installed
- MongoDB running (local or remote)
- AWS credentials configured (for Bedrock, S3, SQS)
- Backend dependencies installed (`npm install`)

---

## 1. Start the Backend

```powershell
cd backend
npm run dev
```

The server will start on `http://localhost:3001`

You should see:

```
[INFO] Server started
[INFO] SQS Worker started
[INFO] Bedrock client initialized
```

---

## 2. Test the System

### Quick Test (Automated)

```powershell
.\test-async-review.ps1
```

This will run all tests automatically and show results.

### Manual Test

**Submit a text review:**

```powershell
$body = @{
  content = "This is a test content for GOV.UK review. The content should be clear, concise, and follow plain English principles. It should be accessible to all users and meet WCAG standards."
  title = "Test GOV.UK Content"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "http://localhost:3001/api/review/text" `
  -Method Post -Body $body -ContentType "application/json"

Write-Host "Review ID: $($response.reviewId)"
$reviewId = $response.reviewId
```

**Check status (poll until complete):**

```powershell
# Poll every 3 seconds until complete
do {
  Start-Sleep -Seconds 3
  $status = Invoke-RestMethod -Uri "http://localhost:3001/api/review/$reviewId"
  Write-Host "Status: $($status.review.status)"

  if ($status.review.status -eq "completed") {
    Write-Host "`n=== REVIEW RESULT ===" -ForegroundColor Green
    Write-Host $status.review.result.reviewContent
    break
  }
  elseif ($status.review.status -eq "failed") {
    Write-Host "Review failed: $($status.review.error)" -ForegroundColor Red
    break
  }
} while ($true)
```

**Upload a file:**

```powershell
# Replace with your actual PDF/DOCX file path
$filePath = "C:\path\to\your\document.pdf"

if (Test-Path $filePath) {
  $response = Invoke-RestMethod -Uri "http://localhost:3001/api/review/file" `
    -Method Post -Form @{file=Get-Item $filePath}

  Write-Host "Review ID: $($response.reviewId)"

  # Then poll for status using the reviewId (same as above)
}
```

**View review history:**

```powershell
$history = Invoke-RestMethod -Uri "http://localhost:3001/api/reviews?limit=10"
$history.reviews | Format-Table id, status, fileName, @{Name="Created";Expression={$_.createdAt}}
```

---

## 3. What to Expect

### Immediate Response (< 1 second)

When you submit a review, you get:

```json
{
  "success": true,
  "reviewId": "review_1234567890_abc123",
  "status": "pending",
  "message": "Review queued for processing"
}
```

### Processing Status

Poll `/api/review/:id` to see:

- **pending** → Just queued
- **processing** → Worker is processing
- **completed** → Review ready! ✅
- **failed** → Something went wrong ❌

### Review Result

When completed, you get a comprehensive review:

```
**Overall Assessment**
The content demonstrates good clarity and structure...

**Strengths**
- Clear, concise language
- Good use of headings
- Accessible formatting

**Areas for Improvement**
1. Consider breaking long sentences...
2. Use active voice...

**Priority Actions**
1. Simplify technical terms
2. Add more white space
3. Improve accessibility

**Rating**
- Clarity: 8/10
- Structure: 7/10
- Accessibility: 9/10
- GOV.UK Style: 8/10
- Overall: 8/10
```

---

## 4. Check Health

### Backend Health

```powershell
Invoke-RestMethod -Uri "http://localhost:3001/health"
```

Expected response:

```json
{
  "status": "ok",
  "service": "content-reviewer-backend"
}
```

### SQS Worker Status

```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/sqs-worker/status"
```

Expected response:

```json
{
  "worker": {
    "running": true,
    "queueUrl": "...",
    "region": "eu-west-2"
  }
}
```

### MongoDB Check

Check if reviews are being stored:

```powershell
# Using MongoDB Compass or mongo shell
use content_reviewer
db.content_reviews.find().pretty()
```

---

## 5. View Logs

The backend logs everything in structured JSON format:

```powershell
# Backend logs show in the terminal
# Look for:
[INFO] Review created: reviewId=review_123...
[INFO] Sending request to Bedrock...
[INFO] Review completed successfully
```

---

## 6. Troubleshooting

### Backend Won't Start

**Check MongoDB:**

```powershell
# Is MongoDB running?
Test-NetConnection localhost -Port 27017
```

**Check Environment Variables:**

```powershell
# Are AWS credentials set?
$env:AWS_PROFILE
$env:BEDROCK_INFERENCE_PROFILE_ARN
$env:S3_BUCKET
$env:SQS_QUEUE_URL
```

### Reviews Stuck in "Pending"

**Check SQS Worker:**

```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/sqs-worker/status"
```

If not running:

- Check backend logs for worker errors
- Verify SQS queue URL is correct
- Check AWS credentials

**Check SQS Queue:**
Go to AWS Console → SQS → Your Queue

- Are messages visible?
- Any messages in flight?
- Any dead letter queue messages?

### Text Extraction Fails

**Verify File Type:**

- Only PDF, DOCX, and TXT supported
- Check file is not corrupted
- Try a different file

**Check Logs:**
Look for extraction errors in backend logs

### Bedrock Errors

**Check Credentials:**

```powershell
aws bedrock-runtime list-foundation-models --region eu-west-2
```

**Check Inference Profile:**

```powershell
# Verify ARN is correct
$env:BEDROCK_INFERENCE_PROFILE_ARN
```

**Check Guardrail:**

```powershell
# Verify guardrail ARN
$env:BEDROCK_GUARDRAIL_ARN
```

---

## 7. Common Commands

### Start Backend

```powershell
npm run dev          # Development with watch
npm start           # Production
```

### Run Tests

```powershell
.\test-async-review.ps1    # Full test suite
npm test                   # Unit tests
```

### Check Code Quality

```powershell
npm run lint              # Check code style
npm run lint:fix          # Auto-fix issues
npm run format            # Format code
```

### View Logs

```powershell
# Logs are in console (development)
# In production, check CloudWatch Logs
```

---

## 8. API Endpoints Summary

| Method | Endpoint                 | Purpose                  |
| ------ | ------------------------ | ------------------------ |
| POST   | `/api/review/file`       | Submit file for review   |
| POST   | `/api/review/text`       | Submit text for review   |
| GET    | `/api/review/:id`        | Get review status/result |
| GET    | `/api/reviews`           | Get review history       |
| GET    | `/health`                | Backend health check     |
| GET    | `/api/sqs-worker/status` | Worker status            |

---

## 9. File Types Supported

- **PDF** (`.pdf`) - Extracted with pdf-parse
- **Word** (`.docx`) - Extracted with mammoth
- **Text** (`.txt`) - Direct UTF-8
- **Max Size:** 10MB

---

## 10. Expected Processing Times

- **Text reviews:** 10-30 seconds
- **PDF extraction + review:** 20-40 seconds
- **DOCX extraction + review:** 15-35 seconds

_Times depend on content length and Bedrock response time_

---

## 11. Next Steps

1. ✅ Start backend: `npm run dev`
2. ✅ Run tests: `.\test-async-review.ps1`
3. ✅ Submit a test review
4. ✅ Verify it completes successfully
5. 📱 Integrate with frontend
6. 🚀 Deploy to CDP

---

## Need Help?

1. **Check Documentation:**
   - `ASYNC-REVIEW-SYSTEM.md` - Technical details
   - `FRONTEND-INTEGRATION.md` - Frontend guide
   - `IMPLEMENTATION-SUMMARY.md` - Overview

2. **Check Logs:**
   - Backend console (structured JSON logs)
   - CloudWatch Logs (production)
   - MongoDB records

3. **Test Endpoints:**
   - Use test scripts
   - Check health endpoints
   - Verify worker status

---

## Success! 🎉

If you can:

- ✅ Submit a review (file or text)
- ✅ See status change from pending → processing → completed
- ✅ View the review result
- ✅ See review in history

Then the system is working correctly! 🚀

Now you can integrate the frontend and deploy to production.
