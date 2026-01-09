# Environment Configuration Guide

This document explains how to configure the Content Reviewer Backend for different environments.

## Environment Types

The application supports the following environments:

- **local** - Local development with LocalStack
- **dev** - CDP Development environment
- **test** - CDP Test environment  
- **perf-test** - CDP Performance Testing environment
- **prod** - CDP Production environment

---

## Local Development (LocalStack)

### Configuration File: `.env`

```bash
ENVIRONMENT=local
NODE_ENV=development

# LocalStack endpoints
AWS_ENDPOINT=http://localhost:4566
SQS_ENDPOINT=http://localhost:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
S3_FORCE_PATH_STYLE=true
```

### Key Features:
- ✅ Uses LocalStack for S3 and SQS
- ✅ No real AWS credentials needed
- ✅ Fast local testing
- ✅ No AWS costs

### Prerequisites:
1. LocalStack container running on port 4566
2. S3 bucket created: `dev-service-optimisation-c63f2`
3. SQS queue created: `content_review_status`

### Quick Setup:
```powershell
# Start LocalStack (Podman)
podman-compose -f compose.yml up -d

# Create S3 bucket
aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2

# Create SQS queue
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name content_review_status
```

---

## CDP Environments

### Dev Environment

**URL:** https://content-reviewer-backend.dev.cdp-int.defra.cloud

**Configuration File:** `.env.dev`

```bash
ENVIRONMENT=dev
NODE_ENV=production

# Real AWS (no endpoints specified - uses IAM role)
AWS_REGION=eu-west-2

# S3
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2

# SQS
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status_dev

# CORS
CORS_ORIGIN=["https://content-reviewer-frontend.dev.cdp-int.defra.cloud"]
```

### Test Environment

**URL:** https://content-reviewer-backend.test.cdp-int.defra.cloud

**Configuration File:** `.env.test`

```bash
ENVIRONMENT=test
NODE_ENV=production
AWS_REGION=eu-west-2
UPLOAD_S3_BUCKET=test-service-optimisation-bucket
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status_test
CORS_ORIGIN=["https://content-reviewer-frontend.test.cdp-int.defra.cloud"]
```

### Perf-Test Environment

**URL:** https://content-reviewer-backend.perf-test.cdp-int.defra.cloud

**Configuration File:** `.env.perf-test`

```bash
ENVIRONMENT=perf-test
NODE_ENV=production
AWS_REGION=eu-west-2
UPLOAD_S3_BUCKET=perf-test-service-optimisation-bucket
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status_perf_test
CORS_ORIGIN=["https://content-reviewer-frontend.perf-test.cdp-int.defra.cloud"]
LOG_LEVEL=warn
```

### Production Environment

**URL:** https://content-reviewer-backend.prod.cdp-int.defra.cloud

**Configuration File:** `.env.prod`

```bash
ENVIRONMENT=prod
NODE_ENV=production
AWS_REGION=eu-west-2
UPLOAD_S3_BUCKET=prod-service-optimisation-bucket
SQS_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status_prod
CORS_ORIGIN=["https://content-reviewer-frontend.prod.cdp-int.defra.cloud"]
LOG_LEVEL=warn
ENABLE_METRICS=true
```

---

## Configuration Variables

### Required Variables

| Variable | Description | Local | CDP |
|----------|-------------|-------|-----|
| `ENVIRONMENT` | Environment name | `local` | `dev`/`test`/`perf-test`/`prod` |
| `NODE_ENV` | Node environment | `development` | `production` |
| `AWS_REGION` | AWS region | `eu-west-2` | `eu-west-2` |
| `UPLOAD_S3_BUCKET` | S3 bucket name | ✅ | ✅ |
| `SQS_QUEUE_URL` | SQS queue URL | ✅ | ✅ |

### LocalStack-Specific Variables

| Variable | Description | Required for LocalStack |
|----------|-------------|------------------------|
| `AWS_ENDPOINT` | LocalStack endpoint | ✅ Yes |
| `SQS_ENDPOINT` | SQS endpoint | ✅ Yes |
| `AWS_ACCESS_KEY_ID` | Access key (use "test") | ✅ Yes |
| `AWS_SECRET_ACCESS_KEY` | Secret key (use "test") | ✅ Yes |
| `S3_FORCE_PATH_STYLE` | Force path-style URLs | ✅ Yes |

