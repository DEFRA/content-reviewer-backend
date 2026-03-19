/**
 * canonical-document.constants.test.js
 *
 * Tests for the exported constants: SOURCE_TYPES and CANONICAL_STATUS.
 */

import { describe, it, expect, vi } from 'vitest'

// ── Minimal mocks required for the module to load ──────────────────────────

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: vi.fn() }
  }),
  PutObjectCommand: vi.fn(function (input) {
    return input
  }),
  GetObjectCommand: vi.fn(function (input) {
    return input
  })
}))

vi.mock('../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const values = {
        'aws.region': 'eu-west-2',
        'aws.endpoint': null,
        's3.bucket': 'test-bucket'
      }
      return values[key] ?? null
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

vi.mock('./pii-redactor.js', () => ({
  piiRedactor: {
    redactUserContent: vi.fn((text) => ({
      redactedText: text,
      hasPII: false,
      redactionCount: 0
    }))
  }
}))

vi.mock('./text-normaliser.js', () => ({
  textNormaliser: {
    normalise: vi.fn((text) => ({
      normalisedText: text,
      stats: {
        originalLength: text.length,
        normalisedLength: text.length,
        charsRemoved: 0
      }
    })),
    buildSourceMap: vi.fn(() => [])
  }
}))

vi.mock('./document-section-stripper.js', () => ({
  documentSectionStripper: {
    strip: vi.fn((text) => ({
      strippedText: text,
      stats: { sectionsRemoved: [] }
    }))
  }
}))

import { SOURCE_TYPES, CANONICAL_STATUS } from './canonical-document.js'

// ── Tests ───────────────────────────────────────────────────────────────────

const SOURCE_TYPES_KEY_COUNT = 3

describe('SOURCE_TYPES', () => {
  it('exports FILE = "file"', () => {
    expect(SOURCE_TYPES.FILE).toBe('file')
  })

  it('exports URL = "url"', () => {
    expect(SOURCE_TYPES.URL).toBe('url')
  })

  it('exports TEXT = "text"', () => {
    expect(SOURCE_TYPES.TEXT).toBe('text')
  })

  it(`has exactly ${SOURCE_TYPES_KEY_COUNT} keys`, () => {
    expect(Object.keys(SOURCE_TYPES)).toHaveLength(SOURCE_TYPES_KEY_COUNT)
  })
})

describe('CANONICAL_STATUS', () => {
  it('exports PENDING = "pending"', () => {
    expect(CANONICAL_STATUS.PENDING).toBe('pending')
  })

  it('exports PROCESSING = "processing"', () => {
    expect(CANONICAL_STATUS.PROCESSING).toBe('processing')
  })

  it('exports COMPLETED = "completed"', () => {
    expect(CANONICAL_STATUS.COMPLETED).toBe('completed')
  })

  it('exports FAILED = "failed"', () => {
    expect(CANONICAL_STATUS.FAILED).toBe('failed')
  })

  it('has exactly four keys', () => {
    expect(Object.keys(CANONICAL_STATUS)).toHaveLength(4)
  })
})
