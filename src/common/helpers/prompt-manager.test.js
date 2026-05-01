import { describe, test, expect, beforeEach, vi } from 'vitest'

const { mockSendFn } = vi.hoisted(() => ({
  mockSendFn: vi.fn()
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    this.send = mockSendFn
  }),
  GetObjectCommand: vi.fn(function (params) {
    Object.assign(this, params)
    return this
  }),
  PutObjectCommand: vi.fn(function (params) {
    Object.assign(this, params)
    return this
  })
}))

vi.mock('../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const configMap = {
        'aws.region': 'eu-west-2',
        'aws.endpoint': null,
        's3.bucket': 'test-bucket',
        's3.promptKey': 'prompts/system-prompt.md'
      }
      return configMap[key]
    })
  }
}))

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

import { config } from '../../config.js'
import { PromptManager, DEFAULT_SYSTEM_PROMPT } from './prompt-manager.js'

const TEST_CONSTANTS = {
  BUCKET_NAME: 'test-bucket',
  PROMPT_KEY: 'prompts/system-prompt.md',
  AWS_REGION: 'eu-west-2',
  CACHE_TTL: 3600000,
  TEST_PROMPT: 'Test system prompt content',
  CUSTOM_PROMPT: 'Custom prompt for testing',
  LONG_PROMPT_LENGTH: 5000,
  PROMPT_LENGTH: 100,
  ZERO: 0,
  ONE: 1,
  ONE_HOUR: 3600000,
  HALF_HOUR: 1800000
}

const LONG_PROMPT = 'A'.repeat(TEST_CONSTANTS.LONG_PROMPT_LENGTH)

describe('PromptManager - Initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should initialize with correct S3 configuration', () => {
    const manager = new PromptManager()
    expect(manager.bucket).toBe(TEST_CONSTANTS.BUCKET_NAME)
    expect(manager.promptKey).toBe(TEST_CONSTANTS.PROMPT_KEY)
    expect(manager.cacheTTL).toBe(TEST_CONSTANTS.CACHE_TTL)
  })
  test('Should initialize with null cache', () => {
    const manager = new PromptManager()
    expect(manager.cache).toBeNull()
    expect(manager.cacheTimestamp).toBeNull()
  })
})

describe('PromptManager - Upload Prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should upload default prompt to S3', async () => {
    mockSendFn.mockResolvedValueOnce({})
    const manager = new PromptManager()
    const result = await manager.uploadPrompt()
    expect(result).toBe(true)
    expect(mockSendFn).toHaveBeenCalledTimes(TEST_CONSTANTS.ONE)
    const uploadCommand =
      mockSendFn.mock.calls[TEST_CONSTANTS.ZERO][TEST_CONSTANTS.ZERO]
    expect(uploadCommand.Bucket).toBe(TEST_CONSTANTS.BUCKET_NAME)
    expect(uploadCommand.Key).toBe(TEST_CONSTANTS.PROMPT_KEY)
    expect(uploadCommand.Body).toBe(DEFAULT_SYSTEM_PROMPT)
  })
  test('Should upload custom prompt to S3', async () => {
    mockSendFn.mockResolvedValueOnce({})
    const manager = new PromptManager()
    const result = await manager.uploadPrompt(TEST_CONSTANTS.CUSTOM_PROMPT)
    expect(result).toBe(true)
    const uploadCommand =
      mockSendFn.mock.calls[TEST_CONSTANTS.ZERO][TEST_CONSTANTS.ZERO]
    expect(uploadCommand.Body).toBe(TEST_CONSTANTS.CUSTOM_PROMPT)
  })
  test('Should set correct metadata when uploading', async () => {
    mockSendFn.mockResolvedValueOnce({})
    const manager = new PromptManager()
    await manager.uploadPrompt(TEST_CONSTANTS.TEST_PROMPT)
    const uploadCommand =
      mockSendFn.mock.calls[TEST_CONSTANTS.ZERO][TEST_CONSTANTS.ZERO]
    expect(uploadCommand.ContentType).toBe('text/markdown')
    expect(uploadCommand.Metadata).toBeDefined()
    expect(uploadCommand.Metadata.version).toBe('1.0')
    expect(uploadCommand.Metadata.source).toBe('prompt-manager')
  })
  test('Should clear cache after successful upload', async () => {
    mockSendFn.mockResolvedValueOnce({})
    const manager = new PromptManager()
    manager.cache = TEST_CONSTANTS.TEST_PROMPT
    manager.cacheTimestamp = Date.now()
    await manager.uploadPrompt()
    expect(manager.cache).toBeNull()
    expect(manager.cacheTimestamp).toBeNull()
  })
  test('Should throw error when S3 upload fails', async () => {
    const error = new Error('S3 upload failed')
    mockSendFn.mockRejectedValueOnce(error)
    const manager = new PromptManager()
    await expect(manager.uploadPrompt()).rejects.toThrow('S3 upload failed')
  })
})

