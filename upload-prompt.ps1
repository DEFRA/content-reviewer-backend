# Upload System Prompt to S3
# This script uploads the embedded system prompt to S3 bucket

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "System Prompt Upload Script" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "This script will upload the GOV.UK system prompt to S3" -ForegroundColor Yellow
Write-Host ""
Write-Host "Requirements:" -ForegroundColor White
Write-Host "  - AWS credentials configured (via AWS CLI or environment variables)" -ForegroundColor Gray
Write-Host "  - Access to S3 bucket: dev-service-optimisation-c63f2" -ForegroundColor Gray
Write-Host "  - Permissions: s3:PutObject" -ForegroundColor Gray
Write-Host ""

$continue = Read-Host "Continue? (y/n)"
if ($continue -ne 'y') {
    Write-Host "Upload cancelled" -ForegroundColor Red
    exit
}

Write-Host ""
Write-Host "Running upload script..." -ForegroundColor Green
node upload-prompt.js

Write-Host ""
Write-Host "Script completed" -ForegroundColor Cyan