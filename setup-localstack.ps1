# LocalStack Setup Script for Podman
# This script automates the setup of LocalStack for testing S3 uploads locally

Write-Host "`n🚀 Setting up LocalStack with Podman...`n" -ForegroundColor Cyan

# 1. Check if Podman is installed
Write-Host "1️⃣  Checking Podman installation..." -ForegroundColor Blue
try {
    $podmanVersion = podman --version
    Write-Host "   ✓ $podmanVersion" -ForegroundColor Green
} catch {
    Write-Host "   ✗ Podman not found. Please install Podman Desktop." -ForegroundColor Red
    Write-Host "   Download from: https://podman-desktop.io/" -ForegroundColor Yellow
    exit 1
}

# 2. Check if AWS CLI is installed
Write-Host "`n2️⃣  Checking AWS CLI installation..." -ForegroundColor Blue
try {
    $awsVersion = aws --version
    Write-Host "   ✓ AWS CLI installed" -ForegroundColor Green
} catch {
    Write-Host "   ⚠️  AWS CLI not found (optional for manual testing)" -ForegroundColor Yellow
    Write-Host "   Install from: https://aws.amazon.com/cli/" -ForegroundColor Yellow
}

# 3. Stop and remove existing LocalStack container
Write-Host "`n3️⃣  Cleaning up existing LocalStack container..." -ForegroundColor Blue
podman rm -f localstack 2>$null | Out-Null
Write-Host "   ✓ Cleaned up" -ForegroundColor Green

# 4. Pull LocalStack image
Write-Host "`n4️⃣  Pulling LocalStack image..." -ForegroundColor Blue
podman pull localstack/localstack:latest
if ($LASTEXITCODE -ne 0) {
    Write-Host "   ✗ Failed to pull LocalStack image" -ForegroundColor Red
    exit 1
}
Write-Host "   ✓ Image pulled successfully" -ForegroundColor Green

# 5. Start LocalStack
Write-Host "`n5️⃣  Starting LocalStack container..." -ForegroundColor Blue
podman run -d `
  --name localstack `
  -p 4566:4566 `
  -e SERVICES=s3,sqs `
  -e DEBUG=1 `
  -e AWS_DEFAULT_REGION=eu-west-2 `
  localstack/localstack:latest

if ($LASTEXITCODE -ne 0) {
    Write-Host "   ✗ Failed to start LocalStack" -ForegroundColor Red
    exit 1
}

Write-Host "   ✓ LocalStack container started" -ForegroundColor Green

# 6. Wait for LocalStack to be ready
Write-Host "`n6️⃣  Waiting for LocalStack to be ready..." -ForegroundColor Blue
$maxAttempts = 30
$attempt = 0
$isReady = $false

while ($attempt -lt $maxAttempts) {
    $health = $null
    try {
        $health = Invoke-RestMethod -Uri "http://localhost:4566/_localstack/health" -TimeoutSec 2 -ErrorAction Stop
        if ($health.services.s3 -eq "running") {
            Write-Host "   [OK] LocalStack is ready!" -ForegroundColor Green
            $isReady = $true
            break
        }
    }
    catch {
        # Still waiting
    }
    $attempt++
    Start-Sleep -Seconds 2
    Write-Host "   [WAIT] Waiting... ($attempt/$maxAttempts)" -ForegroundColor Yellow
}

if (-not $isReady) {
    Write-Host "   ✗ LocalStack failed to start within timeout" -ForegroundColor Red
    Write-Host "`nContainer logs:" -ForegroundColor Yellow
    podman logs localstack
    exit 1
}

# 7. Create S3 bucket
Write-Host "`n7️⃣  Creating S3 bucket..." -ForegroundColor Blue
$bucketResult = aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2 2>&1
if ($LASTEXITCODE -eq 0 -or $bucketResult -like "*already exists*") {
    Write-Host "   ✓ Bucket ready: dev-service-optimisation-c63f2" -ForegroundColor Green
} else {
    Write-Host "   ⚠️  Bucket creation skipped (AWS CLI not available)" -ForegroundColor Yellow
    Write-Host "   You can create it manually later" -ForegroundColor Yellow
}

# 8. Create SQS queue (Standard)
Write-Host "`n8️⃣  Creating SQS queue..." -ForegroundColor Blue
$queueResult = aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name content_review_status --region eu-west-2 2>&1
if ($LASTEXITCODE -eq 0 -or $queueResult -like "*already exists*") {
    Write-Host "   ✓ Queue ready: content_review_status" -ForegroundColor Green
} else {
    Write-Host "   ⚠️  Queue creation skipped (AWS CLI not available)" -ForegroundColor Yellow
}

# 9. Configure S3 Event Notification (NEW - Event-driven architecture)
Write-Host "`n9  Configuring S3 Event Notification..." -ForegroundColor Blue

# s3-notification-localstack.json file should already exist
# Apply S3 event notification
$s3NotifyResult = aws --endpoint-url=http://localhost:4566 s3api put-bucket-notification-configuration --bucket dev-service-optimisation-c63f2 --notification-configuration file://s3-notification-localstack.json 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host "   OK S3 event notification configured" -ForegroundColor Green
    Write-Host "   -> S3 uploads will automatically trigger SQS messages" -ForegroundColor Cyan
} else {
    Write-Host "   WARNING S3 event notification configuration skipped" -ForegroundColor Yellow
    Write-Host "   (Manual SQS calls from backend will still work)" -ForegroundColor White
}

# Verify S3 notification configuration
$verifyResult = aws --endpoint-url=http://localhost:4566 s3api get-bucket-notification-configuration --bucket dev-service-optimisation-c63f2 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "   OK S3 event notification verified" -ForegroundColor Green
}

