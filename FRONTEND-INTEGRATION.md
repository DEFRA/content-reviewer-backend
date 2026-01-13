# Frontend Integration Guide - Async Review System

## Quick Start

The backend now supports **asynchronous content review** with three main endpoints:

### 1. Submit a Review

### 2. Poll for Status

### 3. View History

---

## API Endpoints

### Submit File Review

**Endpoint:** `POST /api/review/file`

**Request:**

```javascript
const formData = new FormData()
formData.append('file', fileInput.files[0])

const response = await fetch('/api/review/file', {
  method: 'POST',
  body: formData
})

const data = await response.json()
// { success: true, reviewId: "review_123...", status: "pending" }
```

**Response (202 Accepted):**

```json
{
  "success": true,
  "reviewId": "review_1234567890_uuid",
  "status": "pending",
  "message": "Review queued for processing"
}
```

---

### Submit Text Review

**Endpoint:** `POST /api/review/text`

**Request:**

```javascript
const response = await fetch('/api/review/text', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    content: 'Your content to review...',
    title: 'My Content' // optional
  })
})

const data = await response.json()
// { success: true, reviewId: "review_123...", status: "pending" }
```

**Response (202 Accepted):**

```json
{
  "success": true,
  "reviewId": "review_1234567890_uuid",
  "status": "pending",
  "message": "Review queued for processing"
}
```

---

### Get Review Status/Result

**Endpoint:** `GET /api/review/:id`

**Request:**

```javascript
const response = await fetch(`/api/review/${reviewId}`)
const data = await response.json()
```

**Response (200 OK):**

**Pending:**

```json
{
  "success": true,
  "review": {
    "id": "review_1234567890_uuid",
    "status": "pending",
    "sourceType": "file",
    "fileName": "document.pdf",
    "fileSize": 123456,
    "createdAt": "2024-01-01T12:00:00Z",
    "updatedAt": "2024-01-01T12:00:00Z",
    "result": null,
    "error": null,
    "processingTime": null
  }
}
```

**Completed:**

```json
{
  "success": true,
  "review": {
    "id": "review_1234567890_uuid",
    "status": "completed",
    "sourceType": "file",
    "fileName": "document.pdf",
    "fileSize": 123456,
    "createdAt": "2024-01-01T12:00:00Z",
    "updatedAt": "2024-01-01T12:01:30Z",
    "result": {
      "reviewContent": "**Overall Assessment**\n\nThe content is clear...",
      "guardrailAssessment": {...},
      "completedAt": "2024-01-01T12:01:30Z"
    },
    "error": null,
    "processingTime": 30000
  }
}
```

**Failed:**

```json
{
  "success": true,
  "review": {
    "id": "review_1234567890_uuid",
    "status": "failed",
    "error": "Failed to extract text from file",
    ...
  }
}
```

---

### Get Review History

**Endpoint:** `GET /api/reviews`

**Query Parameters:**

- `limit` (optional, default: 50, max: 100)
- `skip` (optional, default: 0, for pagination)

**Request:**

```javascript
const response = await fetch('/api/reviews?limit=20&skip=0')
const data = await response.json()
```

**Response (200 OK):**

```json
{
  "success": true,
  "reviews": [
    {
      "id": "review_1234567890_uuid",
      "status": "completed",
      "sourceType": "file",
      "fileName": "document.pdf",
      "fileSize": 123456,
      "createdAt": "2024-01-01T12:00:00Z",
      "updatedAt": "2024-01-01T12:01:30Z",
      "hasResult": true,
      "hasError": false,
      "processingTime": 30000
    }
    // ... more reviews
  ],
  "pagination": {
    "total": 150,
    "limit": 20,
    "skip": 0,
    "returned": 20
  }
}
```

---

## React Implementation Examples

### Hook: useReviewPolling

```javascript
import { useState, useEffect } from 'react'

export function useReviewPolling(reviewId) {
  const [review, setReview] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!reviewId) return

    let pollInterval
    let pollCount = 0
    const maxPolls = 60 // 2 minutes max (2s intervals)

    const pollReview = async () => {
      try {
        const response = await fetch(`/api/review/${reviewId}`)
        const data = await response.json()

        if (!data.success) {
          throw new Error(data.error || 'Failed to fetch review')
        }

        setReview(data.review)

        // Stop polling if completed or failed
        if (
          data.review.status === 'completed' ||
          data.review.status === 'failed'
        ) {
          clearInterval(pollInterval)
          setLoading(false)
        }

        pollCount++
        if (pollCount >= maxPolls) {
          clearInterval(pollInterval)
          setLoading(false)
          setError('Review is taking longer than expected')
        }
      } catch (err) {
        setError(err.message)
        setLoading(false)
        clearInterval(pollInterval)
      }
    }

    // Initial poll
    pollReview()

    // Poll every 2 seconds
    pollInterval = setInterval(pollReview, 2000)

    return () => clearInterval(pollInterval)
  }, [reviewId])

  return { review, loading, error }
}
```

### Component: FileUploadReview

