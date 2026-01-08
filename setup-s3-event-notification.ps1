# S3 Event Notification Setup Script for AWS
# This script configures S3 to automatically send event notifications to SQS

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  S3 Event Notification Setup" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Configuration
$BUCKET_NAME = "dev-service-optimisation-c63f2"
$QUEUE_URL = "https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status"
$QUEUE_ARN = "arn:aws:sqs:eu-west-2:332499610595:content_review_status"
$AWS_REGION = "eu-west-2"

Write-Host "Configuration:" -ForegroundColor Yellow
Write-Host "  S3 Bucket:  $BUCKET_NAME" -ForegroundColor White
Write-Host "  SQS Queue:  content_review_status" -ForegroundColor White
Write-Host "  Queue ARN:  $QUEUE_ARN" -ForegroundColor White
Write-Host "  Region:     $AWS_REGION`n" -ForegroundColor White

# Step 1: Check AWS CLI
Write-Host "[Step 1/5] Checking AWS CLI..." -ForegroundColor Cyan
$awsVersion = aws --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ AWS CLI not found. Please install AWS CLI first." -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ AWS CLI found: $awsVersion" -ForegroundColor Green

# Step 2: Verify AWS credentials
Write-Host "`n[Step 2/5] Verifying AWS credentials..." -ForegroundColor Cyan
$identity = aws sts get-caller-identity 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ AWS credentials not configured" -ForegroundColor Red
    Write-Host "  Please configure AWS credentials using:" -ForegroundColor Yellow
    Write-Host "    aws configure" -ForegroundColor White
    Write-Host "  Or set AWS_PROFILE environment variable" -ForegroundColor White
    exit 1
}
Write-Host "  ✓ AWS credentials verified" -ForegroundColor Green

# Step 3: Update SQS Queue Policy
Write-Host "`n[Step 3/5] Updating SQS Queue Policy..." -ForegroundColor Cyan
Write-Host "  Granting S3 permission to send messages to SQS..." -ForegroundColor White

# Read the policy file
$policyContent = Get-Content -Path "sqs-queue-policy.json" -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10

# Update queue attributes
$result = aws sqs set-queue-attributes `
    --queue-url $QUEUE_URL `
    --attributes "{`"Policy`":$($policyContent -replace '"', '\"')}" `
    --region $AWS_REGION 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ Failed to update SQS queue policy" -ForegroundColor Red
    Write-Host "  Error: $result" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ SQS queue policy updated successfully" -ForegroundColor Green

# Step 4: Configure S3 Event Notification
Write-Host "`n[Step 4/5] Configuring S3 Event Notification..." -ForegroundColor Cyan
Write-Host "  Setting up S3 to send events to SQS..." -ForegroundColor White

$notificationResult = aws s3api put-bucket-notification-configuration `
    --bucket $BUCKET_NAME `
    --notification-configuration file://s3-notification-config.json `
    --region $AWS_REGION 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ Failed to configure S3 event notification" -ForegroundColor Red
    Write-Host "  Error: $notificationResult" -ForegroundColor Red
    Write-Host "`n  Possible causes:" -ForegroundColor Yellow
    Write-Host "    • Insufficient permissions" -ForegroundColor White
    Write-Host "    • SQS queue policy not yet propagated (wait 30 seconds and retry)" -ForegroundColor White
    Write-Host "    • S3 bucket doesn't exist or is in a different region" -ForegroundColor White
    exit 1
}
Write-Host "  ✓ S3 event notification configured successfully" -ForegroundColor Green

# Step 5: Verify Configuration
Write-Host "`n[Step 5/5] Verifying Configuration..." -ForegroundColor Cyan

# Verify SQS Queue Policy
Write-Host "  Checking SQS queue policy..." -ForegroundColor White
$queuePolicy = aws sqs get-queue-attributes `
    --queue-url $QUEUE_URL `
    --attribute-names Policy `
    --region $AWS_REGION 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ SQS queue policy verified" -ForegroundColor Green
} else {
    Write-Host "  ✗ Could not verify SQS queue policy" -ForegroundColor Red
}

# Verify S3 Notification Configuration
Write-Host "  Checking S3 notification configuration..." -ForegroundColor White
$s3Notification = aws s3api get-bucket-notification-configuration `
    --bucket $BUCKET_NAME `
    --region $AWS_REGION 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ S3 notification configuration verified" -ForegroundColor Green
} else {
    Write-Host "  ✗ Could not verify S3 notification configuration" -ForegroundColor Red
}

# Success Summary
Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  ✓ Setup Completed Successfully!" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green

Write-Host "Configuration Summary:" -ForegroundColor Yellow
Write-Host "  • S3 Bucket: $BUCKET_NAME" -ForegroundColor White
Write-Host "  • Event Type: s3:ObjectCreated:*" -ForegroundColor White
Write-Host "  • Filter Prefix: content-uploads/" -ForegroundColor White
Write-Host "  • SQS Queue: content_review_status" -ForegroundColor White
Write-Host "  • Queue URL: $QUEUE_URL`n" -ForegroundColor White

Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host "  1. Test the integration:" -ForegroundColor White
Write-Host "     .\test-s3-event-trigger.ps1`n" -ForegroundColor Cyan
Write-Host "  2. Update SQS worker to handle S3 event messages" -ForegroundColor White
Write-Host "     See: src/common/helpers/sqs-worker.js`n" -ForegroundColor Cyan
Write-Host "  3. Optionally remove manual SQS call from upload route" -ForegroundColor White
Write-Host "     See: src/routes/upload.js`n" -ForegroundColor Cyan

Write-Host "Event Flow:" -ForegroundColor Yellow
Write-Host "  Upload file → S3 → Event → SQS → Worker → AI Review`n" -ForegroundColor White

Write-Host "Monitoring:" -ForegroundColor Yellow
Write-Host "  Check SQS queue messages:" -ForegroundColor White
Write-Host "  aws sqs receive-message --queue-url $QUEUE_URL --max-number-of-messages 1`n" -ForegroundColor Cyan

Write-Host "Documentation:" -ForegroundColor Yellow
Write-Host "  See S3_EVENT_NOTIFICATION_SETUP.md for detailed guide`n" -ForegroundColor White
