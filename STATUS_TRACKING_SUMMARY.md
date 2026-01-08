# Status Tracking Implementation Summary

## ✅ Yes! You can send acknowledgment messages at each step!

This implementation provides **real-time status updates** that the frontend can display as:

- "Uploading file..."
- "File uploaded"
- "Queued for processing"
- "Analyzing content..."
- "AI review in progress..."
- "Review complete!"

---

## 📦 Files Created

### 1. **`src/common/helpers/review-status-tracker.js`**

- Core status tracking logic
- MongoDB integration
- Status history management

### 2. **`src/routes/status.js`**

- REST API endpoints for status queries
- GET `/api/status/:uploadId` - Get specific status
- GET `/api/status` - Get all user statuses
- GET `/api/status/:uploadId/history` - Get status timeline
- GET `/api/status/statistics` - Get statistics

### 3. **`STATUS_TRACKING_ARCHITECTURE.md`**

- Comprehensive documentation
- Implementation guide
- Frontend integration examples

---

## 🎯 How It Works

### Status Flow

```
1. Upload starts → Status: "uploading" (0%)
2. File uploaded to S3 → Status: "uploaded" (15%)
3. Message sent to SQS → Status: "queued" (25%)
4. Worker picks up message → Status: "processing" (35%)
5. Download from S3 → Status: "downloading" (45%)
6. Extract content → Status: "analyzing" (55%)
7. Send to AI → Status: "reviewing" (75%)
8. Save results → Status: "finalizing" (90%)
9. Complete → Status: "completed" (100%)
```

### Database Structure

```javascript
{
  uploadId: "abc-123",
  filename: "document.pdf",
  status: "reviewing",        // Current status
  progress: 75,               // Percentage
  statusHistory: [
    {
      status: "uploading",
      timestamp: "2026-01-08T12:00:00Z",
      message: "Starting file upload",
      progress: 0
    },
    {
      status: "uploaded",
      timestamp: "2026-01-08T12:00:05Z",
      message: "File uploaded successfully",
      progress: 15
    },
    // ... more history entries
  ],
  userId: "user@example.com",
  createdAt: "2026-01-08T12:00:00Z",
  updatedAt: "2026-01-08T12:00:15Z"
}
```

---

## 🔧 Integration Points

### 1. Upload Route (`src/routes/upload.js`)

Add status tracking:

```javascript
import {
  reviewStatusTracker,
  ReviewStatus
} from '../common/helpers/review-status-tracker.js'

// Create initial status
await reviewStatusTracker.createStatus(uploadId, filename, userId)

// Update as file uploads
await reviewStatusTracker.updateStatus(
  uploadId,
  'uploading',
  'Uploading to S3',
  5
)

// Mark as uploaded
await reviewStatusTracker.updateStatus(
  uploadId,
  'uploaded',
  'File uploaded successfully',
  15
)

// Mark as queued
await reviewStatusTracker.updateStatus(
  uploadId,
  'queued',
  'Added to processing queue',
  25
)
```

### 2. SQS Worker (`src/common/helpers/sqs-worker.js`)

Update status at each processing step:

```javascript
import { reviewStatusTracker } from './review-status-tracker.js'

async processContentReview(messageBody, uploadId) {
  try {
    // Processing started
    await reviewStatusTracker.updateStatus(
      uploadId, 'processing', 'Worker started processing', 35
    )

    // Downloading from S3
    await reviewStatusTracker.updateStatus(
      uploadId, 'downloading', 'Downloading file from S3', 45
    )

    // Download file...

    // Analyzing content
    await reviewStatusTracker.updateStatus(
      uploadId, 'analyzing', 'Extracting and analyzing content', 55
    )

    // Extract content...

    // AI Review
    await reviewStatusTracker.updateStatus(
      uploadId, 'reviewing', 'AI content review in progress', 75
    )

    // Call AI service...

    // Finalizing
    await reviewStatusTracker.updateStatus(
      uploadId, 'finalizing', 'Saving review results', 90
    )

    // Save results...

    // Completed
    await reviewStatusTracker.markCompleted(uploadId, reviewResult)

  } catch (error) {
    await reviewStatusTracker.markFailed(uploadId, error.message)
    throw error
  }
}
```

### 3. Router Registration (`src/plugins/router.js`)

Add status routes:

```javascript
import { statusRoutes } from '../routes/status.js'

await server.register([
  exampleRoutes,
  healthRoutes,
  uploadRoutes,
  statusRoutes, // ← Add this
  chatRoutes
])
```

### 4. Frontend Integration

#### Option A: Polling (Simple)

