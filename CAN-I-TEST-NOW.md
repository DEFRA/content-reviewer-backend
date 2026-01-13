# Testing Guide - S3-Based Backend

## Can I Test Now?

### ✅ YES - Local Testing (If you have AWS credentials)

**Requirements:**

- AWS credentials configured
- Access to S3 bucket: `dev-service-optimisation-c63f2`
- Access to SQS queue: `content_review_status`
- Access to Bedrock in `eu-west-2`

**To test locally:**

```powershell
# 1. Set environment variables
$env:S3_BUCKET = "dev-service-optimisation-c63f2"
$env:SQS_QUEUE_URL = "https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status"
$env:AWS_REGION = "eu-west-2"

# 2. Start the backend
npm run dev

# 3. In another terminal, test endpoints
curl http://localhost:3001/health
curl -X POST http://localhost:3001/api/review/text -H "Content-Type: application/json" -d '{"content":"Test document for GOV.UK review","title":"Test"}'
```

### ⚠️ NO - CDP Testing (Needs deployment first)

**You need to complete these steps first:**

1. ✅ Code changes (DONE)
2. ⏳ Commit and push code
3. ⏳ Set environment variables in CDP
4. ⏳ Deploy to CDP
5. ⏳ Then test with `test-cdp-s3-based.ps1`

---

## 🧪 Local Testing (Full Guide)

### Prerequisites Check

```powershell
# Check if AWS CLI is configured
aws sts get-caller-identity

# Check S3 bucket access
aws s3 ls s3://dev-service-optimisation-c63f2/

# Check SQS queue access
aws sqs get-queue-attributes --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status --attribute-names All
```

If all commands work, you're ready to test locally!

### Start Backend Locally

```powershell
# Navigate to backend directory
cd backend

# Set environment variables
$env:S3_BUCKET = "dev-service-optimisation-c63f2"
$env:SQS_QUEUE_URL = "https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status"
$env:AWS_REGION = "eu-west-2"
$env:PORT = "3001"

# Install dependencies (if needed)
npm install

# Start the server
npm run dev
```

### Test Locally

**Terminal 1: Backend running**

```
Server started on http://localhost:3001
Review repository initialized with S3
```

**Terminal 2: Run tests**

```powershell
# Test 1: Health check
Invoke-RestMethod -Uri "http://localhost:3001/health" -Method GET

# Test 2: Submit review
$body = @{
    content = "This is a test document for GOV.UK content review using S3 storage."
    title = "Local Test"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "http://localhost:3001/api/review/text" -Method POST -Headers @{"Content-Type"="application/json"} -Body $body

Write-Host "Review ID: $($response.reviewId)"

# Test 3: Check S3 for the review
aws s3 ls s3://dev-service-optimisation-c63f2/reviews/ --recursive

# Test 4: Get review status (use the reviewId from step 2)
$reviewId = $response.reviewId
Invoke-RestMethod -Uri "http://localhost:3001/api/review/$reviewId" -Method GET
```

### Expected Local Test Results

```
✅ Health check: {"message":"success"}
✅ Submit review: {"success":true,"reviewId":"review_...","status":"pending"}
✅ S3 listing: reviews/2026/01/13/review_....json
✅ Get review: {"success":true,"review":{"id":"review_...","status":"pending",...}}
```

---

## 🚀 CDP Testing (After Deployment)

### Step 1: Deploy (Required)

```powershell
# Commit changes
git add .
git commit -m "Switch to S3-based review storage"
git push

# Then in CDP Portal:
# 1. Add environment variables:
#    - S3_BUCKET=dev-service-optimisation-c63f2
#    - SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status
#    - AWS_REGION=eu-west-2
# 2. Trigger deployment
# 3. Wait for completion
```

### Step 2: Test CDP

```powershell
# Copy test script to your Defra laptop
# Update the API key at the top
# Run the test
.\test-cdp-s3-based.ps1
```

### Expected CDP Test Results

```
✅ TEST 1: Health Check - PASS
✅ TEST 2: Bedrock Integration - PASS
✅ TEST 3: Review Endpoints Registration - PASS
✅ TEST 4: Submit Text Review - PASS
✅ TEST 5: Get Review Status - PASS
✅ TEST 6: Get Review History - PASS
```

---

## 🔍 What Can You Test Right Now?

### ✅ If You Have AWS Credentials Locally:

**You can test RIGHT NOW:**

1. Backend starts successfully
2. S3 connection works
3. Review submission works
4. Review storage in S3 works
5. Review retrieval works

**You CANNOT test yet:**

1. SQS worker processing (need to run worker separately)
2. Bedrock AI integration (unless you have Bedrock access locally)
3. Full end-to-end flow (submit → process → complete)

### ⚠️ If You Don't Have AWS Credentials Locally:

**You need to:**

1. Deploy to CDP first
2. Then test using the CDP endpoint

---

## 🎯 Recommendation

### Option 1: Quick Local Smoke Test (5 minutes)

Test if the code changes work:

```powershell
# Try to start the backend
cd backend
$env:S3_BUCKET = "dev-service-optimisation-c63f2"
$env:AWS_REGION = "eu-west-2"
npm run dev
```

**If it starts without errors:** ✅ Code changes are good!  
**If it errors:** ❌ Need to fix before deploying

### Option 2: Full Testing in CDP (Recommended)

Since CDP already has:

- ✅ AWS credentials configured
- ✅ Bedrock access working
- ✅ All permissions set up

**Best approach:**

1. Deploy to CDP (10 minutes)
2. Test everything there with `test-cdp-s3-based.ps1`
3. Get full end-to-end testing

---

## 🚦 Current Status

| Component             | Local          | CDP                   |
| --------------------- | -------------- | --------------------- |
| Code Changes          | ✅ Done        | ⏳ Need to deploy     |
| S3 Config             | ✅ Done        | ⏳ Need to deploy     |
| Environment Variables | ⏳ Need to set | ⏳ Need to set        |
| AWS Credentials       | ❓ Depends     | ✅ Available          |
| Bedrock Access        | ❓ Depends     | ✅ Working            |
| **Can Test Now?**     | **Maybe**      | **NO - Deploy first** |

---

## ✨ Summary

**Direct Answer to Your Question:**

🔴 **NO - Not full functionality in CDP yet**  
You need to deploy first, then you can test everything.

🟡 **MAYBE - Partial testing locally**  
If you have AWS credentials locally, you can test S3 storage works.

🟢 **YES - After deployment**  
Once deployed to CDP with environment variables set, you can test FULL functionality.

---

## 🎯 Next Step

**I recommend:** Deploy to CDP, then test everything there.

**Why?**

- CDP already has Bedrock working
- CDP has all AWS permissions
- CDP is your target environment anyway
- Faster than setting up local AWS credentials

**How long?**

- Deploy: ~10 minutes
- Test: ~2 minutes
- **Total: ~12 minutes to full testing**

---

**Want me to help with the deployment steps?**
