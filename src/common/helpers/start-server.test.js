import { describe, test, expect, beforeEach, vi } from 'vitest'

const mockCreateServer = vi.fn()

vi.mock('../../server.js', () => ({
  createServer: (...args) => mockCreateServer(...args)
}))

describe('#startServer', () => {
  let startServerImport

  beforeEach(async () => {
    vi.clearAllMocks()
    startServerImport = await import('./start-server.js')
  })

  describe('When server starts', () => {
    test('Should start up server as expected', async () => {
      const mockServer = {
        start: vi.fn().mockResolvedValue(undefined),
        logger: { info: vi.fn(), error: vi.fn() }
      }
      mockCreateServer.mockResolvedValue(mockServer)

      await startServerImport.startServer()

      expect(mockCreateServer).toHaveBeenCalled()
      expect(mockServer.start).toHaveBeenCalled()
    })
  })

  describe('When server start fails', () => {
    test('Should log failed startup message', async () => {
      mockCreateServer.mockRejectedValue(new Error('Server failed to start'))

      await expect(startServerImport.startServer()).rejects.toThrow(
        'Server failed to start'
      )
    })
  })
})
