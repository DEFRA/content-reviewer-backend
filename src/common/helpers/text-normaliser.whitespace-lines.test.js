/**
 * text-normaliser.whitespace-lines.test.js
 *
 * Tests for Steps 4, 6 & 7–8 of the normalisation pipeline:
 *   Step 4  — CRLF / CR → LF line-ending normalisation
 *   Step 6a — Tab → single space
 *   Step 6c — Collapse intra-line multi-spaces (outside URLs / leading bullets)
 *   Step 6d — Trailing whitespace per line trimmed
 *   Step 7  — 3+ consecutive blank lines → 2
 *   Step 8  — Leading / trailing document whitespace trimmed
 */

import { describe, it, expect } from 'vitest'
import { textNormaliser } from './text-normaliser.js'

function testLineEndingNormalisation() {
  const LINE_ONE_TWO = 'Line one\nLine two'

  it('converts CRLF to LF', () => {
    const { normalisedText } = textNormaliser.normalise('Line one\r\nLine two')
    expect(normalisedText).toBe(LINE_ONE_TWO)
    expect(normalisedText).not.toContain('\r')
  })

  it('converts bare CR to LF', () => {
    const { normalisedText } = textNormaliser.normalise('Line one\rLine two')
    expect(normalisedText).toBe(LINE_ONE_TWO)
    expect(normalisedText).not.toContain('\r')
  })

  it('normalises mixed CRLF and bare CR in the same string', () => {
    const { normalisedText } = textNormaliser.normalise('A\r\nB\rC')
    expect(normalisedText).toBe('A\nB\nC')
    expect(normalisedText).not.toContain('\r')
  })

  it('leaves pure LF line endings unchanged', () => {
    const text = 'Line one\nLine two\nLine three'
    const { normalisedText } = textNormaliser.normalise(text)
    expect(normalisedText).toBe(text)
  })
}

function testTabToSpace() {
  it('converts a single tab to a space', () => {
    const { normalisedText } = textNormaliser.normalise('Hello\tWorld')
    expect(normalisedText).toBe('Hello World')
  })

  it('converts multiple tabs to spaces (which then collapse to one)', () => {
    const { normalisedText } = textNormaliser.normalise('A\t\t\tB')
    expect(normalisedText).toBe('A B')
  })
}

function testIntraLineMultiSpaceCollapse() {
  it('collapses two consecutive spaces to one', () => {
    const { normalisedText } = textNormaliser.normalise('Hello  World')
    expect(normalisedText).toBe('Hello World')
  })

  it('collapses many consecutive spaces to one', () => {
    const { normalisedText } = textNormaliser.normalise('A     B')
    expect(normalisedText).toBe('A B')
  })

  it('collapses spaces within a longer prose line', () => {
    const { normalisedText } = textNormaliser.normalise(
      'The  quick   brown  fox'
    )
    expect(normalisedText).toBe('The quick brown fox')
  })
}

function testTrailingWhitespace() {
  it('trims trailing spaces from a line', () => {
    const { normalisedText } = textNormaliser.normalise('Hello   ')
    expect(normalisedText).toBe('Hello')
  })

  it('trims trailing spaces from each line independently', () => {
    const { normalisedText } = textNormaliser.normalise(
      'Line one   \nLine two  '
    )
    expect(normalisedText).toBe('Line one\nLine two')
  })
}

function testBlankLineDeduplication() {
  it('collapses three consecutive blank lines to two', () => {
    const { normalisedText } = textNormaliser.normalise('A\n\n\nB')
    expect(normalisedText).toBe('A\n\nB')
  })

  it('collapses five consecutive blank lines to two', () => {
    const { normalisedText } = textNormaliser.normalise('A\n\n\n\n\nB')
    expect(normalisedText).toBe('A\n\nB')
  })

  it('leaves a single blank line unchanged', () => {
    const { normalisedText } = textNormaliser.normalise(
      'Para one.\n\nPara two.'
    )
    expect(normalisedText).toBe('Para one.\n\nPara two.')
  })

  it('leaves exactly two consecutive blank lines unchanged', () => {
    const { normalisedText } = textNormaliser.normalise('A\n\nB')
    expect(normalisedText).toBe('A\n\nB')
  })
}

function testDocumentLevelTrim() {
  it('trims leading whitespace from the document', () => {
    const { normalisedText } = textNormaliser.normalise('\n\nHello')
    expect(normalisedText).toBe('Hello')
  })

  it('trims trailing whitespace from the document', () => {
    const { normalisedText } = textNormaliser.normalise('Hello\n\n')
    expect(normalisedText).toBe('Hello')
  })

  it('trims both leading and trailing whitespace', () => {
    const { normalisedText } = textNormaliser.normalise('\n  Hello world.  \n')
    expect(normalisedText).toBe('Hello world.')
  })
}

function testBulletLeadingIndentation() {
  it('preserves leading spaces before a nested bullet in a multi-line document', () => {
    const input = '- Top level\n  - nested item'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('  - nested item')
  })

  it('preserves leading spaces before a numbered list item in a multi-line document', () => {
    const input = 'Introduction\n  1. first item'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('  1. first item')
  })
}

function testBlankLinesAsIs() {
  it('blank lines (whitespace-only) are preserved as empty lines', () => {
    const { normalisedText } = textNormaliser.normalise('A\n   \nB')
    // The whitespace-only middle line becomes a blank line
    expect(normalisedText).toBe('A\n\nB')
  })
}

export function testWhitespaceAndLines() {
  testLineEndingNormalisation()
  testTabToSpace()
  testIntraLineMultiSpaceCollapse()
  testTrailingWhitespace()
  testBlankLineDeduplication()
  testDocumentLevelTrim()
  testBulletLeadingIndentation()
  testBlankLinesAsIs()
}

// Run as a standalone test suite when vitest discovers this file directly
describe('TextNormaliser – whitespace and lines', () => {
  testWhitespaceAndLines()
})
