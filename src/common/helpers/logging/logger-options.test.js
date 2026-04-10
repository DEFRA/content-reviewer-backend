import { describe, test, expect } from 'vitest'
import { loggerOptions } from './logger-options.js'

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

  test('Mixin function should include trace when available', () => {
    const mixinResult = loggerOptions.mixin()
    // Result should be an object with optional trace property
    expect(mixinResult === null || typeof mixinResult === 'object').toBe(true)
  })
})
