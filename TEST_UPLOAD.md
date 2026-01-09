# Test File Upload to Backend

## Quick Test via PowerShell

Create a test file and upload it:

```powershell
# Create a test PDF file
"Test Content" | Out-File -FilePath "test-upload.txt" -Encoding UTF8

# Upload the file to the backend
$form = @{
    file = Get-Item -Path "test-upload.txt"
}

$response = Invoke-WebRequest -Uri "http://localhost:3001/api/upload" `
    -Method POST `
    -Form $form `
    -ContentType "multipart/form-data"

# View the response
$response.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10
```

## Alternative: Using curl (if installed)

```powershell
curl -X POST http://localhost:3001/api/upload -F "file=@test-upload.txt"
```

## Check if the file was uploaded to S3

```powershell
# List files in the S3 bucket
$response = Invoke-WebRequest -Uri "http://localhost:4566/dev-service-optimisation-c63f2?list-type=2&prefix=content-uploads/" -Method GET
$response.Content
```

## Test from Frontend

1. Open your browser to http://localhost:3000
2. Click on the file upload input
3. Select a PDF or Word document
4. Click "Review Content"
5. Check the review history table - the status should progress from:
   - Uploading → Queued → Reviewing Content → Completed

## Verify Backend Logs

Check the backend console output for upload activity:
- Look for "Upload request received" messages
- Check for S3 upload confirmations
- Look for any errors

## Verify S3 Upload

After uploading a file through the UI, verify it's in LocalStack S3:

```powershell
# List all files in the bucket
aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive
```

Or using Invoke-WebRequest:

```powershell
$response = Invoke-WebRequest -Uri "http://localhost:4566/dev-service-optimisation-c63f2?list-type=2&prefix=content-uploads/" -Method GET
$response.Content
```
