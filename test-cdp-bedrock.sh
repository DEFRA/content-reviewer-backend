#!/bin/bash
# CDP Bedrock Test Script
# This script tests Bedrock access using AWS CLI in CDP environment
# Run this from the CDP terminal after deployment

set -e

echo "=================================================="
echo "CDP Bedrock Access Test"
echo "=================================================="
echo ""

# Step 1: Find inference profiles
echo "Step 1: Finding inference profiles for service: $SERVICE"
echo "--------------------------------------------------"
inference_profiles=$(aws bedrock list-inference-profiles --type-equals APPLICATION | \
  jq '[.inferenceProfileSummaries[] | select(.inferenceProfileName | startswith(env.SERVICE)) | {"model_arn": .models[0].modelArn, "inference_profile_arn": .inferenceProfileArn}]')

echo "$inference_profiles" | jq .

# Extract the first inference profile ARN (should be Claude Sonnet)
inference_profile_arn=$(echo "$inference_profiles" | jq -r '.[0].inference_profile_arn')

if [ -z "$inference_profile_arn" ] || [ "$inference_profile_arn" = "null" ]; then
  echo "❌ ERROR: No inference profile found for service $SERVICE"
  exit 1
fi

echo ""
echo "✅ Using inference profile: $inference_profile_arn"
echo ""

# Step 2: Find available guardrails
echo "Step 2: Finding available guardrails"
echo "--------------------------------------------------"
guardrails=$(aws bedrock list-guardrails | jq '[.guardrails | sort_by(.name)[] | {"name": .name, "arn": .arn}]')
echo "$guardrails" | jq .

# Look for service-specific guardrail or use platform medium
guardrail_arn=$(echo "$guardrails" | jq -r --arg service "$SERVICE" '.[] | select(.name | contains($service)) | .arn' | head -n 1)

if [ -z "$guardrail_arn" ] || [ "$guardrail_arn" = "null" ]; then
  echo ""
  echo "⚠️  No service-specific guardrail found, using cdp-platform-medium"
  guardrail_arn=$(echo "$guardrails" | jq -r '.[] | select(.name == "cdp-platform-medium") | .arn')
fi

if [ -z "$guardrail_arn" ] || [ "$guardrail_arn" = "null" ]; then
  echo "❌ ERROR: No suitable guardrail found"
  exit 1
fi

echo ""
echo "✅ Using guardrail: $guardrail_arn"
echo ""

# Step 3: Test InvokeModel API
echo "Step 3: Testing Bedrock InvokeModel API"
echo "--------------------------------------------------"

# Create request body
body=$(echo '{
  "anthropic_version": "bedrock-2023-05-31",
  "max_tokens": 500,
  "messages": [
    {
      "role": "user",
      "content": "Please review this test content for GOV.UK compliance: This is a test document."
    }
  ]
}' | base64 -w 0)

# Invoke model
echo "Invoking Bedrock model..."
aws bedrock-runtime invoke-model \
    --model-id "${inference_profile_arn}" \
    --content-type "application/json" \
    --accept "application/json" \
    --trace "ENABLED" \
    --body "${body}" \
    --guardrail-identifier "${guardrail_arn}" \
    --guardrail-version "1" \
    bedrock-response.json

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Bedrock InvokeModel succeeded!"
  echo ""
  echo "Response:"
  echo "--------------------------------------------------"
  cat bedrock-response.json | jq -r '.content[0].text'
  echo ""
  echo ""
  echo "=================================================="
  echo "✅ ALL BEDROCK TESTS PASSED"
  echo "=================================================="
  echo ""
  echo "Configuration to use in your application:"
  echo "  - Inference Profile ARN: $inference_profile_arn"
  echo "  - Guardrail ARN: $guardrail_arn"
  echo ""
else
  echo ""
  echo "❌ Bedrock InvokeModel failed!"
  exit 1
fi

# Cleanup
rm -f bedrock-response.json
