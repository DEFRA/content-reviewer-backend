# How to Test Bedrock Access from CDP

## Why This Test is Important

Before implementing async processing, we should verify that Bedrock access is working correctly. The 30-40 second response times we're seeing **might** be caused by:

1. ❌ Permission issues causing retries
2. ❌ Incorrect ARN configuration
3. ❌ Network/proxy issues
4. ✅ Or just genuinely slow processing (expected)

This test will tell us which one it is.

---

## Steps to Run the Test

### Option 1: From CDP Terminal (Recommended)

1. **Access your CDP service terminal:**
   - Go to CDP Portal
   - Navigate to your service
   - Find "Terminal" or "Shell" option
   - Or SSH into the running container

2. **Upload the test script:**

   ```bash
   # Copy the test-bedrock-access.sh file to the container
   # Or paste its contents directly
   ```

3. **Make it executable:**

   ```bash
   chmod +x test-bedrock-access.sh
   ```

4. **Run the test:**
   ```bash
   ./test-bedrock-access.sh
   ```

### Option 2: Manual Commands

If you can't upload the script, run these commands manually in the CDP terminal:

```bash
# Set your ARNs
inference_profile_arn="arn:aws:bedrock:eu-west-2:332499610595:application-inference-profile/wrmld9jrycya"
guardrail_arn="arn:aws:bedrock:eu-west-2:332499610595:guardrail/th34diy2ti2t"

# Create request body
body=$(echo '{
  "anthropic_version": "bedrock-2023-05-31",
  "max_tokens": 100,
  "messages": [
    {
      "role": "user",
      "content": "Say hello in one sentence"
    }
  ]
}' | base64 -w 0)

# Test the invoke
aws bedrock-runtime invoke-model \
    --model-id "${inference_profile_arn}" \
    --content-type "application/json" \
    --accept "application/json" \
    --trace "ENABLED" \
    --body "${body}" \
    --guardrail-identifier "${guardrail_arn}" \
    --guardrail-version "1" \
    response.json

# Check the result
cat response.json | jq -r '.content[0].text'
```

---

## What to Look For

### ✅ Success (TEST 1 passes):

```
✅ SUCCESS! Bedrock access is working

Response from Claude:
---
Hello! I'm Claude, an AI assistant created by Anthropic.
---
```

**This means:**

- ✅ Permissions are correct
- ✅ ARNs are correct
- ✅ Bedrock API is accessible
- ✅ The 30-40 second delays are genuine processing time (not access issues)

**Next step:** Implement async processing to handle the slow response times

---

### ❌ Failure (TEST 1 fails):

#### Error 1: AccessDeniedException

```
An error occurred (AccessDeniedException) when calling the InvokeModel operation:
User: arn:aws:sts::332499610595:assumed-role/... is not authorized to perform:
bedrock:InvokeModel on resource: ...
```

**This means:**

- ❌ IAM role doesn't have `bedrock:InvokeModel` permission
- ❌ Your service's IAM role needs to be updated

**Next step:** Contact CDP support to add Bedrock permissions to your service's IAM role

---

#### Error 2: ResourceNotFoundException

```
An error occurred (ResourceNotFoundException) when calling the InvokeModel operation:
Could not find inference profile or guardrail
```

**This means:**

- ❌ The inference profile ARN or guardrail ARN is incorrect
- ❌ The ARNs might be for a different environment (e.g., using prod ARNs in dev)

**Next step:**

1. Run the ARN discovery commands from the documentation
2. Update your `config.js` with correct ARNs
3. Redeploy

---

#### Error 3: TimeoutException

```
An error occurred (TimeoutException)
```

**This means:**

- ❌ Network/connectivity issues between CDP and Bedrock
- ❌ Proxy configuration might be wrong

**Next step:** Check proxy configuration in `setup-proxy.js`

---

## Interpreting the Results

### If TEST 1 Succeeds:

**Good news:** Bedrock access is working! The slow response times are expected behavior.

**Options:**

1. **Implement async processing** (recommended) - Let reviews run in background
2. **Request timeout increase** from CDP support - Ask for 60s nginx timeout
3. **Accept limitations** - Document that complex reviews may timeout

### If TEST 1 Fails:

**Bad news:** There's a configuration issue that needs fixing first.

**Don't implement async processing yet** - Fix the access issue first, then the slow responses might actually be faster!

---

## Additional Diagnostics

If you want to measure exact response times, add timing to the test:

```bash
echo "Starting test at $(date)"
start_time=$(date +%s)

aws bedrock-runtime invoke-model \
    --model-id "${inference_profile_arn}" \
    --content-type "application/json" \
    --accept "application/json" \
    --trace "ENABLED" \
    --body "${body}" \
    --guardrail-identifier "${guardrail_arn}" \
    --guardrail-version "1" \
    response.json

end_time=$(date +%s)
duration=$((end_time - start_time))

echo "Completed in ${duration} seconds"
```

**Expected times:**

- Simple query (100 tokens): 2-5 seconds
- Complex review (4000 tokens): 20-40 seconds

---

## Next Steps After Testing

### Scenario A: Test Succeeds, Response is Fast (< 5 seconds)

→ Great! The issue might be in your application code. Review might work with current setup.

### Scenario B: Test Succeeds, Response is Slow (> 5 seconds)

→ Bedrock is just slow. Need async processing or timeout increase.

### Scenario C: Test Fails

→ Fix permissions/ARNs first, then retest.

---

**Run this test and let me know what happens!** 🧪
