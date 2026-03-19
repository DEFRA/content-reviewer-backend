/**
 * text-normaliser.edge-cases.test.js
 *
 * Tests for edge-case / boundary inputs: null, undefined, empty string,
 * whitespace-only, single character, very large documents, etc.
 */

import { describe, it, expect } from 'vitest'
import { textNormaliser } from './text-normaliser.js'

export function testNormaliseEdgeCases() {
  // ── null / undefined / non-string ──────────────────────────────────────

  it('returns empty string for null input', () => {
    const { normalisedText } = textNormaliser.normalise(null)
    expect(normalisedText).toBe('')
  })

  it('returns empty string for undefined input', () => {
    const { normalisedText } = textNormaliser.normalise(undefined)
    expect(normalisedText).toBe('')
  })

  it('returns empty string for empty string input', () => {
    const { normalisedText } = textNormaliser.normalise('')
    expect(normalisedText).toBe('')
  })

  it('returns zero stats for null input', () => {
    const { stats } = textNormaliser.normalise(null)
    expect(stats).toEqual({
      originalLength: 0,
      normalisedLength: 0,
      charsRemoved: 0
    })
  })

  it('returns empty string for whitespace-only input', () => {
    const { normalisedText } = textNormaliser.normalise('   \t  \n  \n  ')
    expect(normalisedText).toBe('')
  })

  it('handles a single character', () => {
    const { normalisedText } = textNormaliser.normalise('A')
    expect(normalisedText).toBe('A')
  })

  it('handles a single newline', () => {
    const { normalisedText } = textNormaliser.normalise('\n')
    expect(normalisedText).toBe('')
  })

  // ── stats shape ─────────────────────────────────────────────────────────

  it('stats.originalLength equals input length', () => {
    const text = 'Hello world.'
    const { stats } = textNormaliser.normalise(text)
    expect(stats.originalLength).toBe(text.length)
  })

  it('stats.normalisedLength equals output length', () => {
    const text = 'Hello world.'
    const { normalisedText, stats } = textNormaliser.normalise(text)
    expect(stats.normalisedLength).toBe(normalisedText.length)
  })

  it('stats.charsRemoved equals originalLength − normalisedLength', () => {
    const text = '  Hello   world.  '
    const { normalisedText, stats } = textNormaliser.normalise(text)
    expect(stats.charsRemoved).toBe(text.length - normalisedText.length)
  })

  // ── large input ─────────────────────────────────────────────────────────

  const LARGE_DOC_REPEAT_COUNT = 3000
  const LARGE_CLEAN_PROSE_REPEAT_COUNT = 5000

  it('handles a 100 000-character document without error', () => {
    const text = 'This is a sentence of clean prose. '.repeat(
      LARGE_DOC_REPEAT_COUNT
    )
    expect(() => textNormaliser.normalise(text)).not.toThrow()
  })

  it('normalised output length is within bounds for a large clean document', () => {
    const text = 'Clean prose. '.repeat(LARGE_CLEAN_PROSE_REPEAT_COUNT)
    const { normalisedText } = textNormaliser.normalise(text)
    expect(normalisedText.length).toBeGreaterThan(0)
    expect(normalisedText.length).toBeLessThanOrEqual(text.length)
  })

  // ── plain ASCII passes through unchanged ────────────────────────────────

  it('leaves clean ASCII prose unchanged', () => {
    const text = 'The quick brown fox jumps over the lazy dog.'
    const { normalisedText } = textNormaliser.normalise(text)
    expect(normalisedText).toBe(text)
  })

  it('leaves multi-line clean prose unchanged', () => {
    const text = 'Line one.\nLine two.\nLine three.'
    const { normalisedText } = textNormaliser.normalise(text)
    expect(normalisedText).toBe(text)
  })
}

// Run as a standalone test suite when vitest discovers this file directly
describe('TextNormaliser – edge cases', () => {
  testNormaliseEdgeCases()
})
