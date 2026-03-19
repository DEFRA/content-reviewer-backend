/**
 * text-normaliser.control-chars.test.js
 *
 * Tests for Step 1 of the normalisation pipeline:
 * removal of invisible / control characters (BOM, null, VT, FF, etc.).
 */

import { describe, it, expect } from 'vitest'
import { textNormaliser } from './text-normaliser.js'

export function testControlChars() {
  // ── BOM (U+FEFF) ────────────────────────────────────────────────────────

  it('strips a leading BOM (U+FEFF)', () => {
    const { normalisedText } = textNormaliser.normalise('\uFEFFHello world.')
    expect(normalisedText).toBe('Hello world.')
    expect(normalisedText).not.toContain('\uFEFF')
  })

  it('strips a BOM embedded mid-text', () => {
    const { normalisedText } = textNormaliser.normalise('Hello\uFEFF world.')
    expect(normalisedText).not.toContain('\uFEFF')
  })

  it('strips multiple BOMs', () => {
    const { normalisedText } = textNormaliser.normalise(
      '\uFEFF\uFEFFText\uFEFF'
    )
    expect(normalisedText).not.toContain('\uFEFF')
    expect(normalisedText).toBe('Text')
  })

  // ── Null byte (U+0000) ──────────────────────────────────────────────────

  it('strips null bytes (U+0000)', () => {
    const { normalisedText } = textNormaliser.normalise('Hello\u0000World')
    expect(normalisedText).not.toContain('\u0000')
    expect(normalisedText).toBe('HelloWorld')
  })

  // ── Vertical tab (U+000B) ───────────────────────────────────────────────

  it('strips vertical tab (U+000B)', () => {
    const { normalisedText } = textNormaliser.normalise(
      'Line one\u000BLine two'
    )
    expect(normalisedText).not.toContain('\u000B')
  })

  // ── Form feed (U+000C) ──────────────────────────────────────────────────

  it('strips form feed (U+000C)', () => {
    const { normalisedText } = textNormaliser.normalise(
      'Page one\u000CPage two'
    )
    expect(normalisedText).not.toContain('\u000C')
  })

  // ── Combinations ────────────────────────────────────────────────────────

  it('strips multiple different control characters in one pass', () => {
    const input = '\uFEFF\u0000Hello\u000B\u000CWorld'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toBe('HelloWorld')
  })

  it('preserves normal tab characters as spaces (not stripped by control-char step)', () => {
    // Tabs are converted to spaces in per-line normalisation (Step 6a), not stripped here.
    const { normalisedText } = textNormaliser.normalise('Hello\tWorld')
    expect(normalisedText).not.toContain('\t')
    expect(normalisedText).toContain('Hello World')
  })

  it('preserves regular newlines', () => {
    const { normalisedText } = textNormaliser.normalise('Line one\nLine two')
    expect(normalisedText).toBe('Line one\nLine two')
  })

  // ── stats reflect characters removed ────────────────────────────────────

  it('stats.charsRemoved accounts for stripped control characters', () => {
    const input = '\uFEFFHello'
    const { stats } = textNormaliser.normalise(input)
    // BOM removed + leading/trailing trim: at least 1 char removed
    expect(stats.charsRemoved).toBeGreaterThanOrEqual(1)
  })
}

// Run as a standalone test suite when vitest discovers this file directly
describe('TextNormaliser – control characters', () => {
  testControlChars()
})
