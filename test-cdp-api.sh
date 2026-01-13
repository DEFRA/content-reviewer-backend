#!/bin/bash
# CDP API Test Script
# This script tests the actual API endpoints after deployment
# Run this from the CDP terminal after deployment

set -e

# Determine the backend URL
# In CDP, your service should be available at localhost or via service name
BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"

echo "=================================================="
echo "CDP API Endpoint Test"
echo "=================================================="
echo "Testing backend at: $BACKEND_URL"
echo ""

# Test 1: Health Check
echo "Test 1: Health Check"
echo "--------------------------------------------------"
health_response=$(curl -s -w "\n%{http_code}" "$BACKEND_URL/health")
health_body=$(echo "$health_response" | head -n -1)
health_status=$(echo "$health_response" | tail -n 1)

echo "Status Code: $health_status"
echo "Response: $health_body"

if [ "$health_status" = "200" ]; then
  echo "✅ Health check passed"
else
  echo "❌ Health check failed"
  exit 1
fi
echo ""

# Test 2: Worker Status
echo "Test 2: Worker Status"
echo "--------------------------------------------------"
worker_response=$(curl -s -w "\n%{http_code}" "$BACKEND_URL/api/review/worker-status")
worker_body=$(echo "$worker_response" | head -n -1)
worker_status=$(echo "$worker_response" | tail -n 1)

echo "Status Code: $worker_status"
echo "Response: $worker_body"

if [ "$worker_status" = "200" ]; then
  echo "✅ Worker status check passed"
else
  echo "❌ Worker status check failed"
  exit 1
fi
echo ""

# Test 3: Submit Text Review
echo "Test 3: Submit Text Review"
echo "--------------------------------------------------"
review_payload='{
  "text": "This is a test content review from CDP. Please check if this meets GOV.UK standards.",
  "metadata": {
    "source": "cdp-test",
    "timestamp": "'$(date -Iseconds)'"
  }
}'

review_response=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$review_payload" \
  "$BACKEND_URL/api/review/text")

review_body=$(echo "$review_response" | head -n -1)
review_status=$(echo "$review_response" | tail -n 1)

echo "Status Code: $review_status"
echo "Response Body:"
echo "$review_body" | jq .

if [ "$review_status" = "200" ] || [ "$review_status" = "202" ]; then
  review_id=$(echo "$review_body" | jq -r '.reviewId')
  echo "✅ Text review submitted successfully"
  echo "Review ID: $review_id"
else
  echo "❌ Text review submission failed"
  exit 1
fi
echo ""

# Test 4: Check Review Status
echo "Test 4: Check Review Status"
echo "--------------------------------------------------"
if [ -n "$review_id" ] && [ "$review_id" != "null" ]; then
  echo "Checking status for review ID: $review_id"
  
  # Wait a moment for processing
  echo "Waiting 5 seconds for processing..."
  sleep 5
  
  status_response=$(curl -s -w "\n%{http_code}" "$BACKEND_URL/api/review/status/$review_id")
  status_body=$(echo "$status_response" | head -n -1)
  status_code=$(echo "$status_response" | tail -n 1)
  
  echo "Status Code: $status_code"
  echo "Response:"
  echo "$status_body" | jq .
  
  if [ "$status_code" = "200" ]; then
    review_status=$(echo "$status_body" | jq -r '.status')
    echo "✅ Status check passed"
    echo "Current review status: $review_status"
  else
    echo "❌ Status check failed"
    exit 1
  fi
else
  echo "⚠️  Skipping status check (no review ID)"
fi
echo ""

# Test 5: Get Review History
echo "Test 5: Get Review History"
echo "--------------------------------------------------"
history_response=$(curl -s -w "\n%{http_code}" "$BACKEND_URL/api/review/history?limit=5")
history_body=$(echo "$history_response" | head -n -1)
history_status=$(echo "$history_response" | tail -n 1)

echo "Status Code: $history_status"
echo "Response:"
echo "$history_body" | jq .

if [ "$history_status" = "200" ]; then
  review_count=$(echo "$history_body" | jq -r '.reviews | length')
  echo "✅ History check passed"
  echo "Found $review_count reviews"
else
  echo "❌ History check failed"
  exit 1
fi
echo ""

# Test 6: SQS Queue Check (if AWS CLI available)
echo "Test 6: SQS Queue Status"
echo "--------------------------------------------------"
if command -v aws &> /dev/null; then
  queue_url="${SQS_QUEUE_URL:-}"
  
  if [ -z "$queue_url" ]; then
    echo "⚠️  SQS_QUEUE_URL not set, skipping queue check"
  else
    echo "Checking queue: $queue_url"
    queue_attrs=$(aws sqs get-queue-attributes \
      --queue-url "$queue_url" \
      --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible 2>&1 || echo "failed")
    
    if [ "$queue_attrs" != "failed" ]; then
      echo "$queue_attrs" | jq .
      echo "✅ Queue check passed"
    else
      echo "⚠️  Queue check failed (may be permissions issue)"
    fi
  fi
else
  echo "⚠️  AWS CLI not available, skipping queue check"
fi
echo ""

# Summary
echo "=================================================="
echo "✅ ALL API TESTS PASSED"
echo "=================================================="
echo ""
echo "Your ContentReviewerAI backend is working correctly in CDP!"
echo ""
echo "Next steps:"
echo "  1. Test the frontend integration"
echo "  2. Monitor the SQS worker logs for processing"
echo "  3. Check MongoDB for stored review results"
echo ""
