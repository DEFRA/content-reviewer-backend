/**
 * canonical-document.get-document.e2e.test.js
 *
 * E2E: getDocument reads a stored canonical document from S3, parses it and
 * returns the full object. S3 and config are mocked; all other code is real.
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

import {
  canonicalDocumentStore,
  SOURCE_TYPES,
  CANONICAL_STATUS
} from './canonical-document.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeS3Body(jsonString) {
  const bytes = new TextEncoder().encode(jsonString)
  return {
    [Symbol.asyncIterator]: async function* () {
      yield bytes
    }
  }
}

function makeStoredDoc(overrides = {}) {
  return {
    documentId: 'review_e2e-get-doc-00000001',
    sourceType: SOURCE_TYPES.FILE,
    rawS3Key: 'uploads/review_e2e-get-doc-00000001/original.pdf',
    canonicalText: 'The full canonical text of the document.',
    charCount: 40,
    tokenEst: 10,
    sourceMap: [
      {
        start: 0,
        end: 39,
        blockType: 'line',
        lineIndex: 0,
        originType: 'page',
        originRef: null
      }
    ],
    createdAt: '2026-03-13T10:00:00.000Z',
    status: CANONICAL_STATUS.PENDING,
    ...overrides
  }
}

const DOC_ID = 'review_e2e-get-doc-00000001'
const TEST_CHAR_COUNT = 40

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getDocument — fetches and parses a document from S3', () => {
  it('reads from the correct S3 key', async () => {
    const stored = makeStoredDoc()
    MOCK_S3_SEND.mockResolvedValueOnce({
      Body: makeS3Body(JSON.stringify(stored))
    })

    await canonicalDocumentStore.getDocument(DOC_ID)

    const [[getCmd]] = MOCK_S3_SEND.mock.calls
    expect(getCmd.Key).toBe(`documents/${DOC_ID}.json`)
    expect(getCmd.Bucket).toBe(S3_BUCKET)
  })

  it('returns the parsed document object with all fields', async () => {
    const stored = makeStoredDoc()
    MOCK_S3_SEND.mockResolvedValueOnce({
      Body: makeS3Body(JSON.stringify(stored))
    })

    const doc = await canonicalDocumentStore.getDocument(DOC_ID)

    expect(doc).toEqual(stored)
  })

  it('returns the correct documentId', async () => {
    const stored = makeStoredDoc()
    MOCK_S3_SEND.mockResolvedValueOnce({
      Body: makeS3Body(JSON.stringify(stored))
    })

    const doc = await canonicalDocumentStore.getDocument(DOC_ID)

    expect(doc.documentId).toBe(DOC_ID)
  })

  it('returns the correct canonicalText', async () => {
    const stored = makeStoredDoc({
      canonicalText: 'Specific text for this test.'
    })
    MOCK_S3_SEND.mockResolvedValueOnce({
      Body: makeS3Body(JSON.stringify(stored))
    })

    const doc = await canonicalDocumentStore.getDocument(DOC_ID)

    expect(doc.canonicalText).toBe('Specific text for this test.')
  })

  it('returns a sourceMap array', async () => {
    const stored = makeStoredDoc()
    MOCK_S3_SEND.mockResolvedValueOnce({
      Body: makeS3Body(JSON.stringify(stored))
    })

    const doc = await canonicalDocumentStore.getDocument(DOC_ID)

    expect(Array.isArray(doc.sourceMap)).toBe(true)
  })
  it('returns charCount matching the stored value', async () => {
    const stored = makeStoredDoc({ charCount: TEST_CHAR_COUNT })
    MOCK_S3_SEND.mockResolvedValueOnce({
      Body: makeS3Body(JSON.stringify(stored))
    })

    const doc = await canonicalDocumentStore.getDocument(DOC_ID)

    expect(doc.charCount).toBe(TEST_CHAR_COUNT)
  })

  it('returns status PENDING for a freshly created document', async () => {
    const stored = makeStoredDoc({ status: CANONICAL_STATUS.PENDING })
    MOCK_S3_SEND.mockResolvedValueOnce({
      Body: makeS3Body(JSON.stringify(stored))
    })

    const doc = await canonicalDocumentStore.getDocument(DOC_ID)

    expect(doc.status).toBe(CANONICAL_STATUS.PENDING)
  })

  it('propagates S3 NoSuchKey errors', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('NoSuchKey'))

    await expect(canonicalDocumentStore.getDocument(DOC_ID)).rejects.toThrow(
      'NoSuchKey'
    )
  })

  it('propagates network errors from S3', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('Network failure'))

    await expect(canonicalDocumentStore.getDocument(DOC_ID)).rejects.toThrow(
      'Network failure'
    )
  })
})

describe('getDocument — round-trip with createCanonicalDocument', () => {
  it('getDocument returns what createCanonicalDocument stored', async () => {
    // Step 1: capture the serialised body from the PutObjectCommand
    let capturedBody = null
    MOCK_S3_SEND.mockImplementation((cmd) => {
      if (cmd.Body !== undefined) {
        capturedBody = cmd.Body
      }
      return Promise.resolve({})
    })

    const { document: created } =
      await canonicalDocumentStore.createCanonicalDocument({
        documentId: DOC_ID,
        text: 'A complete round-trip test document.',
        sourceType: SOURCE_TYPES.TEXT
      })

    // Step 2: replay that body for the GetObjectCommand
    MOCK_S3_SEND.mockResolvedValueOnce({
      Body: makeS3Body(capturedBody)
    })

    const fetched = await canonicalDocumentStore.getDocument(DOC_ID)

    expect(fetched.documentId).toBe(created.documentId)
    expect(fetched.canonicalText).toBe(created.canonicalText)
    expect(fetched.charCount).toBe(created.charCount)
    expect(fetched.status).toBe(created.status)
  })
})
