import { describe, it, expect, vi } from 'vitest'
import { health } from './health.js'

describe('health route', () => {
  it('has GET method and /health path', () => {
    expect(health.method).toBe('GET')
    expect(health.path).toBe('/health')
  })

  it('handler returns success message', () => {
    const responseMock = {}
    const h = { response: vi.fn(() => responseMock) }

    const result = health.handler({}, h)

    expect(h.response).toHaveBeenCalledWith({ message: 'success' })
    expect(result).toBe(responseMock)
  })

  it('handler ignores the request argument', () => {
    const responseMock = {}
    const h = { response: vi.fn(() => responseMock) }

    health.handler(null, h)

    expect(h.response).toHaveBeenCalledWith({ message: 'success' })
  })
})
