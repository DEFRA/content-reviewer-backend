/**
 * text-normaliser.unicode-ligatures.test.js
 *
 * Tests for Steps 2 & 3 of the normalisation pipeline:
 *   Step 2 — Unicode NFC composition
 *   Step 3 — Ligature expansion (PDF artefacts: ﬁ → fi, ﬀ → ff, etc.)
 */

import { describe, it, expect } from 'vitest'
import { textNormaliser } from './text-normaliser.js'

export function testUnicodeAndLigatures() {
  // ── NFC normalisation ───────────────────────────────────────────────────

  it('composes NFD é (e + combining acute) into NFC é (U+00E9)', () => {
    // NFD: e (U+0065) + combining acute accent (U+0301) → NFC: é (U+00E9)
    const nfd = 'caf\u0065\u0301' // café in NFD
    const { normalisedText } = textNormaliser.normalise(nfd)
    expect(normalisedText).toBe('caf\u00E9') // café in NFC
  })

  it('leaves already-NFC text unchanged', () => {
    const text = 'caf\u00E9' // é as a single code point
    const { normalisedText } = textNormaliser.normalise(text)
    expect(normalisedText).toBe(text)
  })

  it('normalises multiple combining characters in one pass', () => {
    // ñ via NFD (n + combining tilde)
    const nfd = 'ma\u006E\u0303ana'
    const { normalisedText } = textNormaliser.normalise(nfd)
    expect(normalisedText).toBe('ma\u00F1ana')
  })

  // ── Ligature expansion ──────────────────────────────────────────────────

  it('expands ﬁ (U+FB01) to "fi"', () => {
    const { normalisedText } = textNormaliser.normalise('\uFB01nance')
    expect(normalisedText).toBe('finance')
  })

  it('expands ﬂ (U+FB02) to "fl"', () => {
    const { normalisedText } = textNormaliser.normalise('\uFB02oor')
    expect(normalisedText).toBe('floor')
  })

  it('expands ﬀ (U+FB00) to "ff"', () => {
    const { normalisedText } = textNormaliser.normalise('\uFB00ect')
    expect(normalisedText).toBe('ffect')
  })

  it('expands ﬃ (U+FB03) to "ffi"', () => {
    const { normalisedText } = textNormaliser.normalise('o\uFB03cial')
    expect(normalisedText).toBe('official')
  })

  it('expands ﬄ (U+FB04) to "ffl"', () => {
    const { normalisedText } = textNormaliser.normalise('a\uFB04uent')
    expect(normalisedText).toBe('affluent')
  })

  it('expands ﬅ (U+FB05) to "st"', () => {
    const { normalisedText } = textNormaliser.normalise('\uFB05atement')
    expect(normalisedText).toBe('statement')
  })

  it('expands ﬆ (U+FB06) to "st"', () => {
    const { normalisedText } = textNormaliser.normalise('\uFB06reet')
    expect(normalisedText).toBe('street')
  })

  it('expands multiple different ligatures in one string', () => {
    const { normalisedText } = textNormaliser.normalise(
      '\uFB01ne \uFB02oor \uFB00ect'
    )
    expect(normalisedText).toBe('fine floor ffect')
  })

  it('stats.charsRemoved is negative when ligatures expand (text gets longer)', () => {
    // ﬃ (1 char) → ffi (3 chars): net change = +2, so charsRemoved = -2
    const { stats } = textNormaliser.normalise('\uFB03')
    expect(stats.charsRemoved).toBeLessThan(0)
  })

  // ── CJK / non-Latin Unicode passes through untouched ────────────────────

  it('leaves CJK characters unchanged', () => {
    const text = '政府文件'
    const { normalisedText } = textNormaliser.normalise(text)
    expect(normalisedText).toBe(text)
  })

  it('leaves Arabic script unchanged', () => {
    const text = 'مرحبا بالعالم'
    const { normalisedText } = textNormaliser.normalise(text)
    expect(normalisedText).toBe(text)
  })

  it('leaves Devanagari script unchanged', () => {
    const text = 'नमस्ते दुनिया'
    const { normalisedText } = textNormaliser.normalise(text)
    expect(normalisedText).toBe(text)
  })

  it('leaves emoji unchanged', () => {
    const text = 'Hello 👋 World 🌍'
    const { normalisedText } = textNormaliser.normalise(text)
    expect(normalisedText).toBe(text)
  })
}

// Run as a standalone test suite when vitest discovers this file directly
describe('TextNormaliser – unicode and ligatures', () => {
  testUnicodeAndLigatures()
})
