/**
 * text-normaliser.mojibake.test.js
 *
 * Tests for Step 0 of the normalisation pipeline:
 *   Step 0 — Mojibake repair (UTF-8 decoded as Latin-1: Â£ → £, Â© → ©, etc.)
 *
 * Covers the _repairMojibake code path that is only exercised when the input
 * contains two-byte UTF-8 sequences that were incorrectly decoded as Latin-1.
 *
 * These 6 source lines are only reached when MOJIBAKE_2BYTE_RE matches, so
 * passing clean ASCII/Unicode text never exercises the repair branch.
 */

import { describe, it, expect } from 'vitest'
import { textNormaliser } from './text-normaliser.js'

// ── Mojibake repair (Step 0) ──────────────────────────────────────────────────

describe('TextNormaliser – mojibake repair (Step 0, uncovered lines)', () => {
  it('repairs Â£ (U+00C2 U+00A3) to £ (pound sign)', () => {
    // Â = U+00C2 (first byte of 2-byte UTF-8 sequence for £)
    // £ = U+00A3 (second byte as Latin-1 — in range 0x80-0xBF)
    const mojibake = '\u00C2\u00A3' // Â£ as separate Unicode code points
    const { normalisedText } = textNormaliser.normalise(mojibake)
    expect(normalisedText).toBe('\u00A3') // £
  })

  it('repairs Â© (U+00C2 U+00A9) to © (copyright sign)', () => {
    const mojibake = '\u00C2\u00A9' // Â©
    const { normalisedText } = textNormaliser.normalise(mojibake)
    expect(normalisedText).toBe('\u00A9') // ©
  })

  it('repairs Â® (U+00C2 U+00AE) to ® (registered sign)', () => {
    const mojibake = '\u00C2\u00AE' // Â®
    const { normalisedText } = textNormaliser.normalise(mojibake)
    expect(normalisedText).toBe('\u00AE') // ®
  })

  it('repairs mojibake within a longer string of clean text', () => {
    // The mojibake pair is embedded in ordinary ASCII text
    const input = 'Price: \u00C2\u00A350 per unit'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toBe('Price: \u00A350 per unit')
  })

  it('repairs multiple mojibake sequences in a single string', () => {
    // Two mojibake pairs: Â£ and Â©
    const input = 'Cost \u00C2\u00A310 \u00C2\u00A9 2025'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toBe('Cost \u00A310 \u00A9 2025')
  })

  it('repairs ÃÂ (U+00C3 followed by a continuation byte) sequence correctly', () => {
    // U+00C3 U+00A0 encodes à (U+00E0) in UTF-8 decoded as Latin-1
    // byte1 = 0xC3, byte2 = 0xA0
    // codepoint = ((0xC3 & 0x1F) << 6) | (0xA0 & 0x3F)
    //           = (0x03 << 6) | 0x20 = 0xC0 | 0x20 = 0xE0 = à
    const mojibake = '\u00C3\u00A0' // encodes à (U+00E0)
    const { normalisedText } = textNormaliser.normalise(mojibake)
    expect(normalisedText).toBe('\u00E0') // à
  })
})

// ── stats when mojibake repair shrinks the string ─────────────────────────────

describe('TextNormaliser – mojibake stats', () => {
  it('reports charsRemoved > 0 when mojibake pairs are repaired (2 chars → 1)', () => {
    // Each mojibake pair (2 chars) becomes 1 char → originalLength > normalisedLength
    const mojibake = '\u00C2\u00A3' // 2 chars → £ (1 char)
    const { stats } = textNormaliser.normalise(mojibake)
    expect(stats.charsRemoved).toBe(1)
    expect(stats.originalLength).toBe(2)
    expect(stats.normalisedLength).toBe(1)
  })
})

// ── clean text fast-path still works (no-mojibake branch) ─────────────────────

describe('TextNormaliser – clean text does not trigger mojibake repair', () => {
  it('passes clean ASCII through unchanged (fast-path: no mojibake detected)', () => {
    const clean = 'Hello world.'
    const { normalisedText } = textNormaliser.normalise(clean)
    expect(normalisedText).toBe(clean)
  })

  it('passes clean Unicode (smart quotes) through the mojibake fast-path unchanged', () => {
    // U+2018/U+2019 are smart quotes — they do NOT match the mojibake pattern
    // because they are not in the U+00C2-U+00DF lead-byte range
    const input = '\u2018Hello\u2019'
    const { normalisedText } = textNormaliser.normalise(input)
    // Smart quotes are normalised to ASCII by the per-line pass (Step 6b), not Step 0
    expect(normalisedText).toBe("'Hello'")
  })
})
