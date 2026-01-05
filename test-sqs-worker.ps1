# Test SQS Worker Status
# Usage: .\test-sqs-worker.ps1

Write-Host "Testing SQS Worker Status..." -ForegroundColor Cyan
Write-Host ""

$backendUrl = "http://localhost:3001"
$endpoint = "$backendUrl/api/sqs-worker/status"

Write-Host "Connecting to: $endpoint" -ForegroundColor Gray
Write-Host ""

try {
    $response = Invoke-RestMethod -Uri $endpoint -Method Get -ContentType "application/json"
    
    Write-Host "Response Status: OK" -ForegroundColor Green
    Write-Host ""
    Write-Host "Worker Status:" -ForegroundColor Cyan
    $response | ConvertTo-Json -Depth 10 | Write-Host
    
    $workerData = $response.data
    
    Write-Host ""
    Write-Host "Summary:" -ForegroundColor Cyan
    if ($workerData.running) {
        Write-Host "  Worker Running: YES" -ForegroundColor Green
    } else {
        Write-Host "  Worker Running: NO" -ForegroundColor Red
    }
    
    if ($workerData.expectedToRun) {
        Write-Host "  Expected to Run: YES" -ForegroundColor Green
    } else {
        Write-Host "  Expected to Run: NO" -ForegroundColor Yellow
    }
    
    Write-Host "  Queue URL: $($workerData.queueUrl)" -ForegroundColor Gray
    Write-Host "  Region: $($workerData.region)" -ForegroundColor Gray
    
    if ($workerData.environment.mockMode) {
        Write-Host "  Mock Mode: YES" -ForegroundColor Yellow
    } else {
        Write-Host "  Mock Mode: NO" -ForegroundColor Green
    }
    
    if ($workerData.environment.skipWorker) {
        Write-Host "  Worker Skipped: YES" -ForegroundColor Yellow
    } else {
        Write-Host "  Worker Skipped: NO" -ForegroundColor Green
    }
    
    Write-Host "  AWS Endpoint: $($workerData.environment.awsEndpoint)" -ForegroundColor Gray
    Write-Host ""
    
    if ($workerData.running -and $workerData.expectedToRun) {
        Write-Host "SQS Worker is running and healthy!" -ForegroundColor Green
    } elseif (-not $workerData.expectedToRun) {
        Write-Host "SQS Worker is not expected to run (MOCK mode or SKIP_SQS_WORKER=true)" -ForegroundColor Yellow
    } else {
        Write-Host "SQS Worker is not running (check logs for errors)" -ForegroundColor Red
    }
    
} catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Make sure the backend server is running:" -ForegroundColor Yellow
    Write-Host "  npm run dev" -ForegroundColor Gray
    exit 1
}

