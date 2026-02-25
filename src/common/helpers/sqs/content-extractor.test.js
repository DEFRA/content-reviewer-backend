import { describe, test, expect, beforeEach, vi } from 'vitest'

// Test constants to avoid magic strings/numbers
const TEST_REVIEW_ID = 'review-123'
const TEST_BUCKET = 'test-bucket'
const TEST_KEY = 'test-key'
const TEST_S3_KEY_PDF = 'uploads/document.pdf'
const TEST_S3_KEY_DOCX = 'uploads/document.docx'
const TEST_S3_KEY_TXT = 'uploads/document.txt'
const TEST_CONTENT_TYPE_PDF = 'application/pdf'
const TEST_CONTENT_TYPE_DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const TEST_CONTENT_TYPE_TEXT = 'text/plain'
const TEST_FILENAME_PDF = 'test.pdf'
const TEST_FILENAME_DOCX = 'test.docx'
const TEST_FILENAME_TXT = 'test.txt'
const TEST_TEXT_CONTENT = 'This is test content'
const TEST_TEXT_EXTRACTED = 'Extracted text content'
const TEST_TEXT_HELLO = 'Hello World Test'
const TEST_WORD_COUNT_THREE = 3
const TEST_WORD_COUNT_FOUR = 4
const TEST_WORD_COUNT_TWENTY = 20
const TEST_AWS_REGION = 'us-east-1'
const TEST_AWS_ENDPOINT = 'http://localhost:4566'
const TEST_ERROR_MESSAGE = 'S3 download failed'
const TEST_ERROR_EXTRACT = 'Text extraction failed'

// Mock functions
const mockS3Send = vi.fn()
const mockLoggerInfo = vi.fn()
const mockLoggerError = vi.fn()
const mockExtractText = vi.fn()
const mockCountWords = vi.fn()

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: mockS3Send }
  }),
  GetObjectCommand: vi.fn(function (params) {
    return params
  })
}))

vi.mock('../../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const configValues = {
        'aws.region': TEST_AWS_REGION,
        'aws.endpoint': TEST_AWS_ENDPOINT
      }
      return configValues[key]
    })
  }
}))

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: (...args) => mockLoggerInfo(...args),
    error: (...args) => mockLoggerError(...args)
  })
}))

vi.mock('../text-extractor.js', () => ({
  textExtractor: {
    extractText: (...args) => mockExtractText(...args),
    countWords: (...args) => mockCountWords(...args)
  }
}))

import { ContentExtractor } from './content-extractor.js'

function createMockAsyncBody(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk
      }
    }
  }
}

function createTestMessageBody(s3Key, contentType, filename) {
  return {
    s3Bucket: TEST_BUCKET,
    s3Key,
    contentType,
    filename
  }
}

describe('ContentExtractor - Initialization', () => {
  let extractor

  beforeEach(() => {
    vi.clearAllMocks()
    extractor = new ContentExtractor()
  })

  test('should initialize with S3 client', () => {
    expect(extractor.s3Client).toBeDefined()
  })
})

describe('ContentExtractor - downloadFromS3', () => {
  let extractor

  beforeEach(() => {
    vi.clearAllMocks()
    extractor = new ContentExtractor()
  })

  test('should download file from S3 successfully', async () => {
    const mockChunks = [Buffer.from(TEST_TEXT_CONTENT)]
    const mockBody = createMockAsyncBody(mockChunks)
    mockS3Send.mockResolvedValueOnce({ Body: mockBody })

    const result = await extractor.downloadFromS3(TEST_BUCKET, TEST_KEY)

    expect(result).toBeInstanceOf(Buffer)
    expect(result.toString()).toBe(TEST_TEXT_CONTENT)
    expect(mockS3Send).toHaveBeenCalledTimes(1)
  })

  test('should handle multiple chunks from S3', async () => {
    const chunk1 = Buffer.from('Hello ')
    const chunk2 = Buffer.from('World')
    const mockChunks = [chunk1, chunk2]
    const mockBody = createMockAsyncBody(mockChunks)
    mockS3Send.mockResolvedValueOnce({ Body: mockBody })

    const result = await extractor.downloadFromS3(TEST_BUCKET, TEST_KEY)

    expect(result.toString()).toBe('Hello World')
  })

  test('should throw error when S3 download fails', async () => {
    mockS3Send.mockRejectedValueOnce(new Error(TEST_ERROR_MESSAGE))

    await expect(
      extractor.downloadFromS3(TEST_BUCKET, TEST_KEY)
    ).rejects.toThrow(TEST_ERROR_MESSAGE)
  })
})

