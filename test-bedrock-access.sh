#!/bin/bash
# Test Bedrock Access from CDP Service
# Run this from the CDP terminal (SSH into your service container)

echo "=========================================="
echo "Bedrock Access Test for Content Reviewer"
echo "=========================================="
echo ""

# Your service's configured ARNs
inference_profile_arn="arn:aws:bedrock:eu-west-2:332499610595:application-inference-profile/wrmld9jrycya"
guardrail_arn="arn:aws:bedrock:eu-west-2:332499610595:guardrail/th34diy2ti2t"
guardrail_version="1"

echo "Configuration:"
echo "  Inference Profile: $inference_profile_arn"
echo "  Guardrail: $guardrail_arn"
echo "  Guardrail Version: $guardrail_version"
echo ""

# Create request body
echo "Creating test request..."
body=$(echo '{
  "anthropic_version": "bedrock-2023-05-31",
  "max_tokens": 100,
  "messages": [
    {
      "role": "user",
      "content": "Say hello in one sentence"
    }
  ]
}' | base64 -w 0)

echo "Request body created (base64 encoded)"
echo ""

# Test 1: Invoke with inference profile and guardrail (SHOULD WORK)
echo "=========================================="
echo "TEST 1: Invoke with Inference Profile + Guardrail"
echo "=========================================="
echo "This should succeed..."
echo ""

aws bedrock-runtime invoke-model \
    --model-id "${inference_profile_arn}" \
    --content-type "application/json" \
    --accept "application/json" \
    --trace "ENABLED" \
    --body "${body}" \
    --guardrail-identifier "${guardrail_arn}" \
    --guardrail-version "${guardrail_version}" \
    response.json

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ SUCCESS! Bedrock access is working"
    echo ""
    echo "Response from Claude:"
    echo "---"
    cat response.json | jq -r '.content[0].text'
    echo "---"
    echo ""
    echo "Full response metadata:"
    cat response.json | jq '{
        model: .modelId,
        stopReason: .stopReason,
        usage: .usage,
        guardrail: .trace.guardrail.action
    }'
else
    echo ""
    echo "❌ FAILED! Check the error above"
    echo ""
    echo "Common issues:"
    echo "  1. IAM role doesn't have bedrock:InvokeModel permission"
    echo "  2. Inference profile ARN is incorrect"
    echo "  3. Guardrail ARN is incorrect"
    echo "  4. Service is not running in CDP environment"
fi

echo ""
echo ""

# Test 2: Invoke without guardrail (SHOULD FAIL)
echo "=========================================="
echo "TEST 2: Invoke WITHOUT Guardrail"
echo "=========================================="
echo "This should fail (guardrails are required)..."
echo ""

aws bedrock-runtime invoke-model \
    --model-id "${inference_profile_arn}" \
    --content-type "application/json" \
    --accept "application/json" \
    --trace "ENABLED" \
    --body "${body}" \
    response-no-guardrail.json 2>&1

if [ $? -ne 0 ]; then
    echo ""
    echo "✅ EXPECTED: Request failed without guardrail (this is correct)"
else
    echo ""
    echo "⚠️  WARNING: Request succeeded without guardrail (unexpected)"
fi

echo ""
echo ""

# Test 3: Invoke model directly (SHOULD FAIL)
echo "=========================================="
echo "TEST 3: Invoke Model Directly"
echo "=========================================="
echo "This should fail (must use inference profile)..."
echo ""

aws bedrock-runtime invoke-model \
    --model-id "anthropic.claude-3-7-sonnet-20250219-v1:0" \
    --content-type "application/json" \
    --accept "application/json" \
    --trace "ENABLED" \
    --body "${body}" \
    --guardrail-identifier "${guardrail_arn}" \
    --guardrail-version "${guardrail_version}" \
    response-direct.json 2>&1

if [ $? -ne 0 ]; then
    echo ""
    echo "✅ EXPECTED: Direct model access failed (this is correct)"
else
    echo ""
    echo "⚠️  WARNING: Direct model access succeeded (unexpected)"
fi

echo ""
echo ""

# Cleanup
rm -f response.json response-no-guardrail.json response-direct.json

echo "=========================================="
echo "Test Complete!"
echo "=========================================="
echo ""
echo "If TEST 1 succeeded, your Bedrock access is configured correctly."
echo "If TEST 1 failed, you need to fix IAM permissions or ARN configuration."
echo ""
