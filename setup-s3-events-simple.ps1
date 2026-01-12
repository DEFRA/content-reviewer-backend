# Simple S3 Event Notification Setup for LocalStack
# This script configures S3 event notifications without complex PowerShell syntax

Write-Host "`nConfiguring S3 Event Notifications for LocalStack...`n" -ForegroundColor Cyan

$LOCALSTACK_ENDPOINT = "http://localhost:4566"
$BUCKET_NAME = "dev-service-optimisation-c63f2"

# Step 1: Test LocalStack connectivity
Write-Host "[1/3] Testing LocalStack connection..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "$LOCALSTACK_ENDPOINT/_localstack/health" -TimeoutSec 5
    Write-Host "  OK - LocalStack is running" -ForegroundColor Green
} catch {
    Write-Host "  ERROR - LocalStack is not running or not accessible" -ForegroundColor Red
    Write-Host "  Please start LocalStack first: podman start localstack" -ForegroundColor Yellow
    exit 1
}

# Step 2: Configure S3 Event Notification using REST API
Write-Host "`n[2/3] Configuring S3 event notification..." -ForegroundColor Yellow

$notificationConfigPath = "s3-notification-localstack.json"

if (-not (Test-Path $notificationConfigPath)) {
    Write-Host "  ERROR - Config file not found: $notificationConfigPath" -ForegroundColor Red
    exit 1
}

$notificationConfig = Get-Content $notificationConfigPath -Raw

# Use Invoke-WebRequest to PUT the notification configuration
$uri = "$LOCALSTACK_ENDPOINT/$BUCKET_NAME/?notification"

try {
    $response = Invoke-WebRequest -Uri $uri -Method PUT -Body $notificationConfig -ContentType "application/xml" -UseBasicParsing
    
    if ($response.StatusCode -eq 200) {
        Write-Host "  OK - S3 event notification configured" -ForegroundColor Green
    } else {
        Write-Host "  WARNING - Unexpected response: $($response.StatusCode)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ERROR - Failed to configure S3 event notification" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "`n  Note: This is expected if LocalStack doesn't support this API" -ForegroundColor Yellow
    Write-Host "  The backend will fall back to manual SQS mode" -ForegroundColor Yellow
}

# Step 3: Update .env file
Write-Host "`n[3/3] Updating .env configuration..." -ForegroundColor Yellow

$envPath = ".env"
$envDevPath = ".env.dev"

# Function to update env file
function Update-EnvFile {
    param($filePath)
    
    if (Test-Path $filePath) {
        $content = Get-Content $filePath -Raw
        
        if ($content -match "S3_EVENT_TRIGGER_ENABLED") {
            # Already exists, update value
            $content = $content -replace "S3_EVENT_TRIGGER_ENABLED=.*", "S3_EVENT_TRIGGER_ENABLED=true"
        } else {
            # Add new configuration
            $content += "`n`n# S3 Event Trigger Mode`nS3_EVENT_TRIGGER_ENABLED=true`n"
        }
        
        Set-Content $filePath -Value $content -NoNewline
        Write-Host "  OK - Updated $filePath" -ForegroundColor Green
    }
}

Update-EnvFile $envPath
Update-EnvFile $envDevPath

Write-Host "`nDone!`n" -ForegroundColor Green
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Restart backend: npm start" -ForegroundColor White
Write-Host "  2. Upload a file via frontend" -ForegroundColor White
Write-Host "  3. Check logs for 'S3 event trigger mode: ENABLED'" -ForegroundColor White
Write-Host ""
