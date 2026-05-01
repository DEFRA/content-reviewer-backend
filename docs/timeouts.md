# Timeout Configuration — Content Reviewe Tool

> **Last updated:** 2026-05-01
> **Maintainer:** See [Related links](#related-links) for source files.

---

## Table of Contents

1. [Overview](#overview)
2. [Purpose](#purpose)
3. [End-to-End Request Flow](#end-to-end-request-flow)
4. [Timeout Values Reference](#timeout-values-reference)
   - [Backend timeouts](#backend)
   - [Frontend timeouts](#frontend)
5. [Rationale](#rationale)
6. [Response Time Logging](#response-time-logging)
7. [Environment Variables](#environment-variables)
8. [Maintainability](#maintainability)
9. [Related Links](#related-links)
10. [Conclusion](#conclusion)

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
Browser
  │
  │  (no browser-side timeout — browser default applies)
  ▼
Frontend Hapi Server  (host: 0.0.0.0:3000)
  │  Hapi socket timeout:  90 s   (src/server/index.js)
  │  Hapi server timeout:  85 s   (src/server/index.js)
  │
  │  AbortController timeout: 30 s  (each API handler — see Frontend table)
  ▼
Backend Hapi Server  (host: 0.0.0.0:3000)
  │  Hapi socket timeout:  90 s   (src/server.js)
  │  Hapi server timeout:  85 s   (src/server.js)
  │
  ├──► S3 (PutObject — text content)
  │      Request timeout:  30 s   (src/common/helpers/s3-uploader.js)
  │
  ├──► SQS (SendMessage — enqueue review job)
  │      No explicit timeout — AWS SDK default (~tens of seconds)
  │      Visibility timeout: 180 s  (src/config.js → SQS_VISIBILITY_TIMEOUT)
  │      Max receive count:    3     (src/config.js → SQS_MAX_RECEIVE_COUNT)
  │
  └──► Bedrock AI (ConverseCommand — content review)
         Request timeout: 120 s  (src/common/helpers/bedrock-client.js)
```

---

## Timeout Values Reference

### Backend

| Component                      | Timeout   | Config key / constant                              | File                                         | Action carried out                                                                                                | What happens on timeout                                                                                                                  | User-facing error                                                        |
| ------------------------------ | --------- | -------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Hapi socket                    | 90 s      | hardcoded                                          | `src/server.js:70`                           | Keeps the TCP connection open while a request is in-flight                                                        | Hapi closes the socket and returns a 503                                                                                                 | `"Request timed out"` (browser default)                                  |
| Hapi server                    | 85 s      | hardcoded                                          | `src/server.js:71`                           | Hard ceiling on total request processing time — fires before the socket timeout                                   | Hapi aborts the request handler and returns a 503                                                                                        | `"Request timed out"`                                                    |
| S3 PutObject                   | 30 s      | `S3_REQUEST_TIMEOUT_MS` → `s3.requestTimeoutMs`    | `src/config.js`                              | Uploads extracted text content to S3 before enqueuing the SQS review job                                          | AWS SDK throws `TimeoutError`; upload route returns 500                                                                                  | `"Failed to upload content"`                                             |
| SQS visibility timeout         | 180 s     | `SQS_VISIBILITY_TIMEOUT` → `sqs.visibilityTimeout` | `src/config.js`                              | Hides the SQS message while the worker is processing it, preventing duplicate delivery                            | SQS makes the message visible again; the worker picks it up for a retry                                                                  | No direct user error — review transitions to a retry attempt             |
| SQS max receive count          | 3 retries | `SQS_MAX_RECEIVE_COUNT` → `sqs.maxReceiveCount`    | `src/config.js`                              | Application-level dead-letter guard — counts how many times a message has been received                           | Worker deletes the message and marks the review as permanently failed                                                                    | `"Review could not be completed after N delivery attempts"`              |
| Bedrock AI request             | 120 s     | `BEDROCK_TIMEOUT_MS` (constant)                    | `src/common/helpers/bedrock-client.js:15`    | Sends the extracted document content to AWS Bedrock for AI review                                                 | AWS SDK throws `TimeoutError`; the error propagates to the SQS worker catch block, which resets the visibility window and lets SQS retry | `"Bedrock API request timed out. The request took too long to process."` |
| Heartbeat interval             | 90 s      | `HEARTBEAT_INTERVAL_MS` (constant)                 | `src/common/helpers/sqs/review-processor.js` | Extends SQS message visibility mid-processing as a safety net in case pre-Bedrock steps take longer than expected | If the heartbeat itself fails (e.g. SQS unavailable), the message may reappear early — the worker logs a warning and continues           | None — transparent to the user                                           |
| Heartbeat visibility extension | 180 s     | `HEARTBEAT_VISIBILITY_SECONDS` (constant)          | `src/common/helpers/sqs/review-processor.js` | On each heartbeat tick, resets the hide window to 3 minutes from now                                              | N/A — this is the window granted, not a timeout that fires                                                                               | None                                                                     |
| Failure visibility reset       | 180 s     | `HEARTBEAT_VISIBILITY_SECONDS` (reused)            | `src/common/helpers/sqs/review-processor.js` | On any processing failure, explicitly resets the visibility window to 3 minutes from the moment of failure        | Ensures the retry always waits the full 3-minute backoff regardless of how much of the original window was consumed                      | None — review remains in a pending/processing state                      |

### Frontend

| Component                | Timeout | Constant             | File                              | Action carried out                                        | What happens on timeout                     | User-facing error                                                                          |
| ------------------------ | ------- | -------------------- | --------------------------------- | --------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Hapi socket              | 90 s    | hardcoded            | `src/server/index.js`             | Keeps TCP connection open during frontend → backend calls | Hapi closes the socket                      | `"Request timed out"`                                                                      |
| Hapi server              | 85 s    | hardcoded            | `src/server/index.js`             | Hard ceiling on request handler duration                  | Hapi returns 503                            | `"Request timed out"`                                                                      |
| → Backend: upload        | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/upload.js`        | Forwards file buffer to backend `/api/upload`             | AbortError thrown; handler returns 500      | `"The upload request timed out. Please try again."`                                        |
| → Backend: text review   | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/text-review.js`   | Posts pasted text to backend `/api/review/text`           | AbortError thrown; handler returns 500      | `"The text review request timed out. Please try again."`                                   |
| → Backend: URL review    | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/url-review.js`    | Posts extracted GOV.UK HTML to backend `/api/review/text` | AbortError thrown; handler returns 500      | `"The request timed out. Please try again."`                                               |
| → Backend: reviews list  | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/reviews.js`       | Fetches paginated review history from backend             | AbortError thrown; handler returns 500      | `"The request timed out. Please try again."`                                               |
| → Backend: delete review | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/delete-review.js` | Sends DELETE to backend `/api/reviews/{id}`               | AbortError thrown; handler returns 500      | `"The delete request timed out. Please try again."`                                        |
| URL fetch (GOV.UK HTML)  | 30 s    | `FETCH_TIMEOUT_MS`   | `src/server/api/fetch-url.js`     | Fetches raw HTML from a GOV.UK URL server-side            | AbortError thrown; mapped to a user message | `"The request timed out. GOV.UK took too long to respond — please try again in a moment."` |

---

## Rationale

### Why 120 s for Bedrock AI?

Bedrock responses typically arrive within 30 seconds for standard documents.
120 seconds (2 minutes) is the hard upper limit — it gives the AI enough
headroom for large or complex documents while failing fast enough to surface
genuine service degradation rather than waiting indefinitely.

### Why 180 s for SQS visibility timeout?

The SQS visibility timeout must **exceed** the Bedrock request timeout to
prevent duplicate processing:

- Bedrock timeout: **120 s**
- SQS visibility timeout: **180 s** (120 s + 60 s safety margin)

The 60-second margin absorbs startup overhead and any delays before the
Bedrock call begins. On failure, the worker explicitly resets the visibility
window to 180 s from the moment of failure — so the retry always waits the
full 3 minutes, regardless of how much of the original window was consumed.

### Why 90 s for the heartbeat interval?

The heartbeat fires once at 90 seconds as a safety net. Since Bedrock is
capped at 120 s, the heartbeat fires before any plausible timeout and extends
the window to 180 s from the heartbeat fire time. Processing always completes
before a second heartbeat would be needed.

### Why 30 s for frontend → backend calls?

The backend responds to upload, review, and delete requests quickly — it
enqueues work to SQS and returns a `reviewId`. Heavy processing (Bedrock,
S3 upload) happens asynchronously. 30 s is generous for a fast async
acknowledgement while staying comfortably below the 85 s Hapi server timeout.

### Why 30 s for S3?

Text content uploaded to S3 is a UTF-8 string (typically < 1 MB). Over a
VPC-internal connection, this should complete in milliseconds. 30 s is
deliberately generous to accommodate S3 degradation events while still
failing fast enough to surface problems quickly.

### Dead-letter queue (SQS)

`sqs.maxReceiveCount` (default: 3) is an **application-level** guard — the
SQS worker tracks how many times a message has been received and discards
it after 3 attempts. A matching `RedrivePolicy maxReceiveCount` must also be
set on the SQS queue in AWS (infrastructure configuration, not code). Without
the queue-level policy, endlessly failing messages would loop forever.

---

## Response Time Logging

Response time is logged at every I/O boundary using `logger.info`:

| Stage                             | Log field                                   | Example log message                                                            |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| Frontend → Backend (upload)       | `backendRequestTime`                        | `File uploaded successfully to backend. Backend response time: 0.42s`          |
| Frontend → Backend (text review)  | `backendRequestTime`                        | `Text review request successful — backendRequestTime: 0.31`                    |
| Frontend → Backend (URL review)   | `backendRequestTime`                        | `url-review: review submitted successfully in 0.28s`                           |
| Frontend → Backend (reviews list) | `backendRequestTime`                        | logged in error path                                                           |
| S3 PutObject                      | `durationMs`                                | `S3 text content upload started → success durationMs: 210`                     |
| Bedrock ConverseCommand — start   | `userPromptLength`, `systemPromptLength`    | `[BEDROCK] Sending request to Bedrock AI - START`                              |
| Bedrock ConverseCommand — success | `durationMs`, `inputTokens`, `outputTokens` | `[BEDROCK] AI review COMPLETED successfully in 1420ms (Tokens: 28000→850)`     |
| Bedrock ConverseCommand — failure | `durationMs`, `blocked`, `reason`           | `[BEDROCK] AI review FAILED after 120000ms`                                    |
| SQS message — processed           | `durationMs`                                | `SQS message processed successfully in 3210ms`                                 |
| SQS message — failed              | `durationMs`, `errorName`                   | `Failed to process SQS message after 120150ms: Bedrock API request timed out.` |

Timeout errors are also logged at `error` level with the elapsed time and
the configured limit, e.g.:

```
Delete review backend request timed out after 30s — totalProcessingTime: 30.01s
[BEDROCK] AI review FAILED after 120000ms
```

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
