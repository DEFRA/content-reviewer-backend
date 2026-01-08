# Status Messages for Frontend Review History UI

## Overview

Every status update in the backend includes a **message** that should be displayed in the frontend Review History UI. These messages are stored in the `statusHistory` array and provide a human-readable timeline of the review process.

---

## 📊 Status Message Flow

```
Backend Status Update → MongoDB statusHistory → API Response → Frontend Review History UI
```

---

## 🔄 Complete Status Messages by Source

### 1. Upload Route Messages (`src/routes/upload.js`)

| Step        | Status      | Message                            | Progress |
| ----------- | ----------- | ---------------------------------- | -------- |
| Initial     | `pending`   | "Upload initiated"                 | 0%       |
| Reading     | `uploading` | "Reading file content"             | 5%       |
| S3 Upload   | `uploading` | "Uploading file to S3"             | 10%      |
| S3 Complete | `uploaded`  | "File uploaded successfully to S3" | 20%      |
| Queue       | `queued`    | "Added to processing queue"        | 30%      |
| Error       | `failed`    | "Upload failed: {error message}"   | -        |

**Code Locations**:

```javascript
// Line ~97 - Initial status
await reviewStatusTracker.createStatus(uploadId, filename, userId, metadata)
// Message: "Upload initiated"

// Line ~124 - Reading file
await reviewStatusTracker.updateStatus(
  uploadId,
  'uploading',
  'Reading file content',
  5
)

// Line ~153 - Uploading to S3
await reviewStatusTracker.updateStatus(
  uploadId,
  'uploading',
  'Uploading file to S3',
  10
)

// Line ~181 - Uploaded to S3
await reviewStatusTracker.updateStatus(
  uploadId,
  'uploaded',
  'File uploaded successfully to S3',
  20
)

// Line ~217 - Queued for processing
await reviewStatusTracker.updateStatus(
  uploadId,
  'queued',
  'Added to processing queue',
  30
)

// Line ~260+ - Failed
await reviewStatusTracker.markFailed(
  uploadId,
  `Upload failed: ${error.message}`
)
```

---

### 2. SQS Worker Messages (`src/common/helpers/sqs-worker.js`)

| Step     | Status        | Message                                     | Progress |
| -------- | ------------- | ------------------------------------------- | -------- |
| Start    | `processing`  | "Worker started processing"                 | 35%      |
| Download | `downloading` | "Downloading file from S3"                  | 45%      |
| Analyze  | `analyzing`   | "Extracting and analyzing document content" | 60%      |
| Review   | `reviewing`   | "AI content review in progress"             | 75%      |
| Finalize | `finalizing`  | "Saving review results"                     | 90%      |
| Complete | `completed`   | "Content review completed successfully"     | 100%     |
| Error    | `failed`      | "Processing failed: {error message}"        | -        |

**Code Locations**:

```javascript
// Line ~212 - Processing started
await reviewStatusTracker.updateStatus(
  uploadId,
  'processing',
  'Worker started processing',
  35
)

// Line ~267 - Downloading from S3
await reviewStatusTracker.updateStatus(
  uploadId,
  'downloading',
  'Downloading file from S3',
  45
)

// Line ~283 - Analyzing content
await reviewStatusTracker.updateStatus(
  uploadId,
  'analyzing',
  'Extracting and analyzing document content',
  60
)

// Line ~298 - AI Review
await reviewStatusTracker.updateStatus(
  uploadId,
  'reviewing',
  'AI content review in progress',
  75
)

// Line ~314 - Finalizing
await reviewStatusTracker.updateStatus(
  uploadId,
  'finalizing',
  'Saving review results',
  90
)

// Line ~334 - Completed
await reviewStatusTracker.markCompleted(uploadId, reviewResult)
// Message: "Content review completed successfully"

// Line ~237+ - Failed
await reviewStatusTracker.markFailed(
  uploadId,
  `Processing failed: ${error.message}`
)
```

---

## 📡 API Response Format

### GET /api/status/:uploadId

