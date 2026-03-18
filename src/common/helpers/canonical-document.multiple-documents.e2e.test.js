/**
 * canonical-document.multiple-documents.e2e.test.js
 *
 * E2E: Multiple distinct documents can be created in sequence without
 * bleed-over between them (isolation, independent IDs, independent text).
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

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
})

const DOC_ID_1 = 'review_e2e-multi-doc-00000001'
const DOC_ID_2 = 'review_e2e-multi-doc-00000002'

const text1 = 'This is the content for document one.'
const text2 = 'This is the content for document two.'

describe('multiple documents — independent creation', () => {
  it('creates two documents with different IDs independently', async () => {
    const { document: doc1 } =
      await canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID_1,
        text: 'Document one content.',
        sourceType: SOURCE_TYPES.TEXT
      })

    const { document: doc2 } =
      await canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID_2,
        text: 'Document two content.',
        sourceType: SOURCE_TYPES.TEXT
      })

    expect(doc1.documentId).toBe(DOC_ID_1)
    expect(doc2.documentId).toBe(DOC_ID_2)
    const { document: doc1b } =
      await canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID_1,
        text: 'Alpha text for document one.',
        sourceType: SOURCE_TYPES.TEXT
      })

    const { document: doc2b } =
      await canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID_2,
        text: 'Beta text for document two.',
        sourceType: SOURCE_TYPES.TEXT
      })

    expect(doc1b.canonicalText).toContain('Alpha text')
    expect(doc2b.canonicalText).toContain('Beta text')
    expect(doc1b.canonicalText).not.toContain('Beta text')
    expect(doc2b.canonicalText).not.toContain('Alpha text')
  })
})

describe('multiple documents — charCount and S3 storage', () => {
  it('each document has its own charCount', async () => {
    const { document: doc1 } =
      await canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID_1,
        text: text1,
        sourceType: SOURCE_TYPES.TEXT
      })

    const { document: doc2 } =
      await canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID_2,
        text: text2,
        sourceType: SOURCE_TYPES.TEXT
      })

    expect(doc1.charCount).toBe(doc1.canonicalText.length)
    expect(doc2.charCount).toBe(doc2.canonicalText.length)
    expect(doc1.charCount).not.toBe(doc2.charCount)

    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID_1,
      text: 'First document.',
      sourceType: SOURCE_TYPES.TEXT
    })

    await canonicalDocumentStore.createCanonicalDocument({
      documentId: DOC_ID_2,
      text: 'Second document.',
      sourceType: SOURCE_TYPES.TEXT
    })

    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(2)

    const calls = MOCK_S3_SEND.mock.calls
    expect(calls[0][0].Key).toBe(`documents/${DOC_ID_1}.json`)
    expect(calls[1][0].Key).toBe(`documents/${DOC_ID_2}.json`)
  })
})

describe('multiple documents — source types and PII removal', () => {
  it('handles different source types and PII removal', async () => {
    const { document: textDoc } =
      await canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID_1,
        text: 'Free text paste content.',
        sourceType: SOURCE_TYPES.TEXT
      })

    const { document: fileDoc } =
      await canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID_2,
        text: '1. Introduction\n\nFile content here.',
        sourceType: SOURCE_TYPES.FILE
      })

    expect(textDoc.sourceType).toBe(SOURCE_TYPES.TEXT)
    expect(fileDoc.sourceType).toBe(SOURCE_TYPES.FILE)

    const { document: piiDoc } =
      await canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID_1,
        text: 'NI number: AB123456C.',
        sourceType: SOURCE_TYPES.TEXT
      })

    const { document: cleanDoc } =
      await canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID_2,
        text: 'Completely clean text here.',
        sourceType: SOURCE_TYPES.TEXT
      })

    expect(piiDoc.canonicalText).not.toContain('AB123456C')
    expect(cleanDoc.canonicalText).toBe('Completely clean text here.')
  })
})

describe('multiple documents — concurrent creation', () => {
  it('creates documents concurrently', async () => {
    const [result1, result2] = await Promise.all([
      canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID_1,
        text: 'Concurrent document one.',
        sourceType: SOURCE_TYPES.TEXT
      }),
      canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID_2,
        text: 'Concurrent document two.',
        sourceType: SOURCE_TYPES.TEXT
      })
    ])

    expect(result1.document.documentId).toBe(DOC_ID_1)
    expect(result2.document.documentId).toBe(DOC_ID_2)
  })
})
