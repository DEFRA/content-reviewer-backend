# LocalStack Setup Script for Podman Desktop on Windows
# Works with Podman Machine using named pipes

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host " LocalStack Setup with Podman Desktop" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

# Set Podman executable path
$podmanExe = "$env:ProgramFiles\RedHat\Podman\podman.exe"
if (-not (Test-Path $podmanExe)) {
    Write-Host "[ERROR] Podman not found at: $podmanExe" -ForegroundColor Red
    Write-Host "Please install Podman Desktop from: https://podman-desktop.io/" -ForegroundColor Yellow
    exit 1
}

# Helper function to run podman commands
function Invoke-Podman {
    param([string]$Arguments)
    $cmd = "& `"$podmanExe`" $Arguments"
    Invoke-Expression $cmd
}

# 1. Check Podman installation
Write-Host "[1/9] Checking Podman installation..." -ForegroundColor Blue
try {
    $podmanVersion = & $podmanExe --version
    Write-Host "  [OK] $podmanVersion" -ForegroundColor Green
}
catch {
    Write-Host "  [ERROR] Podman not accessible" -ForegroundColor Red
    exit 1
}

# 2. Check if Podman machine is running
Write-Host ""
Write-Host "[2/9] Checking Podman machine status..." -ForegroundColor Blue
$machineList = & $podmanExe machine list 2>&1
if ($machineList -like "*Currently running*" -or $machineList -like "*running*") {
    Write-Host "  [OK] Podman machine is running" -ForegroundColor Green
}
else {
    Write-Host "  [WARN] Podman machine may not be running" -ForegroundColor Yellow
    Write-Host "  Starting Podman machine..." -ForegroundColor Yellow
    & $podmanExe machine start 2>&1 | Out-Null
    Start-Sleep -Seconds 5
    Write-Host "  [OK] Podman machine started" -ForegroundColor Green
}

# 3. Check if AWS CLI is installed
Write-Host ""
Write-Host "[3/9] Checking AWS CLI installation..." -ForegroundColor Blue
$awsCliAvailable = $true
try {
    $awsVersion = aws --version 2>&1
    Write-Host "  [OK] AWS CLI installed" -ForegroundColor Green
}
catch {
    Write-Host "  [WARN] AWS CLI not found (optional for manual testing)" -ForegroundColor Yellow
    $awsCliAvailable = $false
}

# 4. Stop and remove existing LocalStack container
Write-Host ""
Write-Host "[4/9] Cleaning up existing LocalStack container..." -ForegroundColor Blue
& $podmanExe rm -f localstack 2>&1 | Out-Null
Write-Host "  [OK] Cleaned up" -ForegroundColor Green

# 5. Pull LocalStack image
Write-Host ""
Write-Host "[5/9] Pulling LocalStack image (this may take a minute)..." -ForegroundColor Blue
$pullResult = & $podmanExe pull localstack/localstack:latest 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] Failed to pull LocalStack image" -ForegroundColor Red
    Write-Host $pullResult -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] Image pulled successfully" -ForegroundColor Green

# 6. Start LocalStack
Write-Host ""
Write-Host "[6/9] Starting LocalStack container..." -ForegroundColor Blue
$runResult = & $podmanExe run -d `
  --name localstack `
  -p 4566:4566 `
  -e SERVICES=s3,sqs `
  -e DEBUG=1 `
  -e AWS_DEFAULT_REGION=eu-west-2 `
  localstack/localstack:latest 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] Failed to start LocalStack" -ForegroundColor Red
    Write-Host $runResult -ForegroundColor Red
    exit 1
}

Write-Host "  [OK] LocalStack container started" -ForegroundColor Green
Write-Host "  Container ID: $($runResult | Select-Object -First 1)" -ForegroundColor Gray

# 7. Wait for LocalStack to be ready
Write-Host ""
Write-Host "[7/9] Waiting for LocalStack to be ready..." -ForegroundColor Blue
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
    if ($attempt % 5 -eq 0) {
        Write-Host "  [WAIT] Waiting... ($attempt/$maxAttempts)" -ForegroundColor Yellow
    }
}

if (-not $isReady) {
    Write-Host "  [ERROR] LocalStack failed to start within timeout" -ForegroundColor Red
    Write-Host ""
    Write-Host "Container logs:" -ForegroundColor Yellow
    & $podmanExe logs localstack
    exit 1
}

# 8. Create S3 bucket
Write-Host ""
Write-Host "[8/9] Creating S3 bucket..." -ForegroundColor Blue
if ($awsCliAvailable) {
    Start-Sleep -Seconds 2  # Give LocalStack a moment to fully initialize
    $bucketResult = aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2 2>&1
    if ($LASTEXITCODE -eq 0 -or $bucketResult -like "*already exists*") {
        Write-Host "  [OK] Bucket ready: dev-service-optimisation-c63f2" -ForegroundColor Green
    }
    else {
        Write-Host "  [WARN] Could not create bucket (will be created on first upload)" -ForegroundColor Yellow
        Write-Host "  $bucketResult" -ForegroundColor Gray
    }
    
    # Create SQS queue
    Write-Host ""
    Write-Host "  Creating SQS queue..." -ForegroundColor Blue
    $queueResult = aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name content_review_status 2>&1
    if ($LASTEXITCODE -eq 0 -or $queueResult -like "*already exists*") {
        Write-Host "  [OK] Queue ready: content_review_status" -ForegroundColor Green
    }
    else {
        Write-Host "  [WARN] Could not create queue" -ForegroundColor Yellow
    }
}
else {
    Write-Host "  [SKIP] AWS CLI not available - bucket will be created on first upload" -ForegroundColor Yellow
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
if ($envContent -notmatch "AWS_ENDPOINT.*localhost:4566") {
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

# CORS (allow frontend)
CORS_ORIGIN=["http://localhost:3000"]

# Disable mock mode (use real LocalStack)
# MOCK_S3_UPLOAD=false
"@
    
    $envConfig | Add-Content .env
    Write-Host "  [OK] LocalStack configuration added to .env" -ForegroundColor Green
}
else {
    Write-Host "  [INFO] .env already contains LocalStack configuration" -ForegroundColor Cyan
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
Write-Host "  * Podman: npipe://\\.\pipe\podman-machine-default" -ForegroundColor Gray
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
Write-Host "     Start-Process http://localhost:3000" -ForegroundColor White
Write-Host ""

if ($awsCliAvailable) {
    Write-Host "Quick Tests:" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  * Check LocalStack health:" -ForegroundColor Yellow
    Write-Host "    curl http://localhost:4566/_localstack/health" -ForegroundColor White
    Write-Host ""
    Write-Host "  * List S3 buckets:" -ForegroundColor Yellow
    Write-Host "    aws --endpoint-url=http://localhost:4566 s3 ls" -ForegroundColor White
    Write-Host ""
    Write-Host "  * View uploaded files:" -ForegroundColor Yellow
    Write-Host "    aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive" -ForegroundColor White
    Write-Host ""
}

Write-Host "Useful Podman Commands:" -ForegroundColor Cyan
Write-Host "  * View logs:     `"$podmanExe`" logs -f localstack" -ForegroundColor White
Write-Host "  * Stop:          `"$podmanExe`" stop localstack" -ForegroundColor White
Write-Host "  * Start:         `"$podmanExe`" start localstack" -ForegroundColor White
Write-Host "  * Restart:       `"$podmanExe`" restart localstack" -ForegroundColor White
Write-Host "  * Remove:        `"$podmanExe`" rm -f localstack" -ForegroundColor White
Write-Host "  * List:          `"$podmanExe`" ps -a" -ForegroundColor White
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
