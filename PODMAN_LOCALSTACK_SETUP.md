# LocalStack with Podman - Local S3 Testing Guide

This guide shows you how to test S3 file uploads locally using Podman and LocalStack, without connecting to real AWS services.

## What is LocalStack?

LocalStack is a fully functional local AWS cloud stack that emulates AWS services (S3, SQS, DynamoDB, etc.) on your local machine. Perfect for development and testing!

---

## Prerequisites

- ✅ Podman Desktop installed
- ✅ Podman CLI installed
- ✅ Node.js and npm installed

---

## Quick Start (5 Minutes)

### Step 1: Start LocalStack with Podman

```powershell
# Pull LocalStack image
podman pull localstack/localstack:latest

# Run LocalStack
podman run -d `
  --name localstack `
  -p 4566:4566 `
  -p 4510-4559:4510-4559 `
  -e SERVICES=s3,sqs `
  -e DEBUG=1 `
  -e DATA_DIR=/tmp/localstack/data `
  localstack/localstack:latest

# Verify it's running
podman ps
```

**Expected output:**
```
CONTAINER ID  IMAGE                              COMMAND     CREATED        STATUS        PORTS                   NAMES
abc123def456  localstack/localstack:latest       ...         5 seconds ago  Up 5 seconds  0.0.0.0:4566->4566/tcp  localstack
```

### Step 2: Configure AWS CLI for LocalStack

```powershell
# Set LocalStack endpoint
$env:AWS_ENDPOINT_URL = "http://localhost:4566"

# Configure AWS CLI with dummy credentials (LocalStack doesn't validate them)
aws configure set aws_access_key_id test
aws configure set aws_secret_access_key test
aws configure set region eu-west-2
aws configure set output json
```

### Step 3: Create S3 Bucket in LocalStack

```powershell
# Create the bucket
aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2

# Verify bucket was created
aws --endpoint-url=http://localhost:4566 s3 ls

# Expected output:
# 2026-01-08 10:30:00 dev-service-optimisation-c63f2
```

### Step 4: Configure Backend for LocalStack

Create or update your `.env` file:

```powershell
# Copy example if not exists
if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
}

# Add LocalStack configuration
@"

# LocalStack Configuration
AWS_ENDPOINT=http://localhost:4566
LOCALSTACK_ENDPOINT=http://localhost:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_REGION=eu-west-2

# S3 Configuration
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
UPLOAD_S3_PATH=content-uploads

# SQS Configuration (optional)
SQS_QUEUE_URL=http://localhost:4566/000000000000/content_review_status
SQS_REGION=eu-west-2

# Development
NODE_ENV=development
LOG_LEVEL=debug
"@ | Add-Content .env

Write-Host "✅ .env configured for LocalStack" -ForegroundColor Green
```

### Step 5: Test the Setup

```powershell
# Test credentials
node test-aws-credentials.js

# Start the backend
npm start
```

### Step 6: Upload a Test File

In a new PowerShell terminal:

```powershell
# Create a test file
"This is a test document for S3 upload." | Out-File test-upload.txt

# Upload via API
curl -X POST http://localhost:3001/upload `
  -F "file=@test-upload.txt"

# Verify file in LocalStack
aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive
```

**Expected output:**
```json
{
  "success": true,
  "uploadId": "abc-123-def",
  "filename": "test-upload.txt",
  "s3Location": "s3://dev-service-optimisation-c63f2/content-uploads/abc-123-def/test-upload.txt"
}
```

---

## Complete Podman Commands Reference

### Managing LocalStack Container

```powershell
# Start LocalStack
podman run -d `
  --name localstack `
  -p 4566:4566 `
  -e SERVICES=s3,sqs `
  -e DEBUG=1 `
  localstack/localstack:latest

# Stop LocalStack
podman stop localstack

# Start existing container
podman start localstack

# Restart LocalStack
podman restart localstack

# Remove container
podman rm localstack

# View logs
podman logs localstack

# Follow logs in real-time
podman logs -f localstack

# Check container status
podman ps -a | Select-String localstack
```

