import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Constants ──────────────────────────────────────────────────────────────
const HTTP_OK = 200
const HTTP_INTERNAL_SERVER_ERROR = 500

// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock('../common/helpers/prompt-manager.js', () => ({
  promptManager: {
    uploadPrompt: vi.fn(),
    clearCache: vi.fn()
  }
}))

vi.mock('../common/helpers/logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

import { promptManager } from '../common/helpers/prompt-manager.js'
import { adminRoutes } from './admin.js'

// ── Helpers ────────────────────────────────────────────────────────────────
function createMockH() {
  const responseMock = { code: vi.fn().mockReturnThis() }
  return {
    response: vi.fn(() => responseMock),
    _responseMock: responseMock
  }
}

function getRoutes() {
  const routes = []
  const server = { route: vi.fn((defs) => routes.push(...defs)) }
  adminRoutes.plugin.register(server)
  return routes
}

function getUploadHandler() {
  return getRoutes().find((r) => r.path === '/admin/prompt/upload').handler
}

function getClearCacheHandler() {
  return getRoutes().find((r) => r.path === '/admin/prompt/cache/clear').handler
}

// ── Plugin structure ───────────────────────────────────────────────────────
describe('adminRoutes plugin', () => {
  it('exports a Hapi plugin named adminRoutes', () => {
    expect(adminRoutes.plugin.name).toBe('adminRoutes')
    expect(typeof adminRoutes.plugin.register).toBe('function')
  })

  it('registers exactly two routes', () => {
    const server = { route: vi.fn() }
    adminRoutes.plugin.register(server)
    const [routeDefs] = server.route.mock.calls[0]
    expect(routeDefs).toHaveLength(2)
  })

  it('both routes use POST method', () => {
    const routes = getRoutes()
    expect(routes.every((r) => r.method === 'POST')).toBe(true)
  })

  it('registers /admin/prompt/upload route', () => {
    const routes = getRoutes()
    expect(routes.some((r) => r.path === '/admin/prompt/upload')).toBe(true)
  })

  it('registers /admin/prompt/cache/clear route', () => {
    const routes = getRoutes()
    expect(routes.some((r) => r.path === '/admin/prompt/cache/clear')).toBe(
      true
    )
  })
})

// ── POST /admin/prompt/upload ─────────────────────────────────────────────
describe('POST /admin/prompt/upload - success', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = getUploadHandler()
    promptManager.uploadPrompt.mockResolvedValue(undefined)
  })

  it('calls promptManager.uploadPrompt()', async () => {
    const h = createMockH()
    await handler({}, h)
    expect(promptManager.uploadPrompt).toHaveBeenCalledTimes(1)
  })

  it('returns 200 with success message', async () => {
    const h = createMockH()
    await handler({}, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'System prompt uploaded to S3 successfully'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_OK)
  })

  it('includes a timestamp in the response', async () => {
    const h = createMockH()
    await handler({}, h)

    const [payload] = h.response.mock.calls[0]
    expect(typeof payload.timestamp).toBe('string')
    expect(() => new Date(payload.timestamp)).not.toThrow()
  })
})

describe('POST /admin/prompt/upload - error', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = getUploadHandler()
    promptManager.uploadPrompt.mockRejectedValue(new Error('S3 unavailable'))
  })

  it('returns 500 when uploadPrompt throws', async () => {
    const h = createMockH()
    await handler({}, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Failed to upload system prompt',
        error: 'S3 unavailable'
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(
      HTTP_INTERNAL_SERVER_ERROR
    )
  })

  it('does not throw; wraps the error in a 500 response', async () => {
    const h = createMockH()
    await expect(handler({}, h)).resolves.not.toThrow()
  })
})

// ── POST /admin/prompt/cache/clear ────────────────────────────────────────
describe('POST /admin/prompt/cache/clear - success', () => {
  let handler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = getClearCacheHandler()
    promptManager.clearCache.mockReturnValue(undefined)
  })

  it('calls promptManager.clearCache()', () => {
    const h = createMockH()
    handler({}, h)
    expect(promptManager.clearCache).toHaveBeenCalledTimes(1)
  })

  it('returns 200 with cache-cleared message', () => {
    const h = createMockH()
    handler({}, h)

    expect(h.response).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('System prompt cache cleared')
      })
    )
    expect(h._responseMock.code).toHaveBeenCalledWith(HTTP_OK)
  })

  it('includes a timestamp in the response', () => {
    const h = createMockH()
    handler({}, h)

    const [payload] = h.response.mock.calls[0]
    expect(typeof payload.timestamp).toBe('string')
  })
})
