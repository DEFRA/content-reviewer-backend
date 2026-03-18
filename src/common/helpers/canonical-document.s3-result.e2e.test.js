/**
 * canonical-document.s3-result.e2e.test.js
 *
 * E2E: The S3 persistence layer correctly receives and stores the canonical
 * document. Verifies PutObjectCommand arguments, metadata, and error handling.
 * Only AWS S3 and config are mocked; all other modules run real code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { MOCK_S3_SEND, S3_BUCKET } = vi.hoisted(() => ({
  MOCK_S3_SEND: vi.fn(),
  S3_BUCKET: 'e2e-test-bucket'
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: MOCK_S3_SEND }
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
    get: vi.fn(
      (key) =>
        ({
          'aws.region': 'eu-west-2',
          'aws.endpoint': null,
          's3.bucket': S3_BUCKET
        })[key] ?? null
    )
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

import { canonicalDocumentStore, SOURCE_TYPES } from './canonical-document.js'

const DOC_ID = 'review_e2e-s3-result-00000001'

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
})

describe('S3 result — PutObjectCommand arguments', () => {
  it('calls S3 send exactly once', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'S3 persistence test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(MOCK_S3_SEND).toHaveBeenCalledOnce()
  })

  it('sends to the correct bucket', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Bucket test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.Bucket).toBe(S3_BUCKET)
  })

  it('sends to the correct S3 key path', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Key path test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.Key).toBe(`documents/${DOC_ID}.json`)
  })

  it('sets ContentType to application/json', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'ContentType test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.ContentType).toBe('application/json')
  })

  it('serialises document body as valid JSON', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'JSON body test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(() => JSON.parse(putCmd.Body)).not.toThrow()
  })

  it('serialised body contains the documentId', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'DocumentId in body test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    const parsed = JSON.parse(putCmd.Body)
    expect(parsed.documentId).toBe(DOC_ID)
  })

  it('serialised body contains the canonicalText', async () => {
    const text = 'The canonical text for serialisation check.'
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text,
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    const parsed = JSON.parse(putCmd.Body)
    expect(parsed.canonicalText).toBe(text)
  })
})

describe('S3 result — metadata on PutObjectCommand', () => {
  it('includes documentId in metadata', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Metadata test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.Metadata.documentId).toBe(DOC_ID)
  })

  it('includes sourceType in metadata', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'SourceType metadata test.',
      sourceType: SOURCE_TYPES.FILE
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.Metadata.sourceType).toBe(SOURCE_TYPES.FILE)
  })

  it('includes charCount as a string in metadata', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'CharCount metadata test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(typeof putCmd.Metadata.charCount).toBe('string')
    expect(Number.isNaN(Number.parseInt(putCmd.Metadata.charCount, 10))).toBe(
      false
    )
  })

  it('sets piiRedacted=false when text contains no PII', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'Clean text with no PII here.',
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.Metadata.piiRedacted).toBe('false')
  })

  it('sets piiRedacted=true when text contains a NI number', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'NI: AB123456C was detected.',
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.Metadata.piiRedacted).toBe('true')
  })

  it('includes rawS3Key in metadata when provided', async () => {
    const rawKey = 'uploads/review_abc/original.pdf'
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'RawS3Key metadata test.',
      sourceType: SOURCE_TYPES.FILE,
      rawS3Key: rawKey
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.Metadata.rawS3Key).toBe(rawKey)
  })

  it('does not include rawS3Key in metadata when not provided', async () => {
    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'No rawS3Key metadata test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    const [[putCmd]] = MOCK_S3_SEND.mock.calls
    expect(putCmd.Metadata).not.toHaveProperty('rawS3Key')
  })
})

describe('S3 result — error handling', () => {
  it('propagates S3 errors thrown during PUT', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('S3 PUT failed'))

    await expect(
      canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID,
        text: 'Error propagation test.',
        sourceType: SOURCE_TYPES.TEXT
      })
    ).rejects.toThrow('S3 PUT failed')
  })

  it('returns the correct s3 location URL', async () => {
    const { s3 } = await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID,
      text: 'S3 location test.',
      sourceType: SOURCE_TYPES.TEXT
    })
    expect(s3.location).toBe(`s3://${S3_BUCKET}/documents/${DOC_ID}.json`)
  })
})
