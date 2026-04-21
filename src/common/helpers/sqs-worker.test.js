import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Constants ─────────────────────────────────────────────────────────────────
const SLEEP_MS = 10
const BACKOFF_MS_BASE = 5000
const BACKOFF_MS_MAX = 30000
const MAX_CONSECUTIVE_ERRORS = 10
const MESSAGE_ID_1 = 'msg-001'
const MESSAGE_ID_2 = 'msg-002'
const CONSECUTIVE_ERRORS_9 = 9
const CONSECUTIVE_ERRORS_10 = 10

const {
  QUEUE_URL,
  AWS_REGION,
  MAX_MESSAGES,
  WAIT_TIME_SECONDS,
  VISIBILITY_TIMEOUT,
  MAX_CONCURRENT
} = vi.hoisted(() => ({
  QUEUE_URL: 'https://sqs.eu-west-2.amazonaws.com/123456789/test-queue',
  AWS_REGION: 'eu-west-2',
  MAX_MESSAGES: 5,
  WAIT_TIME_SECONDS: 20,
  VISIBILITY_TIMEOUT: 30,
  MAX_CONCURRENT: 3
}))

const { MOCK_PROCESS_MESSAGE } = vi.hoisted(() => ({
  MOCK_PROCESS_MESSAGE: vi.fn()
}))

const { MOCK_RECEIVE_MESSAGES } = vi.hoisted(() => ({
  MOCK_RECEIVE_MESSAGES: vi.fn()
}))

vi.mock('../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const values = {
        'sqs.queueUrl': QUEUE_URL,
        'sqs.maxMessages': MAX_MESSAGES,
        'sqs.waitTimeSeconds': WAIT_TIME_SECONDS,
        'sqs.visibilityTimeout': VISIBILITY_TIMEOUT,
        'sqs.maxConcurrentRequests': MAX_CONCURRENT,
        'aws.region': AWS_REGION
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

vi.mock('./sqs/message-handler.js', () => ({
  SQSMessageHandler: vi.fn(function () {
    return { receiveMessages: MOCK_RECEIVE_MESSAGES }
  })
}))

vi.mock('./sqs/review-processor.js', () => ({
  ReviewProcessor: vi.fn(function () {
    return { processMessage: MOCK_PROCESS_MESSAGE }
  })
}))

import { SQSWorker, sqsWorker } from './sqs-worker.js'

// ── initialization ────────────────────────────────────────────────────────────

describe('SQSWorker initialization', () => {
  it('sets isRunning to false initially', () => {
    const worker = new SQSWorker()
    expect(worker.isRunning).toBe(false)
  })

  it('sets queueUrl from config', () => {
    const worker = new SQSWorker()
    expect(worker.queueUrl).toBe(QUEUE_URL)
  })

  it('sets maxMessages from config', () => {
    const worker = new SQSWorker()
    expect(worker.maxMessages).toBe(MAX_MESSAGES)
  })

  it('sets maxConcurrentRequests from config', () => {
    const worker = new SQSWorker()
    expect(worker.maxConcurrentRequests).toBe(MAX_CONCURRENT)
  })

  it('initialises currentConcurrentRequests to 0', () => {
    const worker = new SQSWorker()
    expect(worker.currentConcurrentRequests).toBe(0)
  })

  it('initialises processingQueue as empty array', () => {
    const worker = new SQSWorker()
    expect(worker.processingQueue).toEqual([])
  })
})

// ── start() / stop() ──────────────────────────────────────────────────────────

describe('SQSWorker.start and stop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets isRunning to true when start() is called', async () => {
    const worker = new SQSWorker()
    vi.spyOn(worker, 'poll').mockResolvedValue(undefined)
    await worker.start()
    expect(worker.isRunning).toBe(true)
  })

  it('does not start again if already running', async () => {
    const worker = new SQSWorker()
    const pollSpy = vi.spyOn(worker, 'poll').mockResolvedValue(undefined)
    await worker.start()
    await worker.start()
    expect(pollSpy).toHaveBeenCalledTimes(1)
  })

  it('sets isRunning to false when stop() is called', async () => {
    const worker = new SQSWorker()
    vi.spyOn(worker, 'poll').mockResolvedValue(undefined)
    await worker.start()
    worker.stop()
    expect(worker.isRunning).toBe(false)
  })
})

