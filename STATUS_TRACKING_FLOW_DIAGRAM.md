# Status Tracking Flow Diagram

## Complete Upload and Review Workflow with Status Tracking

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (User)                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ 1. Upload File
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        BACKEND: /api/upload (POST)                          │
│                          src/routes/upload.js                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
   Generate UUID         Validate File Type          Create Status Record
   uploadId              & Size                      ┌──────────────────┐
                                                     │ STATUS: pending  │
                                                     │ PROGRESS: 0%     │
                                                     └──────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Update Status      │
                         │ STATUS: uploading  │
                         │ PROGRESS: 5-10%    │
                         │ MSG: "Uploading to │
                         │      S3..."        │
                         └────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Upload to S3 Bucket                               │
│                       src/common/helpers/s3-uploader.js                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Update Status      │
                         │ STATUS: uploaded   │
                         │ PROGRESS: 20%      │
                         │ MSG: "File uploaded│
                         │      to S3"        │
                         └────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Send Message to SQS                                │
│                       src/common/helpers/sqs-client.js                      │
│                                                                             │
│  Message: {                                                                 │
│    uploadId, filename, s3Bucket, s3Key, s3Location,                        │
│    messageType: 'file_upload', userId, sessionId                           │
│  }                                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Update Status      │
                         │ STATUS: queued     │
                         │ PROGRESS: 30%      │
                         │ MSG: "Added to     │
                         │      queue"        │
                         └────────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Return Response    │
                         │ {                  │
                         │   success: true,   │
                         │   uploadId,        │
                         │   filename,        │
                         │   status: 'queued',│
                         │   statusUrl,       │
                         │   ...              │
                         │ }                  │
                         └────────────────────┘
                                    │
                                    │ Frontend starts polling
                                    ▼
                  ┌──────────────────────────────────┐
                  │  Poll: GET /api/status/:uploadId │
                  │  Every 2 seconds                 │
                  └──────────────────────────────────┘

═══════════════════════════════════════════════════════════════════════════════
                           BACKGROUND PROCESSING
═══════════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────────┐
│                         SQS WORKER (Polling Loop)                           │
│                      src/common/helpers/sqs-worker.js                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Receive Message    │
                         │ from SQS Queue     │
                         │                    │
                         │ Supports:          │
                         │ • App messages     │
                         │ • S3 events        │
                         └────────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Extract uploadId   │
                         │ • From message     │
                         │ • From S3 key      │
                         └────────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Update Status      │
                         │ STATUS: processing │
                         │ PROGRESS: 35%      │
                         │ MSG: "Worker       │
                         │      processing"   │
                         └────────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Update Status      │
                         │ STATUS: downloading│
                         │ PROGRESS: 45%      │
                         │ MSG: "Downloading  │
                         │      from S3"      │
                         └────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │ Download File from S3     │
                    │ (TODO: Implement)         │
                    └───────────────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Update Status      │
                         │ STATUS: analyzing  │
                         │ PROGRESS: 60%      │
                         │ MSG: "Analyzing    │
                         │      content"      │
                         └────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │ Extract Text Content      │
                    │ • PDF: pdf-parse          │
                    │ • Word: mammoth/docx      │
                    │ (TODO: Implement)         │
                    └───────────────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Update Status      │
                         │ STATUS: reviewing  │
                         │ PROGRESS: 75%      │
                         │ MSG: "AI review in │
                         │      progress"     │
                         └────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │ AI Content Review         │
                    │ • Send to Bedrock         │
                    │ • Get compliance results  │
                    │ • Quality analysis        │
                    │ (TODO: Your colleague)    │
                    └───────────────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Update Status      │
                         │ STATUS: finalizing │
                         │ PROGRESS: 90%      │
                         │ MSG: "Saving       │
                         │      results"      │
                         └────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │ Save Results to DB        │
                    │ (TODO: Implement)         │
                    └───────────────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Update Status      │
                         │ STATUS: completed  │
                         │ PROGRESS: 100%     │
                         │ MSG: "Review       │
                         │      complete"     │
                         │ RESULT: {...}      │
                         └────────────────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Delete Message     │
                         │ from SQS Queue     │
                         └────────────────────┘


                              ┌──────────────┐
                              │ ERROR PATH   │
                              └──────────────┘
                                    │
                        Any error during processing
                                    │
                                    ▼
                         ┌────────────────────┐
                         │ Update Status      │
                         │ STATUS: failed     │
                         │ PROGRESS: [last]   │
                         │ MSG: error message │
                         │ ERROR: {...}       │
                         └────────────────────┘

═══════════════════════════════════════════════════════════════════════════════
                           STATUS API ENDPOINTS
═══════════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────────┐
│                           src/routes/status.js                              │
└─────────────────────────────────────────────────────────────────────────────┘

