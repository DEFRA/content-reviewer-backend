# CDP Testing Guide

This guide explains how to test your ContentReviewerAI backend after deploying to CDP.

## Prerequisites

- Service deployed to CDP
- Access to CDP terminal
- `$SERVICE` environment variable set (should be automatic in CDP)

## Testing Approach

We provide two complementary testing scripts:

### 1. `test-cdp-bedrock.sh` - AWS Bedrock Access Test

Tests that your service can access AWS Bedrock directly using AWS CLI.

### 2. `test-cdp-api.sh` - API Endpoint Test

Tests your actual application endpoints end-to-end.

---

## Quick Start

### Step 1: Access CDP Terminal

```bash
# SSH into your CDP service container
# (Follow your organization's CDP access procedures)
```

### Step 2: Upload Test Scripts

Copy the test scripts to your CDP environment:

```bash
# If scripts are in your repo, they should already be available
cd /path/to/backend

# Make scripts executable
chmod +x test-cdp-bedrock.sh test-cdp-api.sh
```

### Step 3: Run Bedrock Access Test

This verifies that Bedrock permissions are correctly configured:

```bash
./test-cdp-bedrock.sh
```

**Expected Output:**

```
✅ Using inference profile: arn:aws:bedrock:eu-west-2:xxx:application-inference-profile/xxx
✅ Using guardrail: arn:aws:bedrock:eu-west-2:xxx:guardrail/xxx
✅ Bedrock InvokeModel succeeded!
✅ ALL BEDROCK TESTS PASSED
```

**If this fails:**

- Check that your service has Bedrock permissions in CDP
- Verify the inference profile exists for your service
- Confirm guardrail is properly configured

### Step 4: Run API Endpoint Test

This tests your actual application:

```bash
# Set backend URL (adjust if needed)
export BACKEND_URL="http://localhost:3000"

# Run tests
./test-cdp-api.sh
```

**Expected Output:**

```
✅ Health check passed
✅ Worker status check passed
✅ Text review submitted successfully
✅ Status check passed
✅ History check passed
✅ ALL API TESTS PASSED
```

---

## Manual Testing with AWS CLI

If you prefer to test manually, follow these steps from CDP documentation:

### Find Inference Profiles

```bash
# List inference profiles for your service
aws bedrock list-inference-profiles --type-equals APPLICATION | \
  jq '[.inferenceProfileSummaries[] | select(.inferenceProfileName | startswith(env.SERVICE)) | {"model_arn": .models[0].modelArn, "inference_profile_arn": .inferenceProfileArn}]'

# Save the inference profile ARN
export INFERENCE_PROFILE_ARN="<your-arn-here>"
```

### Find Guardrails

```bash
# List available guardrails
aws bedrock list-guardrails | \
  jq '[.guardrails | sort_by(.name)[] | {"name": .name, "arn": .arn}]'

# Save your guardrail ARN
export GUARDRAIL_ARN="<your-guardrail-arn>"
```

### Test Bedrock Invocation

```bash
# Create request body
body=$(echo '{
  "anthropic_version": "bedrock-2023-05-31",
  "max_tokens": 1000,
  "messages": [
    {
      "role": "user",
      "content": "Please review this content for GOV.UK compliance."
    }
  ]
}' | base64 -w 0)

# Invoke model
aws bedrock-runtime invoke-model \
    --model-id "${INFERENCE_PROFILE_ARN}" \
    --content-type "application/json" \
    --accept "application/json" \
    --trace "ENABLED" \
    --body "${body}" \
    --guardrail-identifier "${GUARDRAIL_ARN}" \
    --guardrail-version "1" \
    response.json

# Check response
cat response.json | jq -r '.content[0].text'
```

---

## Manual API Testing with curl

### Health Check

```bash
curl http://localhost:3000/health | jq .
```

### Worker Status

```bash
curl http://localhost:3000/api/review/worker-status | jq .
```

