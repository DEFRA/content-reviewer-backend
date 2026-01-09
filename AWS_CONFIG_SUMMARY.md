# AWS S3 Upload Configuration - Summary

## What Was Changed

### 1. Enhanced S3 Uploader (`src/common/helpers/s3-uploader.js`)

**Changes:**
- Added support for AWS SDK credential provider chain
- Now automatically handles multiple authentication methods:
  - IAM roles (EC2/ECS/Lambda)
  - AWS profiles (`AWS_PROFILE`)
  - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
  - AWS SSO
  - Shared credentials file (~/.aws/credentials)
- Improved logging to show authentication method in use
- Removed auto-mock mode in development (now explicit via `MOCK_S3_UPLOAD=true`)

**Key Code:**
```javascript
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'

// Uses AWS SDK default credential chain
s3Config.credentials = fromNodeProviderChain()
```

### 2. Updated Environment Configuration (`.env.example`)

**Added:**
- Comprehensive documentation for all authentication methods
- Examples for each configuration approach
- SQS configuration settings
- Development/testing options

**Key Variables:**
```bash
# Authentication
AWS_PROFILE=your-profile-name           # For local dev
AWS_ACCESS_KEY_ID=...                   # Direct credentials
AWS_ROLE_ARN=...                        # Assume role

# S3 Configuration
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
AWS_REGION=eu-west-2

# Testing
MOCK_S3_UPLOAD=true                     # Simulate uploads
```

### 3. New Documentation

#### QUICK_START.md
- 5-minute setup guide for different scenarios
- Step-by-step instructions for:
  - Mock mode (no AWS required)
  - AWS Profile (local development)
  - AWS SSO
  - IAM Role (production)
- Troubleshooting common issues
- Verification checklist

#### AWS_SETUP_GUIDE.md
- Comprehensive guide for all authentication methods
- Security best practices
- IAM policy examples
- Complete .env file examples for each scenario
- Troubleshooting section
- Required permissions documentation

### 4. AWS Credentials Test Script (`test-aws-credentials.js`)

**Features:**
- Tests AWS credential loading
- Verifies S3 bucket access
- Checks SQS queue connectivity (if configured)
- Provides detailed diagnostic information
- Color-coded output for easy reading

**Usage:**
```bash
node test-aws-credentials.js
# Or with a specific profile:
AWS_PROFILE=your-profile node test-aws-credentials.js
```

### 5. Updated README.md

**Added:**
- Quick start link at the top
- AWS Configuration section with quick setup commands
- Links to all AWS documentation
- List of supported authentication methods

### 6. Installed Dependencies

**New Package:**
- `@aws-sdk/credential-providers` - Provides flexible credential loading

---

## How To Use

### Option 1: Demo Mode (No AWS Required)

Perfect for testing and demos without AWS access.

```bash
cd content-reviewer-backend

# Copy and configure
cp .env.example .env
echo "MOCK_S3_UPLOAD=true" >> .env

# Start backend
npm start
```

Files will be "uploaded" successfully but not actually stored in S3.

---

### Option 2: Real S3 Uploads with AWS Profile

For local development with AWS access.

```bash
cd content-reviewer-backend

# Configure AWS CLI (one time)
aws configure --profile defra-dev
# Enter: Access Key, Secret Key, Region (eu-west-2), Output (json)

# Set up environment
cp .env.example .env
echo "AWS_PROFILE=defra-dev" >> .env

# Test credentials
node test-aws-credentials.js

# Start backend
npm start
```

---

### Option 3: Real S3 Uploads with AWS SSO

For organizations using AWS Single Sign-On.

```bash
cd content-reviewer-backend

# Configure SSO (one time)
aws configure sso --profile defra-sso
# Follow prompts

# Login
aws sso login --profile defra-sso

# Set up environment
cp .env.example .env
echo "AWS_PROFILE=defra-sso" >> .env

# Test credentials
node test-aws-credentials.js

# Start backend
npm start
```

---

### Option 4: Production (IAM Role)

For AWS environments (EC2, ECS, Lambda).

```bash
# No credentials needed!
# Just ensure .env has correct bucket/region:
cp .env.example .env

# Test (will use instance role automatically)
node test-aws-credentials.js

# Start backend
npm start
```

---

## Testing File Uploads

### From Command Line

