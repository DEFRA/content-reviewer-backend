# AWS Credentials & Bedrock Troubleshooting Guide

This guide helps diagnose and fix issues with the `/api/review` endpoint returning 502/500 errors.

## Quick Diagnosis

### Local Testing

Run the test script to verify AWS credentials and Bedrock access:

```bash
node test-aws-credentials.js
```

**Expected locally**: Test will FAIL with `CredentialsProviderError` (this is normal)

### CDP Testing

1. Deploy your changes to CDP
2. SSH into the CDP instance
3. Navigate to the application directory
4. Run the test script:

```bash
cd /path/to/app
node test-aws-credentials.js
```

**Expected in CDP**: Test should PASS

If it fails in CDP, see the troubleshooting section below.

## Error Logging Enhancements

The following enhancements have been added to help diagnose issues:

### 1. Bedrock Client Initialization Logging

When the server starts, you'll see:

```json
{
  "message": "Bedrock client initialized with CDP inference profile",
  "inferenceProfileArn": "arn:aws:bedrock:...",
  "guardrailArn": "arn:aws:bedrock:...",
  "region": "eu-west-2",
  "awsProfile": "none",
  "hasAccessKeyId": false,
  "hasSecretAccessKey": false,
  "hasSessionToken": false,
  "nodeEnv": "production"
}
```

### 2. Detailed Error Logging

When the `/api/review` endpoint fails, you'll see three error blocks:

#### A. Bedrock API Error Block

```
=== BEDROCK API ERROR ===
Error Name: CredentialsProviderError
Error Message: Could not load credentials from any providers
Error Code: undefined
HTTP Status: undefined
Request ID: undefined
Full Error: [error object]
=========================
```

#### B. Credential Diagnostics (for credential errors only)

```
=== CREDENTIAL DIAGNOSTICS ===
AWS Profile: none
Has Access Key ID: false
Has Secret Access Key: false
Has Session Token: false
Node Env: production
AWS Region: eu-west-2
==============================
```

#### C. Route Handler Error Block

```
=== REVIEW ENDPOINT ERROR ===
Error Name: Error
Error Message: AWS credentials not found. In CDP, ensure EC2 instance has IAM role with Bedrock permissions.
Is Boom: false
Full Error: [error object]
=============================
```

## Common Issues & Solutions

### Issue 1: CredentialsProviderError in CDP

**Symptoms:**

- `/api/review` returns 500 error
- Logs show: `CredentialsProviderError: Could not load credentials from any providers`

**Root Cause:** EC2 instance doesn't have an IAM role attached or can't access IMDS

**Solutions:**

1. **Check IAM Role is Attached**

   ```bash
   # On the CDP instance
   curl http://169.254.169.254/latest/meta-data/iam/info
   ```

   Should return JSON with IAM role details. If it returns 404, no role is attached.

2. **Attach IAM Role** (via AWS Console or CDP deployment config)
   - Go to EC2 Console → Instances → Select your instance
   - Actions → Security → Modify IAM role
   - Attach the role with Bedrock permissions

3. **Verify IMDS Access**
   ```bash
   # Should return "0.0.0.0"
   curl http://169.254.169.254/latest/meta-data/local-ipv4
   ```

### Issue 2: AccessDeniedException

**Symptoms:**

- `/api/review` returns 500 error
- Logs show: `AccessDeniedException: User is not authorized`

**Root Cause:** IAM role lacks required Bedrock permissions

**Solution:**

Add these permissions to the IAM role policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:ApplyGuardrail"
      ],
      "Resource": [
        "arn:aws:bedrock:eu-west-2:332499610595:inference-profile/*",
        "arn:aws:bedrock:eu-west-2:332499610595:guardrail/*"
      ]
    }
  ]
}
```

### Issue 3: ResourceNotFoundException

**Symptoms:**

- Logs show: `ResourceNotFoundException: Could not find the requested resource`

**Root Cause:** Inference profile ARN or guardrail ARN is incorrect

**Solution:**

1. Verify the ARNs in your config:
   - Inference Profile: `arn:aws:bedrock:eu-west-2:332499610595:inference-profile/eu.anthropic.claude-3-5-sonnet-20241022-v2:0`
   - Guardrail: `arn:aws:bedrock:eu-west-2:332499610595:guardrail/j7sbivk41lq4`
   - Guardrail Version: `3`

2. Check they exist in the correct region and account

### Issue 4: ThrottlingException

**Symptoms:**

- Logs show: `ThrottlingException: Rate exceeded`

**Root Cause:** Too many requests to Bedrock API

**Solution:**

Implement retry logic with exponential backoff (already in error messages)

## Checking Logs in CDP

### OpenSearch/CloudWatch

Search for these patterns:

1. **For credential errors:**

   ```
   "CREDENTIAL DIAGNOSTICS"
   ```

2. **For Bedrock API errors:**

   ```
   "BEDROCK API ERROR"
   ```

3. **For endpoint errors:**

   ```
   "REVIEW ENDPOINT ERROR"
   ```

4. **For initialization info:**
   ```
   "Bedrock client initialized"
   ```

## Testing After Fixes

1. **Test with the diagnostic script:**

   ```bash
   node test-aws-credentials.js
   ```

2. **Test the actual endpoint:**

   ```bash
   curl -X POST https://your-cdp-url/api/review \
     -H "Content-Type: application/json" \
     -d '{"content":"Test content for review","contentType":"general"}'
   ```

3. **Verify logs show success:**
   - Look for: `"message": "Content review completed successfully"`
   - Check for usage stats: `"tokensUsed": ...`

## Why /api/chat Works But /api/review Doesn't

If `/api/chat` works but `/api/review` fails with credential errors, possible reasons:

1. **Timing Issue**: The review endpoint takes longer, credentials might be expiring
2. **Token Refresh**: Temporary security token expired between requests
3. **Rate Limiting**: Different rate limits for different operations
4. **Resource Permissions**: Chat and review might need different permissions

To diagnose, check:

- Token expiration time in IMDS metadata
- Time between requests
- Different resource ARNs being accessed

## Additional Diagnostics

### Check Instance Metadata Service

```bash
# Version 1 (IMDSv1)
curl http://169.254.169.254/latest/meta-data/

# Version 2 (IMDSv2)
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/
```

### Check Current Credentials

```bash
# Get temporary credentials from instance metadata
curl http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

## Next Steps

1. ✅ Enhanced error logging is in place
2. ✅ Test script created for diagnostics
3. 🔄 Deploy to CDP with these changes
4. 🔄 Run test script in CDP
5. 🔄 Analyze the detailed error output
6. 🔄 Apply the appropriate fix based on the error
7. 🔄 Re-test and verify

## Contact

If issues persist after trying these solutions, provide:

- Full error output from the console logs (=== blocks)
- Output of `node test-aws-credentials.js` in CDP
- IAM role ARN and attached policies
- Region and account ID
