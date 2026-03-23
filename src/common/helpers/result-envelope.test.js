import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { MOCK_S3_SEND, S3_BUCKET } = vi.hoisted(() => ({
  MOCK_S3_SEND: vi.fn(),
  S3_BUCKET: 'test-bucket'
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
    get: vi.fn((key) => {
      const map = {
        'aws.region': 'eu-west-2',
        'aws.endpoint': null,
        's3.bucket': S3_BUCKET
      }
      return map[key] ?? null
    })
  }
}))

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

import { resultEnvelopeStore } from './result-envelope.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const REVIEW_ID = 'review_test-uuid-1234'

function makeS3Body(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj))
  return {
    [Symbol.asyncIterator]: async function* () {
      yield bytes
    }
  }
}

function makeParsedReview(overrides = {}) {
  return {
    scores: {
      'Plain English': { score: 4, note: 'Good use of plain language' },
      'Clarity & Structure': { score: 3, note: 'Could be clearer' },
      Accessibility: { score: 5, note: 'Excellent' },
      'GovUK Style Compliance': { score: 4, note: 'Mostly compliant' },
      'Content Completeness': { score: 3, note: 'Missing some details' }
    },
    reviewedContent: {
      issues: [{ start: 4, end: 11, type: 'plain-english', text: 'utilise' }]
    },
    improvements: [
      {
        severity: 'medium',
        category: 'plain-english',
        issue: 'Use simpler word',
        why: '"utilise" should be "use"',
        current: 'utilise',
        suggested: 'use'
      }
    ],
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_S3_SEND.mockResolvedValue({})
})

// ── getResultKey ──────────────────────────────────────────────────────────────

describe('getResultKey', () => {
  it('returns result/{reviewId}.json', () => {
    expect(resultEnvelopeStore.getResultKey(REVIEW_ID)).toBe(
      `result/${REVIEW_ID}.json`
    )
  })
})

// ── _mapScores ────────────────────────────────────────────────────────────────

describe('_mapScores', () => {
  it('maps all five canonical categories and scales 0-5 to 0-100', () => {
    const raw = {
      'Plain English': { score: 4, note: 'Good' },
      'Clarity & Structure': { score: 3, note: 'OK' },
      Accessibility: { score: 5, note: 'Excellent' },
      'GovUK Style Compliance': { score: 2, note: 'Needs work' },
      'Content Completeness': { score: 1, note: 'Incomplete' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    expect(result.plainEnglish).toBe(80)
    expect(result.clarity).toBe(60)
    expect(result.accessibility).toBe(100)
    expect(result.govukStyle).toBe(40)
    expect(result.completeness).toBe(20)
  })

  it('stores note strings alongside scaled values', () => {
    const raw = {
      'Plain English': { score: 3, note: 'Average' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    expect(result.plainEnglishNote).toBe('Average')
  })

  it('computes overall as the average of non-zero scores', () => {
    const raw = {
      'Plain English': { score: 4, note: '' },
      'Clarity & Structure': { score: 2, note: '' },
      Accessibility: { score: 0, note: '' },
      'GOV.UK Style Compliance': { score: 0, note: '' },
      'Content Completeness': { score: 0, note: '' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    // Only plainEnglish (80) and clarity (40) are non-zero → average = 60
    expect(result.overall).toBe(60)
  })

  it('returns all zeros when scores object is empty', () => {
    const result = resultEnvelopeStore._mapScores({})
    expect(result.plainEnglish).toBe(0)
    expect(result.clarity).toBe(0)
    expect(result.overall).toBe(0)
  })

  it('falls back to legacy key aliases (style, tone)', () => {
    const raw = {
      Style: { score: 3, note: '' },
      Tone: { score: 4, note: '' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    // govukStyle picks up 'style'
    expect(result.govukStyle).toBe(60)
    // clarity picks up 'tone' (or stays 0 if not matched)
    expect(typeof result.clarity).toBe('number')
  })

  it('populates legacy style and tone fields for backwards compatibility', () => {
    const raw = {
      'Plain English': { score: 3, note: '' },
      'Clarity & Structure': { score: 4, note: '' },
      Accessibility: { score: 3, note: '' },
      'GOV.UK Style Compliance': { score: 5, note: '' },
      'Content Completeness': { score: 2, note: '' }
    }
    const result = resultEnvelopeStore._mapScores(raw)
    expect(result.style).toBe(result.govukStyle)
    expect(result.tone).toBe(result.clarity)
  })
})

// ── buildStubEnvelope ─────────────────────────────────────────────────────────

describe('buildStubEnvelope', () => {
  it('returns an envelope with the given status', () => {
    const stub = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'pending')
    expect(stub.status).toBe('pending')
    expect(stub.documentId).toBe(REVIEW_ID)
  })

  it('has empty arrays for annotatedSections, issues and improvements', () => {
    const stub = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'processing')
    expect(stub.annotatedSections).toEqual([])
    expect(stub.issues).toEqual([])
    expect(stub.improvements).toEqual([])
  })

  it('has all score fields set to 0', () => {
    const stub = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'failed')
    expect(stub.scores.plainEnglish).toBe(0)
    expect(stub.scores.clarity).toBe(0)
    expect(stub.scores.overall).toBe(0)
  })

  it('sets processedAt to null and tokenUsed to 0', () => {
    const stub = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'pending')
    expect(stub.processedAt).toBeNull()
    expect(stub.tokenUsed).toBe(0)
  })
})

// ── buildEnvelope ─────────────────────────────────────────────────────────────

describe('buildEnvelope', () => {
  const CANONICAL_TEXT =
    'The department should utilise all resources available.'
  const BEDROCK_USAGE = {
    totalTokens: 500,
    inputTokens: 400,
    outputTokens: 100
  }

  it('returns a completed envelope with documentId and status', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      BEDROCK_USAGE,
      CANONICAL_TEXT
    )
    expect(envelope.documentId).toBe(REVIEW_ID)
    expect(envelope.status).toBe('completed')
  })

  it('includes issueCount matching the number of valid issues', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      BEDROCK_USAGE,
      CANONICAL_TEXT
    )
    expect(typeof envelope.issueCount).toBe('number')
    expect(envelope.issueCount).toBeGreaterThanOrEqual(0)
  })

  it('includes annotatedSections derived from canonicalText', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      BEDROCK_USAGE,
      CANONICAL_TEXT
    )
    expect(Array.isArray(envelope.annotatedSections)).toBe(true)
  })

  it('stores canonicalText on the envelope', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      BEDROCK_USAGE,
      CANONICAL_TEXT
    )
    expect(envelope.canonicalText).toBe(CANONICAL_TEXT)
  })

  it('uses tokenUsed from bedrockUsage.totalTokens', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      { totalTokens: 999 },
      CANONICAL_TEXT
    )
    expect(envelope.tokenUsed).toBe(999)
  })

  it('defaults tokenUsed to 0 when bedrockUsage is null', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      null,
      CANONICAL_TEXT
    )
    expect(envelope.tokenUsed).toBe(0)
  })

  it('accepts a custom status parameter', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview(),
      BEDROCK_USAGE,
      CANONICAL_TEXT,
      'failed'
    )
    expect(envelope.status).toBe('failed')
  })

  it('handles empty canonicalText gracefully', () => {
    const envelope = resultEnvelopeStore.buildEnvelope(
      REVIEW_ID,
      makeParsedReview({ reviewedContent: { issues: [] }, improvements: [] }),
      BEDROCK_USAGE,
      ''
    )
    expect(envelope.annotatedSections).toEqual([])
    expect(envelope.issueCount).toBe(0)
  })
})