```javascript
// After file upload, start polling for status
async function uploadFile(file) {
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetch('/api/upload', {
    method: 'POST',
    body: formData
  })

  const { uploadId } = await response.json()

  // Start polling for status
  pollStatus(uploadId)
}

async function pollStatus(uploadId) {
  const statusElement = document.getElementById('status-message')
  const progressBar = document.getElementById('progress')

  const interval = setInterval(async () => {
    const response = await fetch(`/api/status/${uploadId}`)
    const { data } = await response.json()

    // Update UI
    statusElement.textContent = getStatusMessage(data.status)
    progressBar.value = data.progress

    // Stop polling when done
    if (data.status === 'completed' || data.status === 'failed') {
      clearInterval(interval)

      if (data.status === 'completed') {
        showResults(data.result)
      } else {
        showError(data.error)
      }
    }
  }, 2000) // Poll every 2 seconds
}

function getStatusMessage(status) {
  const messages = {
    uploading: '📤 Uploading file...',
    uploaded: '✅ Upload complete',
    queued: '⏳ Queued for processing',
    processing: '⚙️ Processing started',
    downloading: '📥 Downloading file',
    analyzing: '🔍 Analyzing content',
    reviewing: '🤖 AI review in progress',
    finalizing: '💾 Finalizing results',
    completed: '✨ Review complete!',
    failed: '❌ Review failed'
  }
  return messages[status] || 'Processing...'
}
```

#### Option B: Server-Sent Events (Real-time)

```javascript
// Backend: Add SSE endpoint
server.route({
  method: 'GET',
  path: '/api/status/{uploadId}/stream',
  handler: async (request, h) => {
    const { uploadId } = request.params

    return h
      .response()
      .type('text/event-stream')
      .header('Cache-Control', 'no-cache')
      .header('Connection', 'keep-alive')
  }
})

// Frontend: Listen for updates
const eventSource = new EventSource(`/api/status/${uploadId}/stream`)

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data)
  updateUI(data.status, data.progress, data.message)
}
```

---

## 📊 API Endpoints

### Get Single Status

```bash
GET /api/status/{uploadId}

Response:
{
  "success": true,
  "data": {
    "uploadId": "abc-123",
    "filename": "document.pdf",
    "status": "reviewing",
    "progress": 75,
    "statusHistory": [...],
    "createdAt": "2026-01-08T12:00:00Z",
    "updatedAt": "2026-01-08T12:00:15Z"
  }
}
```

### Get All User Statuses

```bash
GET /api/status?limit=50

Response:
{
  "success": true,
  "data": {
    "count": 3,
    "statuses": [
      {
        "uploadId": "abc-123",
        "filename": "doc1.pdf",
        "status": "completed",
        "progress": 100
      },
      ...
    ]
  }
}
```

### Get Status History

```bash
GET /api/status/{uploadId}/history

Response:
{
  "success": true,
  "data": {
    "uploadId": "abc-123",
    "history": [
      {
        "status": "uploading",
        "timestamp": "2026-01-08T12:00:00Z",
        "message": "Starting file upload",
        "progress": 0
      },
      ...
    ]
  }
}
```

---

## 🧪 Testing

```javascript
// Create status
const status = await reviewStatusTracker.createStatus(
  'test-123',
  'test.pdf',
  'user@example.com'
)

// Update status
await reviewStatusTracker.updateStatus(
  'test-123',
  'analyzing',
  'Analyzing content',
  55
)

// Get status
const current = await reviewStatusTracker.getStatus('test-123')
console.log(current.status) // 'analyzing'
console.log(current.progress) // 55

// Mark completed
await reviewStatusTracker.markCompleted('test-123', {
  score: 95,
  issues: []
})

// Get history
const history = await reviewStatusTracker.getStatusHistory('test-123')
console.log(history) // Array of all status changes
```

---

## ✅ Next Steps

1. **Add status routes to router:**

   ```javascript
   // src/plugins/router.js
   import { statusRoutes } from '../routes/status.js'
   await server.register([..., statusRoutes])
   ```

2. **Update upload route to create status:**

   ```javascript
   // src/routes/upload.js
   await reviewStatusTracker.createStatus(uploadId, filename, userId)
   ```

3. **Update SQS worker to track progress:**

   ```javascript
   // src/common/helpers/sqs-worker.js
   await reviewStatusTracker.updateStatus(
     uploadId,
     'processing',
     'Processing...',
     35
   )
   ```

4. **Frontend: Poll for updates:**
   ```javascript
   setInterval(() => fetch(`/api/status/${uploadId}`), 2000)
   ```

---

## 📚 Documentation

- **Full Guide:** `STATUS_TRACKING_ARCHITECTURE.md`
- **Status Tracker:** `src/common/helpers/review-status-tracker.js`
- **API Routes:** `src/routes/status.js`

---

## ✨ Benefits

✅ **Real-time feedback** - Users see progress at each step  
✅ **Transparency** - Users know what's happening with their file  
✅ **Better UX** - No black box, clear status messages  
✅ **Error tracking** - Failed uploads show exact error message  
✅ **History** - Complete timeline of processing  
✅ **Debugging** - Easy to see where processing is stuck

---

**Status:** ✅ **READY TO INTEGRATE**

The implementation is complete and ready to be integrated into your upload and worker flows!
