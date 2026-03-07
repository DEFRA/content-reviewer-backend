import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sqsWorkerStatus } from './sqs-worker-status.js'

const HTTP_STATUS_OK = 200
const CONFIG_KEY_SKIP_SQS = 'mockMode.skipSqsWorker'
const CONFIG_KEY_S3_UPLOAD = 'mockMode.s3Upload'

vi.mock('../common/helpers/sqs-worker.js', () => ({
  sqsWorker: {
    getStatus: vi.fn(() => ({
      isRunning: true,
      messageCount: 0,
      lastProcessedAt: null
    }))
  }
}))

vi.mock('../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      if (key === 'mockMode.skipSqsWorker') {
        return false
      }
      if (key === 'mockMode.s3Upload') {
        return false
      }
      return null
    })
  }
}))

import { sqsWorker } from '../common/helpers/sqs-worker.js'
import { config } from '../config.js'

function buildDefaultStatus() {
  return { isRunning: true, messageCount: 0, lastProcessedAt: null }
}

function buildDefaultConfigMock() {
  return (key) => {
    if (key === CONFIG_KEY_SKIP_SQS) {
      return false
    }
    if (key === CONFIG_KEY_S3_UPLOAD) {
      return false
    }
    return null
  }
}

function createMockH() {
  const responseMock = { code: vi.fn().mockReturnThis() }
  return {
    response: vi.fn(() => responseMock),
    _responseMock: responseMock
  }
}

describe('sqsWorkerStatus route', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    sqsWorker.getStatus.mockReturnValue(buildDefaultStatus())
    config.get.mockImplementation(buildDefaultConfigMock())
  })

  it('has GET method and correct path', () => {
    expect(sqsWorkerStatus.method).toBe('GET')
    expect(sqsWorkerStatus.path).toBe('/api/sqs-worker/status')
  })

  it('returns status 200 with worker status data', () => {
    const h = createMockH()

    sqsWorkerStatus.handler({}, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        data: expect.objectContaining({
          isRunning: true,
          expectedToRun: true
        })
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_STATUS_OK)
  })

  it('sets expectedToRun to false when skipSqsWorker is true', () => {
    config.get.mockImplementation((key) => {
      if (key === CONFIG_KEY_SKIP_SQS) {
        return true
      }
      if (key === CONFIG_KEY_S3_UPLOAD) {
        return false
      }
      return null
    })
    const h = createMockH()

    sqsWorkerStatus.handler({}, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expectedToRun: false })
      })
    )
  })

  it('includes environment mockMode in response', () => {
    config.get.mockImplementation((key) => {
      if (key === CONFIG_KEY_SKIP_SQS) {
        return false
      }
      if (key === CONFIG_KEY_S3_UPLOAD) {
        return true
      }
      return null
    })
    const h = createMockH()

    sqsWorkerStatus.handler({}, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          environment: { mockMode: true, skipWorker: false }
        })
      })
    )
  })

  it('spreads worker getStatus fields into response data', () => {
    sqsWorker.getStatus.mockReturnValue({ isRunning: false, queueDepth: 5 })
    const h = createMockH()

    sqsWorkerStatus.handler({}, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isRunning: false, queueDepth: 5 })
      })
    )
  })
})
