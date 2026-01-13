# Test AI Outputs - Content Review System

## 🧪 Testing AI Outputs

### **Option 1: Submit a Review and Check Results (Full System Test)**

This tests the complete flow with the GOV.UK review prompt.

#### Step 1: Submit a Test Review

```powershell
# From your Defra laptop
$apiKey = "YOUR_CDP_API_KEY"
$baseUrl = "https://ephemeral-protected.api.dev.cdp-int.defra.cloud/content-reviewer-backend"

$headers = @{
    "x-api-key" = $apiKey
    "Content-Type" = "application/json"
}

# Test with sample GOV.UK content
$testContent = @"
About this service

Use this service to apply for a farming grant. You can:
- check if you are eligible
- see what grants are available
- submit your application

You will need:
- your business details
- information about your farm
- details of the project you want funding for

The application takes around 30 minutes to complete.
"@

$body = @{
    content = $testContent
    title = "Test - Farming Grant Service"
} | ConvertTo-Json

# Submit the review
$response = Invoke-RestMethod -Uri "$baseUrl/api/review/text" -Method POST -Headers $headers -Body $body

Write-Host "Review submitted!" -ForegroundColor Green
Write-Host "Review ID: $($response.reviewId)" -ForegroundColor Cyan
$reviewId = $response.reviewId
```

#### Step 2: Wait for Processing (15-30 seconds)

```powershell
Write-Host "Waiting for AI to process..." -ForegroundColor Yellow
Start-Sleep -Seconds 20
```

#### Step 3: Get the AI Results

```powershell
$result = Invoke-RestMethod -Uri "$baseUrl/api/review/$reviewId" -Method GET -Headers $headers

if ($result.review.status -eq "completed") {
    Write-Host "`n============================================" -ForegroundColor Green
    Write-Host "AI REVIEW RESULTS" -ForegroundColor Green
    Write-Host "============================================`n" -ForegroundColor Green

    $aiResult = $result.review.result

    Write-Host "OVERALL ASSESSMENT:" -ForegroundColor Cyan
    Write-Host $aiResult.overallAssessment
    Write-Host ""

    Write-Host "ISSUES FOUND:" -ForegroundColor Yellow
    foreach ($issue in $aiResult.issues) {
        Write-Host "  - [$($issue.severity)] $($issue.category): $($issue.description)" -ForegroundColor Yellow
        if ($issue.suggestion) {
            Write-Host "    Suggestion: $($issue.suggestion)" -ForegroundColor Gray
        }
    }
    Write-Host ""

    Write-Host "STRENGTHS:" -ForegroundColor Green
    foreach ($strength in $aiResult.strengths) {
        Write-Host "  + $strength" -ForegroundColor Green
    }
    Write-Host ""

    Write-Host "RECOMMENDATIONS:" -ForegroundColor Cyan
    foreach ($rec in $aiResult.recommendations) {
        Write-Host "  → $rec" -ForegroundColor Cyan
    }
    Write-Host ""

    Write-Host "TOKENS USED: $($result.review.bedrockUsage.totalTokens)" -ForegroundColor Gray
} else {
    Write-Host "Still processing... Status: $($result.review.status)" -ForegroundColor Yellow
    Write-Host "Try again in a few seconds" -ForegroundColor Yellow
}
```

---

## **Option 2: Quick Chat Endpoint Test (Direct AI)**

This tests Bedrock directly without the review system:

```powershell
$chatBody = @{
    message = "Review this GOV.UK content: 'You must apply for a licence before you can start work. Applications take 4 to 6 weeks to process.'"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "$baseUrl/api/chat" -Method POST -Headers $headers -Body $chatBody -TimeoutSec 30

Write-Host "`nAI Response:" -ForegroundColor Cyan
Write-Host $response.response
Write-Host "`nTokens used: $($response.usage.totalTokens)" -ForegroundColor Gray
```

---

## **Option 3: Test Different Content Types**

### Test Case 1: Good GOV.UK Content

```powershell
$goodContent = @"
Check if you're eligible

You can apply for this grant if you:
- are a farmer or landowner in England
- have at least 5 hectares of agricultural land
- can show how the project will benefit the environment

You cannot apply if you've already started the project.
"@

# Submit and check (use steps from Option 1)
```

### Test Case 2: Content That Needs Improvement

```powershell
$poorContent = @"
Utilise this governmental digital interface to facilitate the submission of requisite documentation
pertaining to agricultural subsidy applications. The aforementioned service enables stakeholders to:
- Ascertain eligibility parameters
- Peruse available funding mechanisms
- Effectuate application submission

Prerequisites encompass comprehensive business particulars and agricultural holdings information.
"@

# Submit and check - AI should flag complex language
```

### Test Case 3: Content with Accessibility Issues

```powershell
$accessibilityIssues = @"
IMPORTANT!!!

Click here to apply NOW!

You MUST read all the terms and conditions before proceeding. Failure to do so will result in
your application being rejected. Make sure you understand everything because we won't accept
any excuses later.

Contact us via phone (no other methods accepted).
"@

# Submit and check - AI should flag tone, caps, accessibility issues
```

### Test Case 4: Document Structure Issues

```powershell
$structureIssues = @"
This service helps you apply for grants. To apply you need to have all your documents ready.
You also need to know your business details. And you need to have information about your farm.
Applications take a while to process so make sure you apply early. You can check the status of
your application online. But you need to create an account first. Make sure you remember your password.
"@

# Submit and check - AI should suggest better structure/headings
```

---

## **Option 4: Create a Comprehensive Test Script**

Save this as `test-ai-outputs.ps1`:

```powershell
# Test AI Content Review Outputs
# This script tests various content samples and displays the AI feedback

$apiKey = "YOUR_CDP_API_KEY"
$baseUrl = "https://ephemeral-protected.api.dev.cdp-int.defra.cloud/content-reviewer-backend"

$headers = @{
    "x-api-key" = $apiKey
    "Content-Type" = "application/json"
}

function Test-Content {
    param(
        [string]$Content,
        [string]$TestName
    )

    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "TEST: $TestName" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    # Submit review
    $body = @{
        content = $Content
        title = $TestName
    } | ConvertTo-Json

    $response = Invoke-RestMethod -Uri "$baseUrl/api/review/text" -Method POST -Headers $headers -Body $body
    $reviewId = $response.reviewId

    Write-Host "Submitted. Review ID: $reviewId" -ForegroundColor Gray
    Write-Host "Waiting for AI processing..." -ForegroundColor Yellow

    # Wait and retry
    $maxAttempts = 6
    $attempt = 0

    while ($attempt -lt $maxAttempts) {
        Start-Sleep -Seconds 5
        $attempt++

        $result = Invoke-RestMethod -Uri "$baseUrl/api/review/$reviewId" -Method GET -Headers $headers

        if ($result.review.status -eq "completed") {
            $aiResult = $result.review.result

            Write-Host "`nOVERALL ASSESSMENT:" -ForegroundColor Green
            Write-Host $aiResult.overallAssessment

            if ($aiResult.issues -and $aiResult.issues.Count -gt 0) {
                Write-Host "`nISSUES ($($aiResult.issues.Count)):" -ForegroundColor Yellow
                foreach ($issue in $aiResult.issues) {
                    Write-Host "  [$($issue.severity)] $($issue.category): $($issue.description)" -ForegroundColor Yellow
                }
            }

            if ($aiResult.strengths -and $aiResult.strengths.Count -gt 0) {
                Write-Host "`nSTRENGTHS ($($aiResult.strengths.Count)):" -ForegroundColor Green
                foreach ($strength in $aiResult.strengths) {
                    Write-Host "  + $strength" -ForegroundColor Green
                }
            }

            Write-Host "`nTokens: $($result.review.bedrockUsage.totalTokens)" -ForegroundColor Gray
            return
        }

        Write-Host "  Attempt $attempt/$maxAttempts - Status: $($result.review.status)" -ForegroundColor Gray
    }

    Write-Host "Timeout waiting for results" -ForegroundColor Red
}

# Test Cases
Write-Host "==================================" -ForegroundColor Cyan
Write-Host "AI OUTPUT TESTING" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan

Test-Content -TestName "Good GOV.UK Content" -Content @"
Check if you're eligible

You can apply for this grant if you:
- are a farmer in England
- have at least 5 hectares of land
- can show environmental benefits

You cannot apply if you've already started the project.
"@

Test-Content -TestName "Overly Complex Language" -Content @"
Utilise this governmental digital interface to facilitate the submission of requisite
documentation pertaining to agricultural subsidy applications.
"@

Test-Content -TestName "Accessibility Issues" -Content @"
IMPORTANT!!! Click HERE to apply NOW!!!

You MUST read everything before proceeding.
"@

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "ALL TESTS COMPLETE" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
```

---

## **Option 5: View Results in S3**

If you want to see the raw AI output directly from S3:

```bash
# List all reviews
aws s3 ls s3://dev-service-optimisation-c63f2/reviews/ --recursive

# Download a specific review
aws s3 cp s3://dev-service-optimisation-c63f2/reviews/2026/01/13/review_XXXXX.json ./review.json

# View the JSON
cat review.json | jq .
```

---

## **Option 6: Test via API with curl (if you prefer)**

```bash
# Submit review
curl -X POST "https://ephemeral-protected.api.dev.cdp-int.defra.cloud/content-reviewer-backend/api/review/text" \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Test content for GOV.UK review",
    "title": "Test Document"
  }'

