#!/bin/bash

# Test script for async review system
# This script tests the new async review endpoints

BASE_URL="http://localhost:3001"

echo "================================================"
echo "ContentReviewerAI - Async Review System Tests"
echo "================================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Text Review
echo -e "${YELLOW}Test 1: Submit Text Review${NC}"
echo "-------------------------------------------"

TEXT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/review/text" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "This is a test content for review. It contains some text that should be reviewed by the GOV.UK content reviewer. The text includes various sentences to test the review system.",
    "title": "Test Content Review"
  }')

echo "Response: $TEXT_RESPONSE"

# Extract reviewId using grep and sed (portable)
TEXT_REVIEW_ID=$(echo "$TEXT_RESPONSE" | grep -o '"reviewId":"[^"]*"' | sed 's/"reviewId":"\(.*\)"/\1/')

if [ -n "$TEXT_REVIEW_ID" ]; then
  echo -e "${GREEN}✓ Text review submitted successfully${NC}"
  echo "Review ID: $TEXT_REVIEW_ID"
else
  echo -e "${RED}✗ Failed to submit text review${NC}"
  exit 1
fi

echo ""

# Test 2: Check Review Status
echo -e "${YELLOW}Test 2: Check Review Status${NC}"
echo "-------------------------------------------"

for i in {1..10}; do
  echo "Attempt $i/10..."
  
  STATUS_RESPONSE=$(curl -s "$BASE_URL/api/review/$TEXT_REVIEW_ID")
  echo "Response: $STATUS_RESPONSE"
  
  STATUS=$(echo "$STATUS_RESPONSE" | grep -o '"status":"[^"]*"' | sed 's/"status":"\(.*\)"/\1/')
  echo "Current status: $STATUS"
  
  if [ "$STATUS" = "completed" ]; then
    echo -e "${GREEN}✓ Review completed successfully${NC}"
    break
  elif [ "$STATUS" = "failed" ]; then
    echo -e "${RED}✗ Review failed${NC}"
    exit 1
  else
    echo "Status: $STATUS (waiting...)"
    sleep 3
  fi
  
  if [ $i -eq 10 ]; then
    echo -e "${YELLOW}⚠ Review still processing after 30 seconds${NC}"
  fi
done

echo ""

# Test 3: Get Review History
echo -e "${YELLOW}Test 3: Get Review History${NC}"
echo "-------------------------------------------"

HISTORY_RESPONSE=$(curl -s "$BASE_URL/api/reviews?limit=5")
echo "Response: $HISTORY_RESPONSE"

REVIEW_COUNT=$(echo "$HISTORY_RESPONSE" | grep -o '"returned":[0-9]*' | sed 's/"returned":\([0-9]*\)/\1/')

if [ -n "$REVIEW_COUNT" ] && [ "$REVIEW_COUNT" -gt 0 ]; then
  echo -e "${GREEN}✓ Review history retrieved successfully${NC}"
  echo "Found $REVIEW_COUNT reviews"
else
  echo -e "${YELLOW}⚠ No reviews in history yet${NC}"
fi

echo ""

# Test 4: Health Check
echo -e "${YELLOW}Test 4: Health Check${NC}"
echo "-------------------------------------------"

HEALTH_RESPONSE=$(curl -s "$BASE_URL/health")
echo "Response: $HEALTH_RESPONSE"

if echo "$HEALTH_RESPONSE" | grep -q '"status":"ok"'; then
  echo -e "${GREEN}✓ Health check passed${NC}"
else
  echo -e "${RED}✗ Health check failed${NC}"
fi

echo ""

# Test 5: SQS Worker Status
echo -e "${YELLOW}Test 5: SQS Worker Status${NC}"
echo "-------------------------------------------"

WORKER_RESPONSE=$(curl -s "$BASE_URL/api/sqs-worker/status")
echo "Response: $WORKER_RESPONSE"

if echo "$WORKER_RESPONSE" | grep -q '"running":true'; then
  echo -e "${GREEN}✓ SQS Worker is running${NC}"
else
  echo -e "${YELLOW}⚠ SQS Worker may not be running${NC}"
fi

echo ""
echo "================================================"
echo "Test Suite Complete"
echo "================================================"
echo ""
echo "To test file upload manually, run:"
echo "curl -X POST $BASE_URL/api/review/file -F \"file=@/path/to/document.pdf\""
echo ""
