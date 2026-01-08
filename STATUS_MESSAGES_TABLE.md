# Status Messages Reference Table

## Quick Reference: All Status Update Messages

This table shows **every message** that appears in the Review History UI, in chronological order.

---

## 📋 Complete Message Timeline

| #   | Status        | Progress | Message                                                          | Source        | Line          |
| --- | ------------- | -------- | ---------------------------------------------------------------- | ------------- | ------------- |
| 1   | `pending`     | 0%       | **"Upload initiated"**                                           | upload.js     | ~97           |
| 2   | `uploading`   | 5%       | **"Reading file content"**                                       | upload.js     | ~124          |
| 3   | `uploading`   | 10%      | **"Uploading file to S3"**                                       | upload.js     | ~153          |
| 4   | `uploaded`    | 20%      | **"File uploaded successfully to S3"**                           | upload.js     | ~181          |
| 5   | `queued`      | 30%      | **"Added to processing queue"**                                  | upload.js     | ~217          |
| 6   | `processing`  | 35%      | **"Worker started processing"**                                  | sqs-worker.js | ~212          |
| 7   | `downloading` | 45%      | **"Downloading file from S3"**                                   | sqs-worker.js | ~267          |
| 8   | `analyzing`   | 60%      | **"Extracting and analyzing document content"**                  | sqs-worker.js | ~283          |
| 9   | `reviewing`   | 75%      | **"AI content review in progress"**                              | sqs-worker.js | ~298          |
| 10  | `finalizing`  | 90%      | **"Saving review results"**                                      | sqs-worker.js | ~314          |
| 11  | `completed`   | 100%     | **"Content review completed successfully"**                      | sqs-worker.js | ~334          |
| -   | `failed`      | -        | **"Upload failed: {error}"** or **"Processing failed: {error}"** | Either        | Error handler |

---

## 📊 Example Review History Display

### Successful Upload Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  REVIEW HISTORY - document.pdf                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ✓ Upload initiated                                             │
│    Jan 15, 2024 10:00:00 AM • Progress: 0%                      │
│                                                                 │
│  ✓ Reading file content                                         │
│    Jan 15, 2024 10:00:02 AM • Progress: 5%                      │
│                                                                 │
│  ✓ Uploading file to S3                                         │
│    Jan 15, 2024 10:00:05 AM • Progress: 10%                     │
│                                                                 │
│  ✓ File uploaded successfully to S3                             │
│    Jan 15, 2024 10:00:15 AM • Progress: 20%                     │
│                                                                 │
│  ✓ Added to processing queue                                    │
│    Jan 15, 2024 10:00:16 AM • Progress: 30%                     │
│                                                                 │
│  ✓ Worker started processing                                    │
│    Jan 15, 2024 10:00:20 AM • Progress: 35%                     │
│                                                                 │
│  ✓ Downloading file from S3                                     │
│    Jan 15, 2024 10:00:22 AM • Progress: 45%                     │
│                                                                 │
│  ✓ Extracting and analyzing document content                    │
│    Jan 15, 2024 10:00:30 AM • Progress: 60%                     │
│                                                                 │
│  ✓ AI content review in progress                                │
│    Jan 15, 2024 10:00:45 AM • Progress: 75%                     │
│                                                                 │
│  ✓ Saving review results                                        │
│    Jan 15, 2024 10:01:30 AM • Progress: 90%                     │
│                                                                 │
│  ✅ Content review completed successfully                        │
│    Jan 15, 2024 10:01:45 AM • Progress: 100%                    │
│                                                                 │
│    [View Review Results]                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Failed Upload Example

```
┌─────────────────────────────────────────────────────────────────┐
│  REVIEW HISTORY - large-file.pdf                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ✓ Upload initiated                                             │
│    Jan 15, 2024 10:05:00 AM • Progress: 0%                      │
│                                                                 │
│  ✓ Reading file content                                         │
│    Jan 15, 2024 10:05:02 AM • Progress: 5%                      │
│                                                                 │
│  ❌ Upload failed: File too large: 52428800 bytes                │
│    Jan 15, 2024 10:05:05 AM                                     │
│                                                                 │
│    Maximum file size: 50 MB                                     │
│    [Try Again with Smaller File]                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🎨 Frontend Display Patterns

### Pattern 1: Latest Message (Live Progress)

```javascript
// Display only the current status
const latestHistory = statusHistory[statusHistory.length - 1]

