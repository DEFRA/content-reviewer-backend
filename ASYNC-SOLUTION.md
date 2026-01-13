# Async Review Processing - The Real Solution

## Problem Summary

After all optimizations, the review endpoint still fails with 503 errors because:

**Bedrock API response time: 30-40 seconds**  
**CDP nginx timeout: 5 seconds**  
**Gap: 35 seconds** - impossible to bridge with optimizations

### Evidence from Logs:

```
12:42:59 - Request starts
12:43:03 - 503 returned (4.5s - killed by timeout)
12:43:35 - Bedrock completes (36s total - way too late)
```

The review genuinely needs 30-40 seconds to process, which is **8x longer** than nginx allows.

## Why Previous Optimizations Failed

1. ✅ Removed console.error - Fixed routing issue
2. ✅ Shortened prompt - Helped, but not enough
3. ✅ Removed conversation history - Helped, but not enough
4. ✅ Removed route timeout - Doesn't matter, nginx times out first

**Conclusion:** No amount of optimization can make a 30-second API call fit in 5 seconds.

## The Only Solution: Async Processing

### Architecture:

```
Client                Backend                 SQS Queue           Worker
  |                      |                        |                  |
  |--POST /api/review--->|                        |                  |
  |                      |---queue message------->|                  |
  |<--202 Accepted-------|                        |                  |
  |   {reviewId: "123"}  |                        |                  |
  |                      |                        |                  |
  |                      |                        |<--poll-----------|
  |                      |                        |                  |
  |                      |                        |---process------->|
  |                      |                        |                  |--Bedrock API
  |                      |                        |                  |  (30-40s)
  |                      |                        |                  |
  |--GET /api/review/123>|                        |                  |
  |<--200 OK-------------|                        |                  |
  |   {status: "processing"}                      |                  |
  |                      |                        |                  |
  |                      |                        |<--complete-------|
  |                      |                        |                  |
  |--GET /api/review/123>|                        |                  |
  |<--200 OK-------------|                        |                  |
  |   {status: "complete", review: {...}}         |                  |
```

### Implementation Plan:

#### 1. New Endpoint: POST /api/review (Async)

```javascript
handler: async (request, h) => {
  const { content, contentType } = request.payload

  // Generate unique review ID
  const reviewId = crypto.randomUUID()

  // Store initial status in MongoDB
  await db.collection('reviews').insertOne({
    reviewId,
    status: 'queued',
    content,
    contentType,
    createdAt: new Date()
  })

  // Queue for async processing
  await sqsClient.sendMessage({
    QueueUrl: config.get('sqs.reviewQueueUrl'),
    MessageBody: JSON.stringify({
      reviewId,
      content,
      contentType
    })
  })

  // Return immediately
  return h
    .response({
      reviewId,
      status: 'queued',
      message: 'Review queued for processing',
      statusUrl: `/api/review/${reviewId}`
    })
    .code(202) // 202 Accepted
}
```

#### 2. Status Endpoint: GET /api/review/{reviewId}

```javascript
handler: async (request, h) => {
  const { reviewId } = request.params

  const review = await db.collection('reviews').findOne({ reviewId })

  if (!review) {
    throw Boom.notFound('Review not found')
  }

  return h
    .response({
      reviewId: review.reviewId,
      status: review.status, // 'queued', 'processing', 'complete', 'failed'
      review: review.result, // Only present when status is 'complete'
      error: review.error, // Only present when status is 'failed'
      createdAt: review.createdAt,
      completedAt: review.completedAt
    })
    .code(200)
}
```

#### 3. Worker Process (Already exists!)

The SQS worker we already have can handle this:

```javascript
// In sqs-worker.js - add review processing
async processMessage(message) {
  const { reviewId, content, contentType } = JSON.parse(message.Body)

  try {
    // Update status to processing
    await db.collection('reviews').updateOne(
      { reviewId },
      { $set: { status: 'processing', startedAt: new Date() } }
    )

    // Call Bedrock (can take 30-40 seconds - no problem in background!)
    const result = await bedrockClient.reviewContent(content, contentType)

    // Update with result
    await db.collection('reviews').updateOne(
      { reviewId },
      {
        $set: {
          status: 'complete',
          result: result.review,
          usage: result.usage,
          completedAt: new Date()
        }
      }
    )
  } catch (error) {
    // Update with error
    await db.collection('reviews').updateOne(
      { reviewId },
      {
        $set: {
          status: 'failed',
          error: error.message,
          completedAt: new Date()
        }
      }
    )
  }
}
```

### Benefits:

1. ✅ **No timeout issues** - Bedrock can take as long as needed
2. ✅ **Better UX** - Users see progress, not just timeout errors
3. ✅ **Scalable** - Can handle hundreds of reviews concurrently
4. ✅ **Reliable** - SQS handles retries if worker crashes
5. ✅ **Uses existing infrastructure** - SQS worker already exists!

### Frontend Implementation:

```javascript
// Submit review
const response = await fetch('/api/review', {
  method: 'POST',
  body: JSON.stringify({ content, contentType })
})
const { reviewId, statusUrl } = await response.json()

// Poll for status
const pollInterval = setInterval(async () => {
  const statusResponse = await fetch(statusUrl)
  const status = await statusResponse.json()

  if (status.status === 'complete') {
    clearInterval(pollInterval)
    displayReview(status.review)
  } else if (status.status === 'failed') {
    clearInterval(pollInterval)
    displayError(status.error)
  } else {
    showProgress(status.status) // 'queued' or 'processing'
  }
}, 2000) // Poll every 2 seconds
```

## Timeline:

- **Immediate:** Document the timeout limitation
- **Short term (1-2 days):** Implement async review endpoint
- **Alternative:** Contact CDP support to increase nginx timeout to 60s

## Temporary Workaround:

Keep the current endpoint but:

1. Document that reviews may timeout for complex content
2. Return helpful error message suggesting async processing
3. Recommend users split large content into smaller chunks

## Decision:

**The synchronous /api/review endpoint with 5-second nginx timeout is fundamentally incompatible with 30-40 second Bedrock processing times.**

You need to either:

1. **Implement async processing** (recommended, production-ready)
2. **Request nginx timeout increase** from CDP support (may not be possible)
3. **Accept that review endpoint will fail** for anything but trivial content

---

**Next step:** Do you want me to implement the async review processing?