# 10. Configure .env
Write-Host "`n10 Configuring .env file..." -ForegroundColor Blue

if (-not (Test-Path .env)) {
    if (Test-Path .env.example) {
        Copy-Item .env.example .env
        Write-Host "   ✓ Created .env from .env.example" -ForegroundColor Green
    } else {
        New-Item .env -ItemType File | Out-Null
        Write-Host "   ✓ Created new .env file" -ForegroundColor Green
    }
}

# Check if LocalStack config already exists
$envContent = Get-Content .env -Raw
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
SQS_QUEUE_NAME=content_review_status
SQS_REGION=eu-west-2

# Development Settings
NODE_ENV=development
LOG_LEVEL=debug

# Disable mock mode (use real LocalStack)
# MOCK_S3_UPLOAD=false

# S3 Event Trigger Mode
# Set to 'true' to use S3 automatic event notifications (recommended)
# Set to 'false' to use manual SQS calls from upload route
S3_EVENT_TRIGGER_ENABLED=true
"@
    
    $envConfig | Add-Content .env
    Write-Host "   ✓ LocalStack configuration added to .env" -ForegroundColor Green
} else {
    Write-Host "   ℹ️  .env already contains AWS configuration" -ForegroundColor Cyan
}

# 11. Summary
Write-Host "`n" -NoNewline
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "✅ LocalStack Setup Complete!" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""

Write-Host "📋 What's running:" -ForegroundColor Cyan
Write-Host "   • Container: localstack" -ForegroundColor White
Write-Host "   • Endpoint: http://localhost:4566" -ForegroundColor White
Write-Host "   • Services: S3, SQS" -ForegroundColor White
Write-Host "   • Region: eu-west-2" -ForegroundColor White
Write-Host ""

Write-Host "🪣 S3 Resources:" -ForegroundColor Cyan
Write-Host "   • Bucket: dev-service-optimisation-c63f2" -ForegroundColor White
Write-Host "   • Path: content-uploads/" -ForegroundColor White
Write-Host "   • Event: Automatic S3 → SQS trigger enabled ⚡" -ForegroundColor Green
Write-Host ""

Write-Host "📬 SQS Resources:" -ForegroundColor Cyan
Write-Host "   • Queue: content_review_status (Standard)" -ForegroundColor White
Write-Host ""

Write-Host "⚡ Event-Driven Architecture:" -ForegroundColor Cyan
Write-Host "   Upload → S3 → Auto Event → SQS → Worker → Bedrock AI" -ForegroundColor Yellow
Write-Host ""

Write-Host "🚀 Next Steps:" -ForegroundColor Cyan
Write-Host ""
Write-Host "   1. Test AWS credentials:" -ForegroundColor Yellow
Write-Host "      node test-aws-credentials.js" -ForegroundColor White
Write-Host ""
Write-Host "   2. Start the backend:" -ForegroundColor Yellow
Write-Host "      npm start" -ForegroundColor White
Write-Host ""
Write-Host "   3. Start the frontend (in another terminal):" -ForegroundColor Yellow
Write-Host "      cd ..\content-reviewer-frontend" -ForegroundColor White
Write-Host "      npm start" -ForegroundColor White
Write-Host ""
Write-Host "   4. Open browser:" -ForegroundColor Yellow
Write-Host "      http://localhost:3000" -ForegroundColor White
Write-Host ""

Write-Host "🧪 Quick Tests:" -ForegroundColor Cyan
Write-Host ""
Write-Host "   • Check LocalStack health:" -ForegroundColor Yellow
Write-Host "     curl http://localhost:4566/_localstack/health" -ForegroundColor White
Write-Host ""
Write-Host "   • List S3 buckets:" -ForegroundColor Yellow
Write-Host "     aws --endpoint-url=http://localhost:4566 s3 ls" -ForegroundColor White
Write-Host ""
Write-Host "   • Upload test file:" -ForegroundColor Yellow
Write-Host "     `"Test`" | Out-File test.txt" -ForegroundColor White
Write-Host "     curl -X POST http://localhost:3001/upload -F `"file=@test.txt`"" -ForegroundColor White
Write-Host ""
Write-Host "   • View uploaded files:" -ForegroundColor Yellow
Write-Host "     aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive" -ForegroundColor White
Write-Host ""

Write-Host "🛠️  Useful Commands:" -ForegroundColor Cyan
Write-Host ""
Write-Host "   • View logs:     " -NoNewline -ForegroundColor Yellow
Write-Host "podman logs -f localstack" -ForegroundColor White
Write-Host "   • Stop:          " -NoNewline -ForegroundColor Yellow
Write-Host "podman stop localstack" -ForegroundColor White
Write-Host "   • Start:         " -NoNewline -ForegroundColor Yellow
Write-Host "podman start localstack" -ForegroundColor White
Write-Host "   • Restart:       " -NoNewline -ForegroundColor Yellow
Write-Host "podman restart localstack" -ForegroundColor White
Write-Host "   • Remove:        " -NoNewline -ForegroundColor Yellow
Write-Host "podman rm -f localstack" -ForegroundColor White
Write-Host ""

Write-Host "📚 Documentation:" -ForegroundColor Cyan
Write-Host "   • PODMAN_LOCALSTACK_SETUP.md - Detailed guide" -ForegroundColor White
Write-Host "   • QUICK_START.md - Quick start guide" -ForegroundColor White
Write-Host "   • AWS_SETUP_GUIDE.md - AWS configuration" -ForegroundColor White
Write-Host ""

Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "🎉 Happy testing with LocalStack and Podman!" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
