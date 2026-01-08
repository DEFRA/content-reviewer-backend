# Real-Time Status Updates Architecture

## Overview

This document describes how to implement real-time status updates for the content review workflow, allowing the frontend to display progress like "Uploading", "Analyzing", "Reviewing", etc.

## Architecture Options

### Option 1: Database Status Updates (Recommended)

Store status in MongoDB/database, frontend polls for updates.

### Option 2: WebSocket/SSE Real-Time Updates

Push status updates to frontend in real-time.

### Option 3: Additional SQS Queue for Status

Separate queue for status updates that frontend can poll.

---

## Recommended Implementation: Database + Polling

### Status Flow

```
1. File Upload (Frontend)
   ↓
2. Status: "uploading" → Database
   ↓
3. Upload to S3 Complete
   ↓
4. Status: "uploaded" → Database
   ↓
5. S3 Event → SQS Queue
   ↓
6. Worker receives message
   ↓
7. Status: "queued" → Database
   ↓
8. Worker starts processing
   ↓
9. Status: "downloading" → Database
   ↓
10. Download from S3
    ↓
11. Status: "analyzing" → Database
    ↓
12. Send to AI for analysis
    ↓
13. Status: "reviewing" → Database
    ↓
14. AI performs review
    ↓
15. Status: "completed" → Database
    ↓
16. Frontend displays final result
```

## Database Schema

### Review Status Collection

```javascript
{
  uploadId: "abc-123-def-456",
  filename: "document.pdf",
  status: "reviewing",  // Current status
  statusHistory: [      // Timeline of all statuses
    {
      status: "uploading",
      timestamp: "2026-01-08T12:00:00Z",
      message: "Uploading file to S3"
    },
    {
      status: "uploaded",
      timestamp: "2026-01-08T12:00:05Z",
      message: "File uploaded successfully"
    },
    {
      status: "queued",
      timestamp: "2026-01-08T12:00:06Z",
      message: "Added to processing queue"
    },
    {
      status: "analyzing",
      timestamp: "2026-01-08T12:00:10Z",
      message: "Analyzing document content"
    },
    {
      status: "reviewing",
      timestamp: "2026-01-08T12:00:15Z",
      message: "AI content review in progress"
    }
  ],
  s3Location: "s3://bucket/key",
  userId: "user@example.com",
  createdAt: "2026-01-08T12:00:00Z",
  updatedAt: "2026-01-08T12:00:15Z",
  progress: 75,  // Percentage (optional)
  estimatedCompletion: "2026-01-08T12:00:30Z"  // Optional
}
```

## Status Types

```javascript
const ReviewStatus = {
  UPLOADING: 'uploading', // 0%  - Frontend uploading file
  UPLOADED: 'uploaded', // 10% - File uploaded to S3
  QUEUED: 'queued', // 20% - Message in SQS queue
  PROCESSING: 'processing', // 30% - Worker picked up message
  DOWNLOADING: 'downloading', // 40% - Downloading from S3
  ANALYZING: 'analyzing', // 50% - Extracting content
  REVIEWING: 'reviewing', // 70% - AI review in progress
  FINALIZING: 'finalizing', // 90% - Saving results
  COMPLETED: 'completed', // 100% - Review complete
  FAILED: 'failed', // Error occurred
  CANCELLED: 'cancelled' // User cancelled
}
```

## Implementation

### 1. Database Helper (MongoDB)

```javascript
// src/common/helpers/review-status.js

import { createLogger } from './logging/logger.js'
import { mongodb } from './mongodb.js'

const logger = createLogger()

class ReviewStatusTracker {
  constructor() {
    this.collectionName = 'review_statuses'
  }

  async getCollection() {
    const db = await mongodb.getDb()
    return db.collection(this.collectionName)
  }

  /**
   * Create initial review status
   */
  async createStatus(uploadId, filename, userId) {
    const collection = await this.getCollection()

    const status = {
      uploadId,
      filename,
      status: 'uploading',
      statusHistory: [
        {
          status: 'uploading',
          timestamp: new Date(),
          message: 'Starting file upload'
        }
      ],
      userId,
      progress: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    await collection.insertOne(status)
    logger.info({ uploadId }, 'Review status created')
    return status
  }

  /**
   * Update status with progress
   */
  async updateStatus(uploadId, newStatus, message = '', progress = null) {
    const collection = await this.getCollection()

    const statusUpdate = {
      status: newStatus,
      timestamp: new Date(),
      message
    }

    const update = {
      $set: {
        status: newStatus,
        updatedAt: new Date()
      },
      $push: {
        statusHistory: statusUpdate
      }
    }

    if (progress !== null) {
      update.$set.progress = progress
    }

    const result = await collection.updateOne({ uploadId }, update)

    logger.info({ uploadId, status: newStatus, progress }, 'Status updated')
    return result
  }

  /**
   * Get current status
   */
  async getStatus(uploadId) {
    const collection = await this.getCollection()
    return await collection.findOne({ uploadId })
  }

  /**
   * Get status history
   */
  async getStatusHistory(uploadId) {
    const status = await this.getStatus(uploadId)
    return status?.statusHistory || []
  }

  /**
   * Mark as failed
   */
  async markFailed(uploadId, errorMessage) {
    return await this.updateStatus(uploadId, 'failed', errorMessage, null)
  }

  /**
   * Mark as completed
   */
  async markCompleted(uploadId, resultData) {
    const collection = await this.getCollection()

    await collection.updateOne(
      { uploadId },
      {
        $set: {
          status: 'completed',
          progress: 100,
          completedAt: new Date(),
          updatedAt: new Date(),
          result: resultData
        },
        $push: {
          statusHistory: {
            status: 'completed',
            timestamp: new Date(),
            message: 'Review completed successfully'
          }
        }
      }
    )

    logger.info({ uploadId }, 'Review completed')
  }
}

export const reviewStatusTracker = new ReviewStatusTracker()
```

