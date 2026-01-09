# LocalStack Setup Script for Podman (Simple Version)
# This script automates the setup of LocalStack for testing S3 uploads locally

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host " LocalStack Setup with Podman" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check if Podman is installed
Write-Host "[1/9] Checking Podman installation..." -ForegroundColor Blue
try {
    $podmanVersion = podman --version
    Write-Host "  [OK] $podmanVersion" -ForegroundColor Green
}
catch {
    Write-Host "  [ERROR] Podman not found." -ForegroundColor Red
    Write-Host "  Download from: https://podman-desktop.io/" -ForegroundColor Yellow
    exit 1
}

# 2. Check if AWS CLI is installed
Write-Host ""
Write-Host "[2/9] Checking AWS CLI installation..." -ForegroundColor Blue
$awsCliAvailable = $true
try {
    $awsVersion = aws --version 2>&1
    Write-Host "  [OK] AWS CLI installed" -ForegroundColor Green
}
catch {
    Write-Host "  [WARN] AWS CLI not found (optional for manual testing)" -ForegroundColor Yellow
    $awsCliAvailable = $false
}

# 3. Stop and remove existing LocalStack container
Write-Host ""
Write-Host "[3/9] Cleaning up existing LocalStack container..." -ForegroundColor Blue
podman rm -f localstack 2>$null | Out-Null
Write-Host "  [OK] Cleaned up" -ForegroundColor Green

# 4. Pull LocalStack image
Write-Host ""
Write-Host "[4/9] Pulling LocalStack image..." -ForegroundColor Blue
podman pull localstack/localstack:latest 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] Failed to pull LocalStack image" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] Image pulled successfully" -ForegroundColor Green

# 5. Start LocalStack
Write-Host ""
Write-Host "[5/9] Starting LocalStack container..." -ForegroundColor Blue
$result = podman run -d `
  --name localstack `
  -p 4566:4566 `
  -e SERVICES=s3,sqs `
  -e DEBUG=1 `
  -e AWS_DEFAULT_REGION=eu-west-2 `
  localstack/localstack:latest 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] Failed to start LocalStack" -ForegroundColor Red
    Write-Host $result -ForegroundColor Red
    exit 1
}

Write-Host "  [OK] LocalStack container started" -ForegroundColor Green

# 6. Wait for LocalStack to be ready
Write-Host ""
Write-Host "[6/9] Waiting for LocalStack to be ready..." -ForegroundColor Blue
$maxAttempts = 30
$attempt = 0
$isReady = $false

while ($attempt -lt $maxAttempts) {
    $health = $null
    try {
        $health = Invoke-RestMethod -Uri "http://localhost:4566/_localstack/health" -TimeoutSec 2 -ErrorAction Stop
        if ($health.services.s3 -eq "running") {
            Write-Host "  [OK] LocalStack is ready!" -ForegroundColor Green
            $isReady = $true
            break
        }
    }
    catch {
        # Still waiting
    }
    $attempt++
    Start-Sleep -Seconds 2
    Write-Host "  [WAIT] Waiting... ($attempt/$maxAttempts)" -ForegroundColor Yellow
}

if (-not $isReady) {
    Write-Host "  [ERROR] LocalStack failed to start within timeout" -ForegroundColor Red
    Write-Host ""
    Write-Host "Container logs:" -ForegroundColor Yellow
    podman logs localstack
    exit 1
}

# 7. Create S3 bucket
Write-Host ""
Write-Host "[7/9] Creating S3 bucket..." -ForegroundColor Blue
if ($awsCliAvailable) {
    $bucketResult = aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2 2>&1
    if ($LASTEXITCODE -eq 0 -or $bucketResult -like "*already exists*") {
        Write-Host "  [OK] Bucket ready: dev-service-optimisation-c63f2" -ForegroundColor Green
    }
    else {
        Write-Host "  [WARN] Could not create bucket: $bucketResult" -ForegroundColor Yellow
    }
}
else {
    Write-Host "  [SKIP] AWS CLI not available" -ForegroundColor Yellow
}

# 8. Create SQS queue (optional)
Write-Host ""
Write-Host "[8/9] Creating SQS queue..." -ForegroundColor Blue
if ($awsCliAvailable) {
    $queueResult = aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name content_review_status 2>&1
    if ($LASTEXITCODE -eq 0 -or $queueResult -like "*already exists*") {
        Write-Host "  [OK] Queue ready: content_review_status" -ForegroundColor Green
    }
    else {
        Write-Host "  [WARN] Could not create queue" -ForegroundColor Yellow
    }
}
else {
    Write-Host "  [SKIP] AWS CLI not available" -ForegroundColor Yellow
}