```javascript
import React, { useState } from 'react'
import { useReviewPolling } from './hooks/useReviewPolling'

export function FileUploadReview() {
  const [reviewId, setReviewId] = useState(null)
  const [uploading, setUploading] = useState(false)
  const { review, loading, error } = useReviewPolling(reviewId)

  const handleFileSubmit = async (e) => {
    e.preventDefault()
    setUploading(true)

    const formData = new FormData()
    formData.append('file', e.target.file.files[0])

    try {
      const response = await fetch('/api/review/file', {
        method: 'POST',
        body: formData
      })

      const data = await response.json()

      if (data.success) {
        setReviewId(data.reviewId)
      } else {
        alert(data.error)
      }
    } catch (err) {
      alert('Upload failed: ' + err.message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      <h2>Upload File for Review</h2>

      {!reviewId && (
        <form onSubmit={handleFileSubmit}>
          <input type="file" name="file" accept=".pdf,.docx" required />
          <button type="submit" disabled={uploading}>
            {uploading ? 'Uploading...' : 'Submit for Review'}
          </button>
        </form>
      )}

      {reviewId && (
        <div>
          <h3>Review Status</h3>

          {loading && <p>Processing your review... ⏳</p>}

          {error && <p style={{ color: 'red' }}>Error: {error}</p>}

          {review && (
            <div>
              <p>
                Status: <strong>{review.status}</strong>
              </p>
              <p>File: {review.fileName}</p>

              {review.status === 'completed' && review.result && (
                <div className="review-result">
                  <h4>Review Complete ✅</h4>
                  <div
                    dangerouslySetInnerHTML={{
                      __html: marked.parse(review.result.reviewContent)
                    }}
                  />
                  <p>Processing time: {review.processingTime}ms</p>
                </div>
              )}

              {review.status === 'failed' && (
                <p style={{ color: 'red' }}>Review failed: {review.error}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

### Component: ReviewHistory

```javascript
import React, { useState, useEffect } from 'react'

export function ReviewHistory() {
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [pagination, setPagination] = useState({ limit: 20, skip: 0 })

  useEffect(() => {
    fetchReviews()
  }, [pagination])

  const fetchReviews = async () => {
    setLoading(true)
    try {
      const response = await fetch(
        `/api/reviews?limit=${pagination.limit}&skip=${pagination.skip}`
      )
      const data = await response.json()

      if (data.success) {
        setReviews(data.reviews)
      }
    } catch (err) {
      console.error('Failed to fetch reviews:', err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <h2>Review History</h2>

      {loading ? (
        <p>Loading...</p>
      ) : (
        <div>
          <table>
            <thead>
              <tr>
                <th>File Name</th>
                <th>Status</th>
                <th>Created</th>
                <th>Processing Time</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((review) => (
                <tr key={review.id}>
                  <td>{review.fileName}</td>
                  <td>
                    <span className={`status-${review.status}`}>
                      {review.status}
                    </span>
                  </td>
                  <td>{new Date(review.createdAt).toLocaleString()}</td>
                  <td>
                    {review.processingTime ? `${review.processingTime}ms` : '-'}
                  </td>
                  <td>
                    <a href={`/review/${review.id}`}>View</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pagination">
            <button
              onClick={() =>
                setPagination((p) => ({
                  ...p,
                  skip: Math.max(0, p.skip - p.limit)
                }))
              }
              disabled={pagination.skip === 0}
            >
              Previous
            </button>
            <button
              onClick={() =>
                setPagination((p) => ({ ...p, skip: p.skip + p.limit }))
              }
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

---

## Status Values

| Status       | Description                           |
| ------------ | ------------------------------------- |
| `pending`    | Review queued, waiting for worker     |
| `processing` | Worker is currently processing review |
| `completed`  | Review finished successfully          |
| `failed`     | Review failed (see `error` field)     |

---

## Error Handling

All endpoints return consistent error responses:

```json
{
  "success": false,
  "error": "Error message here"
}
```

Common error cases:

- **400 Bad Request:** Invalid input (missing file, content too short, etc.)
- **404 Not Found:** Review ID doesn't exist
- **500 Internal Server Error:** Server error during processing

---

## File Types Supported

- **PDF:** `.pdf` (application/pdf)
- **Word:** `.docx` (application/vnd.openxmlformats-officedocument.wordprocessingml.document)
- **Text:** Direct text input via `/api/review/text`

**File Size Limit:** 10MB

---

## Polling Best Practices

1. **Start with short intervals** (2-3 seconds) for first 30 seconds
2. **Increase interval** to 5-10 seconds after 30 seconds
3. **Set a timeout** (e.g., 2 minutes) and show "still processing" message
4. **Stop polling** when status is `completed` or `failed`
5. **Handle errors** gracefully and allow retry

---

## Testing

Use the provided PowerShell script:

```powershell
cd backend
.\test-async-review.ps1
```

Or test manually:

```powershell
# Submit text review
$body = @{ content = "Test content here"; title = "Test" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3001/api/review/text" -Method Post -Body $body -ContentType "application/json"

# Check status
Invoke-RestMethod -Uri "http://localhost:3001/api/review/review_123..." -Method Get

# Get history
Invoke-RestMethod -Uri "http://localhost:3001/api/reviews" -Method Get
```

---

## Migration from Old Endpoints

The old sync endpoints are still available but deprecated:

- ❌ `POST /api/review` (sync, times out)
- ✅ `POST /api/review/file` (async, new)
- ✅ `POST /api/review/text` (async, new)

Update your frontend to use the new async endpoints for better reliability.