describe('ContentExtractor - extractTextFromFile - successful extraction', () => {
  let extractor

  beforeEach(() => {
    vi.clearAllMocks()
    extractor = new ContentExtractor()
  })

  test('should extract text from PDF file', async () => {
    const messageBody = createTestMessageBody(
      TEST_S3_KEY_PDF,
      TEST_CONTENT_TYPE_PDF,
      TEST_FILENAME_PDF
    )
    const mockChunks = [Buffer.from(TEST_TEXT_CONTENT)]
    const mockBody = createMockAsyncBody(mockChunks)

    mockS3Send.mockResolvedValueOnce({ Body: mockBody })
    mockExtractText.mockResolvedValueOnce(TEST_TEXT_EXTRACTED)
    mockCountWords.mockReturnValueOnce(TEST_WORD_COUNT_THREE)

    const result = await extractor.extractTextFromFile(
      TEST_REVIEW_ID,
      messageBody
    )

    expect(result).toBe(TEST_TEXT_EXTRACTED)
    expect(mockExtractText).toHaveBeenCalledWith(
      expect.any(Buffer),
      TEST_CONTENT_TYPE_PDF,
      TEST_FILENAME_PDF
    )
    expect(mockCountWords).toHaveBeenCalledWith(TEST_TEXT_EXTRACTED)
  })

  test('should log extraction details', async () => {
    const messageBody = createTestMessageBody(
      TEST_S3_KEY_PDF,
      TEST_CONTENT_TYPE_PDF,
      TEST_FILENAME_PDF
    )
    const mockChunks = [Buffer.from(TEST_TEXT_CONTENT)]
    const mockBody = createMockAsyncBody(mockChunks)

    mockS3Send.mockResolvedValueOnce({ Body: mockBody })
    mockExtractText.mockResolvedValueOnce(TEST_TEXT_EXTRACTED)
    mockCountWords.mockReturnValueOnce(TEST_WORD_COUNT_THREE)

    await extractor.extractTextFromFile(TEST_REVIEW_ID, messageBody)

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID
      }),
      expect.any(String)
    )
  })

  test('should extract text from DOCX file', async () => {
    const messageBody = createTestMessageBody(
      TEST_S3_KEY_DOCX,
      TEST_CONTENT_TYPE_DOCX,
      TEST_FILENAME_DOCX
    )
    const mockChunks = [Buffer.from(TEST_TEXT_CONTENT)]
    const mockBody = createMockAsyncBody(mockChunks)

    mockS3Send.mockResolvedValueOnce({ Body: mockBody })
    mockExtractText.mockResolvedValueOnce(TEST_TEXT_HELLO)
    mockCountWords.mockReturnValueOnce(TEST_WORD_COUNT_THREE)

    const result = await extractor.extractTextFromFile(
      TEST_REVIEW_ID,
      messageBody
    )

    expect(result).toBe(TEST_TEXT_HELLO)
    expect(mockExtractText).toHaveBeenCalledWith(
      expect.any(Buffer),
      TEST_CONTENT_TYPE_DOCX,
      TEST_FILENAME_DOCX
    )
  })
})

describe('ContentExtractor - extractTextFromFile - error handling', () => {
  let extractor

  beforeEach(() => {
    vi.clearAllMocks()
    extractor = new ContentExtractor()
  })

  test('should throw error when download fails', async () => {
    const messageBody = createTestMessageBody(
      TEST_S3_KEY_PDF,
      TEST_CONTENT_TYPE_PDF,
      TEST_FILENAME_PDF
    )
    mockS3Send.mockRejectedValueOnce(new Error(TEST_ERROR_MESSAGE))

    await expect(
      extractor.extractTextFromFile(TEST_REVIEW_ID, messageBody)
    ).rejects.toThrow(TEST_ERROR_MESSAGE)
  })

  test('should throw error when text extraction fails', async () => {
    const messageBody = createTestMessageBody(
      TEST_S3_KEY_PDF,
      TEST_CONTENT_TYPE_PDF,
      TEST_FILENAME_PDF
    )
    const mockChunks = [Buffer.from(TEST_TEXT_CONTENT)]
    const mockBody = createMockAsyncBody(mockChunks)

    mockS3Send.mockResolvedValueOnce({ Body: mockBody })
    mockExtractText.mockRejectedValueOnce(new Error(TEST_ERROR_EXTRACT))

    await expect(
      extractor.extractTextFromFile(TEST_REVIEW_ID, messageBody)
    ).rejects.toThrow(TEST_ERROR_EXTRACT)
  })
})

