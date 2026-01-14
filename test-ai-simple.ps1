# Simple AI Review Test
# Tests the complete AI review flow with proper compression handling

$ApiKey = "YOUR_API_KEY_HERE"  # <-- PASTE YOUR CDP API KEY HERE
$baseUrl = "https://ephemeral-protected.api.dev.cdp-int.defra.cloud/content-reviewer-backend"

$headers = @{
    "x-api-key" = $ApiKey
    "Content-Type" = "application/json"
    "Accept-Encoding" = "identity"  # Disable compression to avoid GZip errors
}

Write-Host "Submitting test content for AI review..."

$body = @{
    content = "This is a test document for GOV.UK content review. It demonstrates the AI review system working with S3 storage."
    title = "Test - AI Review"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "$baseUrl/api/review/text" -Method POST -Headers $headers -Body $body
$reviewId = $response.reviewId

Write-Host "Review submitted! ID: $reviewId"
Write-Host "Waiting for AI processing..."

for ($i = 1; $i -le 8; $i++) {
    Start-Sleep -Seconds 5
    Write-Host "  Checking... attempt $i/8"
    
    try {
        $result = Invoke-RestMethod -Uri "$baseUrl/api/review/$reviewId" -Method GET -Headers $headers
        
        if ($result.review.status -eq "completed") {
            Write-Host "`n============================================" -ForegroundColor Green
            Write-Host "AI REVIEW COMPLETED!" -ForegroundColor Green
            Write-Host "============================================`n" -ForegroundColor Green
            Write-Host $result.review.result.reviewContent
            Write-Host "`n============================================`n" -ForegroundColor Green
            break
        }
    }
    catch {
        # Continue polling
    }
}

Write-Host "Done!"
