# Test AI Content Review Outputs - FIXED VERSION
# This script submits content and displays the AI review results

# ============================================================================
# CONFIGURATION
# ============================================================================
$ApiKey = "YOUR_API_KEY_HERE"  # <-- PASTE YOUR CDP API KEY HERE
$Service = "content-reviewer-backend"
$baseUrl = "https://ephemeral-protected.api.dev.cdp-int.defra.cloud/$Service"
# ============================================================================

$headers = @{
    "x-api-key" = $ApiKey
    "Content-Type" = "application/json"
}

Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "AI CONTENT REVIEW OUTPUT TEST - FIXED" -ForegroundColor Cyan
Write-Host "============================================================================`n" -ForegroundColor Cyan

# Sample content to test
$testContent = @"
About this service

Use this service to apply for a farming grant. You can:
- check if you are eligible
- see what grants are available
- submit your application online

You will need:
- your business details
- information about your farm
- details of the project you want funding for

The application takes around 30 minutes to complete.

Before you start, make sure you have all the required documents ready.
"@

Write-Host "Test Content:" -ForegroundColor Yellow
Write-Host $testContent
Write-Host "`n============================================================================`n" -ForegroundColor Cyan

# Submit the review
Write-Host "Submitting content for AI review..." -ForegroundColor Yellow

$body = @{
    content = $testContent
    title = "Test - Farming Grant Service"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/review/text" -Method POST -Headers $headers -Body $body
    
    $reviewId = $response.reviewId
    Write-Host "SUCCESS: Review submitted!" -ForegroundColor Green
    Write-Host "  Review ID: $reviewId" -ForegroundColor Gray
    Write-Host "`nWaiting for AI to process (this takes 15-30 seconds)..." -ForegroundColor Yellow
    
    # Poll for results
    $maxAttempts = 8
    $attempt = 0
    $completed = $false
    
    while ($attempt -lt $maxAttempts -and -not $completed) {
        Start-Sleep -Seconds 5
        $attempt++
        
        Write-Host "  Checking status... (attempt $attempt/$maxAttempts)" -ForegroundColor Gray
        
        try {
            $result = Invoke-RestMethod -Uri "$baseUrl/api/review/$reviewId" -Method GET -Headers $headers
            
            # Check status and display results
            $reviewStatus = $result.data.status
            
            if ($reviewStatus -eq "completed") {
                $completed = $true
                $aiResult = $result.data.result
                
                Write-Host "`n============================================================================" -ForegroundColor Green
                Write-Host "AI REVIEW RESULTS" -ForegroundColor Green
                Write-Host "============================================================================`n" -ForegroundColor Green
                
                # Overall Assessment
                Write-Host "OVERALL ASSESSMENT:" -ForegroundColor Cyan
                Write-Host $aiResult.overallAssessment
                Write-Host ""
                
                # Issues
                if ($aiResult.issues -and $aiResult.issues.Count -gt 0) {
                    Write-Host "ISSUES FOUND ($($aiResult.issues.Count)):" -ForegroundColor Yellow
                    foreach ($issue in $aiResult.issues) {
                        $severityColor = switch ($issue.severity) {
                            "high" { "Red" }
                            "medium" { "Yellow" }
                            "low" { "Gray" }
                            default { "Yellow" }
                        }
                        Write-Host "  [$($issue.severity.ToUpper())] $($issue.category)" -ForegroundColor $severityColor
                        Write-Host "    $($issue.description)" -ForegroundColor Gray
                        if ($issue.suggestion) {
                            Write-Host "    💡 Suggestion: $($issue.suggestion)" -ForegroundColor Cyan
                        }
                        Write-Host ""
                    }
                }
                else {
                    Write-Host "ISSUES: None found ✓" -ForegroundColor Green
                    Write-Host ""
                }
                
                # Strengths
                if ($aiResult.strengths -and $aiResult.strengths.Count -gt 0) {
                    Write-Host "STRENGTHS ($($aiResult.strengths.Count)):" -ForegroundColor Green
                    foreach ($strength in $aiResult.strengths) {
                        Write-Host "  ✓ $strength" -ForegroundColor Green
                    }
                    Write-Host ""
                }
                
                # Recommendations
                if ($aiResult.recommendations -and $aiResult.recommendations.Count -gt 0) {
                    Write-Host "RECOMMENDATIONS ($($aiResult.recommendations.Count)):" -ForegroundColor Cyan
                    foreach ($rec in $aiResult.recommendations) {
                        Write-Host "  → $rec" -ForegroundColor Cyan
                    }
                    Write-Host ""
                }
                
                # Token usage
                if ($result.data.bedrockUsage) {
                    Write-Host "============================================================================" -ForegroundColor Gray
                    Write-Host "AI Usage Stats:" -ForegroundColor Gray
                    Write-Host "  Input tokens: $($result.data.bedrockUsage.inputTokens)" -ForegroundColor Gray
                    Write-Host "  Output tokens: $($result.data.bedrockUsage.outputTokens)" -ForegroundColor Gray
                    Write-Host "  Total tokens: $($result.data.bedrockUsage.totalTokens)" -ForegroundColor Gray
                    
                    if ($result.data.processingStartedAt -and $result.data.processingCompletedAt) {
                        $processingTime = (New-TimeSpan -Start $result.data.processingStartedAt -End $result.data.processingCompletedAt).TotalSeconds
                        Write-Host "  Processing time: $([math]::Round($processingTime, 1)) seconds" -ForegroundColor Gray
                    }
                }
            }
            
            if ($reviewStatus -eq "failed") {
                Write-Host "`nFAILED: Review processing failed" -ForegroundColor Red
                if ($result.data.error -and $result.data.error.message) {
                    Write-Host "  Error: $($result.data.error.message)" -ForegroundColor Red
                }
                break
            }
            
            if ($reviewStatus -ne "completed" -and $reviewStatus -ne "failed") {
                Write-Host "    Status: $reviewStatus" -ForegroundColor Gray
            }
        }
        catch {
            Write-Host "    Error checking status: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    
    if (-not $completed) {
        Write-Host "`nTIMEOUT: Review is still processing" -ForegroundColor Yellow
        Write-Host "  Review ID: $reviewId" -ForegroundColor Gray
        Write-Host "`nYou can check the status manually:" -ForegroundColor Yellow
        Write-Host "  `$response = Invoke-RestMethod -Uri '$baseUrl/api/review/$reviewId' -Method GET -Headers @{'x-api-key'='YOUR_KEY'}" -ForegroundColor Gray
        Write-Host "  `$response.data | ConvertTo-Json -Depth 10" -ForegroundColor Gray
    }
}
catch {
    Write-Host "`nERROR: Failed to submit review" -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host "  Details: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
}

Write-Host "`n============================================================================" -ForegroundColor Cyan
Write-Host "TEST COMPLETE" -ForegroundColor Cyan
Write-Host "============================================================================`n" -ForegroundColor Cyan