### 2. Update Upload Route

```javascript
// src/routes/upload.js - Add status tracking

import { reviewStatusTracker } from '../common/helpers/review-status.js'

handler: async (request, h) => {
  try {
    const file = data.file
    const uploadId = randomUUID()
    const userId = request.headers['x-user-id'] || 'anonymous'

    // 1. Create initial status
    await reviewStatusTracker.createStatus(uploadId, file.hapi.filename, userId)

    // Read file buffer
    const chunks = []
    for await (const chunk of file) {
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)

    // 2. Update status: uploading to S3
    await reviewStatusTracker.updateStatus(
      uploadId,
      'uploading',
      'Uploading file to S3',
      10
    )

    // Upload to S3
    const result = await s3Uploader.uploadFile(fileObject, uploadId)

    // 3. Update status: uploaded
    await reviewStatusTracker.updateStatus(
      uploadId,
      'uploaded',
      'File uploaded successfully to S3',
      20
    )

    // Send message to SQS
    try {
      const sqsResult = await sqsClient.sendMessage({
        uploadId: result.fileId,
        filename: result.filename,
        s3Bucket: result.bucket,
        s3Key: result.key,
        s3Location: result.location,
        userId,
        sessionId: request.headers['x-session-id'] || null
      })

      // 4. Update status: queued
      await reviewStatusTracker.updateStatus(
        uploadId,
        'queued',
        'Added to processing queue',
        30
      )
    } catch (sqsError) {
      // Mark as failed if SQS fails
      await reviewStatusTracker.markFailed(
        uploadId,
        `Failed to queue: ${sqsError.message}`
      )
    }

    return h
      .response({
        success: true,
        uploadId: result.fileId,
        filename: result.filename,
        status: 'queued',
        statusUrl: `/api/status/${uploadId}` // Frontend can poll this
      })
      .code(200)
  } catch (error) {
    // Mark as failed
    if (uploadId) {
      await reviewStatusTracker.markFailed(uploadId, error.message)
    }

    return h
      .response({
        success: false,
        error: error.message
      })
      .code(500)
  }
}
```

### 3. Update SQS Worker

```javascript
// src/common/helpers/sqs-worker.js - Add status updates

import { reviewStatusTracker } from './review-status.js'

async processMessage(message) {
  try {
    const body = JSON.parse(message.Body)

    // Determine uploadId from message
    let uploadId
    if (body.Records && body.Records[0]) {
      // S3 event
      uploadId = body.Records[0].s3.object.key.split('/').pop().split('.')[0]
    } else {
      // Application message
      uploadId = body.uploadId
    }

    // Update status: processing
    await reviewStatusTracker.updateStatus(
      uploadId,
      'processing',
      'Worker started processing',
      40
    )

    // Process content review
    await this.processContentReview(messageData, uploadId)

    // Delete message from queue
    await this.deleteMessage(message.ReceiptHandle)

  } catch (error) {
    logger.error({ error: error.message }, 'Failed to process message')

    // Mark as failed
    if (uploadId) {
      await reviewStatusTracker.markFailed(
        uploadId,
        `Processing failed: ${error.message}`
      )
    }
  }
}

async processContentReview(messageBody, uploadId) {
  try {
    // Step 1: Downloading from S3
    await reviewStatusTracker.updateStatus(
      uploadId,
      'downloading',
      'Downloading file from S3',
      50
    )

    // Download file from S3
    // const fileContent = await s3Client.downloadFile(...)

    // Step 2: Analyzing content
    await reviewStatusTracker.updateStatus(
      uploadId,
      'analyzing',
      'Extracting and analyzing content',
      60
    )

    // Extract text/content from file
    // const extractedContent = await extractContent(fileContent)

    // Step 3: AI Review
    await reviewStatusTracker.updateStatus(
      uploadId,
      'reviewing',
      'AI content review in progress',
      70
    )

    // Send to AI for review
    // const reviewResult = await aiService.review(extractedContent)

    // Step 4: Finalizing
    await reviewStatusTracker.updateStatus(
      uploadId,
      'finalizing',
      'Saving review results',
      90
    )

    // Save results to database
    // await saveResults(uploadId, reviewResult)

    // Step 5: Completed
    await reviewStatusTracker.markCompleted(uploadId, {
      reviewScore: 95,
      issues: [],
      completedAt: new Date()
    })

  } catch (error) {
    await reviewStatusTracker.markFailed(
      uploadId,
      `Review failed: ${error.message}`
    )
    throw error
  }
}
```

