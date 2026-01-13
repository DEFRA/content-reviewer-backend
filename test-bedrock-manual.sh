#!/bin/bash
# Manual Bedrock Test Script for CDP
# Copy and paste this entire script into CDP terminal

echo "=================================================="
echo "Manual Bedrock Test"
echo "=================================================="
echo ""

# Set the ARNs (these worked yesterday)
inference_profile_arn="arn:aws:bedrock:eu-west-2:332499610595:application-inference-profile/wrmld9jrycya"
guardrail_arn="arn:aws:bedrock:eu-west-2:332499610595:guardrail/th34diy2ti2t"

echo "Using inference profile: $inference_profile_arn"
echo "Using guardrail: $guardrail_arn"
echo ""

# Test 1: Simple hello test
echo "Test 1: Simple Hello Test"
echo "--------------------------------------------------"
body=$(echo '{"anthropic_version":"bedrock-2023-05-31","max_tokens":100,"messages":[{"role":"user","content":"Say hello"}]}' | base64 -w 0)

aws bedrock-runtime invoke-model \
    --model-id "${inference_profile_arn}" \
    --content-type "application/json" \
    --accept "application/json" \
    --body "${body}" \
    --guardrail-identifier "${guardrail_arn}" \
    --guardrail-version "1" \
    response.json

echo ""
echo "Response:"
cat response.json | jq -r '.content[0].text'
echo ""
echo ""

# Test 2: Full review test (timed)
echo "Test 2: Full GOV.UK Review Test (with timing)"
echo "--------------------------------------------------"
review_body=$(echo '{
  "anthropic_version": "bedrock-2023-05-31",
  "max_tokens": 1000,
  "messages": [
    {
      "role": "user",
      "content": "Review this content for GOV.UK compliance. Assess clarity, plain English, structure. Provide: assessment, 2 strengths, 2 issues, 2 suggestions, score (0-10).\n\nContent:\nThis is a sample policy document. The purpose of this policy is to ensure compliance with regulatory requirements. All staff must follow the procedures outlined in this document."
    }
  ]
}' | base64 -w 0)

echo "Sending review request..."
time aws bedrock-runtime invoke-model \
    --model-id "${inference_profile_arn}" \
    --content-type "application/json" \
    --accept "application/json" \
    --trace "ENABLED" \
    --body "${review_body}" \
    --guardrail-identifier "${guardrail_arn}" \
    --guardrail-version "1" \
    review-response.json

echo ""
echo "Review Response:"
echo "--------------------------------------------------"
cat review-response.json | jq -r '.content[0].text'
echo ""
echo ""
echo "Token Usage:"
cat review-response.json | jq '.usage'
echo ""

# Cleanup
rm -f response.json review-response.json

echo "=================================================="
echo "✅ Bedrock Tests Complete"
echo "=================================================="
echo ""
echo "If both tests passed, Bedrock is working correctly!"
echo "The review took ~10 seconds, which is expected for Claude."
echo ""
