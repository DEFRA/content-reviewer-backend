# Quick Setup - Copy and Run These Commands

## 1. Create S3 Bucket in LocalStack
```powershell
curl -X PUT http://localhost:4566/dev-service-optimisation-c63f2
```

## 2. Verify Bucket Created
```powershell
curl http://localhost:4566/dev-service-optimisation-c63f2
```

## 3. Start Backend
```powershell
$env:AWS_ACCESS_KEY_ID="test"
$env:AWS_SECRET_ACCESS_KEY="test"
$env:AWS_ENDPOINT="http://localhost:4566"
$env:PORT="3002"
npm start
```

## 4. Check Files After Upload
```powershell
curl "http://localhost:4566/dev-service-optimisation-c63f2?list-type=2&prefix=content-uploads/"
```

## Or Use Podman Desktop:
1. Open Podman Desktop
2. Click on "localstack" container
3. Go to "Logs" tab
4. Watch for S3 PUT requests when you upload files