describe('ContentExtractor - extractTextContent', () => {
  let extractor

  beforeEach(() => {
    vi.clearAllMocks()
    extractor = new ContentExtractor()
  })

  test('should route to extractTextFromFile for file_review message type', async () => {
    const messageBody = {
      messageType: 'file_review',
      s3Bucket: TEST_BUCKET,
      s3Key: TEST_S3_KEY_PDF,
      contentType: TEST_CONTENT_TYPE_PDF,
      filename: TEST_FILENAME_PDF
    }
    const mockChunks = [Buffer.from(TEST_TEXT_CONTENT)]
    const mockBody = createMockAsyncBody(mockChunks)

    mockS3Send.mockResolvedValueOnce({ Body: mockBody })
    mockExtractText.mockResolvedValueOnce(TEST_TEXT_EXTRACTED)
    mockCountWords.mockReturnValueOnce(TEST_WORD_COUNT_THREE)

    const result = await extractor.extractTextContent(
      TEST_REVIEW_ID,
      messageBody
    )

    expect(result).toBe(TEST_TEXT_EXTRACTED)
    expect(mockExtractText).toHaveBeenCalled()
  })

  test('should route to extractTextFromS3 for text_review message type', async () => {
    const messageBody = {
      messageType: 'text_review',
      s3Bucket: TEST_BUCKET,
      s3Key: TEST_S3_KEY_TXT
    }
    const mockChunks = [Buffer.from(TEST_TEXT_CONTENT)]
    const mockBody = createMockAsyncBody(mockChunks)

    mockS3Send.mockResolvedValueOnce({ Body: mockBody })

    const result = await extractor.extractTextContent(
      TEST_REVIEW_ID,
      messageBody
    )

    expect(result).toBe(TEST_TEXT_CONTENT)
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID
      }),
      expect.stringContaining('S3 text content')
    )
  })

  test('should throw error for unknown message type', async () => {
    const messageBody = {
      messageType: 'unknown_type',
      s3Bucket: TEST_BUCKET,
      s3Key: TEST_S3_KEY_TXT
    }

    await expect(
      extractor.extractTextContent(TEST_REVIEW_ID, messageBody)
    ).rejects.toThrow('Unknown message type: unknown_type')
  })
})

describe('ContentExtractor - extractTextFromS3', () => {
  let extractor

  beforeEach(() => {
    vi.clearAllMocks()
    extractor = new ContentExtractor()
  })

  test('should extract text content from S3 successfully', async () => {
    const messageBody = {
      s3Bucket: TEST_BUCKET,
      s3Key: TEST_S3_KEY_TXT
    }
    const mockChunks = [Buffer.from(TEST_TEXT_CONTENT)]
    const mockBody = createMockAsyncBody(mockChunks)

    mockS3Send.mockResolvedValueOnce({ Body: mockBody })

    const result = await extractor.extractTextFromS3(
      TEST_REVIEW_ID,
      messageBody
    )

    expect(result).toBe(TEST_TEXT_CONTENT)
    expect(mockS3Send).toHaveBeenCalledTimes(1)
  })

  test('should log download start and completion', async () => {
    const messageBody = {
      s3Bucket: TEST_BUCKET,
      s3Key: TEST_S3_KEY_TXT
    }
    const mockChunks = [Buffer.from(TEST_TEXT_CONTENT)]
    const mockBody = createMockAsyncBody(mockChunks)

    mockS3Send.mockResolvedValueOnce({ Body: mockBody })

    await extractor.extractTextFromS3(TEST_REVIEW_ID, messageBody)

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID,
        s3Bucket: TEST_BUCKET,
        s3Key: TEST_S3_KEY_TXT
      }),
      'S3 text content download started'
    )
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: TEST_REVIEW_ID,
        contentLength: TEST_TEXT_CONTENT.length
      }),
      expect.stringContaining('S3 text content downloaded')
    )
  })

  test('should handle large text content from S3', async () => {
    const largeTextContent = 'word '.repeat(TEST_WORD_COUNT_TWENTY)
    const messageBody = {
      s3Bucket: TEST_BUCKET,
      s3Key: TEST_S3_KEY_TXT
    }
    const mockChunks = [Buffer.from(largeTextContent)]
    const mockBody = createMockAsyncBody(mockChunks)

    mockS3Send.mockResolvedValueOnce({ Body: mockBody })

    const result = await extractor.extractTextFromS3(
      TEST_REVIEW_ID,
      messageBody
    )

    expect(result).toBe(largeTextContent)
    expect(result.length).toBeGreaterThan(TEST_TEXT_CONTENT.length)
  })

  test('should throw error when S3 download fails', async () => {
    const messageBody = {
      s3Bucket: TEST_BUCKET,
      s3Key: TEST_S3_KEY_TXT
    }

    mockS3Send.mockRejectedValueOnce(new Error(TEST_ERROR_MESSAGE))

    await expect(
      extractor.extractTextFromS3(TEST_REVIEW_ID, messageBody)
    ).rejects.toThrow(TEST_ERROR_MESSAGE)
  })
})
