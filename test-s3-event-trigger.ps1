# Test S3 Event Trigger
# This script tests the S3 event notification by uploading a file and checking SQS

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  S3 Event Notification Test" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Configuration
$BUCKET_NAME = "dev-service-optimisation-c63f2"
$QUEUE_URL = "https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status"
$AWS_REGION = "eu-west-2"
$TEST_FILE = "test-event-trigger.txt"
$S3_KEY = "content-uploads/test-event-trigger-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt"

Write-Host "Test Configuration:" -ForegroundColor Yellow
Write-Host "  S3 Bucket: $BUCKET_NAME" -ForegroundColor White
Write-Host "  S3 Key: $S3_KEY" -ForegroundColor White
Write-Host "  SQS Queue: $QUEUE_URL`n" -ForegroundColor White

# Step 1: Create test file
Write-Host "[Step 1/4] Creating test file..." -ForegroundColor Cyan
$testContent = @"
S3 Event Notification Test File
================================
Created: $(Get-Date)
Purpose: Testing S3 → SQS event notification
Bucket: $BUCKET_NAME
Key: $S3_KEY

This file tests the automatic event notification from S3 to SQS.
When this file is uploaded to S3, it should trigger an event that
sends a message to the SQS queue for processing.
"@

Set-Content -Path $TEST_FILE -Value $testContent
Write-Host "  ✓ Test file created: $TEST_FILE" -ForegroundColor Green

# Step 2: Check current SQS message count
Write-Host "`n[Step 2/4] Checking current SQS queue state..." -ForegroundColor Cyan
$beforeAttributes = aws sqs get-queue-attributes `
    --queue-url $QUEUE_URL `
    --attribute-names ApproximateNumberOfMessages `
    --region $AWS_REGION 2>&1 | ConvertFrom-Json

if ($LASTEXITCODE -eq 0) {
    $messagesBefore = $beforeAttributes.Attributes.ApproximateNumberOfMessages
    Write-Host "  ✓ Messages in queue before upload: $messagesBefore" -ForegroundColor Green
} else {
    Write-Host "  ⚠ Could not get queue state" -ForegroundColor Yellow
    $messagesBefore = "unknown"
}

# Step 3: Upload file to S3
Write-Host "`n[Step 3/4] Uploading file to S3..." -ForegroundColor Cyan
$uploadResult = aws s3 cp $TEST_FILE "s3://$BUCKET_NAME/$S3_KEY" --region $AWS_REGION 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ Failed to upload file to S3" -ForegroundColor Red
    Write-Host "  Error: $uploadResult" -ForegroundColor Red
    Remove-Item -Path $TEST_FILE -Force
    exit 1
}
Write-Host "  ✓ File uploaded successfully" -ForegroundColor Green
Write-Host "  Location: s3://$BUCKET_NAME/$S3_KEY" -ForegroundColor White

# Step 4: Wait and check for SQS message
Write-Host "`n[Step 4/4] Waiting for S3 event notification..." -ForegroundColor Cyan
Write-Host "  Please wait 5 seconds for event propagation..." -ForegroundColor White

Start-Sleep -Seconds 5

# Check SQS for new messages
Write-Host "  Checking SQS queue for event message..." -ForegroundColor White
$message = aws sqs receive-message `
    --queue-url $QUEUE_URL `
    --max-number-of-messages 1 `
    --wait-time-seconds 5 `
    --region $AWS_REGION 2>&1

