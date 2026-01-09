# Quick Commands to Verify S3 Uploads in LocalStack

## Check if LocalStack is Running

```powershell
# Check container status
& "C:\Program Files\RedHat\Podman\podman.exe" ps | Select-String localstack

# Check LocalStack health
curl http://localhost:4566/_localstack/health
```

## List S3 Buckets

```powershell
# If you have AWS CLI installed:
aws --endpoint-url=http://localhost:4566 s3 ls

# Or using curl:
curl http://localhost:4566/dev-service-optimisation-c63f2
```

## List Files in Your Bucket

```powershell
# Using AWS CLI (recommended):
aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive

# Or list specific folder:
aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/
```

## Using Podman Desktop

1. Open **Podman Desktop**
2. Go to **Containers** tab
3. Find **localstack** container
4. Click on it to see details
5. Click **Logs** tab to see S3 upload activity

## Using Podman CLI to Check Logs

```powershell
# View live logs (shows S3 uploads in real-time)
& "C:\Program Files\RedHat\Podman\podman.exe" logs -f localstack

# View last 50 lines
& "C:\Program Files\RedHat\Podman\podman.exe" logs --tail 50 localstack

# Search for S3 PUT operations
& "C:\Program Files\RedHat\Podman\podman.exe" logs localstack | Select-String "PUT"
```

## Using PowerShell to Check S3 via API

```powershell
# List objects in bucket (REST API)
$response = Invoke-RestMethod -Uri "http://localhost:4566/dev-service-optimisation-c63f2?list-type=2&prefix=content-uploads/" -Method Get
$response | ConvertTo-Json

# Or simpler:
curl "http://localhost:4566/dev-service-optimisation-c63f2?list-type=2&prefix=content-uploads/"
```

## Verify After Upload

After uploading a file via the frontend:

```powershell
# 1. Check backend logs for upload confirmation
# (Look for S3Uploader messages)

# 2. List files in LocalStack
aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive

# 3. Download a file to verify (replace with actual path)
aws --endpoint-url=http://localhost:4566 s3 cp s3://dev-service-optimisation-c63f2/content-uploads/YOUR-UPLOAD-ID/filename.pdf ./downloaded.pdf
```

## Install AWS CLI (if not installed)

```powershell
# Using winget
winget install Amazon.AWSCLI

# Or download from:
# https://aws.amazon.com/cli/

# After install, restart PowerShell and test:
aws --version
```

## Quick Test Script

Save as `test-s3.ps1`:

```powershell
Write-Host "Testing LocalStack S3..." -ForegroundColor Cyan

# Check LocalStack
Write-Host "`n1. Checking LocalStack..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod http://localhost:4566/_localstack/health
    Write-Host "   Status: $($health.services.s3)" -ForegroundColor Green
} catch {
    Write-Host "   LocalStack not responding!" -ForegroundColor Red
    exit
}

# List buckets
Write-Host "`n2. Listing S3 buckets..." -ForegroundColor Yellow
$buckets = aws --endpoint-url=http://localhost:4566 s3 ls 2>&1
Write-Host $buckets

# List files
Write-Host "`n3. Listing uploaded files..." -ForegroundColor Yellow
$files = aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive 2>&1
if ($files) {
    Write-Host $files -ForegroundColor Green
} else {
    Write-Host "   No files uploaded yet" -ForegroundColor Yellow
}

Write-Host "`nDone!" -ForegroundColor Green
```

Run with: `.\test-s3.ps1`

## Watch for Uploads in Real-Time

```powershell
# Terminal 1: Watch LocalStack logs
& "C:\Program Files\RedHat\Podman\podman.exe" logs -f localstack | Select-String "PUT|POST"

# Terminal 2: Start backend (if not running)
npm start

# Terminal 3: Start frontend
cd ..\content-reviewer-frontend
npm start

# Then upload a file via browser and watch Terminal 1 for activity
```