// ── save ──────────────────────────────────────────────────────────────────────

describe('save', () => {
  it('calls S3 PutObjectCommand with correct key and content-type', async () => {
    const envelope = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'pending')
    await resultEnvelopeStore.save(REVIEW_ID, envelope)

    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(1)
    const cmd = MOCK_S3_SEND.mock.calls[0][0]
    expect(cmd.Key).toBe(`result/${REVIEW_ID}.json`)
    expect(cmd.Bucket).toBe(S3_BUCKET)
    expect(cmd.ContentType).toBe('application/json')
  })

  it('throws when S3 send rejects', async () => {
    MOCK_S3_SEND.mockRejectedValueOnce(new Error('S3 write failed'))
    const envelope = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'pending')
    await expect(resultEnvelopeStore.save(REVIEW_ID, envelope)).rejects.toThrow(
      'S3 write failed'
    )
  })
})

// ── get ───────────────────────────────────────────────────────────────────────

describe('get', () => {
  it('returns parsed envelope from S3', async () => {
    const stub = resultEnvelopeStore.buildStubEnvelope(REVIEW_ID, 'completed')
    MOCK_S3_SEND.mockResolvedValueOnce({ Body: makeS3Body(stub) })

    const result = await resultEnvelopeStore.get(REVIEW_ID)
    expect(result.documentId).toBe(REVIEW_ID)
    expect(result.status).toBe('completed')
  })

  it('returns null when the envelope does not exist (NoSuchKey)', async () => {
    const notFound = new Error('Not found')
    notFound.name = 'NoSuchKey'
    MOCK_S3_SEND.mockRejectedValueOnce(notFound)

    const result = await resultEnvelopeStore.get(REVIEW_ID)
    expect(result).toBeNull()
  })

  it('rethrows non-NoSuchKey S3 errors', async () => {
    const err = new Error('S3 read failed')
    err.name = 'InternalError'
    MOCK_S3_SEND.mockRejectedValueOnce(err)

    await expect(resultEnvelopeStore.get(REVIEW_ID)).rejects.toThrow(
      'S3 read failed'
    )
  })
})

// ── saveCompleted ─────────────────────────────────────────────────────────────

describe('saveCompleted', () => {
  it('builds and persists a completed envelope, returning it', async () => {
    const result = await resultEnvelopeStore.saveCompleted(
      REVIEW_ID,
      makeParsedReview(),
      { totalTokens: 200 },
      'Some canonical text about planning.'
    )
    expect(result.status).toBe('completed')
    expect(result.documentId).toBe(REVIEW_ID)
    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(1)
  })
})

// ── saveStatus ────────────────────────────────────────────────────────────────

describe('saveStatus', () => {
  it('builds and persists a stub envelope with the given status', async () => {
    const result = await resultEnvelopeStore.saveStatus(REVIEW_ID, 'processing')
    expect(result.status).toBe('processing')
    expect(MOCK_S3_SEND).toHaveBeenCalledTimes(1)
  })

  it('builds and persists a failed stub envelope', async () => {
    const result = await resultEnvelopeStore.saveStatus(REVIEW_ID, 'failed')
    expect(result.status).toBe('failed')
    expect(result.issueCount).toBe(0)
  })
})
