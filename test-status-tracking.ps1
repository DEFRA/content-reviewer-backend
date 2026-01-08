# Test Status Tracking Integration
# This script tests the status tracking during file upload and processing

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Status Tracking Integration Test" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Configuration
$BACKEND_URL = "http://localhost:3001"
$TEST_FILE = "test-status-tracking.txt"

# Create test file
Write-Host "[Step 1/5] Creating test file..." -ForegroundColor Cyan
$testContent = @"
Status Tracking Test File
=========================
Created: $(Get-Date)
Purpose: Testing real-time status updates during upload and processing

This file tests the status tracking system that provides
real-time updates as the file moves through the workflow.
"@

Set-Content -Path $TEST_FILE -Value $testContent
Write-Host "  ✓ Test file created`n" -ForegroundColor Green

# Upload file
Write-Host "[Step 2/5] Uploading file to backend..." -ForegroundColor Cyan
try {
    $form = @{
        file = Get-Item -Path $TEST_FILE
    }
    
    $uploadResponse = Invoke-RestMethod `
        -Uri "$BACKEND_URL/api/upload" `
        -Method Post `
        -Form $form `
        -Headers @{ "x-user-id" = "test-user" }
    
    if ($uploadResponse.success) {
        $uploadId = $uploadResponse.uploadId
        Write-Host "  ✓ File uploaded successfully" -ForegroundColor Green
        Write-Host "  Upload ID: $uploadId" -ForegroundColor White
        Write-Host "  Status URL: $($uploadResponse.statusUrl)`n" -ForegroundColor White
    } else {
        Write-Host "  ✗ Upload failed: $($uploadResponse.error)" -ForegroundColor Red
        Remove-Item -Path $TEST_FILE -Force
        exit 1
    }
} catch {
    Write-Host "  ✗ Upload request failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Make sure the backend is running on $BACKEND_URL" -ForegroundColor Yellow
    Remove-Item -Path $TEST_FILE -Force
    exit 1
}

# Poll for status updates
Write-Host "[Step 3/5] Polling for status updates..." -ForegroundColor Cyan
Write-Host "  Monitoring status changes (press Ctrl+C to stop):`n" -ForegroundColor White

$previousStatus = ""
$statusCount = 0
$maxAttempts = 60  # Poll for up to 60 seconds

