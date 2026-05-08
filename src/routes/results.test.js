import { describe, it, expect, vi, beforeEach } from 'vitest'

const HTTP_BAD_REQUEST = 400
const HTTP_INTERNAL_SERVER_ERROR = 500

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

describe('results plugin', () => {
  it('exports a hapi plugin named results', () => {
    expect(results.plugin.name).toBe('results')
    expect(typeof results.plugin.register).toBe('function')
  })

  it('registers one route on the server', () => {
    const server = { route: vi.fn() }
    results.plugin.register(server)
    expect(server.route).toHaveBeenCalledTimes(1)
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
