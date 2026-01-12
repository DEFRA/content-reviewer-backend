# Purge SQS Queue in LocalStack
# This script purges all messages from the SQS queue

Write-Host "`nPurging SQS Queue..." -ForegroundColor Cyan

$ENDPOINT = "http://localhost:4566"
$QUEUE_NAME = "content_review_status"
$QUEUE_URL = "http://localhost:4566/000000000000/content_review_status"

Write-Host "Queue URL: $QUEUE_URL" -ForegroundColor Yellow

try {
    # Purge queue
    $purgeParams = @{
        Action = "PurgeQueue"
        QueueUrl = $QUEUE_URL
        Version = "2012-11-05"
    }
    
    $queryString = ($purgeParams.GetEnumerator() | ForEach-Object { 
        "$($_.Key)=$([System.Uri]::EscapeDataString($_.Value))" 
    }) -join "&"
    
    $purgeUrl = "$ENDPOINT/?$queryString"
    
    $response = Invoke-WebRequest -Uri $purgeUrl -Method POST -UseBasicParsing -ErrorAction Stop
    
    if ($response.StatusCode -eq 200) {
        Write-Host "SUCCESS - SQS queue purged (all messages deleted)" -ForegroundColor Green
    }
} catch {
    Write-Host "ERROR - Failed to purge queue: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Response: $($_.Exception.Response)" -ForegroundColor Red
}

Write-Host "`nDone!" -ForegroundColor Cyan
