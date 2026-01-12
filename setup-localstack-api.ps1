# LocalStack Setup using REST API (no AWS CLI required)
# This script creates S3 buckets and SQS queues using LocalStack's REST API

Write-Host "`n=== LocalStack Setup ===" -ForegroundColor Green
Write-Host "Setting up S3 bucket and SQS FIFO queue..." -ForegroundColor Cyan

$endpoint = "http://localhost:4566"
$region = "eu-west-2"

# Test LocalStack connectivity
Write-Host "`nTesting LocalStack connection..." -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri "$endpoint/_localstack/health" -TimeoutSec 5
    Write-Host "LocalStack is running!" -ForegroundColor Green
    Write-Host "  S3: $($health.services.s3)" -ForegroundColor White
    Write-Host "  SQS: $($health.services.sqs)" -ForegroundColor White
} catch {
    Write-Host "ERROR: Cannot connect to LocalStack at $endpoint" -ForegroundColor Red
    Write-Host "Make sure LocalStack is running in Podman Desktop" -ForegroundColor Yellow
    exit 1
}

# Create S3 bucket using REST API
Write-Host "`nCreating S3 bucket: content-review" -ForegroundColor Cyan
try {
    $bucketName = "content-review"
    $uri = "$endpoint/$bucketName"
    Invoke-RestMethod -Uri $uri -Method PUT -ErrorAction Stop | Out-Null
    Write-Host "S3 bucket created successfully!" -ForegroundColor Green
} catch {
    if ($_.Exception.Response.StatusCode -eq 409) {
        Write-Host "S3 bucket already exists (OK)" -ForegroundColor Yellow
    } else {
        Write-Host "Warning: Could not create S3 bucket: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# Create SQS FIFO queue using AWS SQS API
Write-Host "`nCreating SQS FIFO queue: content_review_status.fifo" -ForegroundColor Cyan
try {
    $queueName = "content_review_status.fifo"
    
    # SQS CreateQueue action
    $params = @{
        Action = "CreateQueue"
        QueueName = $queueName
        "Attribute.1.Name" = "FifoQueue"
        "Attribute.1.Value" = "true"
        "Attribute.2.Name" = "ContentBasedDeduplication"
        "Attribute.2.Value" = "false"
        Version = "2012-11-05"
    }
    
    $queryString = ($params.GetEnumerator() | ForEach-Object { "$($_.Key)=$([System.Web.HttpUtility]::UrlEncode($_.Value))" }) -join "&"
    $uri = "$endpoint/?$queryString"
    
    $response = Invoke-RestMethod -Uri $uri -Method POST -ContentType "application/x-www-form-urlencoded" -ErrorAction Stop
    Write-Host "SQS FIFO queue created successfully!" -ForegroundColor Green
    Write-Host "  Queue URL: http://localhost:4566/000000000000/$queueName" -ForegroundColor White
} catch {
    if ($_.Exception.Message -like "*already exists*" -or $_.Exception.Message -like "*QueueAlreadyExists*") {
        Write-Host "SQS FIFO queue already exists (OK)" -ForegroundColor Yellow
    } else {
        Write-Host "Warning: Could not create SQS queue: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# Summary
Write-Host "`n=== Setup Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Resources created in LocalStack:" -ForegroundColor Cyan
Write-Host "  S3 Bucket: content-review" -ForegroundColor White
Write-Host "  SQS Queue: content_review_status.fifo" -ForegroundColor White
Write-Host "  Endpoint:  $endpoint" -ForegroundColor White
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Make sure your .env file is configured correctly" -ForegroundColor White
Write-Host "  2. Start the backend: npm start" -ForegroundColor White
Write-Host "  3. Start the frontend in another terminal" -ForegroundColor White
Write-Host "  4. Upload a file and watch it flow through the system!" -ForegroundColor White
Write-Host ""
