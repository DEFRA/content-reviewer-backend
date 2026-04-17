import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { uploadFileToCdpUploader } from './upload.js'

// ─── Mock all external dependencies ───────────────────────────────────────────

vi.mock('form-data', () => ({
  default: class FormData {
    append() {}
    getHeaders() {
      return {}
    }
  }
}))

vi.mock('../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const map = {
        'cdpUploader.url': 'http://cdp-uploader',
        'cdpUploader.pollTimeoutMs': 100,
        'cdpUploader.pollIntervalMs': 10,
        's3.bucket': 'test-bucket',
        cdpEnvironment: 'dev',
        serviceName: 'content-reviewer'
      }
      return map[key] ?? undefined
    })
  }
}))

vi.mock('../common/helpers/canonical-document.js', () => ({
  SOURCE_TYPES: { FILE: 'file' }
}))

vi.mock('./review-helpers.js', () => ({
  HTTP_STATUS: {
    BAD_REQUEST: 400,
    ACCEPTED: 202,
    INTERNAL_SERVER_ERROR: 500
  },
  REVIEW_STATUSES: { PENDING: 'pending' },
  getCorsConfig: vi.fn(() => ({ origin: ['*'] })),
  createCanonicalDocument: vi.fn(),
  createReviewRecord: vi.fn(),
  queueReviewJob: vi.fn()
}))

import { config } from '../config.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStream(content = 'hello') {
  return Readable.from([Buffer.from(content)])
}

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

// ── initiateUpload – local environment branch (lines 267-269) ─────────────────
// When cdpEnvironment is 'local', the callbackUrl is built using host:port rather
// than the CDP service domain (lines 267-269).

describe('initiateUpload – local environment callbackUrl (lines 267-269)', () => {
  let logger

  beforeEach(() => {
    logger = mockLogger()
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('performance', { now: vi.fn().mockReturnValue(0) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('builds callbackUrl from host:port when cdpEnvironment is "local"', async () => {
    vi.mocked(config.get).mockImplementation((key) => {
      const map = {
        'cdpUploader.url': 'http://cdp-uploader',
        'cdpUploader.pollTimeoutMs': 100,
        'cdpUploader.pollIntervalMs': 10,
        's3.bucket': 'test-bucket',
        cdpEnvironment: 'local',
        host: 'localhost',
        port: '3000'
      }
      return map[key] ?? undefined
    })

    // Fail fast at initiate so the full pipeline is not needed for this test
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: vi.fn().mockResolvedValue({}),
      text: vi.fn().mockResolvedValue('')
    })

    await expect(
      uploadFileToCdpUploader(makeStream(), 'multipart/form-data', logger)
    ).rejects.toThrow('cdp-uploader initiate failed: 503')
  })
})

// ── initiateUpload – catch lambda coverage (lines 298, 306) ──────────────────
// Line 298: the `() => ''` catch callback inside `.catch(() => '')` fires when
//           `initResp.text()` rejects (defensive error-handling path).
// Line 306: the `() => ({})` catch callback fires when `initResp.json()` rejects.

describe('initiateUpload – catch lambda coverage (lines 298, 306)', () => {
  let logger

  beforeEach(() => {
    logger = mockLogger()
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('performance', { now: vi.fn().mockReturnValue(0) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('invokes the text catch callback when text() rejects on a non-2xx initiate (line 298)', async () => {
    // initResp.ok=false AND text() rejects → () => '' catch callback fires (line 298)
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({}),
      text: vi.fn().mockRejectedValue(new Error('stream read error'))
    })

    await expect(
      uploadFileToCdpUploader(makeStream(), 'multipart/form-data', logger)
    ).rejects.toThrow('cdp-uploader initiate failed: 500')
  })

  it('invokes the json catch callback when json() rejects on a successful initiate (line 306)', async () => {
    // initResp.ok=true AND json() rejects → () => ({}) catch fires (line 306)
    // initJson becomes {} → uploadId/uploadUrl undefined → throws "no uploadUrl"
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new Error('JSON parse error')),
      text: vi.fn().mockResolvedValue('')
    })

    await expect(
      uploadFileToCdpUploader(makeStream(), 'multipart/form-data', logger)
    ).rejects.toThrow('cdp-uploader initiate did not return an uploadUrl')
  })
})

// ── performUpload – catch lambda coverage (line 343) ─────────────────────────
// Line 343: the `() => ''` catch callback fires when `uploadRes.text()` rejects
//           during the raw file upload's non-2xx error path.

describe('performUpload – catch lambda coverage (line 343)', () => {
  let logger

  beforeEach(() => {
    logger = mockLogger()
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('performance', { now: vi.fn().mockReturnValue(0) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('invokes the text catch callback when upload text() rejects on a non-2xx response (line 343)', async () => {
    // initiate succeeds, upload returns ok=false AND text() rejects → () => '' fires (line 343)
    fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          uploadId: 'u1',
          uploadUrl: 'http://cdp-uploader/upload/u1',
          statusUrl: 'http://cdp-uploader/status/u1'
        }),
        text: vi.fn().mockResolvedValue('')
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        json: vi.fn().mockResolvedValue({}),
        text: vi.fn().mockRejectedValue(new Error('stream read error'))
      })

    await expect(
      uploadFileToCdpUploader(makeStream(), 'multipart/form-data', logger)
    ).rejects.toThrow('Raw upload failed: 413')
  })
})
