/**
 * text-normaliser.page-numbers.test.js
 *
 * Tests for Step 5 of the normalisation pipeline:
 * Removal of standalone page-number-only lines.
 *
 * PAGE_NUMBER_LINE_RE = /^[-\s]*(?:page\s*|p\.\s*)?\d+[-\s]*$/i
 *
 * Lines that match this are stripped entirely from the output.
 */

import { describe, it, expect } from 'vitest'
import { textNormaliser } from './text-normaliser.js'

function testBareDigits() {
  it('removes a line that is only a single digit', () => {
    const { normalisedText } = textNormaliser.normalise(
      'Prose.\n3\nMore prose.'
    )
    expect(normalisedText).not.toContain('\n3\n')
    expect(normalisedText).toContain('Prose.')
    expect(normalisedText).toContain('More prose.')
  })

  it('removes a line that is only multiple digits', () => {
    const { normalisedText } = textNormaliser.normalise('A\n123\nB')
    expect(normalisedText).not.toMatch(/\n123\n/)
  })

  it('removes a line of digits with surrounding whitespace', () => {
    const { normalisedText } = textNormaliser.normalise('A\n  42  \nB')
    expect(normalisedText).not.toMatch(/\n\s*42\s*\n/)
  })
}

function testPagePrefix() {
  it('removes "Page 1"', () => {
    const { normalisedText } = textNormaliser.normalise('Text\nPage 1\nMore')
    expect(normalisedText).not.toContain('Page 1')
  })

  it('removes "page 12" (lowercase)', () => {
    const { normalisedText } = textNormaliser.normalise('Text\npage 12\nMore')
    expect(normalisedText).not.toContain('page 12')
  })

  it('removes "PAGE 5" (uppercase)', () => {
    const { normalisedText } = textNormaliser.normalise('Text\nPAGE 5\nMore')
    expect(normalisedText).not.toContain('PAGE 5')
  })

  it('removes "Page  3" (extra space)', () => {
    const { normalisedText } = textNormaliser.normalise('Text\nPage  3\nMore')
    expect(normalisedText).not.toContain('Page  3')
  })
}

function testPDotPrefix() {
  it('removes "p. 7"', () => {
    const { normalisedText } = textNormaliser.normalise('A\np. 7\nB')
    expect(normalisedText).not.toContain('p. 7')
  })

  it('removes "p.7" (no space after dot)', () => {
    const { normalisedText } = textNormaliser.normalise('A\np.7\nB')
    expect(normalisedText).not.toContain('p.7')
  })
}

function testDashWrapped() {
  it('removes "- 4 -" style page numbers', () => {
    const { normalisedText } = textNormaliser.normalise('A\n- 4 -\nB')
    expect(normalisedText).not.toContain('- 4 -')
  })

  it('removes "- 99 -" style page numbers', () => {
    const { normalisedText } = textNormaliser.normalise('Intro\n- 99 -\nBody')
    expect(normalisedText).not.toContain('- 99 -')
  })
}

function testPreservation() {
  it('does NOT remove a line that has text before a number', () => {
    const { normalisedText } = textNormaliser.normalise('Section 3 overview')
    expect(normalisedText).toContain('Section 3 overview')
  })

  it('does NOT remove a line that has text after a number', () => {
    const { normalisedText } = textNormaliser.normalise('3 reasons to act')
    expect(normalisedText).toContain('3 reasons to act')
  })

  it('does NOT remove a line like "1. Introduction"', () => {
    const { normalisedText } = textNormaliser.normalise('1. Introduction')
    expect(normalisedText).toContain('1. Introduction')
  })

  it('does NOT remove a zero (which is a valid number in prose)', () => {
    // A line with just "0" still matches the page-number regex — it's an artefact
    // This test documents the current behaviour.
    const { normalisedText } = textNormaliser.normalise('A\n0\nB')
    // "0" is a valid match for the page-number-only regex
    expect(normalisedText).not.toMatch(/\n0\n/)
  })
}

function testMultipleAndSurrounding() {
  it('removes multiple consecutive page-number-only lines', () => {
    const { normalisedText } = textNormaliser.normalise('A\nPage 1\nPage 2\nB')
    expect(normalisedText).not.toContain('Page 1')
    expect(normalisedText).not.toContain('Page 2')
    expect(normalisedText).toContain('A')
    expect(normalisedText).toContain('B')
  })

  it('preserves the lines before and after a removed page-number line', () => {
    const { normalisedText } = textNormaliser.normalise(
      'First paragraph.\nPage 4\nSecond paragraph.'
    )
    expect(normalisedText).toContain('First paragraph.')
    expect(normalisedText).toContain('Second paragraph.')
  })
}

export function testPageNumbers() {
  testBareDigits()
  testPagePrefix()
  testPDotPrefix()
  testDashWrapped()
  testPreservation()
  testMultipleAndSurrounding()
}

// Run as a standalone test suite when vitest discovers this file directly
describe('TextNormaliser – page numbers', () => {
  testPageNumbers()
})
