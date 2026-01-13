# Test script for CDP deployment
# Run this after redeploying to verify the service is accessible

Write-Host "=== ContentReviewerAI Backend Deployment Test ===" -ForegroundColor Cyan
Write-Host ""

# Replace this with your actual CDP service URL
$BASE_URL = "https://your-service-url.cdp-int.defra.cloud"  # UPDATE THIS!

Write-Host "Testing against: $BASE_URL" -ForegroundColor Yellow
Write-Host ""

# Test 1: Health Check
Write-Host "1. Testing /health endpoint..." -ForegroundColor Green
try {
    $response = Invoke-WebRequest -Uri "$BASE_URL/health" -Method GET -UseBasicParsing -TimeoutSec 10
    Write-Host "   ✓ Status: $($response.StatusCode)" -ForegroundColor Green
    Write-Host "   Response: $($response.Content)" -ForegroundColor Gray
} catch {
    Write-Host "   ✗ FAILED: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# Test 2: Chat endpoint (should return 400 with no body)
Write-Host "2. Testing /api/chat endpoint (empty request)..." -ForegroundColor Green
try {
    $response = Invoke-WebRequest -Uri "$BASE_URL/api/chat" -Method POST -UseBasicParsing -TimeoutSec 10 -ContentType "application/json" -Body "{}"
    Write-Host "   ✓ Status: $($response.StatusCode)" -ForegroundColor Green
    Write-Host "   Response: $($response.Content)" -ForegroundColor Gray
} catch {
    if ($_.Exception.Response.StatusCode -eq 400) {
        Write-Host "   ✓ Status: 400 (Expected - validation error)" -ForegroundColor Green
        $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        Write-Host "   Response: $responseBody" -ForegroundColor Gray
    } else {
        Write-Host "   ✗ FAILED: $($_.Exception.Message)" -ForegroundColor Red
    }
}
Write-Host ""

# Test 3: Chat endpoint with valid request
Write-Host "3. Testing /api/chat endpoint (valid request)..." -ForegroundColor Green
$validRequest = @{
    message = "Test message"
    context = "Test context for content review"
} | ConvertTo-Json

try {
    $response = Invoke-WebRequest -Uri "$BASE_URL/api/chat" -Method POST -UseBasicParsing -TimeoutSec 30 -ContentType "application/json" -Body $validRequest
    Write-Host "   ✓ Status: $($response.StatusCode)" -ForegroundColor Green
    Write-Host "   Response: $($response.Content)" -ForegroundColor Gray
} catch {
    Write-Host "   ✗ Status: $($_.Exception.Response.StatusCode)" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        Write-Host "   Response: $responseBody" -ForegroundColor Gray
    } else {
        Write-Host "   Error: $($_.Exception.Message)" -ForegroundColor Gray
    }
}
Write-Host ""

Write-Host "=== Test Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Check CDP OpenSearch logs for application logs (look for startup messages)"
Write-Host "2. Check CDP OpenSearch nginx logs for health check requests"
Write-Host "3. Verify service version in CDP portal matches your deployment"