```bash
# Upload a test file
curl -X POST http://localhost:3001/upload \
  -F "file=@path/to/test-file.pdf"

# Expected response:
# {
#   "success": true,
#   "uploadId": "...",
#   "filename": "test-file.pdf",
#   "s3Location": "s3://dev-service-optimisation-c63f2/content-uploads/..."
# }
```

### From Frontend

1. Start both backend and frontend:
   ```bash
   # Terminal 1
   cd content-reviewer-backend
   npm start

   # Terminal 2
   cd content-reviewer-frontend
   npm start
   ```

2. Open http://localhost:3000
3. Upload a file using the web interface
4. Watch Review History for status updates

---

## Troubleshooting

### "Missing credentials in config"

**Cause:** No AWS credentials configured

**Solution:**
```bash
# Quick fix: Use mock mode
echo "MOCK_S3_UPLOAD=true" >> .env

# Or set up credentials:
aws configure --profile defra-dev
echo "AWS_PROFILE=defra-dev" >> .env

# Test:
node test-aws-credentials.js
```

### "Access Denied" / "Forbidden"

**Cause:** IAM permissions insufficient

**Solution:**
1. Verify bucket access:
   ```bash
   aws s3 ls s3://dev-service-optimisation-c63f2 --profile your-profile
   ```

2. Ensure IAM policy includes:
   ```json
   {
     "Effect": "Allow",
     "Action": ["s3:PutObject"],
     "Resource": "arn:aws:s3:::dev-service-optimisation-c63f2/content-uploads/*"
   }
   ```

3. Contact AWS admin if you need permissions

### "Bucket does not exist"

**Cause:** Bucket name or region incorrect

**Solution:**
```bash
# Check bucket configuration
grep UPLOAD_S3_BUCKET .env
# Should show: UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2

grep AWS_REGION .env
# Should show: AWS_REGION=eu-west-2
```

### Backend starts but uploads fail

**Diagnosis:**
```bash
# Check logs for authentication errors
npm start
# Look for S3Uploader initialization messages

# Test credentials explicitly
node test-aws-credentials.js
```

---

## Required IAM Permissions

For S3 uploads:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl"
      ],
      "Resource": "arn:aws:s3:::dev-service-optimisation-c63f2/content-uploads/*"
    }
  ]
}
```

For SQS (optional):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage"
      ],
      "Resource": "arn:aws:sqs:eu-west-2:332499610595:content_review_status"
    }
  ]
}
```

---

## Environment Variables Reference

### AWS Authentication (choose one method)

| Variable | Purpose | Example |
|----------|---------|---------|
| `AWS_PROFILE` | Use named AWS profile | `defra-dev` |
| `AWS_ACCESS_KEY_ID` | Direct credentials | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | Direct credentials | `wJalrX...` |
| `AWS_SESSION_TOKEN` | Temporary credentials | (auto-generated) |
| `AWS_ROLE_ARN` | Assume role | `arn:aws:iam::...` |

### S3 Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `UPLOAD_S3_BUCKET` | S3 bucket name | `dev-service-optimisation-c63f2` |
| `UPLOAD_S3_PATH` | Path prefix | `content-uploads` |
| `AWS_REGION` | AWS region | `eu-west-2` |
| `MOCK_S3_UPLOAD` | Simulate uploads | `false` |

### Development

| Variable | Purpose | Default |
|----------|---------|---------|
| `AWS_ENDPOINT` | Custom endpoint (LocalStack) | - |
| `NODE_ENV` | Environment | `development` |
| `LOG_LEVEL` | Logging verbosity | `info` |

---

## Next Steps

1. ✅ Choose your authentication method (see above)
2. ✅ Configure `.env` file
3. ✅ Test credentials: `node test-aws-credentials.js`
4. ✅ Start backend: `npm start`
5. ✅ Test upload via frontend or curl
6. 🎯 (Optional) Configure SQS for async processing
7. 🎯 (Optional) Enable MongoDB for persistent storage
8. 🎯 (Optional) Set up CloudWatch monitoring

---

## Additional Resources

- **[QUICK_START.md](./QUICK_START.md)** - 5-minute setup guide
- **[AWS_SETUP_GUIDE.md](./AWS_SETUP_GUIDE.md)** - Comprehensive AWS guide
- **[.env.example](./.env.example)** - Environment variables template
- **[AWS SDK Docs](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/)** - Official documentation

---

**You're all set! 🚀** Choose your authentication method above and start uploading files to S3.
