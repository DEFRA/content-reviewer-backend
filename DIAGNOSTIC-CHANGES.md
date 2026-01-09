# Summary of Diagnostic Enhancements

## Overview

Added comprehensive error logging and diagnostics to troubleshoot the `/api/review` endpoint 502/500 errors.

## Files Modified

### 1. `src/common/helpers/bedrock-client.js`

**Changes:**
- Enhanced constructor logging to include credential environment info
- Added detailed error logging in `sendMessage()` catch block:
  - Full AWS error details (name, message, code, HTTP status, request ID)
  - Console output blocks with `===` markers for easy searching
  - Credential diagnostics for `CredentialsProviderError`
  - Better error messages for specific AWS error types
- Added error handling for additional AWS error types:
  - `ResourceNotFoundException`
  - `ValidationException`
  - `ServiceUnavailableException`
- Enhanced error logging in `reviewContent()` catch block

### 2. `src/routes/chat.js`

**Changes:**
- Enhanced error logging in both `chatController` and `reviewController`
- Added detailed console output for debugging:
  - Error name, message, code
  - Boom error detection
  - Full error object
- Structured error details logged to application logger

## Files Created

### 1. `test-aws-credentials.js`

**Purpose:** Diagnostic script to test AWS credentials and Bedrock access

**Features:**
- Environment diagnostics (AWS profile, credentials, region)
- Bedrock API connectivity test
- Detailed error reporting
- Guidance for local vs CDP environments
- Required IAM permissions documentation

**Usage:**
```bash
node test-aws-credentials.js
```

### 2. `TROUBLESHOOTING-BEDROCK.md`

**Purpose:** Comprehensive troubleshooting guide

**Contents:**
- Quick diagnosis steps for local and CDP
- Explanation of enhanced error logging
- Common issues and solutions:
  - CredentialsProviderError
  - AccessDeniedException
  - ResourceNotFoundException
  - ThrottlingException
- How to check logs in CDP
- Testing procedures
- Additional diagnostic commands

## Key Diagnostic Features

### Console Output Markers

All diagnostic output uses clear markers for easy log searching:

```
=== BEDROCK API ERROR ===
...
=========================

=== CREDENTIAL DIAGNOSTICS ===
...
==============================

=== CONTENT REVIEW ERROR ===
...
============================

=== REVIEW ENDPOINT ERROR ===
...
=============================
```

### Structured Logging

All errors are logged with comprehensive details:

```javascript
{
  errorName: 'CredentialsProviderError',
  errorMessage: 'Could not load credentials from any providers',
  errorCode: 'undefined',
  httpStatusCode: 'undefined',
  requestId: 'undefined',
  awsRegion: 'eu-west-2',
  inferenceProfile: 'arn:aws:bedrock:...',
  stack: '...'
}
```

### Credential Diagnostics

When credential errors occur, additional context is provided:

```javascript
{
  awsProfile: 'none',
  hasAccessKeyId: false,
  hasSecretAccessKey: false,
  hasSessionToken: false,
  nodeEnv: 'production',
  region: 'eu-west-2'
}
```

## Testing Performed

### Local Testing

✅ Test script runs successfully
✅ Shows expected `CredentialsProviderError` 
✅ Provides clear guidance for local vs CDP environments
✅ Console output is clear and searchable

### Endpoint Testing

✅ `/api/review` endpoint triggers enhanced error logging
✅ All three error blocks appear in console output:
   - BEDROCK API ERROR
   - CONTENT REVIEW ERROR  
   - REVIEW ENDPOINT ERROR
✅ Structured logs contain full error details

## Next Steps for Deployment

1. **Commit changes** (you'll do this manually):
   ```bash
   git add src/common/helpers/bedrock-client.js
   git add src/routes/chat.js
   git add test-aws-credentials.js
   git add TROUBLESHOOTING-BEDROCK.md
   git commit -m "Add comprehensive error diagnostics for Bedrock API"
   ```

2. **Deploy to CDP**:
   - Merge to appropriate branch
   - Deploy via CDP pipeline

3. **Test in CDP**:
   ```bash
   # SSH into CDP instance
   cd /path/to/app
   node test-aws-credentials.js
   ```

4. **Test the endpoint**:
   ```bash
   curl -X POST https://your-cdp-url/api/review \
     -H "Content-Type: application/json" \
     -d '{"content":"Test","contentType":"general"}'
   ```

5. **Check logs**:
   - Search OpenSearch/CloudWatch for markers like "BEDROCK API ERROR"
   - Look for "CREDENTIAL DIAGNOSTICS" block
   - Review the detailed error output

6. **Apply fix based on error**:
   - If `CredentialsProviderError`: Check IAM role attachment
   - If `AccessDeniedException`: Add Bedrock permissions to IAM role
   - If `ResourceNotFoundException`: Verify ARNs are correct
   - If other error: Refer to TROUBLESHOOTING-BEDROCK.md

## Expected Outcome

With these diagnostics in place, you should be able to:

1. ✅ Identify the exact error type and message
2. ✅ See credential configuration state
3. ✅ Determine if it's a credential, permission, or resource issue
4. ✅ Get actionable error messages with solutions
5. ✅ Quickly find relevant logs using console markers
6. ✅ Test AWS connectivity independently of the API

## Files Not Modified

The following files remain unchanged:
- `src/config.js` - Configuration already correct
- `src/plugins/router.js` - Routes already registered
- `package.json` - All dependencies already installed
- Other route files - Not affected by this issue

## Summary

The root cause is likely one of:
1. **No IAM role attached** to EC2 instance in CDP
2. **IAM role lacks permissions** for Bedrock
3. **Inference profile ARN** is incorrect
4. **Instance metadata service** not accessible

The enhanced logging will definitively identify which of these is the problem when you test in CDP.