### Persistent Data (Optional)

To keep LocalStack data between restarts:

```powershell
# Create a local directory for data
New-Item -ItemType Directory -Path "$env:USERPROFILE\localstack-data" -Force

# Run with volume mount
podman run -d `
  --name localstack `
  -p 4566:4566 `
  -e SERVICES=s3,sqs `
  -e DEBUG=1 `
  -e DATA_DIR=/tmp/localstack/data `
  -v "${env:USERPROFILE}\localstack-data:/tmp/localstack/data" `
  localstack/localstack:latest
```

---

## S3 Operations with LocalStack

### Create Bucket
```powershell
aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2
```

### List Buckets
```powershell
aws --endpoint-url=http://localhost:4566 s3 ls
```

### List Files in Bucket
```powershell
aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive
```

### Upload File Manually
```powershell
aws --endpoint-url=http://localhost:4566 s3 cp test-file.pdf s3://dev-service-optimisation-c63f2/content-uploads/
```

### Download File
```powershell
aws --endpoint-url=http://localhost:4566 s3 cp s3://dev-service-optimisation-c63f2/content-uploads/test-file.pdf ./downloaded-file.pdf
```

### Delete File
```powershell
aws --endpoint-url=http://localhost:4566 s3 rm s3://dev-service-optimisation-c63f2/content-uploads/test-file.pdf
```

### Delete Bucket
```powershell
aws --endpoint-url=http://localhost:4566 s3 rb s3://dev-service-optimisation-c63f2 --force
```

---

## SQS Setup (Optional)

If you want to test SQS message queue functionality:

```powershell
# Create SQS queue
aws --endpoint-url=http://localhost:4566 sqs create-queue `
  --queue-name content_review_status

# Get queue URL (copy this to your .env)
aws --endpoint-url=http://localhost:4566 sqs list-queues

# Send test message
aws --endpoint-url=http://localhost:4566 sqs send-message `
  --queue-url http://localhost:4566/000000000000/content_review_status `
  --message-body "Test message"

# Receive messages
aws --endpoint-url=http://localhost:4566 sqs receive-message `
  --queue-url http://localhost:4566/000000000000/content_review_status
```

---

## Testing with Frontend and Backend

### Complete Local Setup

**Terminal 1 - LocalStack:**
```powershell
podman run -d --name localstack -p 4566:4566 -e SERVICES=s3,sqs localstack/localstack:latest
aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2
```

**Terminal 2 - Backend:**
```powershell
cd "c:\Users\2065580\OneDrive - Cognizant\DEFRA\Service Optimisation\AI Content Review\content-reviewer-backend"
npm start
```

**Terminal 3 - Frontend:**
```powershell
cd "c:\Users\2065580\OneDrive - Cognizant\DEFRA\Service Optimisation\AI Content Review\content-reviewer-frontend"
npm start
```

**Browser:**
1. Open http://localhost:3000
2. Upload a file via the web interface
3. Watch the Review History update
4. Verify file in LocalStack:
   ```powershell
   aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive
   ```

---

## Troubleshooting

### Issue: "Connection refused" when connecting to LocalStack

**Check if LocalStack is running:**
```powershell
podman ps | Select-String localstack
```

**Check LocalStack logs:**
```powershell
podman logs localstack
```

**Restart LocalStack:**
```powershell
podman restart localstack
```

### Issue: "Bucket does not exist"

**Create the bucket:**
```powershell
aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2
```

**Verify bucket exists:**
```powershell
aws --endpoint-url=http://localhost:4566 s3 ls
```

### Issue: Backend can't connect to LocalStack

**Check .env configuration:**
```powershell
Get-Content .env | Select-String -Pattern "AWS_ENDPOINT|LOCALSTACK"
```

**Should show:**
```
AWS_ENDPOINT=http://localhost:4566
LOCALSTACK_ENDPOINT=http://localhost:4566
```

**Test connection:**
```powershell
curl http://localhost:4566/_localstack/health
```

### Issue: Port 4566 already in use

**Find and stop the conflicting process:**
```powershell
netstat -ano | findstr :4566
# Note the PID and stop it, or use a different port:

podman run -d --name localstack -p 4567:4566 localstack/localstack:latest
# Then update .env: AWS_ENDPOINT=http://localhost:4567
```

### Issue: Podman Desktop shows container but it's not responding

**Check container status:**
```powershell
podman ps -a
```

**Check logs for errors:**
```powershell
podman logs localstack
```

**Remove and recreate:**
```powershell
podman rm -f localstack
podman run -d --name localstack -p 4566:4566 -e SERVICES=s3,sqs localstack/localstack:latest
```

---

## LocalStack Web UI

LocalStack Pro includes a web UI, but the free version can be monitored using:

```powershell
# Check health
curl http://localhost:4566/_localstack/health | ConvertFrom-Json

# Check S3 service
curl http://localhost:4566/_localstack/health | ConvertFrom-Json | Select-Object -ExpandProperty services
```

---

## Podman Compose (Alternative Method)

You can also use Podman Compose with your existing `compose.yml`:

### Update compose.yml

Create a new file `compose.localstack.yml`:

```yaml
version: '3.8'

services:
  localstack:
    container_name: localstack
    image: localstack/localstack:latest
    ports:
      - "4566:4566"
      - "4510-4559:4510-4559"
    environment:
      - SERVICES=s3,sqs
      - DEBUG=1
      - DATA_DIR=/tmp/localstack/data
      - AWS_DEFAULT_REGION=eu-west-2
    volumes:
      - "${USERPROFILE}/localstack-data:/tmp/localstack/data"
```

### Run with Podman Compose

```powershell
# Install podman-compose if not already installed
pip install podman-compose

# Start LocalStack
podman-compose -f compose.localstack.yml up -d

# Stop LocalStack
podman-compose -f compose.localstack.yml down

# View logs
podman-compose -f compose.localstack.yml logs -f
```

---

## Automated Setup Script

Create a file `setup-localstack.ps1`:

```powershell
# LocalStack Setup Script for Podman

Write-Host "`n🚀 Setting up LocalStack with Podman...`n" -ForegroundColor Cyan

# 1. Check if Podman is installed
Write-Host "1️⃣  Checking Podman installation..." -ForegroundColor Blue
try {
    $podmanVersion = podman --version
    Write-Host "   ✓ $podmanVersion" -ForegroundColor Green
} catch {
    Write-Host "   ✗ Podman not found. Please install Podman Desktop." -ForegroundColor Red
    exit 1
}

# 2. Stop and remove existing LocalStack container
Write-Host "`n2️⃣  Cleaning up existing LocalStack container..." -ForegroundColor Blue
podman rm -f localstack 2>$null
Write-Host "   ✓ Cleaned up" -ForegroundColor Green

# 3. Pull LocalStack image
Write-Host "`n3️⃣  Pulling LocalStack image..." -ForegroundColor Blue
podman pull localstack/localstack:latest
Write-Host "   ✓ Image pulled" -ForegroundColor Green

# 4. Start LocalStack
Write-Host "`n4️⃣  Starting LocalStack..." -ForegroundColor Blue
podman run -d `
  --name localstack `
  -p 4566:4566 `
  -e SERVICES=s3,sqs `
  -e DEBUG=1 `
  -e AWS_DEFAULT_REGION=eu-west-2 `
  localstack/localstack:latest

Start-Sleep -Seconds 5
Write-Host "   ✓ LocalStack started" -ForegroundColor Green