<div className="current-status">
  <p>{latestHistory.message}</p>
  <span>{latestHistory.progress}%</span>
</div>
```

**Displays**: "AI content review in progress" (75%)

---

### Pattern 2: Complete Timeline (History View)

```javascript
// Display all messages in order
{
  statusHistory.map((item, index) => (
    <div key={index} className="history-item">
      <StatusIcon status={item.status} />
      <div>
        <p className="message">{item.message}</p>
        <span className="timestamp">{formatTimestamp(item.timestamp)}</span>
        <span className="progress">{item.progress}%</span>
      </div>
    </div>
  ))
}
```

**Displays**: All 11 messages (or more if failed at a step)

---

### Pattern 3: Status Card (Dashboard)

```javascript
// Display latest message with status badge
const latestMessage = statusHistory[statusHistory.length - 1].message

<div className="upload-card">
  <h3>{filename}</h3>
  <StatusBadge status={currentStatus} />
  <p className="message">{latestMessage}</p>
  <ProgressBar percentage={progress} />
</div>
```

**Displays**: Latest message with progress indicator

---

## 📡 API Response Example

When you call `GET /api/status/:uploadId`, you get:

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

## 🔍 Message Details by Phase

### Upload Phase (Steps 1-5)

**Location**: `src/routes/upload.js`

| Message                            | Meaning                                          |
| ---------------------------------- | ------------------------------------------------ |
| "Upload initiated"                 | Backend received the file upload request         |
| "Reading file content"             | Backend is reading the uploaded file into memory |
| "Uploading file to S3"             | File is being transferred to S3 storage          |
| "File uploaded successfully to S3" | File is now stored in S3                         |
| "Added to processing queue"        | Message sent to SQS for background processing    |

---

### Processing Phase (Steps 6-11)

**Location**: `src/common/helpers/sqs-worker.js`

| Message                                     | Meaning                                    |
| ------------------------------------------- | ------------------------------------------ |
| "Worker started processing"                 | Background worker picked up the message    |
| "Downloading file from S3"                  | Worker is retrieving the file from S3      |
| "Extracting and analyzing document content" | Worker is extracting text from PDF/Word    |
| "AI content review in progress"             | Content is being sent to AI for review     |
| "Saving review results"                     | Review results are being saved to database |
| "Content review completed successfully"     | Everything is done! Results available      |

---

### Error Messages

**Location**: Both files (error handlers)

| Message Format                  | Example                                         | Meaning            |
| ------------------------------- | ----------------------------------------------- | ------------------ |
| "Upload failed: {reason}"       | "Upload failed: File too large: 52428800 bytes" | Upload phase error |
| "Processing failed: {reason}"   | "Processing failed: Unable to extract text"     | Worker phase error |
| "File type not allowed: {type}" | "File type not allowed: image/jpeg"             | Invalid file type  |

---

## 💡 Frontend Usage Tips

### 1. **Show Latest Message During Upload**

```javascript
const currentMessage = statusHistory[statusHistory.length - 1].message
// Display: "AI content review in progress"
```

### 2. **Show All Messages in History View**

```javascript
statusHistory.forEach((item) => {
  console.log(`${item.message} (${item.progress}%)`)
})
```

### 3. **Format Timestamps**

```javascript
function formatTimestamp(timestamp) {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  })
}
// Output: "Jan 15, 2024 10:00:45 AM"
```

### 4. **Calculate Time Elapsed**

```javascript
function getTimeElapsed(createdAt, updatedAt) {
  const start = new Date(createdAt)
  const end = new Date(updatedAt)
  const seconds = Math.floor((end - start) / 1000)

  if (seconds < 60) return `${seconds} seconds`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} minute${minutes > 1 ? 's' : ''}`
}
```

---

## ✅ Summary

### What You Get From Backend:

- ✅ **11 status messages** for successful flow
- ✅ **Timestamps** for each message
- ✅ **Progress percentage** (0-100%)
- ✅ **Error messages** when things fail
- ✅ **Complete history** in chronological order

### What Frontend Should Display:

- ✅ **Live view**: Latest message + progress bar
- ✅ **History view**: All messages as timeline
- ✅ **Dashboard**: Latest message on each card
- ✅ **Timestamps**: Human-readable format
- ✅ **Icons/badges**: Visual status indicators

---

_All messages are already implemented and available via the API!_
_The frontend just needs to fetch and display them._ 🎉
