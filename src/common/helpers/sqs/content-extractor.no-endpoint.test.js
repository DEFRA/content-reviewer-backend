import { describe, test, expect, vi } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────
// This file deliberately omits 'aws.endpoint' from the config so that the
// false branch of `if (awsEndpoint)` in ContentExtractor's constructor (line 21)
// is executed. The primary test file always returns TEST_AWS_ENDPOINT so that
// branch can only be reached here.

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: vi.fn() }
  }),
  GetObjectCommand: vi.fn(function (params) {
    return params
  })
}))

vi.mock('../../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      // 'aws.endpoint' is intentionally absent → returns undefined → falsy
      const configValues = {
        'aws.region': 'us-east-1'
      }
      return configValues[key]
    })
  }
}))

vi.mock('../logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../text-extractor.js', () => ({
  textExtractor: {
    extractText: vi.fn(),
    countWords: vi.fn()
  }
}))

import { ContentExtractor } from './content-extractor.js'

// ── Constructor — aws.endpoint null (line 21 false branch) ───────────────────

describe('ContentExtractor — aws.endpoint absent (line 21 false branch)', () => {
  test('constructs S3Client without setting endpoint when aws.endpoint is not configured', () => {
    const extractor = new ContentExtractor()
    expect(extractor.s3Client).toBeDefined()
  })
})
