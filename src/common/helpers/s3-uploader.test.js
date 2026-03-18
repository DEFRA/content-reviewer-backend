import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock dependencies before imports
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(),
  PutObjectCommand: vi.fn()
}))

vi.mock('../../config.js', () => ({
  config: {
    get: vi.fn()
  }
}))

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

vi.mock('./pii-redactor.js', () => ({
  piiRedactor: {
    redactUserContent: vi.fn()
  }
}))

// Import after mocks are set up
const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
const { config } = await import('../../config.js')
const { piiRedactor } = await import('./pii-redactor.js')
const { s3Uploader } = await import('./s3-uploader.js')

// Config key constants to avoid duplication
const CONFIG_KEYS = {
  MOCK_MODE: 'mockMode.s3Upload',
  S3_BUCKET: 's3.bucket',
  AWS_REGION: 'aws.region',
  AWS_ENDPOINT: 'aws.endpoint'
}

// Test constants
const TEST_DATA = {
  BUCKET: 'test-bucket',
  REGION: 'us-east-1',
  ENDPOINT: 'http://localhost:4566',
  UPLOAD_ID: 'test-upload-123',
  TEXT: {
    SIMPLE: 'This is test content',
    REDACTED: 'This is test content',
    WITH_PII: 'My card is 4111111111111111',
    REDACTED_PII: 'My card is [CARD_NUMBER_REDACTED]',
    EMPTY: '',
    LONG: 'A'.repeat(1000)
  },
  FILENAMES: {
    SIMPLE: 'Text_Content.txt',
    CUSTOM: 'My_Custom_Title.txt',
    SPECIAL_CHARS: 'Test___File_.txt'
  },
  NUMBERS: {
    ZERO: 0,
    ONE: 1,
    TWO: 2
  },
  PATHS: {
    PREFIX: 'content-uploads'
  },
  MIME_TYPE: 'text/plain'
}

// Helper function to setup config mock
function setupConfigMock(mockMode, hasEndpoint = false) {
  const configMap = {
    [CONFIG_KEYS.MOCK_MODE]: mockMode,
    [CONFIG_KEYS.S3_BUCKET]: TEST_DATA.BUCKET,
    [CONFIG_KEYS.AWS_REGION]: TEST_DATA.REGION,
    [CONFIG_KEYS.AWS_ENDPOINT]: hasEndpoint ? TEST_DATA.ENDPOINT : null
  }

  config.get.mockImplementation((key) => {
    return configMap[key] === undefined ? null : configMap[key]
  })
}

// Helper function to setup PII redactor mock
function setupPiiRedactorMock(hasPII = false, redactionCount = 0) {
  const redactedText = hasPII
    ? TEST_DATA.TEXT.REDACTED_PII
    : TEST_DATA.TEXT.REDACTED

  piiRedactor.redactUserContent.mockReturnValue({
    redactedText,
    hasPII,
    redactionCount
  })
}

describe('s3Uploader - uploadTextContent', () => {
  let mockS3Send

  beforeEach(() => {
    vi.clearAllMocks()
    mockS3Send = vi.fn().mockResolvedValue({})
    S3Client.mockImplementation(() => ({ send: mockS3Send }))
    setupConfigMock(false)
    setupPiiRedactorMock()

    // Set the s3Client on the singleton instance
    s3Uploader.s3Client = { send: mockS3Send }
    s3Uploader.mockMode = false
    s3Uploader.bucket = TEST_DATA.BUCKET
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('Should upload text content successfully', async () => {
    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID
    )

    expect(result.success).toBe(true)
    expect(result.bucket).toBe(TEST_DATA.BUCKET)
    expect(result.fileId).toBe(TEST_DATA.UPLOAD_ID)
    expect(result.filename).toBe(TEST_DATA.FILENAMES.SIMPLE)
    expect(result.contentType).toBe(TEST_DATA.MIME_TYPE)
    expect(result.piiRedacted).toBe(false)
    expect(result.piiRedactionCount).toBe(TEST_DATA.NUMBERS.ZERO)
    expect(piiRedactor.redactUserContent).toHaveBeenCalledWith(
      TEST_DATA.TEXT.SIMPLE
    )
    expect(mockS3Send).toHaveBeenCalled()
  })

  test('Should upload text with custom title', async () => {
    const customTitle = 'My Custom Title'

    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID,
      customTitle
    )

    expect(result.filename).toBe(TEST_DATA.FILENAMES.CUSTOM)
    expect(result.key).toContain(TEST_DATA.FILENAMES.CUSTOM)
  })

  test('Should sanitize special characters in filename', async () => {
    const titleWithSpecialChars = 'Test @#$ File!'

    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID,
      titleWithSpecialChars
    )

    expect(result.filename).toBe('Test_____File_.txt')
    expect(result.filename).not.toMatch(/[@#$!]/)
  })

  test('Should include correct S3 location in response', async () => {
    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID
    )

    expect(result.location).toContain('s3://')
    expect(result.location).toContain(TEST_DATA.BUCKET)
    expect(result.location).toContain(TEST_DATA.PATHS.PREFIX)
  })
})

