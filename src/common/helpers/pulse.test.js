import { describe, test, expect } from 'vitest'
import hapiPulse from 'hapi-pulse'
import { pulse } from './pulse.js'

describe('#pulse', () => {
  test('Should export a pulse object', () => {
    expect(pulse).toBeDefined()
    expect(typeof pulse).toBe('object')
  })

  test('Should use hapi-pulse as the plugin', () => {
    expect(pulse.plugin).toBe(hapiPulse)
  })

  test('Should have an options object', () => {
    expect(pulse.options).toBeDefined()
    expect(typeof pulse.options).toBe('object')
  })

  test('Should have a logger in options', () => {
    expect(pulse.options.logger).toBeDefined()
  })

  test('Should have a timeout of 10 seconds', () => {
    expect(pulse.options.timeout).toBe(10_000)
  })
})