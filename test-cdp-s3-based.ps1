# Test CDP Backend WITH S3 (No MongoDB)
# This tests the S3-based review storage system

# ============================================================================
# CONFIGURATION
# ============================================================================
$ApiKey = "YOUR_API_KEY_HERE"  # <-- PASTE YOUR CDP API KEY HERE
$Service = "content-reviewer-backend"
$baseUrl = "https://ephemeral-protected.api.dev.cdp-int.defra.cloud/$Service"
# ============================================================================

Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "CDP BACKEND TEST (S3-BASED STORAGE)" -ForegroundColor Cyan
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "INFO: Using S3 for review storage (No MongoDB needed)" -ForegroundColor Green
Write-Host ""

$headers = @{
    "x-api-key" = $ApiKey
    "Content-Type" = "application/json"
}

# Test 1: Health Check
Write-Host "TEST 1: Health Check" -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/health" -Method GET -Headers $headers
    Write-Host "SUCCESS: Health check passed" -ForegroundColor Green
    Write-Host "  Response: $($response | ConvertTo-Json -Compress)" -ForegroundColor Gray
}
catch {
    Write-Host "FAILED: Health check failed: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# Test 2: Bedrock Test (via chat endpoint)
Write-Host "TEST 2: Bedrock Integration (Chat Endpoint)" -ForegroundColor Yellow
try {
    $chatBody = @{
        message = "Hello! Can you briefly introduce yourself?"
    } | ConvertTo-Json
    
    $response = Invoke-RestMethod -Uri "$baseUrl/api/chat" -Method POST -Headers $headers -Body $chatBody -TimeoutSec 30
    
    if ($response.response) {
        Write-Host "SUCCESS: Bedrock is working!" -ForegroundColor Green
        $previewLength = [Math]::Min(150, $response.response.Length)
        $preview = $response.response.Substring(0, $previewLength)
        Write-Host "  AI Response: $preview..." -ForegroundColor Gray
        Write-Host "  Tokens: $($response.usage.totalTokens)" -ForegroundColor Gray
    }
    else {
        Write-Host "FAILED: No response from Bedrock" -ForegroundColor Red
    }
}
catch {
    Write-Host "FAILED: Bedrock test failed: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# Test 3: Check if review endpoints are registered (using /api/reviews)
Write-Host "TEST 3: Check Review Endpoints Registration" -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$baseUrl/api/reviews" -Method GET -Headers $headers -ErrorAction Stop
    Write-Host "SUCCESS: Review endpoints are registered (Status: $($response.StatusCode))" -ForegroundColor Green
}
catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 404) {
        Write-Host "FAILED: Review endpoints NOT registered (404 Not Found)" -ForegroundColor Red
        Write-Host "  The review.js routes are not loaded in the backend" -ForegroundColor Yellow
    }
    elseif ($statusCode -eq 500 -or $statusCode -eq 200) {
        Write-Host "SUCCESS: Review endpoints ARE registered" -ForegroundColor Green
    }
    else {
        Write-Host "INFO: Got status code: $statusCode" -ForegroundColor Yellow
    }
}
Write-Host ""

# Test 4: Submit Text Review
Write-Host "TEST 4: Submit Text Review" -ForegroundColor Yellow
$global:reviewId = $null
try {
    $reviewBody = @{
        content = "This is a test document for GOV.UK content review using S3-based storage. It contains enough text to pass validation and demonstrate the async review system working correctly with Amazon S3 instead of MongoDB."
        title = "Test Document - S3 Storage"
    } | ConvertTo-Json
    
    $response = Invoke-RestMethod -Uri "$baseUrl/api/review/text" -Method POST -Headers $headers -Body $reviewBody
    
    if ($response.reviewId) {
        Write-Host "SUCCESS: Review submitted successfully" -ForegroundColor Green
        Write-Host "  Review ID: $($response.reviewId)" -ForegroundColor Gray
        Write-Host "  Status: $($response.status)" -ForegroundColor Gray
        $global:reviewId = $response.reviewId
    }
    else {
        Write-Host "FAILED: No review ID returned" -ForegroundColor Red
    }
}
catch {
    Write-Host "FAILED: Submit failed: $($_.Exception.Message)" -ForegroundColor Red
    
    if ($_.ErrorDetails.Message) {
        Write-Host "  Error Details: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
    
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode) {
        Write-Host "  Status Code: $statusCode" -ForegroundColor Red
    }
}
Write-Host ""

