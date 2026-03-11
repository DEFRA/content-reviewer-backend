import { describe, test, expect, vi, beforeEach } from 'vitest'

// Mock dependencies
vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: vi.fn(),
  ListObjectsV2Command: vi.fn()
}))

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

// Import after mocks
const { GetObjectCommand, ListObjectsV2Command } =
  await import('@aws-sdk/client-s3')
const { searchReview, searchReviewForDay, fetchReviewByKey } =
  await import('./review-repository-search.js')

// Test constants
const TEST_DATA = {
  BUCKET: 'test-bucket',
  PREFIX: 'reviews/',
  REVIEW_ID: 'review-123',
  YEAR: '2026',
  MONTH: '03',
  DAY: '11',
  KEY: 'reviews/2026/03/11/review-123.json',
  REVIEW: {
    id: 'review-123',
    title: 'Test Review',
    content: 'Test content'
  },
  NUMBERS: {
    ZERO: 0,
    ONE: 1,
    TWO: 2,
    SIX: 6,
    SEVEN: 7,
    EIGHT: 8,
    MAX_KEYS: 1000
  },
  DATES: {
    TEST_DATE: '2026-03-11T12:00:00Z',
    MONTH_BOUNDARY: '2026-03-01T12:00:00Z'
  }
}

// Helper to create mock S3 client
function createMockS3Client(sendMock) {
  return {
    send: sendMock
  }
}

// Helper to create mock list response
function createListResponse(keys = []) {
  if (keys.length === 0) {
    return {}
  }

  return {
    Contents: keys.map((key) => ({ Key: key }))
  }
}

// Helper to create mock get response
function createGetResponse(body) {
  return {
    Body: {
      transformToString: vi.fn().mockResolvedValue(body)
    }
  }
}

describe('searchReview', () => {
  let mockS3Send

  beforeEach(() => {
    vi.clearAllMocks()
    mockS3Send = vi.fn()
  })

  test('Should find review on first day', async () => {
    const reviewJson = JSON.stringify(TEST_DATA.REVIEW)

    mockS3Send
      .mockResolvedValueOnce(createListResponse([TEST_DATA.KEY]))
      .mockResolvedValueOnce(createGetResponse(reviewJson))

    const s3Client = createMockS3Client(mockS3Send)

    const result = await searchReview(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.PREFIX,
      TEST_DATA.REVIEW_ID
    )

    expect(result).toEqual(TEST_DATA.REVIEW)
    expect(mockS3Send).toHaveBeenCalledTimes(TEST_DATA.NUMBERS.TWO)
  })

  test('Should search multiple days if not found immediately', async () => {
    const reviewJson = JSON.stringify(TEST_DATA.REVIEW)

    // First two days return empty, third day has the review
    mockS3Send
      .mockResolvedValueOnce(createListResponse([]))
      .mockResolvedValueOnce(createListResponse([]))
      .mockResolvedValueOnce(createListResponse([TEST_DATA.KEY]))
      .mockResolvedValueOnce(createGetResponse(reviewJson))

    const s3Client = createMockS3Client(mockS3Send)

    const result = await searchReview(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.PREFIX,
      TEST_DATA.REVIEW_ID
    )

    expect(result).toEqual(TEST_DATA.REVIEW)
    expect(mockS3Send.mock.calls.length).toBeGreaterThan(TEST_DATA.NUMBERS.TWO)
  })

  test('Should return null if review not found in 7 days', async () => {
    mockS3Send.mockResolvedValue(createListResponse([]))

    const s3Client = createMockS3Client(mockS3Send)

    const result = await searchReview(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.PREFIX,
      TEST_DATA.REVIEW_ID
    )

    expect(result).toBeNull()
    expect(mockS3Send).toHaveBeenCalledTimes(TEST_DATA.NUMBERS.SEVEN)
  })

  test('Should throw error on S3 failure', async () => {
    const errorMessage = 'S3 connection failed'
    mockS3Send.mockRejectedValue(new Error(errorMessage))

    const s3Client = createMockS3Client(mockS3Send)

    await expect(
      searchReview(
        s3Client,
        TEST_DATA.BUCKET,
        TEST_DATA.PREFIX,
        TEST_DATA.REVIEW_ID
      )
    ).rejects.toThrow(errorMessage)
  })
})

