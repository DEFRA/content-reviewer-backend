# Timeout Configuration — Content Reviewer

This document describes every I/O timeout in the system, the rationale behind
each value, where it is set, and how response times are logged.

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
  │  AbortController timeout: 30 s  (each API handler — see below)
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
  │      Visibility timeout: 420 s  (src/config.js → SQS_VISIBILITY_TIMEOUT)
  │      Max receive count:    3     (src/config.js → SQS_MAX_RECEIVE_COUNT)
  │
  └──► Bedrock AI (ConverseCommand — content review)
         Request timeout: 360 s  (src/common/helpers/bedrock-client.js)
```

---

## Timeout Values Reference

### Backend

| Component              | Timeout   | Config key / constant                              | File                                      |
| ---------------------- | --------- | -------------------------------------------------- | ----------------------------------------- |
| Hapi socket            | 90 s      | hardcoded                                          | `src/server.js:70`                        |
| Hapi server            | 85 s      | hardcoded                                          | `src/server.js:71`                        |
| S3 PutObject           | 30 s      | `S3_REQUEST_TIMEOUT_MS` → `s3.requestTimeoutMs`    | `src/config.js`                           |
| SQS visibility timeout | 420 s     | `SQS_VISIBILITY_TIMEOUT` → `sqs.visibilityTimeout` | `src/config.js`                           |
| SQS max receive count  | 3 retries | `SQS_MAX_RECEIVE_COUNT` → `sqs.maxReceiveCount`    | `src/config.js`                           |
| Bedrock AI request     | 360 s     | `BEDROCK_TIMEOUT_MS` (constant)                    | `src/common/helpers/bedrock-client.js:15` |

### Frontend

| Component                | Timeout | Constant             | File                              |
| ------------------------ | ------- | -------------------- | --------------------------------- |
| Hapi socket              | 90 s    | hardcoded            | `src/server/index.js`             |
| Hapi server              | 85 s    | hardcoded            | `src/server/index.js`             |
| → Backend: upload        | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/upload.js`        |
| → Backend: text review   | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/text-review.js`   |
| → Backend: URL review    | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/url-review.js`    |
| → Backend: reviews list  | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/reviews.js`       |
| → Backend: delete review | 30 s    | `BACKEND_TIMEOUT_MS` | `src/server/api/delete-review.js` |
| URL fetch (gov.uk HTML)  | 30 s    | `FETCH_TIMEOUT_MS`   | `src/server/api/fetch-url.js`     |

---

## Rationale

### Why 30 s for frontend → backend calls?

The backend responds to upload, review, and delete requests quickly — it
enqueues work to SQS and returns a `reviewId`. Heavy processing (Bedrock,
S3 upload) happens asynchronously. 30 s is generous for a fast async
acknowledgement while staying comfortably below the 85 s Hapi server timeout.

### Why 420 s for SQS visibility timeout?

The SQS visibility timeout must **exceed** the Bedrock request timeout.

- Bedrock timeout: **360 s**
- SQS visibility timeout: **420 s** (360 s + 60 s safety margin)

If the visibility timeout were shorter than the Bedrock timeout, SQS would
re-deliver the message while Bedrock is still processing it — causing
duplicate reviews. The 60 s margin absorbs startup overhead and transient
delays before the Bedrock call begins.

### Why 360 s for Bedrock AI?

Large documents (~100 k characters) can take 3–5 minutes for Bedrock to
process. 360 s (6 minutes) provides headroom without setting an
unreasonably long timeout that would mask genuine failures.

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

| Stage                             | Log field                       | Example log                                                           |
| --------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Frontend → Backend (upload)       | `backendRequestTime`            | `File uploaded successfully to backend. Backend response time: 0.42s` |
| Frontend → Backend (text review)  | `backendRequestTime`            | `Text review request successful — backendRequestTime: 0.31`           |
| Frontend → Backend (URL review)   | `backendRequestTime`            | `url-review: review submitted successfully in 0.28s`                  |
| Frontend → Backend (reviews list) | `backendRequestTime`            | logged in error path                                                  |
| S3 PutObject                      | `durationMs`                    | `S3 text content upload started → success durationMs: 210`            |
| Bedrock ConverseCommand           | `responseLength`, `inputTokens` | `Bedrock response received — 4200 chars, input: 28000 tokens`         |

Timeout errors are logged at `error` level with the elapsed time and the
configured limit, e.g.:

```
Text review backend request timed out after 30s — totalProcessingTime: 30.01s
```

---

## Environment Variables

| Variable                     | Default        | Description                                      |
| ---------------------------- | -------------- | ------------------------------------------------ |
| `S3_REQUEST_TIMEOUT_MS`      | `30000`        | S3 PutObject request timeout (ms)                |
| `SQS_VISIBILITY_TIMEOUT`     | `420`          | SQS message visibility timeout (s)               |
| `SQS_MAX_RECEIVE_COUNT`      | `3`            | Max SQS delivery attempts before discard         |
| `BACKEND_REQUEST_TIMEOUT_MS` | n/a (constant) | Frontend → backend timeout (30 s, code constant) |
