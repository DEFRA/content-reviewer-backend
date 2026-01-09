# LocalStack with Podman - Quick Reference

## One-Command Setup

```powershell
.\setup-localstack.ps1
```

---

## Manual Setup (4 Commands)

```powershell
# 1. Start LocalStack
podman run -d --name localstack -p 4566:4566 -e SERVICES=s3,sqs localstack/localstack:latest

# 2. Create S3 bucket
aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2

# 3. Configure .env
@"
AWS_ENDPOINT=http://localhost:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_REGION=eu-west-2
"@ | Out-File .env -Append

# 4. Start backend
npm start
```

---

## Essential Commands

| Action | Command |
|--------|---------|
| **Start LocalStack** | `podman start localstack` |
| **Stop LocalStack** | `podman stop localstack` |
| **View logs** | `podman logs -f localstack` |
| **Check health** | `curl http://localhost:4566/_localstack/health` |
| **List buckets** | `aws --endpoint-url=http://localhost:4566 s3 ls` |
| **List files** | `aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive` |
| **Test credentials** | `node test-aws-credentials.js` |
| **Upload test file** | `curl -X POST http://localhost:3001/upload -F "file=@test.txt"` |

---

## .env Configuration

```bash
# LocalStack
AWS_ENDPOINT=http://localhost:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_REGION=eu-west-2

# S3
UPLOAD_S3_BUCKET=dev-service-optimisation-c63f2
UPLOAD_S3_PATH=content-uploads

# SQS (optional)
SQS_QUEUE_URL=http://localhost:4566/000000000000/content_review_status
```

---

## Testing Workflow

```powershell
# 1. Start LocalStack
podman start localstack

# 2. Start backend
npm start

# 3. Start frontend (new terminal)
cd ..\content-reviewer-frontend
npm start

# 4. Open browser
Start-Process http://localhost:3000

# 5. Upload a file and verify
aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port 4566 in use | `podman stop localstack` or use different port |
| Container won't start | `podman logs localstack` to check errors |
| Bucket not found | `aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2` |
| Connection refused | Wait 10-15 seconds for LocalStack to start |
| AWS CLI not found | Install from https://aws.amazon.com/cli/ |

---

## Cleanup

```powershell
# Remove everything
podman rm -f localstack

# Or full reset
podman rm -f localstack
podman rmi localstack/localstack:latest
.\setup-localstack.ps1
```

---

## Full Documentation

- **PODMAN_LOCALSTACK_SETUP.md** - Complete guide with all details
- **QUICK_START.md** - Get started in 5 minutes
- **AWS_SETUP_GUIDE.md** - All AWS authentication methods
- **AWS_CONFIG_SUMMARY.md** - Configuration reference

---

**🚀 Get started:** Run `.\setup-localstack.ps1` and follow the prompts!
