# Quick Reference: Bedrock Error Diagnostics

## 🔍 Quick Diagnosis

### Step 1: Run Test Script in CDP
```bash
node test-aws-credentials.js
```

### Step 2: Check Output

| Output | Meaning | Action |
|--------|---------|--------|
| ✅ Bedrock API ACCESSIBLE | Working correctly | No action needed |
| ❌ CredentialsProviderError | No AWS credentials | Check IAM role attached to EC2 |
| ❌ AccessDeniedException | No Bedrock permissions | Add permissions to IAM role |
| ❌ ResourceNotFoundException | Wrong ARN | Verify inference profile ARN |
| ❌ ThrottlingException | Rate limit exceeded | Implement retry logic |

## 🔎 Log Search Patterns

Search CloudWatch/OpenSearch for:

```
"BEDROCK API ERROR"           → Bedrock API failures
"CREDENTIAL DIAGNOSTICS"      → Credential configuration
"REVIEW ENDPOINT ERROR"       → Endpoint handler errors
"Bedrock client initialized"  → Startup configuration
```

## 🛠️ Common Fixes

### Fix 1: Attach IAM Role
```bash
# Verify role is attached
curl http://169.254.169.254/latest/meta-data/iam/info
```

If 404: Attach IAM role via EC2 Console or CDP config

### Fix 2: Add Bedrock Permissions
```json
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
```

### Fix 3: Verify ARNs
- Inference Profile: `arn:aws:bedrock:eu-west-2:332499610595:inference-profile/eu.anthropic.claude-3-5-sonnet-20241022-v2:0`
- Guardrail: `arn:aws:bedrock:eu-west-2:332499610595:guardrail/j7sbivk41lq4`
- Version: `3`

## 📊 What Changed

| File | Change |
|------|--------|
| `bedrock-client.js` | Enhanced error logging + credential diagnostics |
| `chat.js` | Enhanced route error logging |
| `test-aws-credentials.js` | NEW: Diagnostic test script |
| `TROUBLESHOOTING-BEDROCK.md` | NEW: Full troubleshooting guide |

## 🧪 Test Endpoints

```bash
# Health check
curl https://your-cdp-url/health

# Chat (should work)
curl -X POST https://your-cdp-url/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'

# Review (currently failing)
curl -X POST https://your-cdp-url/api/review \
  -H "Content-Type: application/json" \
  -d '{"content":"Test content","contentType":"general"}'
```

## 📝 Error Output Example

When error occurs, you'll see:

```
=== BEDROCK API ERROR ===
Error Name: CredentialsProviderError
Error Message: Could not load credentials from any providers
Error Code: undefined
HTTP Status: undefined
Request ID: undefined
=========================

=== CREDENTIAL DIAGNOSTICS ===
AWS Profile: none
Has Access Key ID: false
Has Secret Access Key: false
Has Session Token: false
Node Env: production
AWS Region: eu-west-2
==============================
```

## ✅ Success Indicators

When working correctly:

```json
{
  "log.level": "info",
  "message": "Content review completed successfully",
  "tokensUsed": 245
}
```

## 🆘 Still Stuck?

Provide these details:
1. Output of `node test-aws-credentials.js`
2. Full error blocks from logs (=== markers)
3. IAM role ARN
4. Result of: `curl http://169.254.169.254/latest/meta-data/iam/info`

## 📚 Full Documentation

See `TROUBLESHOOTING-BEDROCK.md` for detailed explanations
