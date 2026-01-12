# Create LocalStack Resources
# This script creates S3 bucket and SQS queue in LocalStack

Write-Host "`nCreating LocalStack Resources..." -ForegroundColor Cyan
Write-Host ""

$ENDPOINT = "http://localhost:4566"
$BUCKET = "dev-service-optimisation-c63f2"
$QUEUE = "content_review_status"

# Step 1: Create S3 Bucket
Write-Host "[1/3] Creating S3 Bucket: $BUCKET" -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$ENDPOINT/$BUCKET" -Method PUT -UseBasicParsing -ErrorAction Stop
    if ($response.StatusCode -eq 200) {
        Write-Host "  SUCCESS - S3 bucket created" -ForegroundColor Green
    }
} catch {
    if ($_.Exception.Response.StatusCode -eq 409) {
        Write-Host "  INFO - S3 bucket already exists" -ForegroundColor Cyan
    } else {
        Write-Host "  ERROR - Failed to create bucket: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# Step 2: Create SQS Queue
Write-Host "`n[2/3] Creating SQS Queue: $QUEUE" -ForegroundColor Yellow
try {
    $queueParams = @{
        Action = "CreateQueue"
        QueueName = $QUEUE
        Version = "2012-11-05"
    }
    
    $queryString = ($queueParams.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "&"
    $queueUrl = "$ENDPOINT/?$queryString"
    
    $response = Invoke-WebRequest -Uri $queueUrl -Method POST -UseBasicParsing -ErrorAction Stop
    
    if ($response.StatusCode -eq 200) {
        Write-Host "  SUCCESS - SQS queue created" -ForegroundColor Green
        # Extract queue URL from response
        if ($response.Content -match "<QueueUrl>(.*?)</QueueUrl>") {
            $createdQueueUrl = $matches[1]
            Write-Host "  Queue URL: $createdQueueUrl" -ForegroundColor White
        }
    }
} catch {
    if ($_.Exception.Message -match "already exists") {
        Write-Host "  INFO - SQS queue already exists" -ForegroundColor Cyan
    } else {
        Write-Host "  ERROR - Failed to create queue: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# Step 3: Verify Resources
Write-Host "`n[3/4] Verifying Resources" -ForegroundColor Yellow

# Verify S3
try {
    $s3Response = Invoke-WebRequest -Uri "$ENDPOINT/$BUCKET" -Method HEAD -UseBasicParsing -ErrorAction Stop
    Write-Host "  VERIFIED - S3 bucket exists" -ForegroundColor Green
} catch {
    Write-Host "  FAILED - S3 bucket not found" -ForegroundColor Red
}

# Verify SQS
try {
    $sqsListParams = @{
        Action = "ListQueues"
        Version = "2012-11-05"
    }
    $queryString = ($sqsListParams.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "&"
    $listUrl = "$ENDPOINT/?$queryString"
    
    $listResponse = Invoke-WebRequest -Uri $listUrl -Method POST -UseBasicParsing -ErrorAction Stop
    
    if ($listResponse.Content -match $QUEUE) {
        Write-Host "  VERIFIED - SQS queue exists" -ForegroundColor Green
    } else {
        Write-Host "  WARNING - SQS queue not found in list" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ERROR - Failed to verify SQS: $($_.Exception.Message)" -ForegroundColor Yellow
}

# Step 4: Upload GOV.UK Content Rules to S3
Write-Host "`n[4/4] Uploading GOV.UK Content Rules" -ForegroundColor Yellow
$rulesFile = Join-Path $PSScriptRoot "rules\govuk-content-qa-rules.md"
if (Test-Path $rulesFile) {
    try {
        $rulesContent = Get-Content -Path $rulesFile -Raw
        $rulesKey = "rules/govuk-content-qa-rules.md"
        $uploadUrl = "$ENDPOINT/$BUCKET/$rulesKey"
        
        $response = Invoke-WebRequest -Uri $uploadUrl -Method PUT -Body $rulesContent -ContentType "text/markdown" -UseBasicParsing -ErrorAction Stop
        
        if ($response.StatusCode -eq 200) {
            Write-Host "  SUCCESS - Rules file uploaded to S3" -ForegroundColor Green
            Write-Host "  Location: s3://$BUCKET/$rulesKey" -ForegroundColor White
        }
    } catch {
        Write-Host "  ERROR - Failed to upload rules: $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "  WARNING - Rules file not found at: $rulesFile" -ForegroundColor Yellow
}

Write-Host "`nDone!" -ForegroundColor Green
Write-Host ""
Write-Host "Resources Created:" -ForegroundColor Cyan
Write-Host "  S3 Bucket:  $BUCKET" -ForegroundColor White
Write-Host "  SQS Queue:  $QUEUE" -ForegroundColor White
Write-Host "  Rules File: rules/govuk-content-qa-rules.md" -ForegroundColor White
Write-Host "  Endpoint:   $ENDPOINT" -ForegroundColor White
Write-Host ""
