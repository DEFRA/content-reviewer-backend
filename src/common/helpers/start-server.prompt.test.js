/**
 * start-server.prompt.test.js
 *
 * Tests for the prompt-seeding behaviour in startServer:
 *   - promptManager.uploadPrompt() is called after the server starts
 *   - The .catch() handler logs an error when uploadPrompt() rejects
 */

import { describe, test, expect, beforeEach, vi } from 'vitest'

const { mockCreateServer, mockUploadPrompt } = vi.hoisted(() => ({
  mockCreateServer: vi.fn(),
  mockUploadPrompt: vi.fn()
}))

vi.mock('../../server.js', () => ({
  createServer: (...args) => mockCreateServer(...args)
}))

vi.mock('./prompt-manager.js', () => ({
  promptManager: {
    uploadPrompt: (...args) => mockUploadPrompt(...args)
  }
}))

vi.mock('../../config.js', () => ({
  config: {
    get: vi.fn(() => 3000)
  }
}))

describe('startServer — prompt seeding', () => {
  let startServer

  beforeEach(async () => {
    vi.clearAllMocks()
    mockUploadPrompt.mockResolvedValue(true)
    const mod = await import('./start-server.js')
    startServer = mod.startServer
  })

  test('calls promptManager.uploadPrompt after the server starts', async () => {
    const mockServer = {
      start: vi.fn().mockResolvedValue(undefined),
      logger: { info: vi.fn(), error: vi.fn() }
    }
    mockCreateServer.mockResolvedValue(mockServer)

    await startServer()
    // Allow the unawaited promise to settle
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockUploadPrompt).toHaveBeenCalled()
  })

  test('logs server.logger.error when promptManager.uploadPrompt rejects', async () => {
    const mockServer = {
      start: vi.fn().mockResolvedValue(undefined),
      logger: { info: vi.fn(), error: vi.fn() }
    }
    mockCreateServer.mockResolvedValue(mockServer)
    mockUploadPrompt.mockRejectedValueOnce(new Error('S3 not available'))

    await startServer()
    // Allow the unawaited .catch() handler to execute
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockServer.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'S3 not available' }),
      expect.stringContaining('Failed to seed system prompt')
    )
  })
})
