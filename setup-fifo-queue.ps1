# Quick LocalStack FIFO Queue Setup
# Run this to create the FIFO queue in your existing LocalStack container

Write-Host "`nSetting up LocalStack FIFO Queue..." -ForegroundColor Green

# Set AWS credentials (dummy for LocalStack)
$env:AWS_ACCESS_KEY_ID = "test"
$env:AWS_SECRET_ACCESS_KEY = "test"
$env:AWS_DEFAULT_REGION = "eu-west-2"

$endpoint = "http://localhost:4566"

# Create S3 bucket
Write-Host "`nCreating S3 bucket..." -ForegroundColor Cyan
aws --endpoint-url=$endpoint s3 mb s3://content-review --region eu-west-2 2>&1 | Out-Null
Write-Host "S3 bucket ready: content-review" -ForegroundColor Green

# Create SQS FIFO queue
Write-Host "`nCreating SQS FIFO queue..." -ForegroundColor Cyan
$result = aws --endpoint-url=$endpoint sqs create-queue `
    --queue-name content_review_status.fifo `
    --attributes FifoQueue=true,ContentBasedDeduplication=false `
    --region eu-west-2 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host "FIFO queue created: content_review_status.fifo" -ForegroundColor Green
} else {
    if ($result -like "*already exists*") {
        Write-Host "FIFO queue already exists: content_review_status.fifo" -ForegroundColor Yellow
    } else {
        Write-Host "Failed to create FIFO queue: $result" -ForegroundColor Red
    }
}

# Verify resources
Write-Host "`nVerifying resources..." -ForegroundColor Cyan
Write-Host "`nS3 Buckets:" -ForegroundColor White
aws --endpoint-url=$endpoint s3 ls

Write-Host "`nSQS Queues:" -ForegroundColor White
aws --endpoint-url=$endpoint sqs list-queues --region eu-west-2

Write-Host "`nSetup complete!" -ForegroundColor Green
Write-Host "You can now start the backend with: npm start" -ForegroundColor Yellow