# Test 5: Get Review Status (if we have a reviewId)
if ($global:reviewId) {
    Write-Host "TEST 5: Get Review Status" -ForegroundColor Yellow
    Write-Host "  Waiting 3 seconds for processing..." -ForegroundColor Gray
    Start-Sleep -Seconds 3
    
    try {
        $response = Invoke-RestMethod -Uri "$baseUrl/api/review/$global:reviewId" -Method GET -Headers $headers
        
        Write-Host "SUCCESS: Retrieved review status" -ForegroundColor Green
        Write-Host "  Review ID: $($response.review.id)" -ForegroundColor Gray
        Write-Host "  Status: $($response.review.status)" -ForegroundColor Gray
        
        if ($response.review.result) {
            Write-Host "  Result available: YES" -ForegroundColor Green
            $assessment = $response.review.result.overallAssessment
            if ($assessment -and $assessment.Length -gt 100) {
                $assessment = $assessment.Substring(0, 100) + "..."
            }
            Write-Host "  Assessment: $assessment" -ForegroundColor Gray
        }
        elseif ($response.review.status -eq "pending" -or $response.review.status -eq "processing") {
            Write-Host "  Status: Still processing (check again in a few seconds)" -ForegroundColor Yellow
        }
        else {
            Write-Host "  Result: Not available yet" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host "FAILED: Could not get review status: $($_.Exception.Message)" -ForegroundColor Red
        
        if ($_.ErrorDetails.Message) {
            Write-Host "  Error Details: $($_.ErrorDetails.Message)" -ForegroundColor Red
        }
    }
    Write-Host ""
}
else {
    Write-Host "TEST 5: Get Review Status - SKIPPED (no reviewId from test 4)" -ForegroundColor Yellow
    Write-Host ""
}

# Test 6: Get Review History
Write-Host "TEST 6: Get Review History" -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/reviews?limit=5" -Method GET -Headers $headers
    
    Write-Host "SUCCESS: Retrieved review history" -ForegroundColor Green
    Write-Host "  Total reviews: $($response.reviews.Count)" -ForegroundColor Gray
    
    if ($response.reviews.Count -gt 0) {
        Write-Host "  Recent reviews:" -ForegroundColor Gray
        foreach ($review in $response.reviews) {
            $status = $review.status
            $created = $review.createdAt
            Write-Host "    - $($review.id): $status (created: $created)" -ForegroundColor Gray
        }
    }
    else {
        Write-Host "  No reviews found yet (submit a review first)" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "FAILED: Could not get review history: $($_.Exception.Message)" -ForegroundColor Red
    
    if ($_.ErrorDetails.Message) {
        Write-Host "  Error Details: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
}
Write-Host ""

# Summary
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "TEST SUMMARY" -ForegroundColor Cyan
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "S3-Based Storage Benefits:" -ForegroundColor Green
Write-Host "  - No MongoDB infrastructure needed" -ForegroundColor Gray
Write-Host "  - Simpler deployment and configuration" -ForegroundColor Gray
Write-Host "  - Cost-effective and scalable" -ForegroundColor Gray
Write-Host "  - Built-in durability and backup" -ForegroundColor Gray
Write-Host ""
Write-Host "REQUIRED ENVIRONMENT VARIABLES:" -ForegroundColor Cyan
Write-Host ""
Write-Host "S3 Bucket:" -ForegroundColor Green
Write-Host "  S3_BUCKET=dev-service-optimisation-c63f2" -ForegroundColor Gray
Write-Host ""
Write-Host "SQS Queue (CONFIRMED):" -ForegroundColor Green
Write-Host "  SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status" -ForegroundColor Gray
Write-Host ""
Write-Host "AWS Region:" -ForegroundColor Green
Write-Host "  AWS_REGION=eu-west-2" -ForegroundColor Gray
Write-Host ""
Write-Host "NOT NEEDED (Removed):" -ForegroundColor Yellow
Write-Host "  MONGODB_URI - Not required" -ForegroundColor Gray
Write-Host "  MONGODB_DB_NAME - Not required" -ForegroundColor Gray
Write-Host "  MOCK_MONGODB - Not required" -ForegroundColor Gray
Write-Host ""
Write-Host "NEXT STEPS:" -ForegroundColor Cyan
Write-Host "  1. Replace review-repository.js with S3 version" -ForegroundColor Gray
Write-Host "  2. Update config.js (remove MongoDB config)" -ForegroundColor Gray
Write-Host "  3. Set environment variables in CDP" -ForegroundColor Gray
Write-Host "  4. Redeploy the service" -ForegroundColor Gray
Write-Host "  5. Run this test again" -ForegroundColor Gray
Write-Host ""
Write-Host "See: S3-BASED-STORAGE-GUIDE.md for full details" -ForegroundColor Gray
Write-Host ""