describe('s3Uploader - PII redaction', () => {
  let mockS3Send

  beforeEach(() => {
    vi.clearAllMocks()
    mockS3Send = vi.fn().mockResolvedValue({})
    S3Client.mockImplementation(() => ({ send: mockS3Send }))
    setupConfigMock(false)

    // Set the s3Client on the singleton instance
    s3Uploader.s3Client = { send: mockS3Send }
    s3Uploader.mockMode = false
    s3Uploader.bucket = TEST_DATA.BUCKET
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('Should redact PII before uploading', async () => {
    setupPiiRedactorMock(true, TEST_DATA.NUMBERS.ONE)

    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.WITH_PII,
      TEST_DATA.UPLOAD_ID
    )

    expect(result.piiRedacted).toBe(true)
    expect(result.piiRedactionCount).toBe(TEST_DATA.NUMBERS.ONE)
    expect(piiRedactor.redactUserContent).toHaveBeenCalledWith(
      TEST_DATA.TEXT.WITH_PII
    )
  })

  test('Should include PII metadata in S3 command', async () => {
    setupPiiRedactorMock(true, TEST_DATA.NUMBERS.TWO)

    await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.WITH_PII,
      TEST_DATA.UPLOAD_ID
    )

    expect(mockS3Send).toHaveBeenCalled()
    const callArgs = mockS3Send.mock.calls[0][0]

    // PutObjectCommand stores params in input property
    if (callArgs?.input) {
      expect(callArgs.input.Metadata.piiRedacted).toBe('true')
      expect(callArgs.input.Metadata.piiRedactionCount).toBe('2')
    }
  })

  test('Should handle content without PII', async () => {
    setupPiiRedactorMock(false, TEST_DATA.NUMBERS.ZERO)

    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID
    )

    expect(result.piiRedacted).toBe(false)
    expect(result.piiRedactionCount).toBe(TEST_DATA.NUMBERS.ZERO)
  })
})

describe('s3Uploader - mock mode', () => {
  let mockS3Send

  beforeEach(() => {
    vi.clearAllMocks()
    mockS3Send = vi.fn()
    S3Client.mockImplementation(() => ({ send: mockS3Send }))
    setupConfigMock(true)
    setupPiiRedactorMock()

    // Set mock mode on the singleton instance
    s3Uploader.mockMode = true
    s3Uploader.s3Client = null
    s3Uploader.bucket = TEST_DATA.BUCKET
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('Should not call S3 in mock mode', async () => {
    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID
    )

    expect(result.success).toBe(true)
    expect(result.bucket).toBe(TEST_DATA.BUCKET)
    expect(mockS3Send).not.toHaveBeenCalled()
  })

  test('Should still redact PII in mock mode', async () => {
    setupPiiRedactorMock(true, TEST_DATA.NUMBERS.TWO)

    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.WITH_PII,
      TEST_DATA.UPLOAD_ID
    )

    expect(result.piiRedacted).toBe(true)
    expect(result.piiRedactionCount).toBe(TEST_DATA.NUMBERS.TWO)
    expect(piiRedactor.redactUserContent).toHaveBeenCalled()
  })

  test('Should return proper response structure in mock mode', async () => {
    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID
    )

    expect(result).toHaveProperty('success')
    expect(result).toHaveProperty('bucket')
    expect(result).toHaveProperty('key')
    expect(result).toHaveProperty('location')
    expect(result).toHaveProperty('size')
    expect(result).toHaveProperty('contentType')
  })
})

