import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Constants ──────────────────────────────────────────────────────────────
const REVIEW_ID = 'review_test-123'
const HTTP_BAD_REQUEST = 400
const HTTP_INTERNAL_SERVER_ERROR = 500

const STUB_ENVELOPE = {
  documentId: REVIEW_ID,
  status: 'pending',
  issueCount: 0,
  issues: [],
  scores: {}
}

const COMPLETED_ENVELOPE = {
  documentId: REVIEW_ID,
  status: 'completed',
  issueCount: 2,
  issues: [{ issueId: 'i1' }],
  scores: { overall: 80 }
}

// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock('../common/helpers/result-envelope.js', () => ({
  resultEnvelopeStore: {
    buildStubEnvelope: vi.fn()
  }
}))

vi.mock('../common/helpers/review-repository.js', () => ({
  reviewRepository: {
    getReview: vi.fn()
  }
}))

vi.mock('../common/helpers/logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

vi.mock('../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const vals = {
        'cors.origin': ['*'],
        'cors.credentials': true
      }
      return vals[key] ?? null
    })
  }
}))

import { resultEnvelopeStore } from '../common/helpers/result-envelope.js'
import { reviewRepository } from '../common/helpers/review-repository.js'
import { resultEnvelope } from './result-envelope.js'

// ── Helpers ────────────────────────────────────────────────────────────────
function createMockH() {
  const responseMock = { code: vi.fn().mockReturnThis() }
  return {
    response: vi.fn(() => responseMock),
    _responseMock: responseMock
  }
}

function createRequest(reviewId) {
  return { params: { reviewId } }
}

function getHandler() {
  let capturedHandler
  const server = {
    route: vi.fn((routeDef) => {
      capturedHandler = routeDef.handler
    })
  }
  resultEnvelope.plugin.register(server)
  return capturedHandler
}

// ── Plugin structure ───────────────────────────────────────────────────────
describe('resultEnvelope plugin', () => {
  it('exports a Hapi plugin named result-envelope', () => {
    expect(resultEnvelope.plugin.name).toBe('result-envelope')
    expect(typeof resultEnvelope.plugin.register).toBe('function')
  })

  it('registers one GET route at /api/result/{reviewId}', () => {
    const server = { route: vi.fn() }
    resultEnvelope.plugin.register(server)
    expect(server.route).toHaveBeenCalledTimes(1)
    const [routeDef] = server.route.mock.calls[0]
    expect(routeDef.method).toBe('GET')
    expect(routeDef.path).toBe('/api/result/{reviewId}')
  })

  it('sets auth to false on the route', () => {
    const server = { route: vi.fn() }
    resultEnvelope.plugin.register(server)
    const [routeDef] = server.route.mock.calls[0]
    expect(routeDef.options.auth).toBe(false)
  })
})

// ── Handler: missing / blank reviewId ─────────────────────────────────────
describe('getResultEnvelopeHandler - validation', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = getHandler()
  })

  it('returns 400 when reviewId is an empty string', async () => {
    const req = createRequest('')
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith({
      success: false,
      error: 'reviewId is required'
    })
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_BAD_REQUEST)
  })

  it('returns 400 when reviewId is whitespace only', async () => {
    const req = createRequest('   ')
    const h = createMockH()

    await handler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_BAD_REQUEST)
  })

  it('returns 400 when reviewId is undefined', async () => {
    const req = { params: {} }
    const h = createMockH()

    await handler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_BAD_REQUEST)
  })
})

// ── Handler: review not found → pending stub ──────────────────────────────
describe('getResultEnvelopeHandler - review not found', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = getHandler()
    reviewRepository.getReview.mockResolvedValue(null)
    resultEnvelopeStore.buildStubEnvelope.mockReturnValue(STUB_ENVELOPE)
  })

  it('returns pending stub when review does not exist in repository', async () => {
    const req = createRequest(REVIEW_ID)
    const h = createMockH()

    await handler(req, h)

    expect(resultEnvelopeStore.buildStubEnvelope).toHaveBeenCalledWith(
      REVIEW_ID,
      'pending'
    )
    expect(h.response).toHaveBeenCalledWith({
      success: true,
      data: STUB_ENVELOPE
    })
  })

  it('does not set a non-200 HTTP code for the pending stub', async () => {
    const req = createRequest(REVIEW_ID)
    const h = createMockH()

    await handler(req, h)

    expect(h._responseMock.code).not.toHaveBeenCalledWith(HTTP_BAD_REQUEST)
    expect(h._responseMock.code).not.toHaveBeenCalledWith(
      HTTP_INTERNAL_SERVER_ERROR
    )
  })
})

