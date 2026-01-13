# Test script for async review system (PowerShell)
# This script tests the new async review endpoints

$BaseUrl = "http://localhost:3001"

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "ContentReviewerAI - Async Review System Tests" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# Test 1: Submit Text Review
Write-Host "Test 1: Submit Text Review" -ForegroundColor Yellow
Write-Host "-------------------------------------------"

$textBody = @{
    content = "This is a test content for review. It contains some text that should be reviewed by the GOV.UK content reviewer. The text includes various sentences to test the review system."
    title = "Test Content Review"
} | ConvertTo-Json

try {
    $textResponse = Invoke-RestMethod -Uri "$BaseUrl/api/review/text" `
        -Method Post `
        -ContentType "application/json" `
        -Body $textBody

    Write-Host "Response: $($textResponse | ConvertTo-Json)" -ForegroundColor Gray
    
    if ($textResponse.success -and $textResponse.reviewId) {
        Write-Host "✓ Text review submitted successfully" -ForegroundColor Green
        Write-Host "Review ID: $($textResponse.reviewId)"
        $reviewId = $textResponse.reviewId
    } else {
        Write-Host "✗ Failed to submit text review" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "✗ Error submitting text review: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Test 2: Check Review Status
Write-Host "Test 2: Check Review Status" -ForegroundColor Yellow
Write-Host "-------------------------------------------"

$maxAttempts = 10
$completed = $false

for ($i = 1; $i -le $maxAttempts; $i++) {
    Write-Host "Attempt $i/$maxAttempts..."
    
    try {
        $statusResponse = Invoke-RestMethod -Uri "$BaseUrl/api/review/$reviewId" -Method Get
        Write-Host "Response: $($statusResponse | ConvertTo-Json -Depth 5)" -ForegroundColor Gray
        
        $status = $statusResponse.review.status
        Write-Host "Current status: $status"
        
        if ($status -eq "completed") {
            Write-Host "✓ Review completed successfully" -ForegroundColor Green
            $completed = $true
            break
        } elseif ($status -eq "failed") {
            Write-Host "✗ Review failed: $($statusResponse.review.error)" -ForegroundColor Red
            exit 1
        } else {
            Write-Host "Status: $status (waiting...)" -ForegroundColor Gray
            Start-Sleep -Seconds 3
        }
    } catch {
        Write-Host "Error checking status: $_" -ForegroundColor Red
    }
}

if (-not $completed) {
    Write-Host "⚠ Review still processing after 30 seconds" -ForegroundColor Yellow
}

Write-Host ""

# Test 3: Get Review History
Write-Host "Test 3: Get Review History" -ForegroundColor Yellow
Write-Host "-------------------------------------------"

try {
    $historyResponse = Invoke-RestMethod -Uri "$BaseUrl/api/reviews?limit=5" -Method Get
    Write-Host "Response: $($historyResponse | ConvertTo-Json -Depth 3)" -ForegroundColor Gray
    
    if ($historyResponse.success -and $historyResponse.reviews) {
        Write-Host "✓ Review history retrieved successfully" -ForegroundColor Green
        Write-Host "Found $($historyResponse.pagination.returned) reviews"
    } else {
        Write-Host "⚠ No reviews in history yet" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Error getting history: $_" -ForegroundColor Red
}

Write-Host ""

# Test 4: Health Check
Write-Host "Test 4: Health Check" -ForegroundColor Yellow
Write-Host "-------------------------------------------"

try {
    $healthResponse = Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get
    Write-Host "Response: $($healthResponse | ConvertTo-Json)" -ForegroundColor Gray
    
    if ($healthResponse.status -eq "ok") {
        Write-Host "✓ Health check passed" -ForegroundColor Green
    } else {
        Write-Host "✗ Health check failed" -ForegroundColor Red
    }
} catch {
    Write-Host "✗ Error checking health: $_" -ForegroundColor Red
}

Write-Host ""

# Test 5: SQS Worker Status
Write-Host "Test 5: SQS Worker Status" -ForegroundColor Yellow
Write-Host "-------------------------------------------"

try {
    $workerResponse = Invoke-RestMethod -Uri "$BaseUrl/api/sqs-worker/status" -Method Get
    Write-Host "Response: $($workerResponse | ConvertTo-Json)" -ForegroundColor Gray
    
    if ($workerResponse.worker.running) {
        Write-Host "✓ SQS Worker is running" -ForegroundColor Green
    } else {
        Write-Host "⚠ SQS Worker may not be running" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Error checking worker status: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "Test Suite Complete" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "To test file upload manually, run:"
Write-Host "Invoke-RestMethod -Uri '$BaseUrl/api/review/file' -Method Post -Form @{file=Get-Item 'C:\path\to\document.pdf'}" -ForegroundColor Gray
Write-Host ""
