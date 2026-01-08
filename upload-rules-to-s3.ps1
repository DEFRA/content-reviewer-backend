# Upload Rules to S3 Bucket
# This script uploads the GOV.UK content QA rules to the S3 bucket

param(
    [string]$BackendUrl = "http://localhost:3000",
    [string]$RulesFile = "rules/govuk-content-qa-rules.md"
)

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Upload Rules to S3" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# Check if rules file exists
if (-not (Test-Path $RulesFile)) {
    Write-Host "❌ Error: Rules file not found: $RulesFile" -ForegroundColor Red
    exit 1
}

Write-Host "✓ Found rules file: $RulesFile" -ForegroundColor Green
Write-Host ""

# Get file info
$fileInfo = Get-Item $RulesFile
Write-Host "File Details:" -ForegroundColor Yellow
Write-Host "  Name: $($fileInfo.Name)"
Write-Host "  Size: $($fileInfo.Length) bytes"
Write-Host "  Last Modified: $($fileInfo.LastWriteTime)"
Write-Host ""

# Call API endpoint to upload rules
Write-Host "Uploading rules to S3..." -ForegroundColor Yellow

try {
    $response = Invoke-RestMethod -Uri "$BackendUrl/api/rules/initialize" -Method POST
    
    if ($response.success) {
        Write-Host "✓ Rules uploaded successfully!" -ForegroundColor Green
        Write-Host ""
        Write-Host "Upload Details:" -ForegroundColor Yellow
        Write-Host "  Bucket: $($response.bucket)"
        Write-Host "  Key: $($response.key)"
        Write-Host "  Size: $($response.size) bytes"
        Write-Host "  Location: $($response.location)"
        Write-Host ""
        Write-Host "✓ Rules are now available for AI content review" -ForegroundColor Green
    } else {
        Write-Host "❌ Failed to upload rules: $($response.error)" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "❌ Error uploading rules: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Done!" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