```json
{
  "success": true,
  "data": {
    "uploadId": "abc-123",
    "filename": "document.pdf",
    "status": "reviewing",
    "progress": 75,
    "statusHistory": [
      {
        "status": "pending",
        "message": "Upload initiated",
        "timestamp": "2024-01-15T10:00:00.000Z",
        "progress": 0
      },
      {
        "status": "uploading",
        "message": "Reading file content",
        "timestamp": "2024-01-15T10:00:02.000Z",
        "progress": 5
      },
      {
        "status": "uploading",
        "message": "Uploading file to S3",
        "timestamp": "2024-01-15T10:00:05.000Z",
        "progress": 10
      },
      {
        "status": "uploaded",
        "message": "File uploaded successfully to S3",
        "timestamp": "2024-01-15T10:00:15.000Z",
        "progress": 20
      },
      {
        "status": "queued",
        "message": "Added to processing queue",
        "timestamp": "2024-01-15T10:00:16.000Z",
        "progress": 30
      },
      {
        "status": "processing",
        "message": "Worker started processing",
        "timestamp": "2024-01-15T10:00:20.000Z",
        "progress": 35
      },
      {
        "status": "downloading",
        "message": "Downloading file from S3",
        "timestamp": "2024-01-15T10:00:22.000Z",
        "progress": 45
      },
      {
        "status": "analyzing",
        "message": "Extracting and analyzing document content",
        "timestamp": "2024-01-15T10:00:30.000Z",
        "progress": 60
      },
      {
        "status": "reviewing",
        "message": "AI content review in progress",
        "timestamp": "2024-01-15T10:00:45.000Z",
        "progress": 75
      }
    ],
    "createdAt": "2024-01-15T10:00:00.000Z",
    "updatedAt": "2024-01-15T10:00:45.000Z"
  }
}
```

---

## 🎨 Frontend UI Implementation

### Review History Timeline Component

```javascript
// Example: Display status history as a timeline
function ReviewHistoryTimeline({ uploadId }) {
  const [statusData, setStatusData] = useState(null)

  useEffect(() => {
    // Fetch status history
    async function fetchHistory() {
      const response = await fetch(`/api/status/${uploadId}/history`)
      const { data } = await response.json()
      setStatusData(data)
    }

    fetchHistory()
  }, [uploadId])

  if (!statusData) return <LoadingSpinner />

  return (
    <div className="review-history">
      <h2>Review History: {statusData.filename}</h2>

      <div className="timeline">
        {statusData.history.map((item, index) => (
          <TimelineItem
            key={index}
            status={item.status}
            message={item.message}
            timestamp={item.timestamp}
            progress={item.progress}
            isLatest={index === statusData.history.length - 1}
          />
        ))}
      </div>
    </div>
  )
}

function TimelineItem({ status, message, timestamp, progress, isLatest }) {
  return (
    <div className={`timeline-item ${isLatest ? 'active' : ''}`}>
      <div className="timeline-marker">
        <StatusIcon status={status} />
      </div>

      <div className="timeline-content">
        <div className="status-badge">{status.toUpperCase()}</div>
        <div className="status-message">{message}</div>
        <div className="status-meta">
          <span className="timestamp">
            {new Date(timestamp).toLocaleString()}
          </span>
          {progress !== undefined && (
            <span className="progress">{progress}%</span>
          )}
        </div>
      </div>
    </div>
  )
}
```

---

### Live Status Display (During Upload)

