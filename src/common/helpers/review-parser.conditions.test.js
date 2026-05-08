import { describe, it, expect, vi } from 'vitest'

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

import { parseBedrockResponse } from './review-parser.js'

describe('parseBedrockResponse - malformed score line', () => {
  it('skips score line where value does not match digit/5 pattern', () => {
    const response = [
      '[SCORES]',
      'Clarity: great/5 - Not a valid score',
      '[/SCORES]'
    ].join('\n')
    const result = parseBedrockResponse(response)
    expect(result.scores.clarity).toBeUndefined()
  })
})

describe('parseBedrockResponse - score line with no dash', () => {
  it('skips score line where there is no dash after position 3', () => {
    const response = ['[SCORES]', 'Clarity: 3/5 NoDashHere', '[/SCORES]'].join(
      '\n'
    )
    const result = parseBedrockResponse(response)
    expect(result.scores.clarity).toBeUndefined()
  })
})
