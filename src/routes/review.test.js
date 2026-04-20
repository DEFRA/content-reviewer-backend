import { describe, it, expect, vi, beforeEach } from 'vitest'

const SAMPLE_CONTENT = 'hello world'
const DEFAULT_LIMIT = 50
const DEFAULT_SKIP = 0
const REVIEW_TEXT_PATH = '/api/review/text'
const TEST_QUERY_LIMIT = 10
const TEST_QUERY_SKIP = 5
vi.mock('../common/helpers/review-repository.js', () => ({
  reviewRepository: {
    getReview: vi.fn(),
    getAllReviews: vi.fn(),
    getReviewCount: vi.fn(),
    deleteReview: vi.fn()
  }
}))

vi.mock('./review-helpers.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    validateTextContent: vi.fn(),
    processTextReviewSubmission: vi.fn(),
    formatReviewForResponse: vi.fn((r) => ({ ...r, formatted: true })),
    formatReviewForList: vi.fn((r) => ({ ...r, listed: true })),
    getCorsConfig: vi.fn(() => ({ origin: ['*'], credentials: true }))
  }
})

import { reviewRepository } from '../common/helpers/review-repository.js'
import {
  validateTextContent,
  processTextReviewSubmission,
  formatReviewForResponse,
  formatReviewForList,
  getCorsConfig,
  HTTP_STATUS,
  REVIEW_STATUSES
} from './review-helpers.js'
import { reviewRoutes } from './review.js'

function createMockH() {
  const responseMock = { code: vi.fn().mockReturnThis() }
  return {
    response: vi.fn(() => responseMock),
    _responseMock: responseMock
  }
}

function createMockRequest(overrides = {}) {
  return {
    params: {},
    query: {},
    payload: {},
    headers: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides
  }
}

function getRegisteredRoutes() {
  const routes = []
  const server = { route: vi.fn((r) => routes.push(r)) }
  reviewRoutes.plugin.register(server)
  return routes
}

function getHandler(method, path) {
  const routes = getRegisteredRoutes()
  return routes.find((r) => r.method === method && r.path === path)?.handler
}

beforeEach(() => {
  vi.resetAllMocks()
  getCorsConfig.mockReturnValue({ origin: ['*'], credentials: true })
})

// ============ Plugin shape ============

describe('reviewRoutes plugin', () => {
  it('exports a hapi plugin named review-routes', () => {
    expect(reviewRoutes.plugin.name).toBe('review-routes')
    expect(typeof reviewRoutes.plugin.register).toBe('function')
  })

  it('registers four routes', () => {
    const routes = getRegisteredRoutes()
    expect(routes).toHaveLength(4)
  })

  it('registers POST /api/review/text', () => {
    const routes = getRegisteredRoutes()
    expect(
      routes.some((r) => r.method === 'POST' && r.path === REVIEW_TEXT_PATH)
    ).toBe(true)
  })

  it('registers GET /api/review/{id}', () => {
    const routes = getRegisteredRoutes()
    expect(
      routes.some((r) => r.method === 'GET' && r.path === '/api/review/{id}')
    ).toBe(true)
  })

  it('registers GET /api/reviews', () => {
    const routes = getRegisteredRoutes()
    expect(
      routes.some((r) => r.method === 'GET' && r.path === '/api/reviews')
    ).toBe(true)
  })

  it('registers DELETE /api/reviews/{reviewId}', () => {
    const routes = getRegisteredRoutes()
    expect(
      routes.some(
        (r) => r.method === 'DELETE' && r.path === '/api/reviews/{reviewId}'
      )
    ).toBe(true)
  })
})

// ============ handleTextReview ============