# Get result (replace REVIEW_ID)
curl -X GET "https://ephemeral-protected.api.dev.cdp-int.defra.cloud/content-reviewer-backend/api/review/REVIEW_ID" \
  -H "x-api-key: YOUR_KEY"
```

---

## 📋 **What the AI Reviews**

Based on the GOV.UK Content Design principles, the AI checks:

1. **Clarity** - Plain English, clear language
2. **Structure** - Headings, lists, logical flow
3. **Tone** - Friendly, helpful, not threatening
4. **Accessibility** - Screen reader friendly, no barriers
5. **Actionability** - Clear next steps
6. **Inclusivity** - Considers all users
7. **Conciseness** - No unnecessary words
8. **User Focus** - Written for the user, not the government

---

## 🎯 **Recommended Testing Workflow**

1. **Start with Option 1** - Test the full system
2. **Use Option 4** - Run comprehensive tests with the script
3. **Review results** - See what the AI flags
4. **Iterate** - Test different content types
5. **Document patterns** - Note what the AI consistently catches

---

## 📊 **Example Expected Output**

```
OVERALL ASSESSMENT:
This content generally follows GOV.UK standards but has a few areas for improvement...

ISSUES:
  [medium] Clarity: "Utilise" should be simplified to "use" for better readability
  [minor] Tone: Consider using more active voice

STRENGTHS:
  + Clear bullet point structure
  + Logical information hierarchy
  + Good use of "you" language

RECOMMENDATIONS:
  → Add a clear title at the beginning
  → Consider breaking long paragraphs into shorter ones
  → Add estimated time to complete
```

---

## ✨ **Quick Start**

**Fastest way to test:**

1. Copy the test script from Option 1
2. Replace `YOUR_CDP_API_KEY` with your actual key
3. Run it
4. Wait 20 seconds
5. See the AI output!

---

Would you like me to create any of these test scripts as actual files you can copy to your Defra laptop?
