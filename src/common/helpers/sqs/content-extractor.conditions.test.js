/**
 * content-extractor.conditions.test.js
 *
 * Covers the 2 branch conditions in content-extractor.js that remain uncovered
 * after the main test suite:
 *
 * Condition 1 — `startsWith('documents/') && endsWith('.json')`
 *   Existing tests cover: both-true (documents/x.json) and first-false (content-uploads/…).
 *   Missing: first-true but second-false — a key under documents/ that does NOT end with .json.
 *
 * Condition 2 — `!canonicalText || typeof canonicalText !== 'string'`
 *   Existing tests cover: first-true (canonicalText field absent → !canonicalText = true).
 *   Missing: first-false but second-true — canonicalText is present but is NOT a string.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest'
import { ContentExtractor } from './content-extractor.js'

const TEST_REVIEW_ID = 'review-999'
const TEST_BUCKET = 'test-bucket'
const TEST_TEXT_CONTENT = 'Some canonical text content.'

const mockS3Send = vi.fn()
const mockLoggerInfo = vi.fn()
const mockLoggerError = vi.fn()

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
      const values = {
        'aws.region': 'eu-west-2',
        'aws.endpoint': null
      }
      return values[key] ?? null
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
    extractText: vi.fn(),
    countWords: vi.fn().mockReturnValue(5)
  }
}))

function createMockAsyncBody(buffers) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const buf of buffers) {
        yield buf
      }
    }
  }
}

// ── Condition 1: startsWith('documents/') true but endsWith('.json') false ────

describe('ContentExtractor – isCanonicalDocument: starts with documents/ but not .json', () => {
  let extractor

  beforeEach(() => {
    vi.clearAllMocks()
    extractor = new ContentExtractor()
  })

  test('treats a documents/*.txt key as legacy plain-text (not a canonical document)', async () => {
    // s3Key starts with 'documents/' (condition 1 true) but ends with '.txt' (condition 2 false)
    // → isCanonicalDocument = false → falls back to the legacy plain-text path
    const messageBody = {
      s3Bucket: TEST_BUCKET,
      s3Key: `documents/${TEST_REVIEW_ID}.txt` // starts with documents/ but ends with .txt
    }
    const mockBody = createMockAsyncBody([Buffer.from(TEST_TEXT_CONTENT)])
    mockS3Send.mockResolvedValueOnce({ Body: mockBody })

    const result = await extractor.extractTextFromCanonicalDocument(
      TEST_REVIEW_ID,
      messageBody
    )

    // Legacy path returns { canonicalText: rawString, linkMap: null } (no sourceMap key)
    expect(result.canonicalText).toBe(TEST_TEXT_CONTENT)
    expect(result.linkMap).toBeNull()
    // Legacy log message should be emitted, not the canonical-document one
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: TEST_REVIEW_ID }),
      expect.stringContaining('Legacy plain-text')
    )
  })

  test('treats a documents/*.md key as legacy plain-text', async () => {
    const messageBody = {
      s3Bucket: TEST_BUCKET,
      s3Key: `documents/${TEST_REVIEW_ID}.md`
    }
    const mockBody = createMockAsyncBody([
      Buffer.from('# Heading\n\nBody text.')
    ])
    mockS3Send.mockResolvedValueOnce({ Body: mockBody })

    const result = await extractor.extractTextFromCanonicalDocument(
      TEST_REVIEW_ID,
      messageBody
    )

    expect(result.canonicalText).toBe('# Heading\n\nBody text.')
    expect(result.linkMap).toBeNull()
  })
})

// ── Condition 2: canonicalText is present but is NOT a string ─────────────────

describe('ContentExtractor – _processCanonicalJson: canonicalText is a non-string truthy value', () => {
  let extractor

  beforeEach(() => {
    vi.clearAllMocks()
    extractor = new ContentExtractor()
  })

  test('falls back when canonicalText is a number (typeof check triggers)', async () => {
    // !canonicalText = !(42) = false → first || operand is false
    // typeof 42 !== 'string' = true → second || operand is true → enters the error block
    const doc = {
      documentId: TEST_REVIEW_ID,
      canonicalText: 42, // truthy but not a string
      charCount: 2,
      status: 'pending'
    }
    const messageBody = {
      s3Bucket: TEST_BUCKET,
      s3Key: `documents/${TEST_REVIEW_ID}.json`
    }
    const mockBody = createMockAsyncBody([Buffer.from(JSON.stringify(doc))])
    mockS3Send.mockResolvedValueOnce({ Body: mockBody })

    const result = await extractor.extractTextFromCanonicalDocument(
      TEST_REVIEW_ID,
      messageBody
    )

    // Falls back: returns the raw JSON string as canonicalText, linkMap: null
    expect(result.linkMap).toBeNull()
    expect(typeof result.canonicalText).toBe('string')
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: TEST_REVIEW_ID }),
      'Canonical document missing canonicalText field — falling back to raw document JSON'
    )
  })

  test('falls back when canonicalText is an object (not a string)', async () => {
    const doc = {
      documentId: TEST_REVIEW_ID,
      canonicalText: { text: 'nested' }, // object, not string
      status: 'pending'
    }
    const messageBody = {
      s3Bucket: TEST_BUCKET,
      s3Key: `documents/${TEST_REVIEW_ID}.json`
    }
    const mockBody = createMockAsyncBody([Buffer.from(JSON.stringify(doc))])
    mockS3Send.mockResolvedValueOnce({ Body: mockBody })

    const result = await extractor.extractTextFromCanonicalDocument(
      TEST_REVIEW_ID,
      messageBody
    )

    expect(result.linkMap).toBeNull()
    expect(typeof result.canonicalText).toBe('string')
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: TEST_REVIEW_ID }),
      'Canonical document missing canonicalText field — falling back to raw document JSON'
    )
  })
})

// ── Bonus: sourceMap array present in canonical document ──────────────────────
// Covers Array.isArray(canonicalDoc.sourceMap) true branch

describe('ContentExtractor – _processCanonicalJson: sourceMap array returned when present', () => {
  let extractor

  beforeEach(() => {
    vi.clearAllMocks()
    extractor = new ContentExtractor()
  })

  test('returns the sourceMap array when the canonical document includes a sourceMap', async () => {
    const sourceMap = [
      { start: 0, end: 10, blockType: 'line', lineIndex: 0 },
      { start: 11, end: 20, blockType: 'line', lineIndex: 1 }
    ]
    const doc = {
      documentId: TEST_REVIEW_ID,
      canonicalText: TEST_TEXT_CONTENT,
      charCount: TEST_TEXT_CONTENT.length,
      tokenEst: 6,
      sourceType: 'text',
      status: 'pending',
      sourceMap
    }
    const messageBody = {
      s3Bucket: TEST_BUCKET,
      s3Key: `documents/${TEST_REVIEW_ID}.json`
    }
    const mockBody = createMockAsyncBody([Buffer.from(JSON.stringify(doc))])
    mockS3Send.mockResolvedValueOnce({ Body: mockBody })

    const result = await extractor.extractTextFromCanonicalDocument(
      TEST_REVIEW_ID,
      messageBody
    )

    expect(result.canonicalText).toBe(TEST_TEXT_CONTENT)
    expect(result.sourceMap).toEqual(sourceMap)
    expect(result.linkMap).toBeNull()
  })
})