# 9. Configure .env
Write-Host ""
Write-Host "[9/9] Configuring .env file..." -ForegroundColor Blue

if (-not (Test-Path .env)) {
    if (Test-Path .env.example) {
        Copy-Item .env.example .env
        Write-Host "  [OK] Created .env from .env.example" -ForegroundColor Green
    }
    else {
        New-Item .env -ItemType File | Out-Null
        Write-Host "  [OK] Created new .env file" -ForegroundColor Green
    }
}

# Check if LocalStack config already exists
$envContent = Get-Content .env -Raw -ErrorAction SilentlyContinue
if ($envContent -notmatch "AWS_ENDPOINT") {
    $envConfig = @"

# ================================================
# LocalStack Configuration (Added by setup script)
# ================================================
AWS_ENDPOINT=http://localhost:4566
LOCALSTACK_ENDPOINT=http://localhost:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_REGION=eu-west-2

# S3 Configuration
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
UPLOAD_S3_PATH=content-uploads

# SQS Configuration
SQS_QUEUE_URL=http://localhost:4566/000000000000/content_review_status
SQS_REGION=eu-west-2

# Development Settings
NODE_ENV=development
LOG_LEVEL=debug

# Disable mock mode (use real LocalStack)
# MOCK_S3_UPLOAD=false
"@
    
    $envConfig | Add-Content .env
    Write-Host "  [OK] LocalStack configuration added to .env" -ForegroundColor Green
}
else {
    Write-Host "  [INFO] .env already contains AWS configuration" -ForegroundColor Cyan
}

# Summary
Write-Host ""
Write-Host "===============================================" -ForegroundColor Green
Write-Host " Setup Complete!" -ForegroundColor Green
Write-Host "===============================================" -ForegroundColor Green
Write-Host ""

Write-Host "What's running:" -ForegroundColor Cyan
Write-Host "  * Container: localstack" -ForegroundColor White
Write-Host "  * Endpoint: http://localhost:4566" -ForegroundColor White
Write-Host "  * Services: S3, SQS" -ForegroundColor White
Write-Host "  * Region: eu-west-2" -ForegroundColor White
Write-Host ""

Write-Host "S3 Resources:" -ForegroundColor Cyan
Write-Host "  * Bucket: dev-service-optimisation-c63f2" -ForegroundColor White
Write-Host "  * Path: content-uploads/" -ForegroundColor White
Write-Host ""

Write-Host "Next Steps:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Test AWS credentials:" -ForegroundColor Yellow
Write-Host "     node test-aws-credentials.js" -ForegroundColor White
Write-Host ""
Write-Host "  2. Start the backend:" -ForegroundColor Yellow
Write-Host "     npm start" -ForegroundColor White
Write-Host ""
Write-Host "  3. Start the frontend (in another terminal):" -ForegroundColor Yellow
Write-Host "     cd ..\content-reviewer-frontend" -ForegroundColor White
Write-Host "     npm start" -ForegroundColor White
Write-Host ""
Write-Host "  4. Open browser:" -ForegroundColor Yellow
Write-Host "     http://localhost:3000" -ForegroundColor White
Write-Host ""

if ($awsCliAvailable) {
    Write-Host "Quick Tests:" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  * List S3 buckets:" -ForegroundColor Yellow
    Write-Host "    aws --endpoint-url=http://localhost:4566 s3 ls" -ForegroundColor White
    Write-Host ""
    Write-Host "  * View uploaded files:" -ForegroundColor Yellow
    Write-Host "    aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive" -ForegroundColor White
    Write-Host ""
}

Write-Host "Useful Commands:" -ForegroundColor Cyan
Write-Host "  * View logs:  podman logs -f localstack" -ForegroundColor White
Write-Host "  * Stop:       podman stop localstack" -ForegroundColor White
Write-Host "  * Start:      podman start localstack" -ForegroundColor White
Write-Host "  * Restart:    podman restart localstack" -ForegroundColor White
Write-Host "  * Remove:     podman rm -f localstack" -ForegroundColor White
Write-Host ""

Write-Host "Documentation:" -ForegroundColor Cyan
Write-Host "  * PODMAN_LOCALSTACK_SETUP.md - Detailed guide" -ForegroundColor White
Write-Host "  * LOCALSTACK_QUICK_REF.md - Quick reference" -ForegroundColor White
Write-Host "  * AWS_SETUP_GUIDE.md - AWS configuration" -ForegroundColor White
Write-Host ""

Write-Host "===============================================" -ForegroundColor Green
Write-Host " Happy testing with LocalStack and Podman!" -ForegroundColor Green
Write-Host "===============================================" -ForegroundColor Green
Write-Host ""