// ── getStatus() ───────────────────────────────────────────────────────────────

describe('SQSWorker.getStatus', () => {
  it('returns running as false when stopped', () => {
    const worker = new SQSWorker()
    const status = worker.getStatus()
    expect(status.running).toBe(false)
  })

  it('returns queueUrl in status', () => {
    const worker = new SQSWorker()
    expect(worker.getStatus().queueUrl).toBe(QUEUE_URL)
  })

  it('returns region in status', () => {
    const worker = new SQSWorker()
    expect(worker.getStatus().region).toBe(AWS_REGION)
  })

  it('returns maxConcurrentRequests in status', () => {
    const worker = new SQSWorker()
    expect(worker.getStatus().maxConcurrentRequests).toBe(MAX_CONCURRENT)
  })

  it('returns queuedMessages count in status', () => {
    const worker = new SQSWorker()
    worker.processingQueue.push({ MessageId: MESSAGE_ID_1 })
    expect(worker.getStatus().queuedMessages).toBe(1)
  })
})

// ── enqueueMessage() ──────────────────────────────────────────────────────────

describe('SQSWorker.enqueueMessage', () => {
  it('adds message to processingQueue', () => {
    const worker = new SQSWorker()
    worker.enqueueMessage({ MessageId: MESSAGE_ID_1 })
    expect(worker.processingQueue.length).toBe(1)
    expect(worker.processingQueue[0].MessageId).toBe(MESSAGE_ID_1)
  })

  it('adds multiple messages in order', () => {
    const worker = new SQSWorker()
    worker.enqueueMessage({ MessageId: MESSAGE_ID_1 })
    worker.enqueueMessage({ MessageId: MESSAGE_ID_2 })
    expect(worker.processingQueue.length).toBe(2)
    expect(worker.processingQueue[1].MessageId).toBe(MESSAGE_ID_2)
  })
})

// ── fetchAndEnqueueMessages() ─────────────────────────────────────────────────

describe('SQSWorker.fetchAndEnqueueMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('enqueues received messages', async () => {
    const worker = new SQSWorker()
    MOCK_RECEIVE_MESSAGES.mockResolvedValueOnce([
      { MessageId: MESSAGE_ID_1 },
      { MessageId: MESSAGE_ID_2 }
    ])
    await worker.fetchAndEnqueueMessages()
    expect(worker.processingQueue.length).toBe(2)
  })

  it('does nothing when no available slots', async () => {
    const worker = new SQSWorker()
    worker.currentConcurrentRequests = MAX_CONCURRENT
    await worker.fetchAndEnqueueMessages()
    expect(MOCK_RECEIVE_MESSAGES).not.toHaveBeenCalled()
  })

  it('does nothing when receiveMessages returns empty array', async () => {
    const worker = new SQSWorker()
    MOCK_RECEIVE_MESSAGES.mockResolvedValueOnce([])
    await worker.fetchAndEnqueueMessages()
    expect(worker.processingQueue.length).toBe(0)
  })

  it('does nothing when receiveMessages returns null', async () => {
    const worker = new SQSWorker()
    MOCK_RECEIVE_MESSAGES.mockResolvedValueOnce(null)
    await worker.fetchAndEnqueueMessages()
    expect(worker.processingQueue.length).toBe(0)
  })
})

// ── processQueuedMessages() ───────────────────────────────────────────────────

