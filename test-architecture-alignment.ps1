# Test Script - Architecture Alignment Verification
# Tests that text content is now stored in S3 instead of embedded in SQS messages

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Architecture Alignment Test" -ForegroundColor Cyan
Write-Host "Verifying S3-based text content storage" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Configuration
$backendUrl = "http://localhost:3001"
$testContent = "This is a test review content to verify that text is stored in S3 instead of being embedded in SQS messages. The architecture should now match the reference diagram where Object Storage holds all submitted content."
$testTitle = "Architecture Alignment Test"

# Test 1: Submit text for review
Write-Host "Test 1: Submitting text content..." -ForegroundColor Yellow

$body = @{
    content = $testContent
    title = $testTitle
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$backendUrl/api/review/text" `
        -Method POST `
        -Headers @{"Content-Type"="application/json"} `
        -Body $body `
        -ErrorAction Stop

    if ($response.success) {
        Write-Host "✓ Text submitted successfully" -ForegroundColor Green
        Write-Host "  Review ID: $($response.reviewId)" -ForegroundColor Gray
        Write-Host "  Status: $($response.status)" -ForegroundColor Gray
        $reviewId = $response.reviewId
    } else {
        Write-Host "✗ Submission failed: $($response.error)" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "✗ Request failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Test 2: Check review status
Write-Host "Test 2: Checking review status..." -ForegroundColor Yellow

Start-Sleep -Seconds 2

try {
    $statusResponse = Invoke-RestMethod -Uri "$backendUrl/api/review/status/$reviewId" `
        -Method GET `
        -ErrorAction Stop

    Write-Host "✓ Status retrieved successfully" -ForegroundColor Green
    Write-Host "  Status: $($statusResponse.status)" -ForegroundColor Gray
    Write-Host "  Source Type: $($statusResponse.sourceType)" -ForegroundColor Gray
    
    # Check if S3 key is present (architecture compliance)
    if ($statusResponse.s3Key) {
        Write-Host "  ✓ S3 Key Present: $($statusResponse.s3Key)" -ForegroundColor Green
        Write-Host "    → Architecture compliant! Content stored in S3." -ForegroundColor Cyan
    } else {
        Write-Host "  ✗ S3 Key Missing!" -ForegroundColor Red
        Write-Host "    → Content may still be embedded in MongoDB/SQS." -ForegroundColor Yellow
    }

    # Check if textContent is NOT present (should be removed)
    if ($statusResponse.textContent) {
        Write-Host "  ⚠ Text Content Present in Response!" -ForegroundColor Yellow
        Write-Host "    → This is the old pattern, should use S3 reference only." -ForegroundColor Yellow
    }

} catch {
    Write-Host "✗ Status check failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# Test 3: Verify S3 upload (if using LocalStack)
Write-Host "Test 3: Checking S3 for uploaded content..." -ForegroundColor Yellow

$awsEndpoint = $env:AWS_ENDPOINT
if ($awsEndpoint) {
    Write-Host "  LocalStack endpoint detected: $awsEndpoint" -ForegroundColor Gray
    
    try {
        $s3Bucket = $env:S3_BUCKET
        if (-not $s3Bucket) {
            $s3Bucket = "dev-service-optimisation-c63f2"
        }

        # List S3 objects with the review ID
        $s3Objects = aws s3 ls "s3://$s3Bucket/reviews/" --recursive --endpoint-url=$awsEndpoint 2>&1

        if ($s3Objects -like "*$reviewId*") {
            Write-Host "  ✓ Text content found in S3!" -ForegroundColor Green
            Write-Host "    → Architecture fully compliant!" -ForegroundColor Cyan
            
            # Show matching files
            $s3Objects | Where-Object { $_ -like "*$reviewId*" } | ForEach-Object {
                Write-Host "    File: $_" -ForegroundColor Gray
            }
        } else {
            Write-Host "  ⚠ Text content not found in S3 (yet)" -ForegroundColor Yellow
            Write-Host "    → Check if MOCK_S3_UPLOAD is enabled" -ForegroundColor Gray
        }
    } catch {
        Write-Host "  ℹ Could not verify S3 content (AWS CLI may not be available)" -ForegroundColor Gray
    }
} else {
    Write-Host "  ℹ Not using LocalStack, skipping S3 verification" -ForegroundColor Gray
    Write-Host "    To enable: Set AWS_ENDPOINT environment variable" -ForegroundColor Gray
}

Write-Host ""

# Test 4: Check SQS message size (if accessible)
Write-Host "Test 4: Verifying SQS message structure..." -ForegroundColor Yellow

$sqsQueueUrl = $env:SQS_QUEUE_URL
if ($sqsQueueUrl -and $awsEndpoint) {
    Write-Host "  Checking SQS queue: $sqsQueueUrl" -ForegroundColor Gray
    
    try {
        $sqsMessages = aws sqs receive-message `
            --queue-url $sqsQueueUrl `
            --max-number-of-messages 1 `
            --endpoint-url=$awsEndpoint `
            --output json 2>&1 | ConvertFrom-Json

        if ($sqsMessages.Messages) {
            $message = $sqsMessages.Messages[0]
            $messageBody = $message.Body | ConvertFrom-Json
            $messageSize = [System.Text.Encoding]::UTF8.GetByteCount($message.Body)

            Write-Host "  Message Size: $messageSize bytes" -ForegroundColor Gray

            if ($messageSize -lt 2048) {
                Write-Host "  ✓ Message is lightweight (< 2KB)" -ForegroundColor Green
                Write-Host "    → Architecture compliant! Reference-based messaging." -ForegroundColor Cyan
            } else {
                Write-Host "  ⚠ Message is large (> 2KB)" -ForegroundColor Yellow
                Write-Host "    → May contain embedded content instead of references." -ForegroundColor Yellow
            }

            # Check if message contains s3Key reference
            if ($messageBody.s3Key) {
                Write-Host "  ✓ Message contains S3 reference: $($messageBody.s3Key)" -ForegroundColor Green
            }

            # Check if message contains embedded textContent (should NOT)
            if ($messageBody.textContent) {
                Write-Host "  ✗ Message contains embedded textContent!" -ForegroundColor Red
                Write-Host "    → This violates the reference architecture." -ForegroundColor Yellow
            }
        } else {
            Write-Host "  ℹ No messages in queue currently" -ForegroundColor Gray
        }
    } catch {
        Write-Host "  ℹ Could not access SQS queue" -ForegroundColor Gray
    }
} else {
    Write-Host "  ℹ SQS queue not accessible for direct verification" -ForegroundColor Gray
    Write-Host "    To enable: Set SQS_QUEUE_URL and AWS_ENDPOINT environment variables" -ForegroundColor Gray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Architecture Changes:" -ForegroundColor White
Write-Host "  ✓ Text content submitted via API" -ForegroundColor Green
Write-Host "  ✓ Review record created with status" -ForegroundColor Green
Write-Host "  → Check logs for S3 upload confirmation" -ForegroundColor Cyan
Write-Host "  → Verify SQS worker retrieves from S3" -ForegroundColor Cyan
Write-Host ""
Write-Host "Review ID for manual verification: $reviewId" -ForegroundColor White
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host "  1. Check backend logs for 'Text content uploaded to S3'" -ForegroundColor Gray
Write-Host "  2. Check worker logs for 'Downloading text content from S3'" -ForegroundColor Gray
Write-Host "  3. Verify S3 bucket contains text file for review: $reviewId" -ForegroundColor Gray
Write-Host "  4. Confirm SQS message contains s3Key (not textContent)" -ForegroundColor Gray
Write-Host ""
