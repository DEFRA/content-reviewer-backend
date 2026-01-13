# AWS Bedrock Integration - Complete ✅

## 🎉 What's Been Added

All files for AWS Bedrock integration have been created and configured!

---

## 📁 Files Created/Modified

### **New Files:**

1. ✅ `src/common/helpers/bedrock-client.js` - AWS Bedrock client wrapper
2. ✅ `src/common/helpers/gov-uk-review-prompt.js` - GOV.UK content review prompts
3. ✅ `src/routes/chat.js` - Chat API endpoints for AI conversations
4. ✅ `test-bedrock.js` - Test script to verify Bedrock integration

### **Modified Files:**

5. ✅ `src/config.js` - Added Bedrock configuration section
6. ✅ `src/plugins/router.js` - Registered chat routes
7. ✅ `.env` - Added Bedrock environment variables

---

## 🚀 Quick Start

### **Current Status: MOCK Mode** ⚠️

By default, Bedrock is running in **MOCK mode** (no AWS required).

### **Test in MOCK Mode:**

```bash
# Start the backend
npm run dev

# Test the chat endpoint
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Review this: The dog was walked."}'

# Expected response:
{
  "success": true,
  "response": "This is a mock response. Enable real Bedrock...",
  "mock": true
}
```

---

## 🔐 Enable Real AWS Bedrock

### **Step 1: AWS Setup**

1. **Enable Bedrock model access** in AWS Console:
   - Go to: AWS Console → Bedrock → Model access
   - Request access to Claude 3 Sonnet
   - Wait for approval (usually instant)

2. **Configure AWS credentials:**
   ```bash
   export AWS_ACCESS_KEY_ID=your_key_id
   export AWS_SECRET_ACCESS_KEY=your_secret_key
   export AWS_REGION=eu-west-2
   ```

### **Step 2: Update .env**

```bash
# Enable Bedrock
ENABLE_BEDROCK=true

# Disable mock mode
MOCK_BEDROCK=false

# AWS credentials (if not using environment variables)
AWS_ACCESS_KEY_ID=your_key_id
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=eu-west-2
```

### **Step 3: Test Real Bedrock**

```bash
# Run test script
node test-bedrock.js

# Expected output:
✅ Bedrock is enabled and configured
💬 Sending test message to Bedrock...
✅ Response received!
```

---

## 📡 API Endpoints

### **POST /api/chat**

Send a message to the AI for content review.

**Request:**

```json
{
  "message": "Review this: The application was submitted by the user."
}
```

**Response:**

```json
{
  "success": true,
  "response": "Consider using active voice: 'The user submitted the application.' This is clearer and more direct, following GOV.UK style guidelines.",
  "usage": {
    "input_tokens": 45,
    "output_tokens": 32
  }
}
```

### **POST /api/chat/stream**

Same as above but with streaming support (for future real-time updates).

---

## 🎯 Integration Points

### **For Chat Interface (Real-Time)**

The chat route is already integrated and ready to use from your frontend:

```javascript
// frontend: application.js
async function sendChatMessage(message) {
  const response = await fetch('http://localhost:3001/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  })
  const data = await response.json()
  return data.response
}
```

### **For File Upload Review (SQS Worker)**

To integrate Bedrock with file uploads:

1. **Enhance `src/common/helpers/sqs-worker.js`:**

   ```javascript
   import { BedrockClient } from './bedrock-client.js'
   import { buildReviewPrompt } from './gov-uk-review-prompt.js'

   async processContentReview(messageBody) {
     // 1. Download file from S3
     const content = await downloadFromS3(messageBody.s3Location)

     // 2. Build review prompt
     const prompt = buildReviewPrompt(content)

     // 3. Call Bedrock
     const bedrock = new BedrockClient()
     const result = await bedrock.invokeModel(prompt)

     // 4. Store results in S3
     await storeResults(messageBody.jobId, result.content)
   }
   ```

---

## ⚙️ Configuration

All settings are in `.env`:

```bash
# Enable/disable Bedrock
ENABLE_BEDROCK=true          # Set to false to disable AI completely

# Mock mode (for testing without AWS)
MOCK_BEDROCK=false           # Set to true for testing without AWS

# AWS region (must have Bedrock access)
BEDROCK_REGION=eu-west-2

# Model selection
BEDROCK_MODEL_ID=anthropic.claude-3-sonnet-20240229-v1:0
# Options:
#   - anthropic.claude-3-haiku-20240307-v1:0    (fastest, cheapest)
#   - anthropic.claude-3-sonnet-20240229-v1:0   (balanced, recommended)
#   - anthropic.claude-3-opus-20240229-v1:0     (best quality, expensive)

# Response limits
BEDROCK_MAX_TOKENS=4096      # Maximum response length

# Creativity level
BEDROCK_TEMPERATURE=0.7      # 0.0 = focused, 1.0 = creative
```

---

## 💰 Cost Estimates

Based on Claude 3 Sonnet pricing:

- **Input:** $3 per 1M tokens
- **Output:** $15 per 1M tokens

**Typical content review:**

- Input: ~500 tokens (content to review)
- Output: ~800 tokens (detailed feedback)
- **Cost per review: ~$0.01**

**Monthly estimates:**

- 100 reviews: ~$1
- 1,000 reviews: ~$10
- 10,000 reviews: ~$100

---

## 🧪 Testing

### **Test 1: Mock Mode (No AWS needed)**

```bash
# .env: MOCK_BEDROCK=true
npm run dev
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "test"}'
```

### **Test 2: Real Bedrock**

```bash
# .env: MOCK_BEDROCK=false
# Configure AWS credentials first
node test-bedrock.js
```

### **Test 3: From Frontend**

```bash
# Start both servers
cd backend && npm run dev
cd frontend && npm run dev

# Open http://localhost:3000
# Type a message in chat
# Should get AI-powered response
```

---

## 🐛 Troubleshooting

### **"Bedrock is disabled"**

- Set `ENABLE_BEDROCK=true` in `.env`

### **"Credentials not found"**

- Configure AWS credentials:
  ```bash
  export AWS_ACCESS_KEY_ID=your_key
  export AWS_SECRET_ACCESS_KEY=your_secret
  ```

### **"AccessDeniedException"**

- Request model access in AWS Console → Bedrock → Model access
- Ensure IAM permissions include `bedrock:InvokeModel`

### **"ValidationException: model not found"**

- Check `BEDROCK_MODEL_ID` in `.env`
- Verify model is available in your region

### **"Region not supported"**

- Bedrock is available in: us-east-1, us-west-2, eu-west-3, ap-northeast-1
- Update `BEDROCK_REGION` in `.env`

---

## 📚 Next Steps

### **1. Test the Integration**

```bash
node test-bedrock.js
```

### **2. Connect Frontend Chat**

Update `frontend/src/client/javascripts/application.js` to call `/api/chat`

### **3. Integrate with File Uploads**

Enhance `sqs-worker.js` to process uploaded documents through Bedrock

### **4. Add Job Status Tracking**

Create routes to check review status and retrieve results

---

## 🎓 Learn More

- [AWS Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
- [Claude Model Guide](https://docs.anthropic.com/claude/docs)
- [GOV.UK Content Design](https://www.gov.uk/guidance/content-design)

---

**Status: ✅ Ready to test!**