### Submit Text Review

```bash
curl -X POST http://localhost:3000/api/review/text \
  -H "Content-Type: application/json" \
  -d '{
    "text": "This is a test document for GOV.UK content review.",
    "metadata": {"source": "manual-test"}
  }' | jq .
```

### Check Review Status

```bash
# Use the reviewId from the previous response
REVIEW_ID="<review-id-here>"
curl http://localhost:3000/api/review/status/$REVIEW_ID | jq .
```

### Get Review History

```bash
curl http://localhost:3000/api/review/history?limit=10 | jq .
```

---

## Troubleshooting

### Bedrock Access Denied

**Error:**

```
AccessDeniedException: User is not authorized to perform: bedrock:InvokeModel
```

**Solutions:**

1. Ensure you're using the **inference profile ARN**, not the model ARN directly
2. Verify the guardrail is included in the request
3. Check that your service has Bedrock permissions in CDP

### API Endpoints Not Responding

**Error:**

```
Connection refused or timeout
```

**Solutions:**

1. Check that the service is running: `docker ps` or `kubectl get pods`
2. Verify the port (default: 3000)
3. Check service logs: `docker logs <container>` or `kubectl logs <pod>`

### SQS Worker Not Processing

**Check worker logs:**

```bash
# View recent logs
docker logs <backend-container> --tail 100

# Follow logs in real-time
docker logs <backend-container> -f | grep -i "sqs\|worker\|queue"
```

**Common issues:**

- SQS queue URL not configured
- Worker not started (check `worker-status` endpoint)
- MongoDB connection issues
- Bedrock permission issues

### MongoDB Connection Issues

**Check environment variables:**

```bash
echo $MONGODB_URI
echo $MONGODB_DB_NAME
```

**Test MongoDB connection:**

```bash
# From Node.js (if mongo shell not available)
node -e "
const { MongoClient } = require('mongodb');
const client = new MongoClient(process.env.MONGODB_URI);
client.connect()
  .then(() => console.log('✅ Connected'))
  .catch(err => console.error('❌ Failed:', err))
  .finally(() => client.close());
"
```

---

## Environment Variables to Verify

Ensure these are set in your CDP deployment:

```bash
# Core
NODE_ENV=production
SERVICE=<your-service-name>

# MongoDB
MONGODB_URI=<mongodb-connection-string>
MONGODB_DB_NAME=<database-name>

# AWS SQS
SQS_QUEUE_URL=<sqs-queue-url>
AWS_REGION=eu-west-2

# AWS Bedrock
BEDROCK_MODEL_ID=<inference-profile-arn>
BEDROCK_GUARDRAIL_ID=<guardrail-arn>

# Optional
LOG_LEVEL=info
MAX_TOKENS=4096
```

---

## Post-Deployment Checklist

- [ ] Service is running and accessible
- [ ] Health endpoint returns 200
- [ ] Worker status shows worker is running
- [ ] Bedrock AWS CLI test passes
- [ ] Can submit text review via API
- [ ] Review status can be retrieved
- [ ] Review history shows submitted reviews
- [ ] SQS messages are being processed (check logs)
- [ ] Results are stored in MongoDB
- [ ] Frontend can connect to backend
- [ ] End-to-end review flow works

---

## Additional Resources

- [CDP Bedrock Documentation](https://docs.cdp.defra.cloud.uk/docs/services/bedrock/)
- [AWS Bedrock API Reference](https://docs.aws.amazon.com/bedrock/latest/APIReference/)
- [Backend Documentation](./ASYNC-REVIEW-SYSTEM.md)
- [Frontend Integration](./FRONTEND-INTEGRATION.md)

---

## Support

If tests continue to fail after troubleshooting:

1. Check CDP platform status
2. Review service logs in CDP monitoring
3. Verify all infrastructure (MongoDB, SQS, Bedrock) is provisioned
4. Contact CDP platform support if needed