describe('handleTextReview - validation failure', () => {
  let handler

  beforeEach(() => {
    vi.resetAllMocks()
    getCorsConfig.mockReturnValue({ origin: ['*'], credentials: true })
    handler = getHandler('POST', REVIEW_TEXT_PATH)
  })

  it('returns 400 when validation fails', async () => {
    validateTextContent.mockReturnValueOnce({
      valid: false,
      error: 'Content is required and must be a string',
      statusCode: HTTP_STATUS.BAD_REQUEST
    })
    const req = createMockRequest({ payload: { content: null } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Content is required and must be a string'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST)
  })
})

describe('handleTextReview - processing outcomes', () => {
  let handler

  beforeEach(() => {
    vi.resetAllMocks()
    getCorsConfig.mockReturnValue({ origin: ['*'], credentials: true })
    handler = getHandler('POST', REVIEW_TEXT_PATH)
  })

  it('returns 202 with reviewId on success', async () => {
    validateTextContent.mockReturnValueOnce({
      valid: true,
      content: SAMPLE_CONTENT,
      title: 'T'
    })
    processTextReviewSubmission.mockResolvedValueOnce({
      reviewId: 'review_abc',
      s3Result: { key: 'k' },
      timings: { s3UploadDuration: 10, dbCreateDuration: 5, sqsSendDuration: 8 }
    })
    const req = createMockRequest({
      payload: { content: SAMPLE_CONTENT, title: 'T' }
    })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        reviewId: 'review_abc',
        status: REVIEW_STATUSES.PENDING
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.ACCEPTED)
  })

  it('returns 500 when processTextReviewSubmission throws', async () => {
    validateTextContent.mockReturnValueOnce({
      valid: true,
      content: SAMPLE_CONTENT,
      title: 'T'
    })
    processTextReviewSubmission.mockRejectedValueOnce(new Error('S3 is down'))
    const req = createMockRequest({ payload: { content: SAMPLE_CONTENT } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'S3 is down' })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    )
  })

  it('returns 500 with default message when error has no message property', async () => {
    validateTextContent.mockReturnValueOnce({
      valid: true,
      content: SAMPLE_CONTENT,
      title: 'T'
    })
    processTextReviewSubmission.mockRejectedValueOnce({})
    const req = createMockRequest({ payload: { content: SAMPLE_CONTENT } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Failed to queue text review'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    )
  })
})

// ============ handleGetReview ============

describe('handleGetReview', () => {
  let handler

  beforeEach(() => {
    vi.resetAllMocks()
    getCorsConfig.mockReturnValue({ origin: ['*'], credentials: true })
    handler = getHandler('GET', '/api/review/{id}')
  })

  it('returns 404 when review is not found', async () => {
    reviewRepository.getReview.mockResolvedValueOnce(null)
    const req = createMockRequest({ params: { id: 'missing-id' } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Review not found' })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.NOT_FOUND)
  })

  it('returns 200 with formatted review when found', async () => {
    const review = { id: 'rev-1', status: 'completed' }
    reviewRepository.getReview.mockResolvedValueOnce(review)
    formatReviewForResponse.mockReturnValueOnce({
      id: 'rev-1',
      status: 'completed',
      formatted: true
    })
    const req = createMockRequest({ params: { id: 'rev-1' } })
    const h = createMockH()

    await handler(req, h)

    expect(formatReviewForResponse).toHaveBeenCalledWith(review)
    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ id: 'rev-1' })
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.OK)
  })

  it('returns 500 when repository throws', async () => {
    reviewRepository.getReview.mockRejectedValueOnce(new Error('DB failure'))
    const req = createMockRequest({ params: { id: 'rev-err' } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    )
  })
})

// ============ handleGetAllReviews ============

describe('handleGetAllReviews - query parameters', () => {
  let handler

  beforeEach(() => {
    vi.resetAllMocks()
    getCorsConfig.mockReturnValue({ origin: ['*'], credentials: true })
    handler = getHandler('GET', '/api/reviews')
  })

  it('returns 200 with reviews and pagination', async () => {
    const reviews = [{ id: 'r1' }, { id: 'r2' }]
    reviewRepository.getAllReviews.mockResolvedValueOnce(reviews)
    reviewRepository.getReviewCount.mockResolvedValueOnce(2)
    formatReviewForList.mockImplementation((r) => ({ ...r, listed: true }))
    const req = createMockRequest({ query: {} })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        reviews: expect.arrayContaining([
          expect.objectContaining({ id: 'r1' })
        ]),
        pagination: expect.objectContaining({ total: 2 })
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.OK)
  })

  it('uses default limit and skip when query params are absent', async () => {
    reviewRepository.getAllReviews.mockResolvedValueOnce([])
    reviewRepository.getReviewCount.mockResolvedValueOnce(0)
    const req = createMockRequest({ query: {} })
    const h = createMockH()

    await handler(req, h)

    expect(reviewRepository.getAllReviews).toHaveBeenCalledWith(
      DEFAULT_LIMIT,
      DEFAULT_SKIP,
      null
    )
  })

  it('passes userId from query param', async () => {
    reviewRepository.getAllReviews.mockResolvedValueOnce([])
    reviewRepository.getReviewCount.mockResolvedValueOnce(0)
    const req = createMockRequest({ query: { userId: 'user-99' } })
    const h = createMockH()

    await handler(req, h)

    expect(reviewRepository.getAllReviews).toHaveBeenCalledWith(
      DEFAULT_LIMIT,
      DEFAULT_SKIP,
      'user-99'
    )
  })

  it('uses provided limit and skip values from query params', async () => {
    reviewRepository.getAllReviews.mockResolvedValueOnce([])
    reviewRepository.getReviewCount.mockResolvedValueOnce(0)
    const req = createMockRequest({
      query: { limit: String(TEST_QUERY_LIMIT), skip: String(TEST_QUERY_SKIP) }
    })
    const h = createMockH()

    await handler(req, h)

    expect(reviewRepository.getAllReviews).toHaveBeenCalledWith(
      TEST_QUERY_LIMIT,
      TEST_QUERY_SKIP,
      null
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.OK)
  })
})

describe('handleGetAllReviews - error handling', () => {
  let handler

  beforeEach(() => {
    vi.resetAllMocks()
    getCorsConfig.mockReturnValue({ origin: ['*'], credentials: true })
    handler = getHandler('GET', '/api/reviews')
  })

  it('returns 500 when repository throws', async () => {
    reviewRepository.getAllReviews.mockRejectedValueOnce(
      new Error('DB failure')
    )
    const req = createMockRequest({ query: {} })
    const h = createMockH()

    await handler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    )
  })
})