# 5. Wait for LocalStack to be ready
Write-Host "`n5️⃣  Waiting for LocalStack to be ready..." -ForegroundColor Blue
$maxAttempts = 30
$attempt = 0
while ($attempt -lt $maxAttempts) {
    try {
        $health = Invoke-RestMethod -Uri "http://localhost:4566/_localstack/health" -ErrorAction Stop
        if ($health.services.s3 -eq "running") {
            Write-Host "   ✓ LocalStack is ready!" -ForegroundColor Green
            break
        }
    } catch {
        # Still waiting
    }
    $attempt++
    Start-Sleep -Seconds 2
    Write-Host "   ⏳ Waiting... ($attempt/$maxAttempts)" -ForegroundColor Yellow
}

if ($attempt -eq $maxAttempts) {
    Write-Host "   ✗ LocalStack failed to start" -ForegroundColor Red
    podman logs localstack
    exit 1
}

# 6. Create S3 bucket
Write-Host "`n6️⃣  Creating S3 bucket..." -ForegroundColor Blue
aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2 2>$null
Write-Host "   ✓ Bucket created: dev-service-optimisation-c63f2" -ForegroundColor Green

# 7. Create SQS queue
Write-Host "`n7️⃣  Creating SQS queue..." -ForegroundColor Blue
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name content_review_status 2>$null
Write-Host "   ✓ Queue created: content_review_status" -ForegroundColor Green

# 8. Configure .env
Write-Host "`n8️⃣  Configuring .env file..." -ForegroundColor Blue
if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
}

$envConfig = @"

# LocalStack Configuration (Podman)
AWS_ENDPOINT=http://localhost:4566
LOCALSTACK_ENDPOINT=http://localhost:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_REGION=eu-west-2
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
UPLOAD_S3_PATH=content-uploads
SQS_QUEUE_URL=http://localhost:4566/000000000000/content_review_status
SQS_REGION=eu-west-2
NODE_ENV=development
LOG_LEVEL=debug
"@

$envConfig | Add-Content .env
Write-Host "   ✓ .env configured" -ForegroundColor Green

# 9. Summary
Write-Host "`n✅ LocalStack Setup Complete!`n" -ForegroundColor Green
Write-Host "📋 What's running:" -ForegroundColor Cyan
Write-Host "   • LocalStack: http://localhost:4566" -ForegroundColor White
Write-Host "   • S3 Bucket: dev-service-optimisation-c63f2" -ForegroundColor White
Write-Host "   • SQS Queue: content_review_status`n" -ForegroundColor White

Write-Host "🚀 Next steps:" -ForegroundColor Cyan
Write-Host "   1. Test credentials: node test-aws-credentials.js" -ForegroundColor Yellow
Write-Host "   2. Start backend: npm start" -ForegroundColor Yellow
Write-Host "   3. Start frontend: cd ../content-reviewer-frontend && npm start`n" -ForegroundColor Yellow

Write-Host "🧪 Test S3 upload:" -ForegroundColor Cyan
Write-Host '   "Test content" | Out-File test.txt' -ForegroundColor White
Write-Host '   curl -X POST http://localhost:3001/upload -F "file=@test.txt"' -ForegroundColor White
Write-Host '   aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive' -ForegroundColor White
Write-Host ""
```

**Run the script:**
```powershell
.\setup-localstack.ps1
```

---

## Summary

With Podman and LocalStack, you can:

✅ Test S3 uploads without AWS account  
✅ Test SQS message queues locally  
✅ Develop offline  
✅ Avoid AWS costs during development  
✅ Reset environment easily  

**Simple workflow:**
1. `podman run -d --name localstack -p 4566:4566 -e SERVICES=s3,sqs localstack/localstack:latest`
2. `aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2`
3. Update `.env` with LocalStack endpoint
4. `npm start`
5. Upload files via frontend or API
6. Verify with `aws --endpoint-url=http://localhost:4566 s3 ls ...`

🎉 **You're ready to test S3 uploads locally with Podman!**