for ($i = 0; $i -lt $maxAttempts; $i++) {
    try {
        $statusResponse = Invoke-RestMethod `
            -Uri "$BACKEND_URL/api/status/$uploadId" `
            -Method Get
        
        if ($statusResponse.success) {
            $currentStatus = $statusResponse.data.status
            $progress = $statusResponse.data.progress
            
            # Only display if status changed
            if ($currentStatus -ne $previousStatus) {
                $statusCount++
                $emoji = switch ($currentStatus) {
                    'uploading' { '📤' }
                    'uploaded' { '✅' }
                    'queued' { '⏳' }
                    'processing' { '⚙️' }
                    'downloading' { '📥' }
                    'analyzing' { '🔍' }
                    'reviewing' { '🤖' }
                    'finalizing' { '💾' }
                    'completed' { '✨' }
                    'failed' { '❌' }
                    default { '📋' }
                }
                
                $latestHistory = $statusResponse.data.statusHistory | Select-Object -Last 1
                Write-Host "  $emoji Status: " -NoNewline -ForegroundColor Yellow
                Write-Host "$currentStatus " -NoNewline -ForegroundColor White
                Write-Host "($progress%)" -ForegroundColor Cyan
                if ($latestHistory.message) {
                    Write-Host "     Message: $($latestHistory.message)" -ForegroundColor Gray
                }
                
                $previousStatus = $currentStatus
            }
            
            # Stop if completed or failed
            if ($currentStatus -eq 'completed' -or $currentStatus -eq 'failed') {
                break
            }
        }
    } catch {
        Write-Host "  ⚠ Failed to fetch status: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    
    Start-Sleep -Seconds 1
}

# Get final status with full details
Write-Host "`n[Step 4/5] Fetching final status..." -ForegroundColor Cyan
try {
    $finalStatus = Invoke-RestMethod `
        -Uri "$BACKEND_URL/api/status/$uploadId" `
        -Method Get
    
    if ($finalStatus.success) {
        $data = $finalStatus.data
        
        Write-Host "`n  Final Status Details:" -ForegroundColor Yellow
        Write-Host "  ===================" -ForegroundColor Yellow
        Write-Host "  Upload ID:  $($data.uploadId)" -ForegroundColor White
        Write-Host "  Filename:   $($data.filename)" -ForegroundColor White
        Write-Host "  Status:     $($data.status)" -ForegroundColor White
        Write-Host "  Progress:   $($data.progress)%" -ForegroundColor White
        Write-Host "  Created:    $($data.createdAt)" -ForegroundColor White
        Write-Host "  Updated:    $($data.updatedAt)" -ForegroundColor White
        
        if ($data.completedAt) {
            Write-Host "  Completed:  $($data.completedAt)" -ForegroundColor Green
        }
        
        if ($data.error) {
            Write-Host "  Error:      $($data.error)" -ForegroundColor Red
        }
        
        Write-Host "`n  Status History ($($data.statusHistory.Count) transitions):" -ForegroundColor Yellow
        foreach ($history in $data.statusHistory) {
            $timestamp = [DateTime]::Parse($history.timestamp).ToString("HH:mm:ss")
            Write-Host "    $timestamp - $($history.status) ($($history.progress)%)" -ForegroundColor Gray
            if ($history.message) {
                Write-Host "              $($history.message)" -ForegroundColor DarkGray
            }
        }
        
        if ($data.result) {
            Write-Host "`n  Review Result:" -ForegroundColor Yellow
            Write-Host "    Score: $($data.result.reviewScore)" -ForegroundColor White
            Write-Host "    Compliance: $($data.result.compliance.passed)" -ForegroundColor White
            if ($data.result.aiInsights) {
                Write-Host "    AI Insights:" -ForegroundColor White
                foreach ($insight in $data.result.aiInsights) {
                    Write-Host "      • $insight" -ForegroundColor Gray
                }
            }
        }
    }
} catch {
    Write-Host "  ✗ Failed to fetch final status" -ForegroundColor Red
}

# Test status history endpoint
Write-Host "`n[Step 5/5] Testing status history endpoint..." -ForegroundColor Cyan
try {
    $historyResponse = Invoke-RestMethod `
        -Uri "$BACKEND_URL/api/status/$uploadId/history" `
        -Method Get
    
    if ($historyResponse.success) {
        Write-Host "  ✓ Status history retrieved: $($historyResponse.data.history.Count) entries`n" -ForegroundColor Green
    }
} catch {
    Write-Host "  ⚠ Failed to fetch status history`n" -ForegroundColor Yellow
}

# Cleanup
Write-Host "Cleaning up..." -ForegroundColor White
Remove-Item -Path $TEST_FILE -Force
Write-Host "✓ Local test file deleted`n" -ForegroundColor Green

# Summary
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Test Summary" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

if ($finalStatus.data.status -eq 'completed') {
    Write-Host "✅ SUCCESS: Status tracking working perfectly!" -ForegroundColor Green
    Write-Host "   • File uploaded and processed" -ForegroundColor White
    Write-Host "   • $statusCount status transitions tracked" -ForegroundColor White
    Write-Host "   • Real-time updates received" -ForegroundColor White
    Write-Host "   • Final status: completed`n" -ForegroundColor White
} elseif ($finalStatus.data.status -eq 'failed') {
    Write-Host "❌ FAILED: Processing failed" -ForegroundColor Red
    Write-Host "   Error: $($finalStatus.data.error)`n" -ForegroundColor Red
} else {
    Write-Host "⚠️  PARTIAL: Processing may still be in progress" -ForegroundColor Yellow
    Write-Host "   Current status: $($finalStatus.data.status)`n" -ForegroundColor Yellow
}

Write-Host "Frontend Integration:" -ForegroundColor Yellow
Write-Host "  The frontend can poll: GET /api/status/$uploadId" -ForegroundColor Cyan
Write-Host "  Every 2 seconds to get real-time updates`n" -ForegroundColor White

Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host "  1. Integrate status polling in frontend" -ForegroundColor White
Write-Host "  2. Display progress bar and status messages" -ForegroundColor White
Write-Host "  3. Start SQS worker for automatic processing:" -ForegroundColor White
Write-Host "     npm run sqs:worker`n" -ForegroundColor Cyan
