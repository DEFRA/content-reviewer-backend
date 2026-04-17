import { describe, test, expect } from 'vitest'
import { tracing } from '@defra/hapi-tracing'
import { config } from '../../config.js'
import { requestTracing } from './request-tracing.js'

describe('#requestTracing', () => {
  test('Should export a requestTracing object', () => {
    expect(requestTracing).toBeDefined()
    expect(typeof requestTracing).toBe('object')
  })

  test('Should use tracing.plugin from @defra/hapi-tracing', () => {
    expect(requestTracing.plugin).toBe(tracing.plugin)
  })

  test('Should have an options object', () => {
    expect(requestTracing.options).toBeDefined()
    expect(typeof requestTracing.options).toBe('object')
  })

  test('Should have a tracingHeader option', () => {
    expect(requestTracing.options).toHaveProperty('tracingHeader')
    expect(typeof requestTracing.options.tracingHeader).toBe('string')
  })

  test('Should use the tracingHeader from config', () => {
    expect(requestTracing.options.tracingHeader).toBe(
      config.get('tracing.header')
    )
  })
})