import { describe, test, expect, vi } from 'vitest'
import { loggerOptions } from './logger-options.js'

// vi.hoisted ensures mockGetTraceId is initialised before vi.mock's factory
// runs, so the factory can reference it without a direct import of getTraceId.
const mockGetTraceId = vi.hoisted(() => vi.fn().mockReturnValue(null))

vi.mock('@defra/hapi-tracing', () => ({
  getTraceId: mockGetTraceId
}))

describe('Logger Options', () => {
  test('Should export loggerOptions object', () => {
    expect(loggerOptions).toBeDefined()
    expect(typeof loggerOptions).toBe('object')
  })

  test('Should have enabled property', () => {
    expect(loggerOptions).toHaveProperty('enabled')
    expect(typeof loggerOptions.enabled).toBe('boolean')
  })

  test('Should have ignorePaths array', () => {
    expect(loggerOptions).toHaveProperty('ignorePaths')
    expect(Array.isArray(loggerOptions.ignorePaths)).toBe(true)
    expect(loggerOptions.ignorePaths).toContain('/health')
  })

  test('Should have redact configuration', () => {
    expect(loggerOptions).toHaveProperty('redact')
    expect(loggerOptions.redact).toHaveProperty('paths')
    expect(loggerOptions.redact).toHaveProperty('remove')
    expect(loggerOptions.redact.remove).toBe(true)
  })

  test('Should have log level', () => {
    expect(loggerOptions).toHaveProperty('level')
    expect(typeof loggerOptions.level).toBe('string')
  })

  test('Should have nesting enabled', () => {
    expect(loggerOptions).toHaveProperty('nesting')
    expect(loggerOptions.nesting).toBe(true)
  })

  test('Should have mixin function', () => {
    expect(loggerOptions).toHaveProperty('mixin')
    expect(typeof loggerOptions.mixin).toBe('function')
  })

  test('Mixin function should return object', () => {
    const mixinResult = loggerOptions.mixin()
    expect(typeof mixinResult).toBe('object')
    expect(mixinResult).not.toBeNull()
  })

  test('Mixin should return empty object when no traceId', () => {
    mockGetTraceId.mockReturnValueOnce(null)
    const result = loggerOptions.mixin()
    expect(result).toEqual({})
  })

  test('Mixin should include trace.id when traceId is available', () => {
    mockGetTraceId.mockReturnValueOnce('abc-123')
    const result = loggerOptions.mixin()
    expect(result.trace).toEqual({ id: 'abc-123' })
  })
})