describe('PromptManager - Get System Prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should fetch prompt from S3 successfully', async () => {
    const mockBody = {
      transformToString: vi.fn().mockResolvedValue(TEST_CONSTANTS.TEST_PROMPT)
    }
    mockSendFn.mockResolvedValueOnce({ Body: mockBody })
    const manager = new PromptManager()
    const result = await manager.getSystemPrompt()
    expect(result).toBe(TEST_CONSTANTS.TEST_PROMPT)
    expect(mockSendFn).toHaveBeenCalledTimes(TEST_CONSTANTS.ONE)
  })
  test('Should cache prompt after fetching from S3', async () => {
    const mockBody = {
      transformToString: vi.fn().mockResolvedValue(TEST_CONSTANTS.TEST_PROMPT)
    }
    mockSendFn.mockResolvedValueOnce({ Body: mockBody })
    const manager = new PromptManager()
    await manager.getSystemPrompt()
    expect(manager.cache).toBe(TEST_CONSTANTS.TEST_PROMPT)
    expect(manager.cacheTimestamp).toBeDefined()
  })
  test('Should use cached prompt when cache is valid', async () => {
    const manager = new PromptManager()
    manager.cache = TEST_CONSTANTS.TEST_PROMPT
    manager.cacheTimestamp = Date.now()
    const result = await manager.getSystemPrompt()
    expect(result).toBe(TEST_CONSTANTS.TEST_PROMPT)
    expect(mockSendFn).not.toHaveBeenCalled()
  })
  test('Should refresh cache when forceRefresh is true', async () => {
    const mockBody = {
      transformToString: vi.fn().mockResolvedValue('New prompt')
    }
    mockSendFn.mockResolvedValueOnce({ Body: mockBody })
    const manager = new PromptManager()
    manager.cache = TEST_CONSTANTS.TEST_PROMPT
    manager.cacheTimestamp = Date.now()
    const result = await manager.getSystemPrompt(true)
    expect(result).toBe('New prompt')
    expect(mockSendFn).toHaveBeenCalledTimes(TEST_CONSTANTS.ONE)
  })
  test('Should refresh cache when TTL expired', async () => {
    const mockBody = {
      transformToString: vi.fn().mockResolvedValue('Updated prompt')
    }
    mockSendFn.mockResolvedValueOnce({ Body: mockBody })
    const manager = new PromptManager()
    manager.cache = TEST_CONSTANTS.TEST_PROMPT
    manager.cacheTimestamp = Date.now() - TEST_CONSTANTS.ONE_HOUR - 1000
    const result = await manager.getSystemPrompt()
    expect(result).toBe('Updated prompt')
    expect(mockSendFn).toHaveBeenCalledTimes(TEST_CONSTANTS.ONE)
  })
  test('Should fall back to default prompt when S3 fails', async () => {
    mockSendFn.mockRejectedValueOnce(new Error('S3 error'))
    const manager = new PromptManager()
    const result = await manager.getSystemPrompt()
    expect(result).toBe(DEFAULT_SYSTEM_PROMPT)
  })
  test('Should fall back to default when S3 returns NoSuchKey error', async () => {
    const error = new Error('NoSuchKey')
    error.name = 'NoSuchKey'
    mockSendFn.mockRejectedValueOnce(error)
    const manager = new PromptManager()
    const result = await manager.getSystemPrompt()
    expect(result).toBe(DEFAULT_SYSTEM_PROMPT)
  })
  test('Should still return default prompt when auto-seed upload also fails after S3 fetch error', async () => {
    // First call: GetObjectCommand fails → fallback path triggered
    // Second call: PutObjectCommand inside auto-seed uploadPrompt() also fails
    mockSendFn
      .mockRejectedValueOnce(new Error('S3 get error'))
      .mockRejectedValueOnce(new Error('S3 put error'))

    const manager = new PromptManager()
    const result = await manager.getSystemPrompt()

    // Should still return the embedded default prompt
    expect(result).toBe(DEFAULT_SYSTEM_PROMPT)

    // Allow the unawaited uploadPrompt().catch() handler to settle
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Both S3 calls were attempted (get + auto-seed put)
    expect(mockSendFn).toHaveBeenCalledTimes(2)
  })
})

