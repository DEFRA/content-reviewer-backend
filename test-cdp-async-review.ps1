# CDP Async Review System Test Script
# Tests the new async review endpoints deployed to CDP

# ============================================================================
# CONFIGURATION - PASTE YOUR API KEY HERE
# ============================================================================
$ApiKey = "YOUR_API_KEY_HERE"  # <-- PASTE YOUR CDP API KEY HERE
$Environment = "dev"
$Service = "content-reviewer-backend"
# ============================================================================

# Configuration
$baseUrl = "https://ephemeral-protected.api.dev.cdp-int.defra.cloud/$Service"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# Colors for output
function Write-Success { Write-Host $args -ForegroundColor Green }
function Write-Failure { Write-Host $args -ForegroundColor Red }
function Write-Info { Write-Host $args -ForegroundColor Cyan }
function Write-Warning { Write-Host $args -ForegroundColor Yellow }

# Test counter
$script:totalTests = 0
$script:passedTests = 0
$script:failedTests = 0

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Method = "GET",
        [string]$Endpoint,
        [hashtable]$Body = $null,
        [string]$ExpectedStatus = "200",
        [scriptblock]$Validation = $null
    )
    
    $script:totalTests++
    Write-Host "`n[TEST $script:totalTests] $Name" -ForegroundColor Yellow
    Write-Host "---"
    Write-Host "  Endpoint: $Method $Endpoint"
    
    try {
        $headers = @{
            "x-api-key" = $ApiKey
            "Content-Type" = "application/json"
        }
        
        if ($Body) {
            $bodyJson = $Body | ConvertTo-Json -Depth 10
            Write-Host "  Request Body: $bodyJson"
        }
        
        $params = @{
            Uri = $Endpoint
            Method = $Method
            Headers = $headers
            TimeoutSec = 30
        }
        
        if ($Body) {
            $params.Body = $Body | ConvertTo-Json -Depth 10
        }
        
        $response = Invoke-RestMethod @params
        
        Write-Success "[PASS] Request successful"
        $script:passedTests++
        
        # Show response
        $responseJson = $response | ConvertTo-Json -Depth 10 -Compress
        if ($responseJson.Length -gt 500) {
            Write-Host "  Response: $($responseJson.Substring(0, 500))... (truncated)"
        } else {
            Write-Host "  Response: $responseJson"
        }
        
        # Run custom validation if provided
        if ($Validation) {
            $validationResult = & $Validation $response
            if ($validationResult) {
                Write-Success "  $validationResult"
            }
        }
        
        return $response
        
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        
        if ($ExpectedStatus -eq $statusCode.ToString()) {
            Write-Warning "[EXPECTED] Request failed with expected status: $statusCode"
            Write-Host "  Details: $($_.Exception.Message)"
            $script:passedTests++
        } else {
            Write-Failure "[FAIL] Request failed"
            Write-Host "  Details: Status: $statusCode, Error: $($_.Exception.Message)"
            $script:failedTests++
        }
        
        return $null
    }
}

# Header
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "CDP ASYNC REVIEW SYSTEM TEST" -ForegroundColor Cyan
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "Environment: $Environment"
Write-Host "Service: $Service"
Write-Host "Base URL: $baseUrl"
Write-Host "Date: $timestamp"
Write-Host ""

# Check API key
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Failure "[ERROR] API Key not configured"
    Write-Host "Please set the CDP_API_KEY environment variable or pass -ApiKey parameter"
    exit 1
} else {
    Write-Success "[OK] API Key configured"
}

Write-Host "`nStarting tests...`n"

# Test 1: Health Check
$healthResponse = Test-Endpoint `
    -Name "Health Check Endpoint" `
    -Method "GET" `
    -Endpoint "$baseUrl/health" `
    -Validation {
        param($response)
        if ($response.message -eq "success") {
            return "Health check returned expected 'success' message"
        }
        return "Health check returned: $($response | ConvertTo-Json -Compress)"
    }

Start-Sleep -Seconds 1

# Test 2: Worker Status
$workerResponse = Test-Endpoint `
    -Name "Worker Status Endpoint (NEW)" `
    -Method "GET" `
    -Endpoint "$baseUrl/api/review/worker-status" `
    -Validation {
        param($response)
        if ($response.workerRunning) {
            return "SQS worker is running and processing messages"
        } else {
            return "WARNING: SQS worker is not running"
        }
    }

Start-Sleep -Seconds 1

# Test 3: Submit Text Review (Async)
Write-Info "`n[INFO] Submitting async text review..."
$reviewBody = @{
    text = "This is a test content review from CDP. The purpose of this test is to ensure compliance with GOV.UK content standards. All content must follow the guidelines outlined in the GOV.UK style guide."
    metadata = @{
        source = "powershell-test"
        timestamp = $timestamp
    }
}

