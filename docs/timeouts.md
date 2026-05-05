# Timeout Configuration — Content Reviewer Tool

> **Last updated:** 2026-05-01
> **Maintainer:** See [Related links](#related-links) for source files.

---

## Table of Contents

1. [Overview](#overview)
2. [Purpose](#purpose)
3. [End-to-End Request Flow](#end-to-end-request-flow)
4. [Timeout Values Reference](#timeout-values-reference)
   - [Frontend timeouts](#frontend)
   - [Backend timeouts](#backend)
5. [Rationale](#rationale)
6. [Response Time Logging](#response-time-logging)
7. [Timeout Logging](#timeout-logging)
8. [Environment Variables](#environment-variables)
9. [Maintainability](#maintainability)
10. [Related Links](#related-links)
11. [Conclusion](#conclusion)

---

## Overview

Every I/O boundary in the Content Reviewer system has an explicit timeout.
This document lists each timeout, its current value, where it is configured,
what action it guards, what happens when it fires, and the error message the
user sees if it does.

---

## Purpose

Unguarded I/O calls can stall a request indefinitely, exhausting server
threads and confusing users with no feedback. Explicit timeouts ensure:

- **Predictable failure** — requests fail fast with a clear message instead
  of hanging until the browser gives up.
- **Retry safety** — SQS messages are hidden for a defined window so a
  slow or failed Bedrock call does not trigger duplicate processing.
- **Observability** — every timeout is logged at `error` level with the
  elapsed time so on-call engineers can diagnose latency spikes immediately.

---

## End-to-End Request Flow

```
User's Browser
  │
  │  (no time limit set here — browser decides when to give up)
  ▼
Frontend Web Server  (the Node.js app the user's browser talks to)
  │  Connection keep-alive limit:  90 s   (src/server/index.js)
  │  Request processing limit:     85 s   (src/server/index.js)
  │  — if a request takes longer than 85 s, the web server gives up and
  │    returns an error before the connection itself is dropped at 90 s
  │
  │  Per-call time limit to backend: 30 s  (each API handler — see Frontend table)
  │  — each call the frontend makes to the backend has its own 30 s deadline;
  │    if the backend doesn't respond in time, the user sees a timeout error
  ▼
Backend Web Server  (the Node.js app that does the actual work)
  │  Connection keep-alive limit:  90 s   (src/server.js)
  │  Request processing limit:     85 s   (src/server.js)
  │
  ├──► AWS S3 — file storage
  │      Saves the document text before queuing it for review
  │      Time limit:  30 s   (src/common/helpers/s3-uploader.js)
  │
  ├──► AWS SQS — job queue
  │      Adds the review job to the queue so the worker can pick it up
  │      No explicit time limit — AWS SDK handles this automatically
  │      Hide window (prevents the same job being picked up twice): 180 s  (src/config.js)
  │      Max delivery attempts before giving up:                      3     (src/config.js)
  │
  └──► AWS Bedrock AI — the AI that reads and reviews the content
         Time limit: 120 s  (src/common/helpers/bedrock-client.js)
         — if the AI takes longer than 2 minutes to respond, the job
           fails and SQS retries it after the 3-minute hide window expires
```

---

## Timeout Values Reference

### Frontend

| Component                   | Timeout | Constant             | File                              | Action carried out                                                                                                                         | What happens on timeout                          | User-facing error                                                                          |
| --------------------------- | ------- | -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Connection keep-alive limit | 90 s    | hardcoded            | `src/server/index.js`             | Keeps the network connection open while the browser waits for a response                                                                   | Connection is cut; browser shows a network error | `"Request timed out"`                                                                      |
| Request processing limit    | 85 s    | hardcoded            | `src/server/index.js`             | Hard ceiling on how long the server spends on any single request — fires 5 s before the connection is cut so a clean error can be returned | Server gives up and returns a 503 error          | `"Request timed out"`                                                                      |
| → Backend: upload           | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/upload.js`        | Forwards file buffer to backend `/api/upload`                                                                                              | AbortError thrown; handler returns 500           | `"The upload request timed out. Please try again."`                                        |
| → Backend: text review      | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/text-review.js`   | Posts pasted text to backend `/api/review/text`                                                                                            | AbortError thrown; handler returns 500           | `"The text review request timed out. Please try again."`                                   |
| → Backend: URL review       | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/url-review.js`    | Posts extracted GOV.UK HTML to backend `/api/review/text`                                                                                  | AbortError thrown; handler returns 500           | `"The request timed out. Please try again."`                                               |
| → Backend: reviews list     | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/reviews.js`       | Fetches paginated review history from backend                                                                                              | AbortError thrown; handler returns 500           | `"The request timed out. Please try again."`                                               |
| → Backend: delete review    | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/delete-review.js` | Sends DELETE to backend `/api/reviews/{id}`                                                                                                | AbortError thrown; handler returns 500           | `"The delete request timed out. Please try again."`                                        |
| URL fetch (GOV.UK HTML)     | 30 s    | `FETCH_TIMEOUT_MS`   | `src/server/api/fetch-url.js`     | Fetches raw HTML from a GOV.UK URL server-side                                                                                             | AbortError thrown; mapped to a user message      | `"The request timed out. GOV.UK took too long to respond — please try again in a moment."` |

### Backend

| Component                   | Timeout   | Config key / constant                              | File                                      | Action carried out                                                                                                                         | What happens on timeout                                                                                                                  | User-facing error                                                        |
| --------------------------- | --------- | -------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Connection keep-alive limit | 90 s      | hardcoded                                          | `src/server.js:70`                        | Keeps the network connection open while the frontend waits for a response                                                                  | Connection is cut; frontend receives a network error                                                                                     | `"Request timed out"` (browser default)                                  |
| Request processing limit    | 85 s      | hardcoded                                          | `src/server.js:71`                        | Hard ceiling on how long the server spends on any single request — fires 5 s before the connection is cut so a clean error can be returned | Server gives up and returns a 503 error                                                                                                  | `"Request timed out"`                                                    |
| S3 PutObject                | 30 s      | `S3_REQUEST_TIMEOUT_MS` → `s3.requestTimeoutMs`    | `src/config.js`                           | Uploads extracted text content to S3 before enqueuing the SQS review job                                                                   | AWS SDK throws `TimeoutError`; upload route returns 500                                                                                  | `"Failed to upload content"`                                             |
| SQS visibility timeout      | 180 s     | `SQS_VISIBILITY_TIMEOUT` → `sqs.visibilityTimeout` | `src/config.js`                           | Hides the SQS message while the worker is processing it, preventing duplicate delivery                                                     | SQS makes the message visible again; the worker picks it up for a retry                                                                  | No direct user error — review transitions to a retry attempt             |
| SQS max receive count       | 3 retries | `SQS_MAX_RECEIVE_COUNT` → `sqs.maxReceiveCount`    | `src/config.js`                           | Application-level dead-letter guard — counts how many times a message has been received                                                    | Worker deletes the message and marks the review as permanently failed                                                                    | `"Review could not be completed after N delivery attempts"`              |
| Bedrock AI request          | 120 s     | `BEDROCK_TIMEOUT_MS` (constant)                    | `src/common/helpers/bedrock-client.js:15` | Sends the extracted document content to AWS Bedrock for AI review                                                                          | AWS SDK throws `TimeoutError`; the error propagates to the SQS worker catch block, which resets the visibility window and lets SQS retry | `"Bedrock API request timed out. The request took too long to process."` |

---

## Rationale

### Dead-letter queue (SQS)

`sqs.maxReceiveCount` (default: 3) is an **application-level** guard — the
SQS worker tracks how many times a message has been received and discards
it after 3 attempts. A matching `RedrivePolicy maxReceiveCount` must also be
set on the SQS queue in AWS (infrastructure configuration, not code). Without
the queue-level policy, endlessly failing messages would loop forever.

---

## Response Time Logging

Response time is logged at every I/O boundary using `logger.info`:

| Stage                             | Log level | Log field                                   | Actual log message                                                                                                                  |
| --------------------------------- | --------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Frontend → Backend (upload)       | `info`    | `backendRequestTime`, `totalProcessingTime` | `File: report.pdf uploaded successfully to backend. Backend response time: 0.42s, Total processing time: 0.55s`                     |
| Frontend → Backend (text review)  | `info`    | `backendRequestTime`, `totalProcessingTime` | `Text review request successful` (with structured fields: reviewId, textLength, wordCount, backendRequestTime, totalProcessingTime) |
| Frontend → Backend (URL review)   | `info`    | `backendRequestTime`                        | `url-review: review submitted successfully in 0.28s`                                                                                |
| Frontend → Backend (reviews list) | `error`   | `backendRequestTime`                        | `Backend review history request failed - endpoint: …, status: 500, statusText: Internal Server Error, requestTime: 0.31s`           |
| S3 upload — start                 | `info`    | `uploadId`, `originalLength`, `durationMs`  | `S3 text content upload started` (or `S3 text upload started - PII REDACTED (N instances)` when PII is detected)                    |
| S3 upload — success               | `info`    | `uploadId`, `durationMs`, `s3Location`      | _(no message string — structured fields only: uploadId, filename, contentLength, bucket, key, s3Location, durationMs)_              |
| S3 upload — failure               | `error`   | `uploadId`, `durationMs`, `errorName`       | `S3 text upload failed after 30000ms: TimeoutError`                                                                                 |
| Bedrock AI — start                | `info`    | `userPromptLength`, `systemPromptLength`    | `[BEDROCK] Sending request to Bedrock AI - START`                                                                                   |
| Bedrock AI — success              | `info`    | `durationMs`, `inputTokens`, `outputTokens` | `[BEDROCK] AI review COMPLETED successfully in 1420ms (Tokens: 28000→850)`                                                          |
| Bedrock AI — failure              | `error`   | `durationMs`, `blocked`, `reason`           | `[BEDROCK] AI review FAILED after 120000ms`                                                                                         |
| SQS message — processed           | `info`    | `messageId`, `uploadId`, `durationMs`       | `SQS message processed successfully in 3210ms`                                                                                      |
| SQS message — failed              | `error`   | `messageId`, `durationMs`, `errorName`      | `Failed to process SQS message after 120150ms: Bedrock API request timed out.`                                                      |

## Timeout Logging

Every timeout is logged at `error` level with the elapsed time so engineers can diagnose slow or stalled calls immediately:

| Where the timeout fires                       | Log level | Actual log message                                                                                                       |
| --------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| Frontend → Backend: upload (30 s)             | `error`   | `Upload API request failed with error` _(AbortError is detected and shown to the user but not named in the log message)_ |
| Frontend → Backend: text review (30 s)        | `error`   | `Text review backend request timed out after 30s — totalProcessingTime: 30.02s`                                          |
| Frontend → Backend: URL review (30 s)         | `error`   | `url-review: backend request timed out after 30s`                                                                        |
| Frontend → Backend: reviews list (30 s)       | `error`   | `Reviews backend request timed out after 30s — totalProcessingTime: 30.01s`                                              |
| Frontend → Backend: delete review (30 s)      | `error`   | `Delete review backend request timed out after 30s — reviewId: abc-123, totalProcessingTime: 30.01s`                     |
| Frontend: GOV.UK URL fetch (30 s)             | `error`   | `fetch-url: upstream fetch failed after retries` _(AbortError mapped to user message; no dedicated timeout log line)_    |
| Backend: S3 file save (30 s)                  | `error`   | `S3 text upload failed after 30000ms: TimeoutError`                                                                      |
| Backend: Bedrock AI review (120 s)            | `error`   | `[BEDROCK] AI review FAILED after 120000ms`                                                                              |
| Backend: SQS message processing (any failure) | `error`   | `Failed to process SQS message after 120150ms: Bedrock API request timed out.`                                           |

---

## Environment Variables

| Variable                     | Default        | Description                                                                  |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------- |
| `S3_REQUEST_TIMEOUT_MS`      | `30000`        | S3 PutObject request timeout (ms)                                            |
| `SQS_VISIBILITY_TIMEOUT`     | `180`          | SQS message visibility timeout (s) — must exceed `BEDROCK_TIMEOUT_MS / 1000` |
| `SQS_MAX_RECEIVE_COUNT`      | `3`            | Max SQS delivery attempts before the message is dead-lettered                |
| `BACKEND_REQUEST_TIMEOUT_MS` | n/a (constant) | Frontend → backend timeout (30 s, code constant)                             |

---

## Maintainability

When changing any timeout value:

1. **Update the constant or config default** in the source file listed in
   the table above.
2. **Update `SQS_VISIBILITY_TIMEOUT`** if `BEDROCK_TIMEOUT_MS` changes —
   the visibility timeout must always exceed the Bedrock timeout by at least
   60 seconds to prevent duplicate processing.
3. **Update `.env`** to keep the local development value in sync with the
   new default.
4. **Update `HEARTBEAT_INTERVAL_MS`** in `review-processor.js` if the
   visibility timeout changes significantly — the heartbeat must fire before
   the visibility window expires.
5. **Update this document** — reflect the new values in the table, the
   End-to-End Request Flow diagram, and the Rationale section.
6. **Run tests** — `review-processor.processing.test.js` has assertions on
   the heartbeat interval and visibility extension values; update them to
   match.

---

## Related Links

| Resource                              | Location                                                        |
| ------------------------------------- | --------------------------------------------------------------- |
| Bedrock client (timeout constant)     | `src/common/helpers/bedrock-client.js`                          |
| SQS config (visibility timeout)       | `src/config.js` — `sqs.visibilityTimeout`                       |
| Heartbeat & failure visibility reset  | `src/common/helpers/sqs/review-processor.js` — `processMessage` |
| Frontend API handlers (30 s timeouts) | `src/server/api/*.js`                                           |
| Heartbeat test                        | `src/common/helpers/sqs/review-processor.processing.test.js`    |

---

## Conclusion

All timeouts in the Content Reviewer system are intentionally layered:
frontend handlers fail after 30 s, Hapi servers enforce an 85/90 s ceiling,
Bedrock is capped at 120 s, and the SQS visibility window (180 s) ensures
failed messages are retried after the full 3-minute backoff. The heartbeat
and explicit failure visibility reset in `review-processor.js` guarantee that
the retry window is always measured from the moment of failure, not from when
the message was originally received.

Any future changes to these values should follow the checklist in the
[Maintainability](#maintainability) section to keep all layers consistent.