1. GET /api/status/:uploadId
   ├─► Get detailed status for specific upload
   ├─► Returns: status, progress, history, result/error
   └─► Used by: Frontend polling

2. GET /api/status
   ├─► Get all uploads for current user
   ├─► Headers: x-user-id
   ├─► Query: limit (default 50)
   └─► Used by: Dashboard/history view

3. GET /api/status/:uploadId/history
   ├─► Get complete status timeline
   ├─► Returns: array of all status changes with timestamps
   └─► Used by: Detailed status view

4. GET /api/status/statistics
   ├─► Get counts by status
   ├─► Returns: pending, processing, completed, failed counts
   └─► Used by: Admin dashboard

5. DELETE /api/status/:uploadId
   ├─► Delete status record
   └─► Used by: Testing/cleanup

═══════════════════════════════════════════════════════════════════════════════
                           DATABASE STORAGE
═══════════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────────┐
│                        MongoDB: reviewStatuses                              │
│                   src/common/helpers/review-status-tracker.js               │
└─────────────────────────────────────────────────────────────────────────────┘

{
  _id: ObjectId("..."),
  uploadId: "uuid-here",                    // Unique index
  filename: "document.pdf",
  userId: "user123",                        // Index
  status: "reviewing",                      // Index
  progress: 75,

  statusHistory: [
    {
      status: "pending",
      message: "Upload initiated",
      timestamp: "2024-01-15T10:00:00Z",
      progress: 0
    },
    {
      status: "uploading",
      message: "Uploading file to S3",
      timestamp: "2024-01-15T10:00:05Z",
      progress: 10
    },
    {
      status: "reviewing",
      message: "AI review in progress",
      timestamp: "2024-01-15T10:01:30Z",
      progress: 75
    }
  ],

  metadata: {
    sessionId: "session456",
    userAgent: "Mozilla/5.0...",
    ipAddress: "192.168.1.1"
  },

  error: null,                              // Only if failed
  result: null,                             // Only if completed

  createdAt: "2024-01-15T10:00:00Z",       // Index
  updatedAt: "2024-01-15T10:01:30Z",
  completedAt: null,
  failedAt: null
}

═══════════════════════════════════════════════════════════════════════════════
                           STATUS WORKFLOW STATES
═══════════════════════════════════════════════════════════════════════════════

1. pending      (0%)   → Upload initiated
2. uploading    (5%)   → Reading file content
3. uploading    (10%)  → Uploading to S3
4. uploaded     (20%)  → File uploaded to S3
5. queued       (30%)  → Added to processing queue
6. processing   (35%)  → Worker started processing
7. downloading  (45%)  → Downloading from S3
8. analyzing    (60%)  → Extracting/analyzing content
9. reviewing    (75%)  → AI review in progress
10. finalizing  (90%)  → Saving results
11. completed   (100%) → Review complete with results
12. failed      (*)    → Error occurred

═══════════════════════════════════════════════════════════════════════════════
                           FRONTEND INTEGRATION
═══════════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────────┐
│                         Upload Component Flow                               │
└─────────────────────────────────────────────────────────────────────────────┘

User selects file
     │
     ▼
Show upload form
     │
     ▼
User clicks "Upload"
     │
     ▼
POST /api/upload
     │
     ▼
Get response with uploadId & statusUrl
     │
     ▼
Start polling status
     │
     ├─► Every 2 seconds: GET /api/status/:uploadId
     │
     ├─► Update progress bar (0-100%)
     │
     ├─► Update status message
     │
     ├─► If status === 'completed'
     │   ├─► Stop polling
     │   ├─► Show success message
     │   └─► Display results
     │
     └─► If status === 'failed'
         ├─► Stop polling
         ├─► Show error message
         └─► Display error details

┌─────────────────────────────────────────────────────────────────────────────┐
│                         Dashboard Component Flow                            │
└─────────────────────────────────────────────────────────────────────────────┘

Load dashboard
     │
     ▼
GET /api/status (with x-user-id header)
     │
     ▼
Display list of uploads
     │
     ├─► Show status badge for each
     │
     ├─► Show progress for in-progress items
     │
     └─► Click to view details
         │
         ▼
         GET /api/status/:uploadId/history
         │
         ▼
         Show timeline with all status changes

═══════════════════════════════════════════════════════════════════════════════

## Key Integration Points

✅ **Upload Route** → Creates and updates status at each step
✅ **SQS Worker** → Updates status throughout processing
✅ **Status API** → Provides real-time status to frontend
✅ **MongoDB** → Stores status with history
✅ **Frontend Polling** → Fetches updates every 2 seconds
✅ **Error Handling** → Automatic failure tracking

## Testing Flow

1. Run backend: `npm run dev`
2. Run test script: `.\test-status-tracking.ps1`
3. Watch status updates in real-time
4. Verify completion or error handling
```