### CDP-Specific Variables

| Variable | Description | Required for CDP |
|----------|-------------|------------------|
| `SERVICE_VERSION` | Service version | Auto-injected |
| `ENABLE_METRICS` | Enable CloudWatch metrics | ✅ Yes |
| `LOG_FORMAT` | Log format (use "ecs") | ✅ Yes |

---

## How It Works

### Local Development (LocalStack)
```
Application → AWS SDK → LocalStack (localhost:4566) → Mock S3/SQS
```

### CDP Environments
```
Application → AWS SDK → IAM Role → Real AWS S3/SQS
```

The application automatically detects the environment:
- If `AWS_ENDPOINT` is set → Uses LocalStack
- If `AWS_ENDPOINT` is NOT set → Uses real AWS with IAM role

---

## Switching Environments

### Method 1: Use Environment-Specific Files

```powershell
# Local development
cp .env.local .env
npm start

# Dev environment
cp .env.dev .env
npm start

# Test environment
cp .env.test .env
npm start
```

### Method 2: Environment Variables

```powershell
# Override individual variables
$env:ENVIRONMENT='dev'
$env:AWS_REGION='eu-west-2'
npm start
```

---

## Validation

### Check Current Configuration

The application logs configuration on startup:

```
[S3Uploader] Using custom AWS endpoint: http://localhost:4566
[S3Uploader] Target bucket: dev-service-optimisation-c63f2/content-uploads
[S3Uploader] Environment: local
[SQSClient] Queue Name: content_review_status
[SQSClient] Environment: local
```

### Test Connectivity

```powershell
# Test S3 (LocalStack)
curl.exe http://localhost:4566/dev-service-optimisation-c63f2

# Test S3 (Real AWS)
aws s3 ls s3://dev-service-optimisation-c63f2/

# Test SQS (LocalStack)
aws --endpoint-url=http://localhost:4566 sqs list-queues

# Test SQS (Real AWS)
aws sqs list-queues
```

---

## Best Practices

### Local Development
1. ✅ Always use `.env` file (not committed to git)
2. ✅ Keep LocalStack running
3. ✅ Use test credentials
4. ✅ Enable debug logging

### CDP Environments
1. ✅ Never commit `.env.*` files with real credentials
2. ✅ Use IAM roles (no hardcoded credentials)
3. ✅ Enable metrics in production
4. ✅ Use ECS log format
5. ✅ Set appropriate log levels

---

## Troubleshooting

### Issue: "Cannot connect to LocalStack"
**Solution:** Ensure LocalStack container is running on port 4566

### Issue: "Access Denied" in CDP
**Solution:** Check IAM role has S3 and SQS permissions

### Issue: "CORS error"
**Solution:** Verify `CORS_ORIGIN` matches frontend URL

### Issue: "Queue not found"
**Solution:** Check `SQS_QUEUE_URL` is correct for environment

---

## Security Notes

### LocalStack (Local):
- ⚠️ Uses test credentials (not secure, local only)
- ⚠️ No encryption
- ⚠️ Not for production data

### CDP Environments:
- ✅ Uses IAM roles (no hardcoded credentials)
- ✅ S3 encryption at rest
- ✅ VPC network security
- ✅ CloudWatch logging

---

## Quick Reference

| Environment | Endpoint | Auth Method | S3 Bucket Prefix |
|-------------|----------|-------------|------------------|
| **local** | localhost:4566 | Test credentials | `dev-` |
| **dev** | Real AWS | IAM Role | `dev-` |
| **test** | Real AWS | IAM Role | `test-` |
| **perf-test** | Real AWS | IAM Role | `perf-test-` |
| **prod** | Real AWS | IAM Role | `prod-` |

---

For more details, see:
- AWS SDK Documentation: https://docs.aws.amazon.com/sdk-for-javascript/
- LocalStack Documentation: https://docs.localstack.cloud/
- CDP Platform Guide: (Internal Defra documentation)
