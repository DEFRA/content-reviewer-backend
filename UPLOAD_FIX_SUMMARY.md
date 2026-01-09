# File Upload Fix Summary

## Problem
The frontend was trying to upload files to `http://localhost:3001/upload`, but the backend endpoint is configured as `/api/upload`.

## Solution
Updated the frontend JavaScript in `content-reviewer-frontend/src/server/home/index.njk` to call the correct endpoint:

**Changed from:**
```javascript
const response = await fetch(window.APP_CONFIG.backendApiUrl + '/upload', {
```

**Changed to:**
```javascript
const response = await fetch(window.APP_CONFIG.backendApiUrl + '/api/upload', {
```

## Verification

### 1. Backend endpoint test
```powershell
curl.exe -X POST http://localhost:3001/api/upload -F "file=@test-upload.txt"
```

**Response:** ✅ Backend is responding correctly (rejecting .txt files as expected - only PDF/Word are allowed)

### 2. Both servers are running
- ✅ Frontend: http://localhost:3000
- ✅ Backend: http://localhost:3001

### 3. LocalStack S3 is ready
- ✅ Bucket: `dev-service-optimisation-c63f2` exists
- ✅ Endpoint: http://localhost:4566

## How to Test File Upload from UI

1. **Open the frontend** in your browser:
   ```
   http://localhost:3000
   ```

2. **Upload a file:**
   - Click on the file input under "Upload a document (optional)"
   - Select a PDF (.pdf) or Word (.doc, .docx) file
   - Click "Review Content" button

3. **Expected behavior:**
   - The file should upload successfully
   - Status in the review history table will progress:
     - Uploading → Queued → Reviewing Content → Completed
   - File should be stored in LocalStack S3 bucket

4. **Verify the upload in S3:**
   ```powershell
   # Using AWS CLI
   aws --endpoint-url=http://localhost:4566 s3 ls s3://dev-service-optimisation-c63f2/content-uploads/ --recursive
   
   # Or using Invoke-WebRequest
   $response = Invoke-WebRequest -Uri "http://localhost:4566/dev-service-optimisation-c63f2?list-type=2&prefix=content-uploads/" -Method GET
   $response.Content
   ```

## Accepted File Types

The backend accepts the following file types:
- **PDF**: `.pdf` (application/pdf)
- **Word**: `.doc` (application/msword)
- **Word**: `.docx` (application/vnd.openxmlformats-officedocument.wordprocessingml.document)

Maximum file size: **10MB**

## Backend Configuration

The backend is configured to use LocalStack via the `.env` file:

```
S3_ENDPOINT=http://localhost:4566
S3_BUCKET=dev-service-optimisation-c63f2
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
```

## Common Issues

### Issue: "File type not allowed"
**Cause:** Trying to upload a file type other than PDF or Word
**Solution:** Only upload PDF (.pdf) or Word (.doc, .docx) files

### Issue: "Upload failed: 404"
**Cause:** Backend endpoint path mismatch
**Solution:** ✅ Fixed - Frontend now calls `/api/upload`

### Issue: "CORS error"
**Cause:** CORS not configured properly
**Solution:** Backend has CORS enabled for `http://localhost:3000`

## Next Steps

After successful file upload:
1. Files will be stored in LocalStack S3
2. (Optional) SQS queue can be configured to process uploaded files
3. Files can be retrieved from S3 for review/processing

## Files Changed

- `content-reviewer-frontend/src/server/home/index.njk` - Fixed upload endpoint path