```javascript
function UploadProgress({ uploadId }) {
  const [currentStatus, setCurrentStatus] = useState(null)

  useEffect(() => {
    // Poll for status updates
    const interval = setInterval(async () => {
      const response = await fetch(`/api/status/${uploadId}`)
      const { data } = await response.json()

      setCurrentStatus(data)

      // Stop polling when complete or failed
      if (data.status === 'completed' || data.status === 'failed') {
        clearInterval(interval)
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [uploadId])

  if (!currentStatus) return <LoadingSpinner />

  // Get the latest status message
  const latestHistory =
    currentStatus.statusHistory[currentStatus.statusHistory.length - 1]

  return (
    <div className="upload-progress">
      <ProgressBar percentage={currentStatus.progress} />

      <div className="current-status">
        <StatusBadge status={currentStatus.status} />
        <p className="status-message">{latestHistory.message}</p>
      </div>

      {currentStatus.status === 'completed' && (
        <Button onClick={() => viewResults(currentStatus.result)}>
          View Results
        </Button>
      )}

      {currentStatus.status === 'failed' && (
        <ErrorMessage error={currentStatus.error} />
      )}
    </div>
  )
}
```

---

### Dashboard with Upload List

```javascript
function UploadDashboard({ userId }) {
  const [uploads, setUploads] = useState([])

  useEffect(() => {
    async function fetchUploads() {
      const response = await fetch('/api/status', {
        headers: { 'x-user-id': userId }
      })
      const { data } = await response.json()
      setUploads(data)
    }

    fetchUploads()
  }, [userId])

  return (
    <div className="upload-dashboard">
      <h2>My Uploads</h2>

      <div className="upload-list">
        {uploads.map((upload) => {
          // Get latest status message
          const latestMessage =
            upload.statusHistory[upload.statusHistory.length - 1].message

          return (
            <div key={upload.uploadId} className="upload-card">
              <div className="upload-header">
                <h3>{upload.filename}</h3>
                <StatusBadge status={upload.status} />
              </div>

              <div className="upload-details">
                <p className="status-message">{latestMessage}</p>
                <ProgressBar percentage={upload.progress} />
                <p className="timestamp">
                  {new Date(upload.createdAt).toLocaleString()}
                </p>
              </div>

              <Button onClick={() => viewDetails(upload.uploadId)}>
                View History
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

---

## 📝 Message Display Guidelines

### 1. **Live Progress View**

Display the **latest message** from `statusHistory`:

```javascript
const latestMessage = statusHistory[statusHistory.length - 1].message
```

### 2. **Complete Timeline View**

Display **all messages** in chronological order:

```javascript
statusHistory.map((item) => (
  <div>
    <p>{item.message}</p>
    <span>{new Date(item.timestamp).toLocaleString()}</span>
  </div>
))
```

### 3. **Status Badges**

Map status to visual indicators:

```javascript
const statusConfig = {
  pending: { color: 'gray', icon: 'clock' },
  uploading: { color: 'blue', icon: 'upload' },
  uploaded: { color: 'green', icon: 'check' },
  queued: { color: 'orange', icon: 'queue' },
  processing: { color: 'blue', icon: 'cog' },
  downloading: { color: 'blue', icon: 'download' },
  analyzing: { color: 'purple', icon: 'search' },
  reviewing: { color: 'purple', icon: 'eye' },
  finalizing: { color: 'green', icon: 'save' },
  completed: { color: 'green', icon: 'check-circle' },
  failed: { color: 'red', icon: 'x-circle' }
}
```

---

## 🎯 Example UI Layouts

### Timeline View (Vertical)

```
┌─────────────────────────────────────────┐
│  Review History: document.pdf           │
├─────────────────────────────────────────┤
│                                         │
│  ● Upload initiated                     │
│    10:00:00 AM - 0%                     │
│    ↓                                    │
│  ● Reading file content                 │
│    10:00:02 AM - 5%                     │
│    ↓                                    │
│  ● Uploading file to S3                 │
│    10:00:05 AM - 10%                    │
│    ↓                                    │
│  ● File uploaded successfully to S3     │
│    10:00:15 AM - 20%                    │
│    ↓                                    │
│  ● Added to processing queue            │
│    10:00:16 AM - 30%                    │
│    ↓                                    │
│  ● Worker started processing            │
│    10:00:20 AM - 35%                    │
│    ↓                                    │
│  ● Downloading file from S3             │
│    10:00:22 AM - 45%                    │
│    ↓                                    │
│  ● Extracting and analyzing content     │
│    10:00:30 AM - 60%                    │
│    ↓                                    │
│  ⚡ AI content review in progress       │
│    10:00:45 AM - 75% (CURRENT)          │
│                                         │
└─────────────────────────────────────────┘
```

### Progress View (Live)

```
┌─────────────────────────────────────────┐
│  Uploading: document.pdf                │
├─────────────────────────────────────────┤
│                                         │
│  [████████████████░░░░] 75%            │
│                                         │
│  Status: REVIEWING                      │
│  AI content review in progress          │
│                                         │
│  Started: 10:00:00 AM                   │
│  Time elapsed: 45 seconds               │
│                                         │
└─────────────────────────────────────────┘
```

### Card View (Dashboard)

```
┌──────────────────────┐  ┌──────────────────────┐
│  document.pdf        │  │  report.docx         │
│  ───────────────     │  │  ───────────────     │
│  [REVIEWING] 75%     │  │  [COMPLETED] 100%    │
│                      │  │                      │
│  AI content review   │  │  Review complete     │
│  in progress         │  │                      │
│                      │  │                      │
│  10:00 AM            │  │  9:30 AM             │
│  [View History]      │  │  [View Results]      │
└──────────────────────┘  └──────────────────────┘
```

---

## 🔄 Real-time Updates

### Polling Strategy

```javascript
// Poll every 2 seconds for active uploads
const POLL_INTERVAL = 2000

