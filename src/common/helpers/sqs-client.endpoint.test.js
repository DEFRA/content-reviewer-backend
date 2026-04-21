import { describe, test, expect, vi } from 'vitest'

// ── Purpose ───────────────────────────────────────────────────────────────────
// The primary sqs-client.test.js always returns null for 'aws.endpoint', so the
// true branch of `if (awsEndpoint)` in the SQSClientHelper constructor (lines
// 18-20) is never executed there.  This file mocks config to return a LocalStack
// endpoint, causing the branch to execute and setting sqsConfig.endpoint.

// ── Hoisted captures ──────────────────────────────────────────────────────────

const mockConstructorArg = vi.hoisted(() => ({ value: null }))

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(function (sqsConfig) {
    mockConstructorArg.value = sqsConfig
    this.send = vi.fn()
  }),
  SendMessageCommand: vi.fn(function (params) {
    Object.assign(this, params)
    return this
  })
}))

vi.mock('../../config.js', () => ({
  config: {
    get: vi.fn((key) => {
      const configMap = {
        'aws.region': 'eu-west-2',
        'aws.endpoint': 'http://localhost:4566',
        'sqs.queueUrl':
          'https://sqs.eu-west-2.amazonaws.com/123456789/test-queue',
        'sqs.queueName': 'test-queue'
      }
      return configMap[key] ?? null
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

// ── Import under test ─────────────────────────────────────────────────────────

import { sqsClient } from './sqs-client.js'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SQSClientHelper — aws.endpoint configured (lines 18-20 true branch)', () => {
  test('passes endpoint to SQSClient constructor when aws.endpoint is set', () => {
    expect(mockConstructorArg.value).not.toBeNull()
    expect(mockConstructorArg.value.endpoint).toBe('http://localhost:4566')
    expect(mockConstructorArg.value.region).toBe('eu-west-2')
  })

  test('initialises queueUrl and queueName correctly', () => {
    expect(sqsClient.queueUrl).toBe(
      'https://sqs.eu-west-2.amazonaws.com/123456789/test-queue'
    )
    expect(sqsClient.queueName).toBe('test-queue')
  })
})
