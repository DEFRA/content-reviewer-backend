import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock('../routes/health.js', () => ({
  health: { method: 'GET', path: '/health', handler: vi.fn() }
}))
vi.mock('../routes/review.js', () => ({
  reviewRoutes: { plugin: { name: 'reviewRoutes', register: vi.fn() } }
}))
vi.mock('../routes/results.js', () => ({
  results: { plugin: { name: 'results', register: vi.fn() } }
}))
vi.mock('../routes/sqs-worker-status.js', () => ({
  sqsWorkerStatus: {
    method: 'GET',
    path: '/sqs-worker-status',
    handler: vi.fn()
  }
}))
vi.mock('../routes/result-envelope.js', () => ({
  resultEnvelope: { plugin: { name: 'result-envelope', register: vi.fn() } }
}))
vi.mock('../routes/admin.js', () => ({
  adminRoutes: { plugin: { name: 'adminRoutes', register: vi.fn() } }
}))

import { health } from '../routes/health.js'
import { sqsWorkerStatus } from '../routes/sqs-worker-status.js'
import { reviewRoutes } from '../routes/review.js'
import { results } from '../routes/results.js'
import { resultEnvelope } from '../routes/result-envelope.js'
import { adminRoutes } from '../routes/admin.js'
import { router } from './router.js'

// ── Helpers ────────────────────────────────────────────────────────────────
function createMockServer() {
  return {
    route: vi.fn(),
    register: vi.fn().mockResolvedValue(undefined)
  }
}

// ── Plugin structure ───────────────────────────────────────────────────────
describe('router plugin', () => {
  it('exports a Hapi plugin named router', () => {
    expect(router.plugin.name).toBe('router')
    expect(typeof router.plugin.register).toBe('function')
  })
})

// ── Plugin registration ───────────────────────────────────────────────────
describe('router plugin - register', () => {
  let server

  beforeEach(() => {
    vi.clearAllMocks()
    server = createMockServer()
  })

  it('calls server.route with health and sqsWorkerStatus routes', async () => {
    await router.plugin.register(server, {})

    expect(server.route).toHaveBeenCalledTimes(1)
    const [routeArgs] = server.route.mock.calls[0]
    expect(routeArgs).toContain(health)
    expect(routeArgs).toContain(sqsWorkerStatus)
  })

  it('registers reviewRoutes, results, resultEnvelope and adminRoutes plugins', async () => {
    await router.plugin.register(server, {})

    expect(server.register).toHaveBeenCalledTimes(1)
    const [plugins] = server.register.mock.calls[0]
    expect(plugins).toContain(reviewRoutes)
    expect(plugins).toContain(results)
    expect(plugins).toContain(resultEnvelope)
    expect(plugins).toContain(adminRoutes)
  })

  it('awaits server.register (async registration)', async () => {
    server.register = vi.fn().mockResolvedValue(undefined)
    await expect(router.plugin.register(server, {})).resolves.not.toThrow()
    expect(server.register).toHaveBeenCalledTimes(1)
  })
})
