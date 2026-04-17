import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest'

// Use a plain boolean so clearMocks: true (which wipes vi.fn() call records
// between tests) cannot erase evidence of the top-level startServer() call
// that happens once when the module is first imported in beforeAll.
let startServerWasCalled = false
const mockLoggerInfo = vi.fn()
const mockLoggerError = vi.fn()

vi.mock('./common/helpers/start-server.js', () => ({
  startServer: () => {
    startServerWasCalled = true
    return Promise.resolve(undefined)
  }
}))

vi.mock('./common/helpers/logging/logger.js', () => ({
  createLogger: () => ({ info: mockLoggerInfo, error: mockLoggerError })
}))

describe('#index', () => {
  let unhandledRejectionHandler
  let originalExitCode

  beforeAll(async () => {
    originalExitCode = process.exitCode
    const processOnSpy = vi.spyOn(process, 'on')
    await import('./index.js')
    unhandledRejectionHandler = processOnSpy.mock.calls.find(
      ([event]) => event === 'unhandledRejection'
    )?.[1]
    processOnSpy.mockRestore()
  })

  afterAll(() => {
    process.exitCode = originalExitCode
  })

  test('Should call startServer on load', () => {
    expect(startServerWasCalled).toBe(true)
  })

  describe('unhandledRejection handler', () => {
    test('Should register an unhandledRejection handler', () => {
      expect(unhandledRejectionHandler).toBeTypeOf('function')
    })

    test('Should log info, log the error and set exitCode to 1', () => {
      const error = new Error('test unhandled rejection')

      unhandledRejectionHandler(error)

      expect(mockLoggerInfo).toHaveBeenCalledWith('Unhandled rejection')
      expect(mockLoggerError).toHaveBeenCalledWith(error)
      expect(process.exitCode).toBe(1)
    })
  })
})