describe('PromptManager - Cache Management', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should clear cache correctly', () => {
    const manager = new PromptManager()
    manager.cache = TEST_CONSTANTS.TEST_PROMPT
    manager.cacheTimestamp = Date.now()
    manager.clearCache()
    expect(manager.cache).toBeNull()
    expect(manager.cacheTimestamp).toBeNull()
  })
  test('Should respect cache TTL', async () => {
    const mockBody = {
      transformToString: vi.fn().mockResolvedValue(TEST_CONSTANTS.TEST_PROMPT)
    }
    mockSendFn.mockResolvedValue({ Body: mockBody })
    const manager = new PromptManager()
    await manager.getSystemPrompt()
    manager.cacheTimestamp = Date.now() - TEST_CONSTANTS.HALF_HOUR
    await manager.getSystemPrompt()
    expect(mockSendFn).toHaveBeenCalledTimes(TEST_CONSTANTS.ONE)
  })
  test('Should handle multiple concurrent requests', async () => {
    const mockBody = {
      transformToString: vi.fn().mockResolvedValue(TEST_CONSTANTS.TEST_PROMPT)
    }
    mockSendFn.mockResolvedValue({ Body: mockBody })
    const manager = new PromptManager()
    const results = await Promise.all([
      manager.getSystemPrompt(),
      manager.getSystemPrompt(),
      manager.getSystemPrompt()
    ])
    expect(results.every((r) => r === TEST_CONSTANTS.TEST_PROMPT)).toBe(true)
  })
})

describe('PromptManager - S3 Command Parameters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should send correct GetObjectCommand parameters', async () => {
    const mockBody = {
      transformToString: vi.fn().mockResolvedValue(TEST_CONSTANTS.TEST_PROMPT)
    }
    mockSendFn.mockResolvedValueOnce({ Body: mockBody })
    const manager = new PromptManager()
    await manager.getSystemPrompt()
    const getCommand =
      mockSendFn.mock.calls[TEST_CONSTANTS.ZERO][TEST_CONSTANTS.ZERO]
    expect(getCommand.Bucket).toBe(TEST_CONSTANTS.BUCKET_NAME)
    expect(getCommand.Key).toBe(TEST_CONSTANTS.PROMPT_KEY)
  })
  test('Should send correct PutObjectCommand parameters', async () => {
    mockSendFn.mockResolvedValueOnce({})
    const manager = new PromptManager()
    await manager.uploadPrompt(LONG_PROMPT)
    const putCommand =
      mockSendFn.mock.calls[TEST_CONSTANTS.ZERO][TEST_CONSTANTS.ZERO]
    expect(putCommand.Bucket).toBe(TEST_CONSTANTS.BUCKET_NAME)
    expect(putCommand.Key).toBe(TEST_CONSTANTS.PROMPT_KEY)
    expect(putCommand.Body).toBe(LONG_PROMPT)
  })
})