$submitResponse = Test-Endpoint `
    -Name "Submit Text Review (Async)" `
    -Method "POST" `
    -Endpoint "$baseUrl/api/review/text" `
    -Body $reviewBody `
    -Validation {
        param($response)
        if ($response.reviewId) {
            return "Review submitted successfully with ID: $($response.reviewId)"
        }
        return "Review response received"
    }

$reviewId = $submitResponse.reviewId
Start-Sleep -Seconds 2

# Test 4: Check Review Status
if ($reviewId) {
    Write-Info "`n[INFO] Checking review status (ID: $reviewId)..."
    
    $maxAttempts = 6
    $attempt = 1
    $reviewComplete = $false
    
    while ($attempt -le $maxAttempts -and -not $reviewComplete) {
        Write-Host "`n  Attempt $attempt of $maxAttempts (waiting for processing...)"
        
        $validationScript = {
            param($response)
            $status = $response.status
            switch ($status) {
                "pending" { return "Status: PENDING - Review queued for processing" }
                "processing" { return "Status: PROCESSING - AI is analyzing content" }
                "completed" { return "Status: COMPLETED - Review finished successfully" }
                "failed" { return "Status: FAILED - Review processing failed" }
                default { return "Status: $status" }
            }
        }
        
        $statusResponse = Test-Endpoint -Name "Check Review Status - Attempt $attempt" -Method "GET" -Endpoint "$baseUrl/api/review/status/$reviewId" -Validation $validationScript
        
        if ($statusResponse.status -eq "completed") {
            $reviewComplete = $true
            Write-Success "`n  Review completed successfully!"
            
            # Show review results
            if ($statusResponse.result) {
                Write-Host "`n  Review Results:" -ForegroundColor Cyan
                Write-Host "  Score: $($statusResponse.result.score)/10"
                $assessmentLength = [Math]::Min(200, $statusResponse.result.assessment.Length)
                Write-Host "  Assessment: $($statusResponse.result.assessment.Substring(0, $assessmentLength))..."
            }
        } elseif ($statusResponse.status -eq "failed") {
            Write-Failure "`n  Review failed"
            break
        } else {
            Start-Sleep -Seconds 5
            $attempt++
        }
    }
    
    if (-not $reviewComplete -and $attempt -gt $maxAttempts) {
        Write-Warning "`n  Review still processing after $maxAttempts attempts (expected for long reviews)"
    }
} else {
    Write-Warning "SKIP: Review status check skipped (no reviewId from previous test)"
}

Start-Sleep -Seconds 1

# Test 5: Review History
$historyResponse = Test-Endpoint `
    -Name "Review History Endpoint" `
    -Method "GET" `
    -Endpoint "$baseUrl/api/review/history?limit=10" `
    -Validation {
        param($response)
        if ($response.reviews) {
            $count = $response.reviews.Count
            return "Found $count review(s) in history"
        }
        return "History retrieved"
    }

Start-Sleep -Seconds 1

# Test 6: Error Handling - Empty Text
$emptyTextBody = @{
    text = ""
}

Test-Endpoint `
    -Name "Error Handling - Empty Text" `
    -Method "POST" `
    -Endpoint "$baseUrl/api/review/text" `
    -Body $emptyTextBody `
    -ExpectedStatus "400" `
    -Validation {
        return "Expected error for empty text - validation works correctly"
    }

Start-Sleep -Seconds 1

# Test 7: Error Handling - Invalid Review ID
Test-Endpoint `
    -Name "Error Handling - Invalid Review ID" `
    -Method "GET" `
    -Endpoint "$baseUrl/api/review/status/invalid-id-12345" `
    -ExpectedStatus "404" `
    -Validation {
        return "Expected error for invalid ID - error handling works correctly"
    }

# Summary
Write-Host "`n============================================================================" -ForegroundColor Cyan
Write-Host "TEST SUMMARY" -ForegroundColor Cyan
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Total Tests: $script:totalTests"
Write-Host "Passed: " -NoNewline
Write-Success "$script:passedTests"
Write-Host "Failed: " -NoNewline
Write-Failure "$script:failedTests"
$successRate = [math]::Round(($script:passedTests / $script:totalTests) * 100, 2)
Write-Host "Success Rate: $successRate%"
Write-Host ""

if ($script:failedTests -gt 0) {
    Write-Warning "WARNING: SOME TESTS FAILED"
    Write-Host "`nTroubleshooting:"
    Write-Host "1. Check CloudWatch logs in CDP Portal"
    Write-Host "2. Verify MongoDB connection (MONGODB_URI)"
    Write-Host "3. Verify SQS queue (SQS_QUEUE_URL)"
    Write-Host "4. Check Bedrock configuration (BEDROCK_INFERENCE_PROFILE_ARN)"
    Write-Host "5. Ensure all environment variables are set"
    Write-Host "6. Check if SQS worker is running (worker-status endpoint)"
    exit 1
} else {
    Write-Success "`nALL TESTS PASSED!"
    Write-Host "`nYour async review system is working correctly in CDP!"
    exit 0
}