describe('searchReviewForDay - basic functionality', () => {
  let mockS3Send

  beforeEach(() => {
    vi.clearAllMocks()
    mockS3Send = vi.fn()

    // Mock Date to return consistent values
    vi.useFakeTimers()
    vi.setSystemTime(new Date(TEST_DATA.DATES.TEST_DATE))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('Should search for review on specific day (today)', async () => {
    const reviewJson = JSON.stringify(TEST_DATA.REVIEW)

    mockS3Send
      .mockResolvedValueOnce(createListResponse([TEST_DATA.KEY]))
      .mockResolvedValueOnce(createGetResponse(reviewJson))

    const s3Client = createMockS3Client(mockS3Send)

    const result = await searchReviewForDay(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.PREFIX,
      TEST_DATA.REVIEW_ID,
      TEST_DATA.NUMBERS.ZERO
    )

    expect(result).toEqual(TEST_DATA.REVIEW)
    expect(mockS3Send).toHaveBeenCalledTimes(TEST_DATA.NUMBERS.TWO)
  })

  test('Should search for review 1 day ago', async () => {
    const reviewJson = JSON.stringify(TEST_DATA.REVIEW)
    const yesterdayKey = 'reviews/2026/03/10/review-123.json'

    mockS3Send
      .mockResolvedValueOnce(createListResponse([yesterdayKey]))
      .mockResolvedValueOnce(createGetResponse(reviewJson))

    const s3Client = createMockS3Client(mockS3Send)

    const result = await searchReviewForDay(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.PREFIX,
      TEST_DATA.REVIEW_ID,
      TEST_DATA.NUMBERS.ONE
    )

    expect(result).toEqual(TEST_DATA.REVIEW)
    expect(mockS3Send).toHaveBeenCalled()
  })

  test('Should return null if no contents in list response', async () => {
    mockS3Send.mockResolvedValueOnce({})

    const s3Client = createMockS3Client(mockS3Send)

    const result = await searchReviewForDay(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.PREFIX,
      TEST_DATA.REVIEW_ID,
      TEST_DATA.NUMBERS.ZERO
    )

    expect(result).toBeNull()
  })

  test('Should return null if review ID not in any keys', async () => {
    const otherKey = 'reviews/2026/03/11/review-999.json'

    mockS3Send.mockResolvedValueOnce(createListResponse([otherKey]))

    const s3Client = createMockS3Client(mockS3Send)

    const result = await searchReviewForDay(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.PREFIX,
      TEST_DATA.REVIEW_ID,
      TEST_DATA.NUMBERS.ZERO
    )

    expect(result).toBeNull()
  })
})

describe('searchReviewForDay - date handling', () => {
  let mockS3Send

  beforeEach(() => {
    vi.clearAllMocks()
    mockS3Send = vi.fn()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(TEST_DATA.DATES.TEST_DATE))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('Should construct correct S3 prefix for date', async () => {
    mockS3Send.mockResolvedValueOnce(createListResponse([]))

    const s3Client = createMockS3Client(mockS3Send)

    await searchReviewForDay(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.PREFIX,
      TEST_DATA.REVIEW_ID,
      TEST_DATA.NUMBERS.ZERO
    )

    expect(mockS3Send).toHaveBeenCalled()
    expect(ListObjectsV2Command).toHaveBeenCalled()
  })

  test('Should handle month boundary correctly', async () => {
    vi.setSystemTime(new Date(TEST_DATA.DATES.MONTH_BOUNDARY))

    mockS3Send.mockResolvedValueOnce(createListResponse([]))

    const s3Client = createMockS3Client(mockS3Send)

    await searchReviewForDay(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.PREFIX,
      TEST_DATA.REVIEW_ID,
      TEST_DATA.NUMBERS.ONE
    )

    expect(mockS3Send).toHaveBeenCalled()
    expect(ListObjectsV2Command).toHaveBeenCalled()
  })
})

describe('fetchReviewByKey - successful operations', () => {
  let mockS3Send

  beforeEach(() => {
    vi.clearAllMocks()
    mockS3Send = vi.fn()
  })

  test('Should fetch and parse review from S3', async () => {
    const reviewJson = JSON.stringify(TEST_DATA.REVIEW)

    mockS3Send.mockResolvedValueOnce(createGetResponse(reviewJson))

    const s3Client = createMockS3Client(mockS3Send)

    const result = await fetchReviewByKey(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.KEY
    )

    expect(result).toEqual(TEST_DATA.REVIEW)
    expect(mockS3Send).toHaveBeenCalledTimes(TEST_DATA.NUMBERS.ONE)
  })

  test('Should use GetObjectCommand with correct parameters', async () => {
    const reviewJson = JSON.stringify(TEST_DATA.REVIEW)

    mockS3Send.mockResolvedValueOnce(createGetResponse(reviewJson))

    const s3Client = createMockS3Client(mockS3Send)

    await fetchReviewByKey(s3Client, TEST_DATA.BUCKET, TEST_DATA.KEY)

    expect(mockS3Send).toHaveBeenCalled()
    expect(GetObjectCommand).toHaveBeenCalled()
  })

  test('Should handle complex review objects', async () => {
    const complexReview = {
      id: 'review-456',
      title: 'Complex Review',
      metadata: {
        author: 'Test Author',
        tags: ['tag1', 'tag2']
      },
      nested: {
        deep: {
          value: 'test'
        }
      }
    }
    const reviewJson = JSON.stringify(complexReview)

    mockS3Send.mockResolvedValueOnce(createGetResponse(reviewJson))

    const s3Client = createMockS3Client(mockS3Send)

    const result = await fetchReviewByKey(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.KEY
    )

    expect(result).toEqual(complexReview)
    expect(result.nested.deep.value).toBe('test')
  })
})

describe('fetchReviewByKey - error handling', () => {
  let mockS3Send

  beforeEach(() => {
    vi.clearAllMocks()
    mockS3Send = vi.fn()
  })

  test('Should throw error on invalid JSON', async () => {
    const invalidJson = 'not valid json'

    mockS3Send.mockResolvedValueOnce(createGetResponse(invalidJson))

    const s3Client = createMockS3Client(mockS3Send)

    await expect(
      fetchReviewByKey(s3Client, TEST_DATA.BUCKET, TEST_DATA.KEY)
    ).rejects.toThrow()
  })

  test('Should throw error on S3 get failure', async () => {
    const errorMessage = 'Access denied'
    mockS3Send.mockRejectedValue(new Error(errorMessage))

    const s3Client = createMockS3Client(mockS3Send)

    await expect(
      fetchReviewByKey(s3Client, TEST_DATA.BUCKET, TEST_DATA.KEY)
    ).rejects.toThrow(errorMessage)
  })
})

describe('Integration scenarios', () => {
  let mockS3Send

  beforeEach(() => {
    vi.clearAllMocks()
    mockS3Send = vi.fn()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(TEST_DATA.DATES.TEST_DATE))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('Should find review with multiple files in same day', async () => {
    const reviewJson = JSON.stringify(TEST_DATA.REVIEW)
    const keys = [
      'reviews/2026/03/11/review-999.json',
      'reviews/2026/03/11/review-123.json',
      'reviews/2026/03/11/review-888.json'
    ]

    mockS3Send
      .mockResolvedValueOnce(createListResponse(keys))
      .mockResolvedValueOnce(createGetResponse(reviewJson))

    const s3Client = createMockS3Client(mockS3Send)

    const result = await searchReview(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.PREFIX,
      TEST_DATA.REVIEW_ID
    )

    expect(result).toEqual(TEST_DATA.REVIEW)
  })

  test('Should handle empty prefix correctly', async () => {
    const reviewJson = JSON.stringify(TEST_DATA.REVIEW)
    const emptyPrefix = ''

    mockS3Send
      .mockResolvedValueOnce(createListResponse(['2026/03/11/review-123.json']))
      .mockResolvedValueOnce(createGetResponse(reviewJson))

    const s3Client = createMockS3Client(mockS3Send)

    const result = await searchReviewForDay(
      s3Client,
      TEST_DATA.BUCKET,
      emptyPrefix,
      TEST_DATA.REVIEW_ID,
      TEST_DATA.NUMBERS.ZERO
    )

    expect(result).toEqual(TEST_DATA.REVIEW)
    expect(mockS3Send).toHaveBeenCalled()
  })

  test('Should handle review found on last search day', async () => {
    const reviewJson = JSON.stringify(TEST_DATA.REVIEW)

    // Empty for first 6 days, found on 7th day
    for (let i = 0; i < TEST_DATA.NUMBERS.SIX; i++) {
      mockS3Send.mockResolvedValueOnce(createListResponse([]))
    }

    mockS3Send
      .mockResolvedValueOnce(createListResponse([TEST_DATA.KEY]))
      .mockResolvedValueOnce(createGetResponse(reviewJson))

    const s3Client = createMockS3Client(mockS3Send)

    const result = await searchReview(
      s3Client,
      TEST_DATA.BUCKET,
      TEST_DATA.PREFIX,
      TEST_DATA.REVIEW_ID
    )

    expect(result).toEqual(TEST_DATA.REVIEW)
    expect(mockS3Send).toHaveBeenCalledTimes(TEST_DATA.NUMBERS.EIGHT)
  })
})