describe('PromptManager - Default System Prompt', () => {
  test('Should export DEFAULT_SYSTEM_PROMPT', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toBeDefined()
    expect(typeof DEFAULT_SYSTEM_PROMPT).toBe('string')
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(TEST_CONSTANTS.ZERO)
  })
  test('Should contain required prompt sections', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('[SCORES]')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('[IMPROVEMENTS]')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('START:')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('END:')
  })
  test('Should contain scoring guidelines', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Plain English')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Clarity & Structure')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Accessibility')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('GOV.UK Style Compliance')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Content Completeness')
  })
})

describe('PromptManager - Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should handle network errors gracefully', async () => {
    mockSendFn.mockRejectedValueOnce(new Error('Network error'))
    const manager = new PromptManager()
    const result = await manager.getSystemPrompt()
    expect(result).toBe(DEFAULT_SYSTEM_PROMPT)
  })
  test('Should handle invalid response from S3', async () => {
    const invalidBody = {
      transformToString: vi
        .fn()
        .mockRejectedValue(new Error('Transform failed'))
    }
    mockSendFn.mockResolvedValueOnce({ Body: invalidBody })
    const manager = new PromptManager()
    const result = await manager.getSystemPrompt()
    expect(result).toBe(DEFAULT_SYSTEM_PROMPT)
  })
  test('Should propagate upload errors', async () => {
    mockSendFn.mockRejectedValueOnce(new Error('Upload failed'))
    const manager = new PromptManager()
    await expect(manager.uploadPrompt()).rejects.toThrow('Upload failed')
  })

  test('Should return default and handle auto-seed failure when both get and put fail', async () => {
    mockSendFn.mockRejectedValueOnce(new Error('S3 read error'))
    mockSendFn.mockRejectedValueOnce(new Error('S3 write error'))
    const manager = new PromptManager()

    const result = await manager.getSystemPrompt()

    expect(result).toBe(DEFAULT_SYSTEM_PROMPT)
    await new Promise((r) => setTimeout(r, 50))
  })
})

describe('PromptManager - Edge Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  test('Should handle empty prompt upload', async () => {
    mockSendFn.mockResolvedValueOnce({})
    const manager = new PromptManager()
    const result = await manager.uploadPrompt('')
    expect(result).toBe(true)
  })
  test('Should handle very long prompt content', async () => {
    const mockBody = {
      transformToString: vi.fn().mockResolvedValue(LONG_PROMPT)
    }
    mockSendFn.mockResolvedValueOnce({ Body: mockBody })
    const manager = new PromptManager()
    const result = await manager.getSystemPrompt()
    expect(result).toBe(LONG_PROMPT)
  })
  test('Should handle cache timestamp at exact TTL boundary', async () => {
    const mockBody = {
      transformToString: vi.fn().mockResolvedValue('New content')
    }
    mockSendFn.mockResolvedValueOnce({ Body: mockBody })
    const manager = new PromptManager()
    manager.cache = TEST_CONSTANTS.TEST_PROMPT
    manager.cacheTimestamp = Date.now() - TEST_CONSTANTS.ONE_HOUR
    const result = await manager.getSystemPrompt()
    expect(result).toBe('New content')
  })
})

describe('PromptManager - Initialization with LocalStack endpoint', () => {
  const DEFAULT_CONFIG = {
    'aws.region': 'eu-west-2',
    'aws.endpoint': null,
    's3.bucket': 'test-bucket',
    's3.promptKey': 'prompts/system-prompt.md'
  }

  afterEach(() => {
    config.get.mockImplementation((key) => DEFAULT_CONFIG[key])
  })

  test('Should configure S3 client with endpoint and forcePathStyle when awsEndpoint is set', () => {
    config.get.mockImplementation((key) => {
      if (key === 'aws.endpoint') return 'http://localhost:4566'
      return DEFAULT_CONFIG[key]
    })

    const manager = new PromptManager()

    expect(manager.bucket).toBe(TEST_CONSTANTS.BUCKET_NAME)
    expect(manager.promptKey).toBe(TEST_CONSTANTS.PROMPT_KEY)
  })
})
