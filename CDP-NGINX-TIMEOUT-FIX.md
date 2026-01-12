# CDP Nginx 5-Second Timeout Fix

## Problem Discovered

After extensive investigation, we found that **CDP's nginx has a 5-second timeout for upstream requests**. This was causing the review endpoint to fail with 502/499 errors.

### Evidence from nginx Logs:

```
Jan 12, 2026 @ 12:10:03.444  /api/review  499  POST  5.001s  (timeout!)
Jan 12, 2026 @ 12:09:58.444  /api/chat    200  POST  3.84s   (success)
Jan 12, 2026 @ 12:09:54.051  /api/chat    200  POST  3.918s  (success)
```

- **Status 499**: Client closed connection (nginx upstream timeout)
- **Response time 5.001s**: Exactly at nginx's timeout limit
- **Chat endpoint**: Works fine at ~4 seconds
- **Review endpoint**: Fails because it takes >5 seconds (earlier logs showed 7.6s)

## Root Cause

The review endpoint was slow because:

1. **Long system prompt**: 260-word detailed instructions sent on every request
2. **More tokens**: Longer prompts = more processing time
3. **Conversation history**: Building artificial conversation history adds overhead
4. **CDP nginx timeout**: Only 5 seconds for POST requests to /api/review

## Changes Made

### 1. Optimized Review Prompt (bedrock-client.js)

**Before:**

```javascript
const systemPrompt = `You are a content quality reviewer for GOV.UK services...
(260 words of detailed instructions)`
```

**After:**

```javascript
const systemPrompt = `You are a GOV.UK content reviewer. Assess content for clarity, plain English, structure, and accessibility. Provide: Overall Assessment, Strengths, Issues, Suggestions, and a Compliance Score (0-10).`
```

**Reduction:** ~260 words → ~30 words (92% reduction)
**Benefit:** Faster processing, lower token usage, quicker responses

### 2. Reduced Bedrock Client Timeout

**Before:** 60 seconds  
**After:** 30 seconds  
**Reason:** Must complete within nginx's 5s limit; this allows graceful timeout handling

### 3. Added Route-Specific Timeout (chat.js)

```javascript
const reviewController = {
  options: {
    // ...existing options...
    timeout: {
      server: 4500 // 4.5 seconds - must complete before nginx 5s timeout
    }
  }
}
```

**Benefit:** Hapi will kill the request at 4.5s and return proper error, rather than letting nginx timeout at 5s with 499/502

### 4. Enhanced Timeout Error Handling (chat.js)

```javascript
if (
  error.message?.includes('timeout') ||
  error.name === 'TimeoutError' ||
  error.code === 'ETIMEDOUT'
) {
  throw Boom.gatewayTimeout(
    'Content review took too long to process. Please try with shorter content or contact support.'
  )
}
```

**Benefit:** Users get a helpful error message instead of generic 502

## Timeout Hierarchy (Updated)

```
┌─────────────────────────────────────────────────┐
│ CDP nginx: 5 seconds (HARD LIMIT)               │
│  ┌───────────────────────────────────────────┐  │
│  │ Hapi review route timeout: 4.5 seconds   │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │ Bedrock API timeout: 30 seconds     │  │  │
│  │  │ (won't be reached due to route)     │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘

For other routes (chat, health):
┌─────────────────────────────────────────────────┐
│ CDP nginx: ~60-90 seconds                        │
│  ┌───────────────────────────────────────────┐  │
│  │ Hapi server timeout: 85 seconds           │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │ Bedrock API timeout: 30 seconds     │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## Expected Results After Fix

### ✅ Review Endpoint (with optimized prompt):

- Should complete in 3-4 seconds (under the 5s limit)
- Returns proper review with assessment, strengths, issues, suggestions
- If it times out, returns 504 with helpful message

### ✅ Chat Endpoint:

- Already working, no changes needed
- Continues to work as before

### ✅ Health Endpoint:

- Already working, no changes needed
- Fast response (<10ms)

## Testing After Deployment

Run the test script:

```powershell
.\test-cdp-deployment.ps1
```

### Expected Results:

| Test                     | Expected | Status              |
| ------------------------ | -------- | ------------------- |
| Health Check             | 200      | ✅ Already working  |
| Chat - Simple            | 200      | ✅ Already working  |
| Chat - Review Query      | 200      | ✅ Already working  |
| **Review Endpoint**      | **200**  | **Should now work** |
| Chat - Empty Message     | 400      | ✅ Already working  |
| Review - Missing Content | 400      | ✅ Already working  |
| Invalid API Key          | 403      | ✅ Already working  |

**Success Rate:** Should increase from 85.71% to **100%**

## Alternative Solutions (If Still Failing)

If the review endpoint still times out after these changes:

### Option 1: Async Processing (Recommended)

- Accept review request immediately, return 202 Accepted
- Process review asynchronously via SQS
- Poll for results or use webhooks
- **Benefit:** No timeout issues, can handle very long content

### Option 2: Request CDP to Increase nginx Timeout

- Contact CDP support
- Request 30-60 second timeout for `/api/review` endpoint
- **Benefit:** Allows longer processing times
- **Risk:** May not be configurable per-endpoint

### Option 3: Further Optimize Prompt

- Use even shorter system prompt
- Skip conversation history entirely
- Use direct model call instead of Converse API
- **Benefit:** Fastest possible response
- **Risk:** Lower quality reviews

## Deployment Instructions

1. **Commit changes:**

   ```bash
   git add .
   git commit -m "fix: Optimize review endpoint to work within CDP's 5s nginx timeout"
   git push
   ```

2. **Deploy to CDP** (version 0.5.1 or 0.6.0)

3. **Wait 2-3 minutes** for deployment to complete

4. **Run test script:**

   ```powershell
   .\test-cdp-deployment.ps1
   ```

5. **Check results:**
   - All tests should pass (100% success rate)
   - Review endpoint should return 200 in ~3-4 seconds

6. **If still failing:**
   - Check OpenSearch application logs for timeout errors
   - Check nginx logs for response times
   - Consider implementing async processing (Option 1 above)

## Summary

**Before:**

- Review endpoint: 7.6 seconds → 499/502 error
- Long prompt: 260 words
- No route-specific timeout handling

**After:**

- Review endpoint: 3-4 seconds (estimated) → 200 success
- Short prompt: 30 words (92% reduction)
- Route timeout: 4.5 seconds with graceful error handling
- Better error messages for users

**Result:** Review endpoint should now work reliably within CDP's 5-second nginx timeout.
