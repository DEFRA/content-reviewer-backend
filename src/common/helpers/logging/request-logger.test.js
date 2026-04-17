import { describe, test, expect } from 'vitest'
import hapiPino from 'hapi-pino'
import { requestLogger } from './request-logger.js'

describe('#requestLogger', () => {
  test('Should export a requestLogger object', () => {
    expect(requestLogger).toBeDefined()
    expect(typeof requestLogger).toBe('object')
  })

  test('Should use hapi-pino as the plugin', () => {
    expect(requestLogger.plugin).toBe(hapiPino)
  })

  test('Should have an options object', () => {
    expect(requestLogger.options).toBeDefined()
    expect(typeof requestLogger.options).toBe('object')
  })

  test('Should ignore the /health path', () => {
    expect(requestLogger.options.ignorePaths).toContain('/health')
  })

  test('Should have nesting enabled', () => {
    expect(requestLogger.options.nesting).toBe(true)
  })

  test('Should have a mixin function', () => {
    expect(typeof requestLogger.options.mixin).toBe('function')
  })

  test('Mixin function should return an object', () => {
    const result = requestLogger.options.mixin()
    expect(result).toBeDefined()
    expect(typeof result).toBe('object')
  })
})
