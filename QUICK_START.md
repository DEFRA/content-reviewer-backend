# AWS Setup Quick Start

This guide will help you get S3 uploads working in under 5 minutes!

## 🚀 Quick Start (Choose Your Path)

### Path 1: Using Mock Mode (No AWS Required) - 30 seconds
Perfect for demos and testing without AWS access.

```bash
# 1. Copy the example env file
cp .env.example .env

# 2. Enable mock mode
echo "MOCK_S3_UPLOAD=true" >> .env

# 3. Start the backend
npm start
```

✅ **Done!** Files will be simulated without actual S3 uploads.

---

### Path 2: Using AWS Profile (Local Development) - 2 minutes
Best for local development with AWS access.

```bash
# 1. Configure AWS CLI (if not already done)
aws configure --profile defra-dev
# Enter your AWS Access Key ID, Secret Key, region (eu-west-2), and output format

# 2. Test your credentials
aws s3 ls s3://dev-service-optimisation-c63f2 --profile defra-dev

# 3. Copy the example env file
cp .env.example .env

# 4. Add your profile to .env
echo "AWS_PROFILE=defra-dev" >> .env

# 5. Test credentials
node test-aws-credentials.js

# 6. Start the backend
npm start
```

✅ **Done!** Your backend will upload files to S3.

---

### Path 3: Using AWS SSO - 3 minutes
For organizations using AWS SSO.

```bash
# 1. Configure SSO
aws configure sso --profile defra-sso
# Follow the prompts to set up SSO

# 2. Login to SSO
aws sso login --profile defra-sso

# 3. Copy the example env file
cp .env.example .env

# 4. Add your SSO profile to .env
echo "AWS_PROFILE=defra-sso" >> .env

# 5. Test credentials
node test-aws-credentials.js

# 6. Start the backend
npm start
```

✅ **Done!** Your backend will upload files to S3 with SSO.

---

### Path 4: IAM Role (Production/AWS Environment) - 1 minute
For EC2, ECS, Lambda, or other AWS services.

```bash
# 1. Ensure your instance/service has an IAM role with S3 permissions
# (This is usually set up by your DevOps team)

# 2. Copy the example env file
cp .env.example .env

# 3. No AWS credentials needed in .env!
# The SDK will automatically use the instance role

# 4. Test credentials
node test-aws-credentials.js

# 5. Start the backend
npm start
```

✅ **Done!** Your backend will use the instance IAM role.

---

## 🧪 Testing Your Setup

After starting the backend, test file upload:

### Option 1: Using curl
```bash
curl -X POST http://localhost:3001/upload \
  -F "file=@path/to/test-file.pdf"
```

### Option 2: Using the Frontend
1. Start the frontend: `cd ../content-reviewer-frontend && npm start`
2. Open http://localhost:3000
3. Upload a file using the web interface
4. Check the Review History for status updates

---

## 🔍 Troubleshooting

### Problem: "Missing credentials in config"
**Solution:**
```bash
# Check if credentials are configured
node test-aws-credentials.js

# If it fails, use one of these:
# Option A: Use mock mode
echo "MOCK_S3_UPLOAD=true" > .env

# Option B: Set up AWS profile
aws configure --profile defra-dev
echo "AWS_PROFILE=defra-dev" >> .env
```

### Problem: "Access Denied"
**Solution:**
```bash
# Verify your IAM permissions
aws s3 ls s3://dev-service-optimisation-c63f2 --profile your-profile

# If this works, your credentials are fine. If not, contact your AWS admin.
```

### Problem: "Bucket does not exist"
**Solution:**
```bash
# Check if the bucket name in .env is correct
grep UPLOAD_S3_BUCKET .env

# Should show:
# UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
```

### Problem: "Network timeout"
**Solution:**
```bash
# Check your internet connection
ping s3.eu-west-2.amazonaws.com

# If using a proxy, set HTTP_PROXY in .env:
echo "HTTP_PROXY=http://your-proxy:8080" >> .env
```

---

## 📋 Verification Checklist

Run through this checklist to ensure everything is set up correctly:

- [ ] **Backend starts without errors**
  ```bash
  npm start
  ```
  
- [ ] **S3Uploader logs show correct bucket**
  ```
  [S3Uploader] Target bucket: dev-service-optimisation-c63f2/content-uploads
  ```

- [ ] **Credentials test passes**
  ```bash
  node test-aws-credentials.js
  ```

- [ ] **File upload works**
  ```bash
  curl -X POST http://localhost:3001/upload -F "file=@test.pdf"
  ```

- [ ] **Frontend can upload files**
  - Visit http://localhost:3000
  - Upload a test file
  - See it appear in Review History

---

## 🎯 Next Steps

Once uploads are working:

1. **Configure SQS** (optional) for async processing:
   ```bash
   echo "SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status" >> .env
   ```

2. **Enable MongoDB** (optional) for persistent storage:
   ```bash
   echo "MONGO_ENABLED=true" >> .env
   echo "MONGO_URI=mongodb://localhost:27017/" >> .env
   ```

3. **Set up monitoring** with CloudWatch or Application Insights

4. **Review security settings** in AWS_SETUP_GUIDE.md

---

## 📚 Additional Resources

- **Full AWS Setup Guide:** See `AWS_SETUP_GUIDE.md` for detailed configuration options
- **Environment Variables:** See `.env.example` for all available options
- **File Upload Implementation:** See `FILE_UPLOAD_IMPLEMENTATION.md` in frontend folder
- **AWS SDK Docs:** https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/

---

## 🆘 Still Having Issues?

1. Check the logs for detailed error messages
2. Run `node test-aws-credentials.js` for diagnostic info
3. Verify your bucket and IAM permissions in AWS Console
4. Try mock mode first to isolate AWS-specific issues
5. Check the backend README.md for additional troubleshooting

---

**Happy uploading! 🎉**
