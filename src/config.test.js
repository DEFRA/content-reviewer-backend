import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest'

describe('#config – default (test) environment', () => {
  test('Should export a config object', async () => {
    const { config } = await import('./config.js')
    expect(config).toBeDefined()
    expect(typeof config.get).toBe('function')
  })

  test('log.format should default to pino-pretty in non-production', async () => {
    const { config } = await import('./config.js')
    expect(config.get('log.format')).toBe('pino-pretty')
  })

  test('log.redact should default to request fields in non-production', async () => {
    const { config } = await import('./config.js')
    expect(config.get('log.redact')).toEqual(['req', 'res', 'responseTime'])
  })
})

describe('#config – production environment', () => {
  let prodConfig
  const originalNodeEnv = process.env.NODE_ENV

  beforeAll(async () => {
    process.env.NODE_ENV = 'production'
    vi.resetModules()
    const mod = await import('./config.js')
    prodConfig = mod.config
  })

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv
    vi.resetModules()
  })

  test('log.format should be ecs in production', () => {
    expect(prodConfig.get('log.format')).toBe('ecs')
  })

  test('log.redact should include auth headers in production', () => {
    const redact = prodConfig.get('log.redact')
    expect(redact).toContain('req.headers.authorization')
    expect(redact).toContain('req.headers.cookie')
    expect(redact).toContain('res.headers')
  })
})
