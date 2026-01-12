# Timeout Configuration Fix for 502 Errors

## Problem

After fixing the service routing issue (removing `console.error()` calls), some API endpoints were returning 502 Bad Gateway errors:

- Chat endpoint with longer messages: 502 error
- Content review endpoint: 502 error
- Simple chat messages: ✅ Working

## Root Cause

**Request timeouts** between different layers:

1. CDP nginx/load balancer: ~60 second timeout
2. Hapi.js server: 120 second default timeout (too long)
3. Bedrock API calls: No timeout configured (could hang indefinitely)

When Bedrock API calls took longer than nginx's timeout, nginx would return 502 Bad Gateway while the backend was still processing.

## Solution

### 1. Added Server Timeout Configuration (`src/server.js`)

```javascript
routes: {
  // ...existing config...
  timeout: {
    socket: 90000,  // 90 seconds - must be less than nginx timeout
    server: 85000   // 85 seconds - allow time for response before socket closes
  }
}
```

**Why these values:**

- `socket: 90000` (90s): Maximum time for a complete request/response cycle
- `server: 85000` (85s): Hapi will terminate the request processing before the socket times out
- Both are **less than nginx's timeout** to ensure clean error handling

### 2. Added Bedrock Client Timeout (`src/common/helpers/bedrock-client.js`)

```javascript
this.timeout = 60000 // 60 seconds timeout for Bedrock API calls

this.client = new BedrockRuntimeClient({
  region: this.region,
  requestHandler: {
    requestTimeout: this.timeout
  }
})
```

**Why 60 seconds:**

- Gives Bedrock API reasonable time to respond
- Still leaves 25 seconds buffer for Hapi to handle the timeout and return proper error
- Prevents indefinite hangs

### 3. Added Timeout Error Handling

```javascript
if (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT') {
  throw new Error(
    'Bedrock API request timed out. The request took too long to process.'
  )
}
```

Now returns a proper error message instead of generic 502.

## Timeout Hierarchy

```
┌─────────────────────────────────────────────────┐
│ CDP nginx/Load Balancer: ~60-90 seconds         │
│  ┌───────────────────────────────────────────┐  │
│  │ Hapi Socket Timeout: 90 seconds           │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │ Hapi Server Timeout: 85 seconds     │  │  │
│  │  │  ┌───────────────────────────────┐  │  │  │
│  │  │  │ Bedrock API: 60 seconds       │  │  │  │
│  │  │  └───────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

Each layer times out before the layer above it, ensuring:

1. Bedrock API times out first (60s)
2. Hapi catches the timeout and returns proper error (85s)
3. Socket remains valid for error response (90s)
4. Nginx receives response before its timeout (~90s)

## Expected Behavior After Fix

### ✅ Short requests (< 60s):

- Process normally
- Return 200 with response

### ⚠️ Long requests (60-85s):

- Bedrock API times out at 60s
- Hapi catches timeout and returns 500 with error message
- Client receives proper error, not 502

### ❌ Very long requests (> 85s):

- Hapi server timeout kills the request
- Returns 503 Service Unavailable
- Better than 502 Bad Gateway

## Testing

After deploying:

1. **Short chat messages**: Should work (< 10s)
2. **Long chat messages**: Should work or timeout gracefully with 500
3. **Content review**: Should work or timeout gracefully with 500
4. **No more 502 errors** from request processing (only from actual gateway issues)

## Deployment

Commit and push these changes, then redeploy to CDP:

```bash
git add src/server.js src/common/helpers/bedrock-client.js
git commit -m "fix: Add timeout configuration to prevent 502 errors"
git push
```

Version: 0.4.2 (or 0.5.0)