if ($LASTEXITCODE -eq 0) {
    $messageData = $message | ConvertFrom-Json
    
    if ($messageData.Messages) {
        Write-Host "`n  ✓ SUCCESS! S3 event message received in SQS" -ForegroundColor Green
        
        # Parse message body
        $messageBody = $messageData.Messages[0].Body | ConvertFrom-Json
        
        Write-Host "`n  Event Details:" -ForegroundColor Yellow
        if ($messageBody.Records) {
            # S3 event format
            $s3Event = $messageBody.Records[0]
            Write-Host "    Event Type: $($s3Event.eventName)" -ForegroundColor White
            Write-Host "    Event Time: $($s3Event.eventTime)" -ForegroundColor White
            Write-Host "    S3 Bucket:  $($s3Event.s3.bucket.name)" -ForegroundColor White
            Write-Host "    S3 Key:     $($s3Event.s3.object.key)" -ForegroundColor White
            Write-Host "    File Size:  $($s3Event.s3.object.size) bytes" -ForegroundColor White
        } else {
            # Application message format
            Write-Host "    Upload ID:  $($messageBody.uploadId)" -ForegroundColor White
            Write-Host "    Filename:   $($messageBody.filename)" -ForegroundColor White
            Write-Host "    S3 Bucket:  $($messageBody.s3Bucket)" -ForegroundColor White
            Write-Host "    S3 Key:     $($messageBody.s3Key)" -ForegroundColor White
        }
        
        Write-Host "`n  Full Message Body:" -ForegroundColor Yellow
        Write-Host "  $($messageData.Messages[0].Body)" -ForegroundColor Gray
        
        # Ask if user wants to delete the message
        Write-Host "`n  Delete test message from queue? (Y/N): " -ForegroundColor Yellow -NoNewline
        $deleteChoice = Read-Host
        
        if ($deleteChoice -eq 'Y' -or $deleteChoice -eq 'y') {
            $receiptHandle = $messageData.Messages[0].ReceiptHandle
            aws sqs delete-message `
                --queue-url $QUEUE_URL `
                --receipt-handle $receiptHandle `
                --region $AWS_REGION 2>&1 | Out-Null
            
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  ✓ Test message deleted from queue" -ForegroundColor Green
            }
        }
        
    } else {
        Write-Host "`n  ⚠ No messages received" -ForegroundColor Yellow
        Write-Host "  Possible causes:" -ForegroundColor Yellow
        Write-Host "    • Event notification may take longer to propagate" -ForegroundColor White
        Write-Host "    • S3 event configuration not properly set" -ForegroundColor White
        Write-Host "    • SQS queue policy doesn't allow S3 to send messages" -ForegroundColor White
        Write-Host "`n  Try checking manually in a few moments:" -ForegroundColor Yellow
        Write-Host "  aws sqs receive-message --queue-url $QUEUE_URL --max-number-of-messages 1" -ForegroundColor Cyan
    }
} else {
    Write-Host "`n  ✗ Failed to receive messages from SQS" -ForegroundColor Red
    Write-Host "  Error: $message" -ForegroundColor Red
}

# Check final queue state
Write-Host "`n  Checking final SQS queue state..." -ForegroundColor White
$afterAttributes = aws sqs get-queue-attributes `
    --queue-url $QUEUE_URL `
    --attribute-names ApproximateNumberOfMessages `
    --region $AWS_REGION 2>&1 | ConvertFrom-Json

if ($LASTEXITCODE -eq 0) {
    $messagesAfter = $afterAttributes.Attributes.ApproximateNumberOfMessages
    Write-Host "  Messages in queue: $messagesAfter" -ForegroundColor White
}

# Cleanup
Write-Host "`n  Cleaning up test file..." -ForegroundColor White
Remove-Item -Path $TEST_FILE -Force
Write-Host "  ✓ Local test file deleted" -ForegroundColor Green

# Ask if user wants to delete S3 file
Write-Host "`n  Delete test file from S3? (Y/N): " -ForegroundColor Yellow -NoNewline
$s3DeleteChoice = Read-Host

if ($s3DeleteChoice -eq 'Y' -or $s3DeleteChoice -eq 'y') {
    aws s3 rm "s3://$BUCKET_NAME/$S3_KEY" --region $AWS_REGION 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✓ Test file deleted from S3" -ForegroundColor Green
    }
}

# Summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Test Complete" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host "  1. Update SQS worker to handle S3 event format" -ForegroundColor White
Write-Host "     See: src/common/helpers/sqs-worker.js`n" -ForegroundColor Cyan
Write-Host "  2. Monitor SQS queue:" -ForegroundColor White
Write-Host "     aws sqs get-queue-attributes --queue-url $QUEUE_URL --attribute-names All`n" -ForegroundColor Cyan
Write-Host "  3. Check CloudWatch for S3 event metrics" -ForegroundColor White
Write-Host "     AWS Console → CloudWatch → Metrics → S3`n" -ForegroundColor Cyan