describe('SQSWorker.processQueuedMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('processes messages from the queue', async () => {
    const worker = new SQSWorker()
    MOCK_PROCESS_MESSAGE.mockResolvedValue(undefined)
    worker.processingQueue.push({ MessageId: MESSAGE_ID_1 })
    await worker.processQueuedMessages()
    expect(MOCK_PROCESS_MESSAGE).toHaveBeenCalledTimes(1)
  })

  it('does not exceed maxConcurrentRequests', async () => {
    const worker = new SQSWorker()
    worker.currentConcurrentRequests = MAX_CONCURRENT
    MOCK_PROCESS_MESSAGE.mockResolvedValue(undefined)
    worker.processingQueue.push({ MessageId: MESSAGE_ID_1 })
    await worker.processQueuedMessages()
    expect(MOCK_PROCESS_MESSAGE).not.toHaveBeenCalled()
  })

  it('decrements currentConcurrentRequests after success', async () => {
    const worker = new SQSWorker()
    MOCK_PROCESS_MESSAGE.mockResolvedValue(undefined)
    worker.processingQueue.push({ MessageId: MESSAGE_ID_1 })
    await worker.processQueuedMessages()
    await worker.sleep(SLEEP_MS)
    expect(worker.currentConcurrentRequests).toBe(0)
  })

  it('decrements currentConcurrentRequests after error', async () => {
    const worker = new SQSWorker()
    MOCK_PROCESS_MESSAGE.mockRejectedValue(new Error('processing failed'))
    worker.processingQueue.push({ MessageId: MESSAGE_ID_1 })
    await worker.processQueuedMessages()
    await worker.sleep(SLEEP_MS)
    expect(worker.currentConcurrentRequests).toBe(0)
  })
})

// ── handlePollingError() ──────────────────────────────────────────────────────

describe('SQSWorker.handlePollingError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false and waits when errors below threshold', async () => {
    const worker = new SQSWorker()
    vi.spyOn(worker, 'sleep').mockResolvedValue(undefined)
    const shouldStop = await worker.handlePollingError(
      new Error('timeout'),
      CONSECUTIVE_ERRORS_9
    )
    expect(shouldStop).toBe(false)
    expect(worker.sleep).toHaveBeenCalled()
  })

  it('returns true and stops worker when errors reach threshold', async () => {
    const worker = new SQSWorker()
    vi.spyOn(worker, 'sleep').mockResolvedValue(undefined)
    const shouldStop = await worker.handlePollingError(
      new Error('critical'),
      CONSECUTIVE_ERRORS_10
    )
    expect(shouldStop).toBe(true)
    expect(worker.isRunning).toBe(false)
  })

  it('applies exponential backoff up to MAX_BACKOFF_MS', async () => {
    const worker = new SQSWorker()
    const sleepSpy = vi.spyOn(worker, 'sleep').mockResolvedValue(undefined)
    await worker.handlePollingError(new Error('error'), 1)
    const calledWith = sleepSpy.mock.calls[0][0]
    expect(calledWith).toBeLessThanOrEqual(BACKOFF_MS_MAX)
    expect(calledWith).toBeGreaterThanOrEqual(BACKOFF_MS_BASE)
  })
})

// ── sleep() ───────────────────────────────────────────────────────────────────

describe('SQSWorker.sleep', () => {
  it('resolves after specified milliseconds', async () => {
    const worker = new SQSWorker()
    const start = Date.now()
    await worker.sleep(SLEEP_MS)
    expect(Date.now() - start).toBeGreaterThanOrEqual(SLEEP_MS - 1)
  })
})

// ── singleton export ──────────────────────────────────────────────────────────

describe('sqsWorker singleton', () => {
  it('is an instance of SQSWorker', () => {
    expect(sqsWorker).toBeInstanceOf(SQSWorker)
  })

  it('exposes start method', () => {
    expect(typeof sqsWorker.start).toBe('function')
  })

  it('exposes stop method', () => {
    expect(typeof sqsWorker.stop).toBe('function')
  })

  it('exposes getStatus method', () => {
    expect(typeof sqsWorker.getStatus).toBe('function')
  })
})