function pollStatus(uploadId, onUpdate) {
  const interval = setInterval(async () => {
    const response = await fetch(`/api/status/${uploadId}`)
    const { data } = await response.json()

    // Get latest message
    const latestHistory = data.statusHistory[data.statusHistory.length - 1]

    onUpdate({
      status: data.status,
      progress: data.progress,
      message: latestHistory.message,
      timestamp: latestHistory.timestamp
    })

    // Stop polling when done
    if (data.status === 'completed' || data.status === 'failed') {
      clearInterval(interval)
    }
  }, POLL_INTERVAL)

  return () => clearInterval(interval)
}
```

---

## 📊 Message Categories

### Information Messages (Blue)

- "Upload initiated"
- "Reading file content"
- "Uploading file to S3"
- "Worker started processing"
- "Downloading file from S3"

### Processing Messages (Purple)

- "Extracting and analyzing document content"
- "AI content review in progress"
- "Saving review results"

### Success Messages (Green)

- "File uploaded successfully to S3"
- "Added to processing queue"
- "Content review completed successfully"

### Error Messages (Red)

- "Upload failed: {reason}"
- "Processing failed: {reason}"
- "File type not allowed: {type}"
- "File too large: {size} bytes"

---

## 🎨 CSS Example

```css
.timeline-item {
  display: flex;
  padding: 1rem;
  border-left: 2px solid #e0e0e0;
}

.timeline-item.active {
  border-left-color: #6366f1;
  background: #f5f5ff;
}

.status-message {
  font-size: 1rem;
  color: #374151;
  font-weight: 500;
}

.status-badge {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}

.status-badge.reviewing {
  background: #ddd6fe;
  color: #6d28d9;
}

.status-badge.completed {
  background: #d1fae5;
  color: #065f46;
}

.status-badge.failed {
  background: #fee2e2;
  color: #991b1b;
}
```

---

## ✅ Summary

**All status messages are:**

1. ✅ Stored in `statusHistory` array in MongoDB
2. ✅ Returned by `/api/status/:uploadId` endpoint
3. ✅ Include human-readable text
4. ✅ Include timestamps and progress percentage
5. ✅ Ready to be displayed in frontend Review History UI

**Frontend should:**

1. Poll `/api/status/:uploadId` every 2 seconds during upload
2. Display latest message in live progress view
3. Display complete history in timeline view
4. Format timestamps as human-readable
5. Show progress bar with percentage
6. Use status badges for visual clarity

---

_All messages are already implemented and flowing through the system. The frontend just needs to consume the API and display them!_ 🎉