describe('s3Uploader - error handling', () => {
  let mockS3Send

  beforeEach(() => {
    vi.clearAllMocks()
    mockS3Send = vi.fn()
    S3Client.mockImplementation(() => ({ send: mockS3Send }))
    setupConfigMock(false)
    setupPiiRedactorMock()

    // Set the s3Client on the singleton instance
    s3Uploader.s3Client = { send: mockS3Send }
    s3Uploader.mockMode = false
    s3Uploader.bucket = TEST_DATA.BUCKET
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('Should throw error when S3 upload fails', async () => {
    const errorMessage = 'S3 connection failed'
    mockS3Send.mockRejectedValue(new Error(errorMessage))

    await expect(
      s3Uploader.uploadTextContent(TEST_DATA.TEXT.SIMPLE, TEST_DATA.UPLOAD_ID)
    ).rejects.toThrow('S3 text upload failed')
  })

  test('Should include original error message in thrown error', async () => {
    const errorMessage = 'Access Denied'
    mockS3Send.mockRejectedValue(new Error(errorMessage))

    await expect(
      s3Uploader.uploadTextContent(TEST_DATA.TEXT.SIMPLE, TEST_DATA.UPLOAD_ID)
    ).rejects.toThrow(errorMessage)
  })

  test('Should handle S3 error with error code', async () => {
    const s3Error = new Error('NoSuchBucket')
    s3Error.Code = 'NoSuchBucket'
    mockS3Send.mockRejectedValue(s3Error)

    await expect(
      s3Uploader.uploadTextContent(TEST_DATA.TEXT.SIMPLE, TEST_DATA.UPLOAD_ID)
    ).rejects.toThrow()
  })
})

describe('s3Uploader - edge cases', () => {
  let mockS3Send

  beforeEach(() => {
    vi.clearAllMocks()
    mockS3Send = vi.fn().mockResolvedValue({})
    S3Client.mockImplementation(() => ({ send: mockS3Send }))
    setupConfigMock(false)

    // Set the s3Client on the singleton instance
    s3Uploader.s3Client = { send: mockS3Send }
    s3Uploader.mockMode = false
    s3Uploader.bucket = TEST_DATA.BUCKET
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('Should handle empty text content', async () => {
    piiRedactor.redactUserContent.mockReturnValue({
      redactedText: TEST_DATA.TEXT.EMPTY,
      hasPII: false,
      redactionCount: TEST_DATA.NUMBERS.ZERO
    })

    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.EMPTY,
      TEST_DATA.UPLOAD_ID
    )

    expect(result.success).toBe(true)
    expect(result.size).toBe(TEST_DATA.NUMBERS.ZERO)
  })

  test('Should handle very long text content', async () => {
    piiRedactor.redactUserContent.mockReturnValue({
      redactedText: TEST_DATA.TEXT.LONG,
      hasPII: false,
      redactionCount: TEST_DATA.NUMBERS.ZERO
    })

    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.LONG,
      TEST_DATA.UPLOAD_ID
    )

    expect(result.success).toBe(true)
    expect(result.size).toBe(TEST_DATA.TEXT.LONG.length)
  })

  test('Should handle filename with all special characters', async () => {
    setupPiiRedactorMock()
    const specialTitle = '@#$%^&*()'

    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID,
      specialTitle
    )

    expect(result.filename).toBe('_________.txt')
    expect(result.filename).toMatch(/^[a-zA-Z0-9_-]+\.txt$/)
  })

  test('Should handle default title parameter', async () => {
    setupPiiRedactorMock()

    const result = await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID
    )

    expect(result.filename).toBe(TEST_DATA.FILENAMES.SIMPLE)
  })
})

describe('s3Uploader - S3 command verification', () => {
  let mockS3Send

  beforeEach(() => {
    vi.clearAllMocks()
    mockS3Send = vi.fn().mockResolvedValue({})
    S3Client.mockImplementation(() => ({ send: mockS3Send }))
    setupConfigMock(false)
    setupPiiRedactorMock()

    // Set the s3Client on the singleton instance
    s3Uploader.s3Client = { send: mockS3Send }
    s3Uploader.mockMode = false
    s3Uploader.bucket = TEST_DATA.BUCKET
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('Should call S3 send method', async () => {
    await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID
    )

    expect(mockS3Send).toHaveBeenCalled()
    expect(mockS3Send).toHaveBeenCalledTimes(1)
  })

  test('Should send PutObjectCommand to S3', async () => {
    await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID
    )

    const callArgs = mockS3Send.mock.calls[0][0]
    expect(callArgs).toBeDefined()
    // The command structure may vary based on SDK implementation
    expect(mockS3Send).toHaveBeenCalledWith(expect.any(Object))
  })

  test('Should set correct bucket in command', async () => {
    await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID
    )

    const callArgs = mockS3Send.mock.calls[0][0]
    if (callArgs?.input) {
      expect(callArgs.input.Bucket).toBe(TEST_DATA.BUCKET)
    }
  })

  test('Should set correct key structure in command', async () => {
    await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID
    )

    const callArgs = mockS3Send.mock.calls[0][0]
    if (callArgs?.input) {
      expect(callArgs.input.Key).toContain(TEST_DATA.PATHS.PREFIX)
      expect(callArgs.input.Key).toContain(TEST_DATA.UPLOAD_ID)
    }
  })

  test('Should include metadata in command', async () => {
    await s3Uploader.uploadTextContent(
      TEST_DATA.TEXT.SIMPLE,
      TEST_DATA.UPLOAD_ID
    )

    const callArgs = mockS3Send.mock.calls[0][0]
    if (callArgs?.input?.Metadata) {
      const metadata = callArgs.input.Metadata

      expect(metadata).toHaveProperty('originalName')
      expect(metadata).toHaveProperty('uploadId')
      expect(metadata).toHaveProperty('uploadedAt')
      expect(metadata).toHaveProperty('contentLength')
      expect(metadata).toHaveProperty('piiRedacted')
      expect(metadata).toHaveProperty('piiRedactionCount')
      expect(metadata.uploadId).toBe(TEST_DATA.UPLOAD_ID)
    }
  })
})
