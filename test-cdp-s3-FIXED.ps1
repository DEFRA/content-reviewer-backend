# Test CDP Backend WITH S3 (No MongoDB) - FIXED VERSION
# This version uses Invoke-RestMethod to avoid GZip issues

# ============================================================================
# CONFIGURATION
# ============================================================================
$ApiKey = "YOUR_API_KEY_HERE"  # <-- PASTE YOUR CDP API KEY HERE
$Service = "content-reviewer-backend"
$baseUrl = "https://ephemeral-protected.api.dev.cdp-int.defra.cloud/$Service"
# ============================================================================

Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "CDP BACKEND TEST (S3-BASED STORAGE) - FIXED VERSION" -ForegroundColor Cyan
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "INFO: Using S3 for review storage (No MongoDB needed)" -ForegroundColor Green
Write-Host "INFO: Using Invoke-RestMethod to handle GZip compression" -ForegroundColor Green
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
    Write-Host "FAILED: Health check failed" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# Test 2: Bedrock Integration (Chat Endpoint)
Write-Host "TEST 2: Bedrock Integration (Chat Endpoint)" -ForegroundColor Yellow
try {
    $chatBody = @{
        message = "Hello! Just testing the connection."
    } | ConvertTo-Json
    
    $response = Invoke-RestMethod -Uri "$baseUrl/api/chat" -Method POST -Headers $headers -Body $chatBody -TimeoutSec 30
    
    Write-Host "SUCCESS: Bedrock is working!" -ForegroundColor Green
    $responseText = $response.response
    if ($responseText.Length -gt 100) {
        $responseText = $responseText.Substring(0, 100) + "..."
    }
    Write-Host "  AI Response: $responseText" -ForegroundColor Gray
    Write-Host "  Tokens: $($response.usage.totalTokens)" -ForegroundColor Gray
}
catch {
    Write-Host "FAILED: Bedrock integration failed" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# Test 3: Check if review endpoints are registered (using /api/reviews)
Write-Host "TEST 3: Check Review Endpoints Registration" -ForegroundColor Yellow
try {
    # Use Invoke-RestMethod which handles GZip compression automatically
    $response = Invoke-RestMethod -Uri "$baseUrl/api/reviews" -Method GET -Headers $headers
    
    Write-Host "SUCCESS: Review endpoints are registered" -ForegroundColor Green
    Write-Host "  Total reviews: $($response.total)" -ForegroundColor Gray
}
catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 404) {
        Write-Host "FAILED: Review endpoints NOT registered (404 Not Found)" -ForegroundColor Red
        Write-Host "  The review.js routes are not loaded in the backend" -ForegroundColor Yellow
    }
    elseif ($statusCode -eq 403) {
        Write-Host "FAILED: Got 403 Forbidden - check your API key" -ForegroundColor Red
    }
    else {
        Write-Host "FAILED: Error: $($_.Exception.Message)" -ForegroundColor Red
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
        Write-Host "SUCCESS: Review submitted successfully (Status: 202)" -ForegroundColor Green
        Write-Host "  Review ID: $($response.reviewId)" -ForegroundColor Gray
        Write-Host "  Status: $($response.status)" -ForegroundColor Gray
        Write-Host "  (202 = Accepted for async processing - this is correct!)" -ForegroundColor Gray
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
        
        if ($response.review.status -eq "completed" -and $response.review.result) {
            Write-Host "  Result: Available (review completed!)" -ForegroundColor Green
        }
        elseif ($response.review.status -eq "processing") {
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
    # Use Invoke-RestMethod which handles GZip compression automatically
    $response = Invoke-RestMethod -Uri "$baseUrl/api/reviews?limit=5" -Method GET -Headers $headers
    
    Write-Host "SUCCESS: Retrieved review history" -ForegroundColor Green
    Write-Host "  Total reviews: $($response.reviews.Count)" -ForegroundColor Gray
    
    if ($response.reviews.Count -gt 0) {
        Write-Host "  Recent reviews:" -ForegroundColor Gray
        foreach ($review in $response.reviews) {
            $status = $review.status
            $created = $review.createdAt
            $id = if ($review.id) { $review.id } else { $review._id }
            Write-Host "    - ${id}: $status (created: $created)" -ForegroundColor Gray
        }
    }
    else {
        Write-Host "  No reviews found yet (submit a review first)" -ForegroundColor Yellow
    }
}
catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 403) {
        Write-Host "FAILED: Got 403 Forbidden - check your API key" -ForegroundColor Red
    } else {
        Write-Host "FAILED: Could not get review history: $($_.Exception.Message)" -ForegroundColor Red
    }
    
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
Write-Host "REQUIRED ENVIRONMENT VARIABLES:" -ForegroundColor Yellow
Write-Host ""
Write-Host "S3 Bucket:" -ForegroundColor Cyan
Write-Host "  S3_BUCKET=dev-service-optimisation-c63f2" -ForegroundColor Gray
Write-Host ""
Write-Host "SQS Queue (CONFIRMED):" -ForegroundColor Cyan
Write-Host "  SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status" -ForegroundColor Gray
Write-Host ""
Write-Host "AWS Region:" -ForegroundColor Cyan
Write-Host "  AWS_REGION=eu-west-2" -ForegroundColor Gray
Write-Host ""
Write-Host "NOT NEEDED (Removed):" -ForegroundColor Yellow
Write-Host "  MONGODB_URI - Not required" -ForegroundColor Gray
Write-Host "  MONGODB_DB_NAME - Not required" -ForegroundColor Gray
Write-Host "  MOCK_MONGODB - Not required" -ForegroundColor Gray
Write-Host ""
Write-Host "NOTES:" -ForegroundColor Cyan
Write-Host "  - This script uses Invoke-RestMethod to avoid GZip compression issues" -ForegroundColor Gray
Write-Host "  - All 6 tests should pass successfully" -ForegroundColor Gray
Write-Host "  - If tests fail, check your API key and network connectivity" -ForegroundColor Gray
Write-Host ""
Write-Host "See: S3-BASED-STORAGE-GUIDE.md for full details" -ForegroundColor Gray
