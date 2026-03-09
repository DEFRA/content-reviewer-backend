import { describe, it, expect, vi, beforeEach } from 'vitest'

const HTTP_BAD_REQUEST = 400
const HTTP_INTERNAL_SERVER_ERROR = 500
const HTTP_STATUS_OK = 200

vi.mock('../common/helpers/review-repository.js', () => ({
  reviewRepository: {
    getReview: vi.fn()
  }
}))

vi.mock('../common/helpers/logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }))
}))

vi.mock('../config.js', () => {
  const configValues = {
    's3.bucket': 'test-bucket',
    'cors.origin': ['*'],
    'cors.credentials': true
  }
  return {
    config: {
      get: vi.fn((key) => configValues[key] ?? null)
    }
  }
})

import { reviewRepository } from '../common/helpers/review-repository.js'
import { results } from './results.js'

function createMockH() {
  const responseMock = { code: vi.fn().mockReturnThis() }
  return {
    response: vi.fn(() => responseMock),
    _responseMock: responseMock
  }
}

function createMockRequest(params = {}, query = {}) {
  return {
    params,
    query,
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  }
}

function buildCompletedReview(overrides = {}) {
  return {
    status: 'completed',
    result: { reviewData: { scores: {} }, originalText: 'hello' },
    s3Key: 'reviews/job-123/result.json',
    fileName: 'test.pdf',
    createdAt: new Date('2024-01-01'),
    processingCompletedAt: new Date('2024-01-02'),
    error: null,
    ...overrides
  }
}

describe('results plugin', () => {
  it('exports a hapi plugin named results', () => {
    expect(results.plugin.name).toBe('results')
    expect(typeof results.plugin.register).toBe('function')
  })

  it('registers two routes on the server', () => {
    const server = { route: vi.fn() }
    results.plugin.register(server)
    expect(server.route).toHaveBeenCalledTimes(2)
  })
})

function getResultRouteHandler() {
  const routes = []
  const server = { route: vi.fn((r) => routes.push(r)) }
  results.plugin.register(server)
  return routes.find(
    (r) => r.path === '/api/results/{jobId}' && r.method === 'GET'
  ).handler
}

describe('getResultHandler - validation', () => {
  let getResultHandler

  beforeEach(async () => {
    vi.resetAllMocks()
    getResultHandler = getResultRouteHandler()
  })

  it('returns 400 when jobId is missing', async () => {
    const req = createMockRequest({ jobId: '' })
    const h = createMockH()

    await getResultHandler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Job ID is required' })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_BAD_REQUEST)
  })

  it('returns 400 when jobId is whitespace only', async () => {
    const req = createMockRequest({ jobId: '   ' })
    const h = createMockH()

    await getResultHandler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_BAD_REQUEST)
  })
})

describe('getResultHandler - result fetching', () => {
  let getResultHandler

  beforeEach(async () => {
    vi.resetAllMocks()
    getResultHandler = getResultRouteHandler()
  })

  it('returns processing response when review not found', async () => {
    reviewRepository.getReview.mockResolvedValueOnce(null)
    const req = createMockRequest({ jobId: 'job-404' })
    const h = createMockH()

    await getResultHandler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ status: 'processing' })
      })
    )
    expect(h._responseMock.code).not.toHaveBeenCalled()
  })

  it('returns review result with s3 metadata when review found', async () => {
    const review = buildCompletedReview()
    reviewRepository.getReview.mockResolvedValueOnce(review)
    const req = createMockRequest({ jobId: 'job-123' })
    const h = createMockH()

    await getResultHandler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          jobId: 'job-123',
          status: 'completed',
          s3ResultLocation: 'test-bucket/reviews/job-123/result.json',
          metadata: {
            bucket: 'test-bucket',
            s3Key: 'reviews/job-123/result.json'
          }
        })
      })
    )
  })

  it('returns null s3 metadata when review has no s3Key', async () => {
    const review = buildCompletedReview({ s3Key: null })
    reviewRepository.getReview.mockResolvedValueOnce(review)
    const req = createMockRequest({ jobId: 'job-125' })
    const h = createMockH()

    await getResultHandler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          s3ResultLocation: null,
          metadata: null
        })
      })
    )
  })

  it('returns 500 when repository throws', async () => {
    reviewRepository.getReview.mockRejectedValueOnce(new Error('DB error'))
    const req = createMockRequest({ jobId: 'job-err' })
    const h = createMockH()

    await getResultHandler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_INTERNAL_SERVER_ERROR
    )
  })
})

describe('getResultStatusHandler - via registered route', () => {
  let getResultStatusHandler

  beforeEach(async () => {
    vi.resetAllMocks()
    const routes = []
    const server = { route: vi.fn((r) => routes.push(r)) }
    results.plugin.register(server)
    getResultStatusHandler = routes.find(
      (r) => r.path === '/api/results/{jobId}/status'
    ).handler
  })

  it('returns 400 when jobId is missing', async () => {
    const req = createMockRequest({ jobId: '' })
    const h = createMockH()

    await getResultStatusHandler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_BAD_REQUEST)
  })

  it('returns ready false when review not found', async () => {
    reviewRepository.getReview.mockResolvedValueOnce(null)
    const req = createMockRequest({ jobId: 'job-pending' })
    const h = createMockH()

    await getResultStatusHandler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        ready: false,
        status: 'processing'
      })
    )
  })

  it('returns ready true when review is completed', async () => {
    reviewRepository.getReview.mockResolvedValueOnce({ status: 'completed' })
    const req = createMockRequest({ jobId: 'job-done' })
    const h = createMockH()

    await getResultStatusHandler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        ready: true,
        status: 'completed'
      })
    )
  })

  it('returns ready false when review status is processing', async () => {
    reviewRepository.getReview.mockResolvedValueOnce({ status: 'processing' })
    const req = createMockRequest({ jobId: 'job-proc' })
    const h = createMockH()

    await getResultStatusHandler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ ready: false, status: 'processing' })
    )
  })

  it('returns 500 when repository throws', async () => {
    reviewRepository.getReview.mockRejectedValueOnce(new Error('DB error'))
    const req = createMockRequest({ jobId: 'job-err' })
    const h = createMockH()

    await getResultStatusHandler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_INTERNAL_SERVER_ERROR
    )
  })

  it('returns 200 on success (no explicit code call)', async () => {
    reviewRepository.getReview.mockResolvedValueOnce({ status: 'completed' })
    const req = createMockRequest({ jobId: 'job-ok' })
    const h = createMockH()

    await getResultStatusHandler(req, h)

    expect(h._responseMock.code).not.toHaveBeenCalled()
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, jobId: 'job-ok' })
    )
  })
})
