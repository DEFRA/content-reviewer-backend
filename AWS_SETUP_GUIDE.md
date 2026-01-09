# AWS S3 Upload Configuration Guide

This guide explains how to configure AWS S3 access for the Content Reviewer Backend using different authentication methods.

## Prerequisites

- S3 Bucket: `dev-service-optimisation-c63f2`
- AWS Region: `eu-west-2`
- AWS Account ID: `332499610595`

## Authentication Methods

### Method 1: IAM Role (Recommended for AWS Environments)

**Best for:** EC2, ECS, Lambda, or any AWS service with an attached IAM role

**Setup:**
1. Ensure your EC2 instance/ECS task/Lambda function has an IAM role attached
2. The role should have permissions to:
   - `s3:PutObject` on `arn:aws:s3:::dev-service-optimisation-c63f2/content-uploads/*`
   - `sqs:SendMessage` on the SQS queue (if using SQS)

**Configuration:**
```bash
# No environment variables needed!
# The AWS SDK will automatically use the instance role
AWS_REGION=eu-west-2
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
```

**IAM Policy Example:**
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

---

### Method 2: AWS Profile (Recommended for Local Development)

**Best for:** Local development on your machine

**Setup:**
1. Configure AWS CLI with your profile:
   ```bash
   aws configure --profile your-profile-name
   ```
2. Or manually edit `~/.aws/credentials` (or `%USERPROFILE%\.aws\credentials` on Windows):
   ```ini
   [your-profile-name]
   aws_access_key_id = YOUR_ACCESS_KEY
   aws_secret_access_key = YOUR_SECRET_KEY
   ```

3. For SSO profiles, use:
   ```bash
   aws configure sso --profile your-sso-profile
   aws sso login --profile your-sso-profile
   ```

**Configuration (.env):**
```bash
AWS_PROFILE=your-profile-name
AWS_REGION=eu-west-2
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
```

---

### Method 3: Environment Variables (Direct Credentials)

**Best for:** CI/CD pipelines, temporary testing (NOT recommended for production)

**Configuration (.env):**
```bash
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_REGION=eu-west-2
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2

# Optional: For temporary credentials (STS)
# AWS_SESSION_TOKEN=your-session-token
```

⚠️ **Security Warning:** Never commit credentials to version control!

---

### Method 4: Assume Role (Cross-Account Access)

**Best for:** Accessing resources in another AWS account

**Configuration (.env):**
```bash
AWS_ROLE_ARN=arn:aws:iam::332499610595:role/ContentReviewerRole
AWS_ROLE_SESSION_NAME=content-reviewer-session
AWS_REGION=eu-west-2
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
```

---

### Method 5: LocalStack (Local AWS Simulation)

**Best for:** Complete local development without AWS account

**Setup:**
1. Install and run LocalStack:
   ```bash
   docker run -d -p 4566:4566 localstack/localstack
   ```

2. Create local S3 bucket:
   ```bash
   aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2
   ```

**Configuration (.env):**
```bash
AWS_ENDPOINT=http://localhost:4566
LOCALSTACK_ENDPOINT=http://localhost:4566
AWS_REGION=eu-west-2
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
```

---

### Method 6: Mock Mode (No AWS Connection)

**Best for:** Development/testing without any AWS connectivity

**Configuration (.env):**
```bash
MOCK_S3_UPLOAD=true
```

This simulates successful uploads without actually connecting to S3.

---

## Complete .env File Examples

### Production (IAM Role)
```bash
NODE_ENV=production
PORT=3001
AWS_REGION=eu-west-2
AWS_ACCOUNT_ID=332499610595
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
UPLOAD_S3_PATH=content-uploads
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status
CORS_ORIGIN=["https://your-frontend-domain.com"]
```

### Local Development (AWS Profile)
```bash
NODE_ENV=development
PORT=3001
AWS_PROFILE=defra-dev
AWS_REGION=eu-west-2
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
UPLOAD_S3_PATH=content-uploads
CORS_ORIGIN=["http://localhost:3000"]
LOG_LEVEL=debug
LOG_FORMAT=pino-pretty
```

### Local Development (Mock Mode)
```bash
NODE_ENV=development
PORT=3001
MOCK_S3_UPLOAD=true
AWS_REGION=eu-west-2
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
CORS_ORIGIN=["http://localhost:3000"]
LOG_LEVEL=debug
```

---

## Verifying Your Configuration

1. **Start the backend:**
   ```bash
   npm start
   ```

2. **Check the logs for:**
   ```
   [S3Uploader] Initializing S3 client for region: eu-west-2
   [S3Uploader] Target bucket: dev-service-optimisation-c63f2/content-uploads
   ```

3. **Test upload via the API:**
   ```bash
   curl -X POST http://localhost:3001/upload \
     -F "file=@test-document.pdf"
   ```

4. **Expected successful response:**
   ```json
   {
     "success": true,
     "uploadId": "...",
     "filename": "test-document.pdf",
     "s3Location": "s3://dev-service-optimisation-c63f2/content-uploads/..."
   }
   ```

---

## Troubleshooting

### Error: "Missing credentials in config"
- **Solution:** Set up one of the authentication methods above
- **Quick fix:** Use AWS Profile or set `MOCK_S3_UPLOAD=true`

### Error: "Access Denied"
- **Solution:** Ensure your IAM user/role has `s3:PutObject` permission
- **Check:** Bucket policy and IAM policy

### Error: "Network timeout" / "ECONNREFUSED"
- **Solution:** Check AWS endpoint configuration
- **For LocalStack:** Ensure LocalStack is running on port 4566

### Error: "InvalidAccessKeyId"
- **Solution:** Verify your AWS credentials are correct
- **Check:** `~/.aws/credentials` or environment variables

---

## Security Best Practices

1. ✅ Use IAM roles in AWS environments (EC2/ECS/Lambda)
2. ✅ Use AWS SSO/profiles for local development
3. ✅ Rotate credentials regularly
4. ✅ Use least-privilege IAM policies
5. ✅ Never commit credentials to Git
6. ❌ Avoid hardcoding credentials in code
7. ❌ Don't use root account credentials

---

## Required IAM Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3UploadPermissions",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl"
      ],
      "Resource": "arn:aws:s3:::dev-service-optimisation-c63f2/content-uploads/*"
    },
    {
      "Sid": "SQSPermissions",
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:eu-west-2:332499610595:content_review_status"
    }
  ]
}
```

---

## Next Steps

1. Choose the authentication method that fits your environment
2. Create a `.env` file in the backend directory (copy from `.env.example`)
3. Configure the appropriate environment variables
4. Test the upload functionality
5. Monitor CloudWatch logs for S3 upload confirmations

For questions or issues, check the AWS SDK documentation:
- https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html