// ============ handleDeleteReview ============

describe('handleDeleteReview - success', () => {
  let handler

  beforeEach(() => {
    vi.resetAllMocks()
    getCorsConfig.mockReturnValue({ origin: ['*'], credentials: true })
    handler = getHandler('DELETE', '/api/reviews/{reviewId}')
  })

  it('returns 200 with deletion info on success', async () => {
    reviewRepository.deleteReview.mockResolvedValueOnce({
      reviewId: 'rev-del',
      fileName: 'doc.pdf',
      deletedKeys: ['key1', 'key2'],
      deletedCount: 2
    })
    const req = createMockRequest({ params: { reviewId: 'rev-del' } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        reviewId: 'rev-del',
        deletedCount: 2
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.OK)
  })

  it('uses reviewId in message when result has no fileName', async () => {
    reviewRepository.deleteReview.mockResolvedValueOnce({
      reviewId: 'rev-no-name',
      fileName: undefined,
      deletedKeys: ['key1'],
      deletedCount: 1
    })
    const req = createMockRequest({ params: { reviewId: 'rev-no-name' } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        message: 'Review "rev-no-name" deleted successfully'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.OK)
  })
})

describe('handleDeleteReview - error handling', () => {
  let handler

  beforeEach(() => {
    vi.resetAllMocks()
    getCorsConfig.mockReturnValue({ origin: ['*'], credentials: true })
    handler = getHandler('DELETE', '/api/reviews/{reviewId}')
  })

  it('returns 404 when delete throws not-found error', async () => {
    reviewRepository.deleteReview.mockRejectedValueOnce(
      new Error('Review not found')
    )
    const req = createMockRequest({ params: { reviewId: 'rev-missing' } })
    const h = createMockH()

    await handler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS.NOT_FOUND)
  })

  it('returns 500 for other delete errors', async () => {
    reviewRepository.deleteReview.mockRejectedValueOnce(
      new Error('Unexpected DB failure')
    )
    const req = createMockRequest({ params: { reviewId: 'rev-err' } })
    const h = createMockH()

    await handler(req, h)

    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    )
  })

  it('includes reviewId in error response', async () => {
    reviewRepository.deleteReview.mockRejectedValueOnce(new Error('Some error'))
    const req = createMockRequest({ params: { reviewId: 'rev-x' } })
    const h = createMockH()

    await handler(req, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, reviewId: 'rev-x' })
    )
  })
})
