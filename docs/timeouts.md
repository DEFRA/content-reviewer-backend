# Timeout Configuration — Content Reviewer Tool

> **Last updated:** 2026-05-12
> **Maintainer:** See [Related links](#related-links) for source files.

---

## Table of Contents

1. [Overview](#overview)
2. [Purpose](#purpose)
3. [How a request flows through the system](#how-a-request-flows-through-the-system)
4. [Environment variables — the master list](#environment-variables--the-master-list)
   - [Frontend variables](#frontend-variables)
   - [Backend variables](#backend-variables)
5. [Where each variable is used](#where-each-variable-is-used)
6. [Rationale](#rationale)
7. [Response Time Logging](#response-time-logging)
8. [Timeout Logging](#timeout-logging)
9. [Maintainability](#maintainability)
10. [Related Links](#related-links)
11. [Conclusion](#conclusion)

---

## Overview

Every place the system talks to the network or to another service has an
**explicit time limit**. If the call takes longer than that limit, it is
aborted and an error is logged. All limits are now **environment variables**
managed in `cdp-app-config` — they can be tuned per environment (dev / test /
prod) without a code change.

This document is the single reference for:

- which timeout exists
- what it does in plain English
- which file reads it
- what default value it ships with
- what gets logged when it fires

---

## Purpose

Unguarded calls can hang indefinitely and exhaust server resources. Explicit
timeouts give:

- **Predictable failure** — requests fail fast with a clear message.
- **Retry safety** — SQS messages are hidden long enough that a slow
  Bedrock call cannot cause duplicate processing.
- **Observability** — every fired timeout is logged at `error` level with
  the elapsed time so on-call engineers can spot latency spikes immediately.
- **Per-environment tuning** — ops can lower limits in `dev` for testing and
  raise them in `prod` without rebuilding the service.

---

## How a request flows through the system

```
User's Browser
  │
  │  (no time limit set here — browser decides when to give up)
  ▼
Frontend Web Server  (the Node.js app the user's browser talks to)
  │  Per-route socket limit for /api/review/url:  60 s   (ROUTE_SOCKET_TIMEOUT_LONG_MS)
  │  Per-route socket limit for /api/fetch-url:   30 s   (ROUTE_SOCKET_TIMEOUT_FETCH_MS)
  │
  │  Per-call time limit to backend: 30 s  (BACKEND_REQUEST_TIMEOUT_MS — every API handler)
  │  — each call the frontend makes to the backend has its own 30 s deadline;
  │    if the backend doesn't respond in time, the user sees a timeout error
  │
  │  Per-call time limit to GOV.UK: 30 s  (FETCH_TIMEOUT_MS — URL review feature)
  │  — when fetching a GOV.UK page server-side
  ▼
Backend Web Server  (the Node.js app that does the actual work)
  │  Connection keep-alive limit:  90 s   (HAPI_SOCKET_TIMEOUT_MS)
  │  Request processing limit:     85 s   (HAPI_SERVER_TIMEOUT_MS)
  │  — if a request takes longer than 85 s, the server returns a 503 error
  │    before the connection itself is dropped at 90 s
  │
  ├──► AWS S3 — file storage
  │      Saves the document text before queuing it for review
  │      Time limit:  30 s   (S3_REQUEST_TIMEOUT_MS)
  │
  ├──► AWS SQS — job queue
  │      Adds the review job to the queue so the worker can pick it up
  │      Hide window (prevents the same job being picked up twice):  180 s  (SQS_VISIBILITY_TIMEOUT)
  │      Heartbeat extends visibility every 90 s while processing:           (SQS_HEARTBEAT_INTERVAL_MS)
  │      Heartbeat grants another 180 s on each tick:                        (SQS_HEARTBEAT_VISIBILITY_SECONDS)
  │      Max delivery attempts before giving up:                  3          (SQS_MAX_RECEIVE_COUNT)
  │
  ├──► CDP Uploader — virus scan + S3 deposit
  │      Polls the uploader service until a file is scanned
  │      Total polling budget:   60 s   (CDP_POLL_TIMEOUT_MS)
  │      Time between poll calls:  1.5 s  (CDP_POLL_INTERVAL_MS)
  │
  └──► AWS Bedrock AI — the AI that reads and reviews the content
         Time limit: 120 s  (BEDROCK_TIMEOUT_MS)
         — if the AI takes longer than 2 minutes, the job fails and SQS
           retries it after the 3-minute hide window expires
```

---

## Environment variables — the master list

Every timeout below is sourced from `cdp-app-config` for deployed environments
and from `.env` for local development. Changing a value in `cdp-app-config` and
redeploying is enough — **no code change required**.

### Frontend variables

| Variable                        | Default (ms)   | In plain English                                                                                                                                               |
| ------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKEND_REQUEST_TIMEOUT_MS`    | `30000` (30 s) | How long the frontend will wait for the backend to reply on any API call (upload, text review, URL review, reviews list, delete review). After this it aborts. |
| `FETCH_TIMEOUT_MS`              | `30000` (30 s) | How long the frontend will wait for a GOV.UK page to load when the user submits a URL. Aborts the upstream fetch.                                              |
| `ROUTE_SOCKET_TIMEOUT_LONG_MS`  | `60000` (60 s) | Max time the URL-review route's connection can stay open. Covers fetch + extract + backend submit in one handler.                                              |
| `ROUTE_SOCKET_TIMEOUT_FETCH_MS` | `30000` (30 s) | Max time the "fetch GOV.UK page" proxy route's connection can stay open. Matches `FETCH_TIMEOUT_MS`.                                                           |

### Backend variables

| Variable                           | Default          | In plain English                                                                                                                                                    |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HAPI_SOCKET_TIMEOUT_MS`           | `90000` (90 s)   | How long the network connection to the backend can stay open while a request is being handled. Acts as the outer safety net.                                        |
| `HAPI_SERVER_TIMEOUT_MS`           | `85000` (85 s)   | How long the backend will work on a single request before giving up. Fires 5 s before the socket is cut so a clean 503 response is delivered.                       |
| `S3_REQUEST_TIMEOUT_MS`            | `30000` (30 s)   | How long the backend will wait for an S3 upload (saving extracted text) before failing the request.                                                                 |
| `SQS_WAIT_TIME_SECONDS`            | `20` (seconds)   | How long the SQS worker keeps a single "give me a message" call open while it waits for work. AWS calls this long polling. Reduces empty responses and AWS charges. |
| `SQS_VISIBILITY_TIMEOUT`           | `180` (seconds)  | How long an SQS message is hidden from other workers while one worker is processing it. Prevents two workers picking up the same job.                               |
| `SQS_HEARTBEAT_INTERVAL_MS`        | `90000` (90 s)   | How often the worker pings SQS to extend the hide window during a long-running job. Fires once at 90 s as a safety net during Bedrock calls.                        |
| `SQS_HEARTBEAT_VISIBILITY_SECONDS` | `180` (seconds)  | How many extra seconds each heartbeat tick adds to the hide window. Also used to reset the window after a failure so the retry waits the full backoff.              |
| `SQS_MAX_RECEIVE_COUNT`            | `3` (attempts)   | How many times a message can be picked up before the worker gives up and marks the review as permanently failed. **Not** a time — a counter.                        |
| `BEDROCK_TIMEOUT_MS`               | `120000` (120 s) | How long the backend will wait for AWS Bedrock to reply with the AI review. The hard ceiling per review.                                                            |
| `CDP_POLL_TIMEOUT_MS`              | `60000` (60 s)   | How long the backend will keep polling the CDP Uploader service waiting for a file to finish virus scanning before giving up.                                       |
| `CDP_POLL_INTERVAL_MS`             | `1500` (1.5 s)   | How long between each poll call to the CDP Uploader. Smaller values mean faster reaction but more network chatter.                                                  |

---

## Where each variable is used

### Frontend

| Variable                        | File(s) that read it                                                                                                                                                                                                                                                                                                                                                                             | Config key                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `BACKEND_REQUEST_TIMEOUT_MS`    | [`src/server/api/text-review.js`](../../content-reviewer-frontend/src/server/api/text-review.js), [`src/server/api/url-review.js`](../../content-reviewer-frontend/src/server/api/url-review.js), [`src/server/api/reviews.js`](../../content-reviewer-frontend/src/server/api/reviews.js), [`src/server/api/delete-review.js`](../../content-reviewer-frontend/src/server/api/delete-review.js) | `backend.requestTimeoutMs`    |
| `FETCH_TIMEOUT_MS`              | [`src/server/api/fetch-url.js`](../../content-reviewer-frontend/src/server/api/fetch-url.js)                                                                                                                                                                                                                                                                                                     | `fetch.timeoutMs`             |
| `ROUTE_SOCKET_TIMEOUT_LONG_MS`  | [`src/server/router.js`](../../content-reviewer-frontend/src/server/router.js) — `/api/review/url` route                                                                                                                                                                                                                                                                                         | `routes.socketTimeoutLongMs`  |
| `ROUTE_SOCKET_TIMEOUT_FETCH_MS` | [`src/server/router.js`](../../content-reviewer-frontend/src/server/router.js) — `/api/fetch-url` route                                                                                                                                                                                                                                                                                          | `routes.socketTimeoutFetchMs` |

### Backend

| Variable                           | File(s) that read it                                                                                                | Config key                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `HAPI_SOCKET_TIMEOUT_MS`           | [`src/server.js`](../src/server.js)                                                                                 | `hapi.socketTimeoutMs`           |
| `HAPI_SERVER_TIMEOUT_MS`           | [`src/server.js`](../src/server.js)                                                                                 | `hapi.serverTimeoutMs`           |
| `S3_REQUEST_TIMEOUT_MS`            | [`src/common/helpers/s3-uploader.js`](../src/common/helpers/s3-uploader.js) (via SDK requestHandler)                | `s3.requestTimeoutMs`            |
| `SQS_WAIT_TIME_SECONDS`            | [`src/common/helpers/sqs-client.js`](../src/common/helpers/sqs-client.js)                                           | `sqs.waitTimeSeconds`            |
| `SQS_VISIBILITY_TIMEOUT`           | [`src/common/helpers/sqs-client.js`](../src/common/helpers/sqs-client.js)                                           | `sqs.visibilityTimeout`          |
| `SQS_HEARTBEAT_INTERVAL_MS`        | [`src/common/helpers/sqs/review-processor.js`](../src/common/helpers/sqs/review-processor.js) — `processMessage()`  | `sqs.heartbeatIntervalMs`        |
| `SQS_HEARTBEAT_VISIBILITY_SECONDS` | [`src/common/helpers/sqs/review-processor.js`](../src/common/helpers/sqs/review-processor.js) — `processMessage()`  | `sqs.heartbeatVisibilitySeconds` |
| `SQS_MAX_RECEIVE_COUNT`            | [`src/common/helpers/sqs/review-processor.js`](../src/common/helpers/sqs/review-processor.js) — `isDeadLettered()`  | `sqs.maxReceiveCount`            |
| `BEDROCK_TIMEOUT_MS`               | [`src/common/helpers/bedrock-client.js`](../src/common/helpers/bedrock-client.js) — constructor + timeout-error log | `bedrock.timeoutMs`              |
| `CDP_POLL_TIMEOUT_MS`              | [`src/common/helpers/cdp-uploader-client.js`](../src/common/helpers/cdp-uploader-client.js)                         | `cdpUploader.pollTimeoutMs`      |
| `CDP_POLL_INTERVAL_MS`             | [`src/common/helpers/cdp-uploader-client.js`](../src/common/helpers/cdp-uploader-client.js)                         | `cdpUploader.pollIntervalMs`     |

---

## Rationale

### Why 120 s for Bedrock?

Normal Bedrock calls complete within ~30 seconds. 120 seconds is the hard
upper limit before we surface a timeout — enough headroom for very large
documents while still failing fast on genuine service problems.

### Why 180 s for the SQS visibility window?

It must exceed the Bedrock timeout so a slow Bedrock call cannot cause the
same message to be redelivered to another worker. 180 s = Bedrock timeout
(120 s) + a 60 s safety margin for setup and parsing.

### Why 90 s for the heartbeat?

The heartbeat fires once at 90 s as a safety net. Bedrock is already capped
at 120 s, so processing always completes before the next heartbeat would
fire at 180 s. The single heartbeat protects against unusual slowness in
the pre-Bedrock steps (S3 read, content validation).

### Why 30 s for frontend → backend calls?

The backend acknowledges most calls quickly (it enqueues to SQS and returns
a `reviewId`). The heavy AI work happens asynchronously. 30 s is generous
for the acknowledgement and comfortably below the 85 s Hapi server timeout.

### Why the per-route socket timeouts on the frontend?

The default Hapi socket timeout is 30 s. The URL review route does _three_
upstream calls back-to-back (GOV.UK fetch + content extraction + backend
submission), so it needs a longer per-route budget — 60 s.
The dedicated `/api/fetch-url` proxy route only does the GOV.UK fetch, so
30 s matches `FETCH_TIMEOUT_MS` exactly.

### Why a max-receive-count of 3?

Three attempts is the standard for retry-able transient failures. After
that, the message is treated as permanently failed — both at the
application level (this counter) and at the AWS queue level (the matching
`RedrivePolicy maxReceiveCount` must be set on the queue itself).

---

## Response Time Logging

Response times are logged at every I/O boundary using `logger.info`:

| Stage                             | Log level | Log field                                   | Actual log message                                                                                                                                  |
| --------------------------------- | --------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend → Backend (upload)       | `info`    | `backendRequestTime`, `totalProcessingTime` | `File: report.pdf uploaded successfully to backend. Backend response time: 0.42s, Total processing time: 0.55s`                                     |
| Frontend → Backend (text review)  | `info`    | `backendRequestTime`, `totalProcessingTime` | `[RESPONSE TIME] Text review request successful` (with structured fields: reviewId, textLength, wordCount, backendRequestTime, totalProcessingTime) |
| Frontend → Backend (URL review)   | `info`    | `backendRequestTime`                        | `url-review: review submitted successfully in 0.28s`                                                                                                |
| Frontend → Backend (reviews list) | `error`   | `backendRequestTime`                        | `Backend review history request failed - endpoint: …, status: 500, statusText: Internal Server Error, requestTime: 0.31s`                           |
| S3 upload — start                 | `info`    | `uploadId`, `originalLength`, `durationMs`  | `S3 text content upload started` (or `S3 text upload started - PII REDACTED (N instances)` when PII is detected)                                    |
| S3 upload — success               | `info`    | `uploadId`, `durationMs`, `s3Location`      | _(no message string — structured fields only)_                                                                                                      |
| S3 upload — failure               | `error`   | `uploadId`, `durationMs`, `errorName`       | `S3 text upload failed after 30000ms: TimeoutError`                                                                                                 |
| Bedrock AI — start                | `info`    | `userPromptLength`, `systemPromptLength`    | `[BEDROCK] Sending request to Bedrock AI - START`                                                                                                   |
| Bedrock AI — success              | `info`    | `durationMs`, `inputTokens`, `outputTokens` | `[BEDROCK] AI review COMPLETED successfully in 1420ms (Tokens: 28000→850)`                                                                          |
| Bedrock AI — failure              | `error`   | `durationMs`, `blocked`, `reason`           | `[BEDROCK] AI review FAILED after 120000ms`                                                                                                         |
| SQS message — processed           | `info`    | `messageId`, `uploadId`, `durationMs`       | `SQS message processed successfully in 3210ms`                                                                                                      |
| SQS message — failed              | `error`   | `messageId`, `durationMs`, `errorName`      | `Failed to process SQS message after 120150ms: Bedrock API request timed out.`                                                                      |

---

## Timeout Logging

Every timeout is logged at `error` level with the elapsed time so engineers can grep `[TIMEOUT]` to find them quickly:

| Where the timeout fires                       | Log level | Actual log message                                                                                                       |
| --------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| Frontend → Backend: upload                    | `error`   | `Upload API request failed with error` _(AbortError is detected and shown to the user but not named in the log message)_ |
| Frontend → Backend: text review               | `error`   | `[TIMEOUT] Text review backend request timed out after 30s — totalProcessingTime: 30.02s`                                |
| Frontend → Backend: URL review                | `error`   | `[TIMEOUT] url-review: backend request timed out after 30s`                                                              |
| Frontend → Backend: reviews list              | `error`   | `[TIMEOUT] Reviews backend request timed out after 30s — totalProcessingTime: 30.01s`                                    |
| Frontend → Backend: delete review             | `error`   | `[TIMEOUT] Delete review backend request timed out after 30s — reviewId: abc-123, totalProcessingTime: 30.01s`           |
| Frontend: GOV.UK URL fetch                    | `error`   | `fetch-url: upstream fetch failed after retries` _(AbortError mapped to user message; no dedicated timeout log line)_    |
| Backend: S3 file save                         | `error`   | `S3 text upload failed after 30000ms: TimeoutError`                                                                      |
| Backend: Bedrock AI review                    | `error`   | `[TIMEOUT] Bedrock API request timed out after 120s`                                                                     |
| Backend: SQS message processing (any failure) | `error`   | `Failed to process SQS message after 120150ms: Bedrock API request timed out.`                                           |

---

## Maintainability

When changing any timeout value:

1. **Decide where the value lives.** All defaults are in code (`config.js` /
   `config/config.js`). The deployed value comes from `cdp-app-config`. For
   local dev, set the value in `.env`.
2. **Respect the invariants:**
   - `SQS_VISIBILITY_TIMEOUT (s)` must exceed `BEDROCK_TIMEOUT_MS / 1000` by
     at least 60 s — otherwise a slow Bedrock call can cause duplicate
     processing.
   - `SQS_HEARTBEAT_INTERVAL_MS` must be less than `BEDROCK_TIMEOUT_MS` —
     otherwise the heartbeat fires too late to extend visibility.
   - `HAPI_SERVER_TIMEOUT_MS` must be less than `HAPI_SOCKET_TIMEOUT_MS` —
     otherwise the socket closes before the server can send a clean 503.
   - `BACKEND_REQUEST_TIMEOUT_MS` must be less than `HAPI_SERVER_TIMEOUT_MS`
     — otherwise the frontend may give up before the backend can reply.
3. **Update `.env`** in both repos so local dev mirrors the deployed defaults.
4. **Update this document** — reflect the new value in the variable tables
   and (if it changed significantly) the flow diagram.
5. **Run tests** — the heartbeat behaviour is covered by
   `review-processor.processing.test.js`.

---

## Related Links

| Resource                                                   | Location                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend config (all defaults + env names + invariant docs) | [`src/config.js`](../src/config.js)                                                                                                                                                                                             |
| Frontend config                                            | [`src/config/config.js`](../../content-reviewer-frontend/src/config/config.js)                                                                                                                                                  |
| Backend Hapi server timeouts                               | [`src/server.js`](../src/server.js)                                                                                                                                                                                             |
| Frontend per-route socket timeouts                         | [`src/server/router.js`](../../content-reviewer-frontend/src/server/router.js)                                                                                                                                                  |
| Bedrock client (timeout enforcement + error logging)       | [`src/common/helpers/bedrock-client.js`](../src/common/helpers/bedrock-client.js)                                                                                                                                               |
| SQS worker (heartbeat + failure visibility reset)          | [`src/common/helpers/sqs/review-processor.js`](../src/common/helpers/sqs/review-processor.js)                                                                                                                                   |
| Frontend → Backend AbortController calls                   | [`src/server/api/text-review.js`](../../content-reviewer-frontend/src/server/api/text-review.js), [`src/server/api/url-review.js`](../../content-reviewer-frontend/src/server/api/url-review.js), and the other api/\*.js files |
| Frontend GOV.UK fetch                                      | [`src/server/api/fetch-url.js`](../../content-reviewer-frontend/src/server/api/fetch-url.js)                                                                                                                                    |

---

## Conclusion

All timeouts in the Content Reviewer system are intentionally layered and
**fully env-driven** via `cdp-app-config`:

- Frontend handlers fail after 30 s on backend calls.
- Per-route Hapi socket timeouts on the frontend protect long-running routes.
- Backend Hapi enforces an 85 / 90 s ceiling on the whole request.
- Bedrock is capped at 120 s.
- SQS visibility (180 s) and the 90 s heartbeat together guarantee a failed
  message is always retried after the full 3-minute backoff.

Tuning any of these values is now an **ops change** — update the variable in
`cdp-app-config`, redeploy. Future changes should follow the checklist in
[Maintainability](#maintainability) to keep the invariants intact.