### 4. Status API Endpoint

```javascript
// src/routes/status.js - New file

export const statusRoutes = {
  plugin: {
    name: 'status-routes',
    register: async (server) => {
      // GET /api/status/:uploadId
      server.route({
        method: 'GET',
        path: '/api/status/{uploadId}',
        options: {
          cors: true
        },
        handler: async (request, h) => {
          try {
            const { uploadId } = request.params

            const status = await reviewStatusTracker.getStatus(uploadId)

            if (!status) {
              return h
                .response({
                  success: false,
                  error: 'Upload not found'
                })
                .code(404)
            }

            return h
              .response({
                success: true,
                uploadId: status.uploadId,
                filename: status.filename,
                status: status.status,
                progress: status.progress || 0,
                statusHistory: status.statusHistory,
                createdAt: status.createdAt,
                updatedAt: status.updatedAt,
                completedAt: status.completedAt,
                result: status.result
              })
              .code(200)
          } catch (error) {
            request.logger.error(error, 'Failed to get status')
            return h
              .response({
                success: false,
                error: 'Failed to retrieve status'
              })
              .code(500)
          }
        }
      })

      // GET /api/status - Get all statuses for user
      server.route({
        method: 'GET',
        path: '/api/status',
        options: {
          cors: true
        },
        handler: async (request, h) => {
          try {
            const userId = request.headers['x-user-id'] || 'anonymous'

            const db = await mongodb.getDb()
            const statuses = await db
              .collection('review_statuses')
              .find({ userId })
              .sort({ createdAt: -1 })
              .limit(50)
              .toArray()

            return h
              .response({
                success: true,
                statuses: statuses.map((s) => ({
                  uploadId: s.uploadId,
                  filename: s.filename,
                  status: s.status,
                  progress: s.progress || 0,
                  createdAt: s.createdAt,
                  updatedAt: s.updatedAt
                }))
              })
              .code(200)
          } catch (error) {
            request.logger.error(error, 'Failed to get statuses')
            return h
              .response({
                success: false,
                error: 'Failed to retrieve statuses'
              })
              .code(500)
          }
        }
      })
    }
  }
}
```

### 5. Frontend Integration

```javascript
// Frontend: Poll for status updates

async function pollReviewStatus(uploadId) {
  const statusElement = document.getElementById('review-status')
  const progressBar = document.getElementById('progress-bar')

  const interval = setInterval(async () => {
    try {
      const response = await fetch(`/api/status/${uploadId}`)
      const data = await response.json()

      if (data.success) {
        // Update UI
        statusElement.textContent = getStatusMessage(data.status)
        progressBar.value = data.progress

        // Stop polling if completed or failed
        if (data.status === 'completed' || data.status === 'failed') {
          clearInterval(interval)

          if (data.status === 'completed') {
            showResults(data.result)
          } else {
            showError(data.statusHistory[data.statusHistory.length - 1].message)
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch status:', error)
    }
  }, 2000) // Poll every 2 seconds
}

function getStatusMessage(status) {
  const messages = {
    uploading: 'Uploading file...',
    uploaded: 'Upload complete',
    queued: 'Queued for processing',
    processing: 'Processing started',
    downloading: 'Downloading file',
    analyzing: 'Analyzing content',
    reviewing: 'AI review in progress',
    finalizing: 'Finalizing results',
    completed: 'Review complete!',
    failed: 'Review failed'
  }
  return messages[status] || 'Processing...'
}
```

## Alternative: WebSocket Real-Time Updates

For true real-time updates without polling:

```javascript
// Using Socket.IO

// Backend
io.on('connection', (socket) => {
  socket.on('subscribe', (uploadId) => {
    socket.join(`review-${uploadId}`)
  })
})

// Emit status updates
async function updateStatus(uploadId, status, message, progress) {
  // Update database
  await reviewStatusTracker.updateStatus(uploadId, status, message, progress)

  // Emit to subscribers
  io.to(`review-${uploadId}`).emit('status-update', {
    status,
    message,
    progress,
    timestamp: new Date()
  })
}

// Frontend
const socket = io()
socket.emit('subscribe', uploadId)
socket.on('status-update', (data) => {
  updateUI(data)
})
```

## Summary

✅ **Database + Polling** (Recommended)

- Simple to implement
- Works with existing infrastructure
- Good for most use cases
- Poll every 2-3 seconds

✅ **WebSocket/SSE** (Advanced)

- True real-time updates
- Better UX
- Requires WebSocket infrastructure

Choose based on your needs!