// ── Handler: completed review with envelope ────────────────────────────────
describe('getResultEnvelopeHandler - completed review', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = getHandler()
  })

  it('returns stored envelope for a completed review', async () => {
    reviewRepository.getReview.mockResolvedValue({
      status: 'completed',
      envelope: COMPLETED_ENVELOPE
    })

    const req = createRequest(REVIEW_ID)
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith({
      success: true,
      data: COMPLETED_ENVELOPE
    })
    expect(resultEnvelopeStore.buildStubEnvelope).not.toHaveBeenCalled()
  })

  it('falls back to stub when completed review has no envelope field', async () => {
    reviewRepository.getReview.mockResolvedValue({
      status: 'completed',
      envelope: null
    })
    resultEnvelopeStore.buildStubEnvelope.mockReturnValue({
      ...STUB_ENVELOPE,
      status: 'completed'
    })

    const req = createRequest(REVIEW_ID)
    const h = createMockH()

    await handler(req, h)

    expect(resultEnvelopeStore.buildStubEnvelope).toHaveBeenCalledWith(
      REVIEW_ID,
      'completed'
    )
  })
})

// ── Handler: processing / failed → status stub ────────────────────────────
describe('getResultEnvelopeHandler - processing or failed status', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = getHandler()
    resultEnvelopeStore.buildStubEnvelope.mockReturnValue(STUB_ENVELOPE)
  })

  it('returns stub with processing status when review is still processing', async () => {
    reviewRepository.getReview.mockResolvedValue({ status: 'processing' })

    const req = createRequest(REVIEW_ID)
    const h = createMockH()

    await handler(req, h)

    expect(resultEnvelopeStore.buildStubEnvelope).toHaveBeenCalledWith(
      REVIEW_ID,
      'processing'
    )
    expect(h.response).toHaveBeenCalledWith({
      success: true,
      data: STUB_ENVELOPE
    })
  })

  it('returns stub with failed status when review has failed', async () => {
    reviewRepository.getReview.mockResolvedValue({ status: 'failed' })

    const req = createRequest(REVIEW_ID)
    const h = createMockH()

    await handler(req, h)

    expect(resultEnvelopeStore.buildStubEnvelope).toHaveBeenCalledWith(
      REVIEW_ID,
      'failed'
    )
  })

  it('attaches errorMessage to stub when failed review has an error message', async () => {
    reviewRepository.getReview.mockResolvedValue({
      status: 'failed',
      error: { message: 'Content blocked by guardrails' }
    })
    const freshStub = { ...STUB_ENVELOPE, status: 'failed' }
    resultEnvelopeStore.buildStubEnvelope.mockReturnValue(freshStub)

    const req = createRequest(REVIEW_ID)
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({
        errorMessage: 'Content blocked by guardrails'
      })
    })
  })

  it('does not attach errorMessage to stub when failed review has no error', async () => {
    reviewRepository.getReview.mockResolvedValue({ status: 'failed' })
    const freshStub = { ...STUB_ENVELOPE, status: 'failed' }
    resultEnvelopeStore.buildStubEnvelope.mockReturnValue(freshStub)

    const req = createRequest(REVIEW_ID)
    const h = createMockH()

    await handler(req, h)

    const responseArg = h.response.mock.calls[0][0]
    expect(responseArg.data).not.toHaveProperty('errorMessage')
  })
})

// ── Handler: S3 / repository error → 500 ─────────────────────────────────
describe('getResultEnvelopeHandler - repository error', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = getHandler()
  })

  it('returns 500 when repository throws', async () => {
    reviewRepository.getReview.mockRejectedValue(new Error('S3 read failed'))

    const req = createRequest(REVIEW_ID)
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith({
      success: false,
      error: 'Failed to read result envelope'
    })
    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_INTERNAL_SERVER_ERROR
    )
  })

  it('does not throw; wraps errors in 500 response', async () => {
    reviewRepository.getReview.mockRejectedValue(new Error('network error'))

    const req = createRequest(REVIEW_ID)
    const h = createMockH()

    await expect(handler(req, h)).resolves.not.toThrow()
  })
})
