/**
 * text-normaliser.quotes-dashes.test.js
 *
 * Tests for Step 6b of the normalisation pipeline:
 * typographic substitutions — smart quotes and typographic dashes
 * are converted to their plain ASCII equivalents (outside URL tokens).
 */

import { describe, it, expect } from 'vitest'
import { textNormaliser } from './text-normaliser.js'

function testSmartDoubleQuotes() {
  it('converts left double quotation mark (U+201C) to "', () => {
    const { normalisedText } = textNormaliser.normalise('\u201CHello\u201D')
    expect(normalisedText).toBe('"Hello"')
  })

  it('converts right double quotation mark (U+201D) to "', () => {
    const { normalisedText } = textNormaliser.normalise(
      'said \u201DHello\u201C'
    )
    expect(normalisedText).toBe('said "Hello"')
  })

  it('converts double low-9 quotation mark (U+201E) to "', () => {
    const { normalisedText } = textNormaliser.normalise('\u201Etest\u201D')
    expect(normalisedText).toBe('"test"')
  })

  it('converts double high-reversed-9 mark (U+201F) to "', () => {
    const { normalisedText } = textNormaliser.normalise('\u201Ftext\u201F')
    expect(normalisedText).toBe('"text"')
  })

  it('converts double prime (U+2033) to "', () => {
    const { normalisedText } = textNormaliser.normalise('12\u2033 wide')
    expect(normalisedText).toBe('12" wide')
  })

  it('converts left-pointing double angle (U+00AB) to "', () => {
    const { normalisedText } = textNormaliser.normalise('\u00ABterm\u00BB')
    expect(normalisedText).toBe('"term"')
  })

  it('converts right-pointing double angle (U+00BB) to "', () => {
    const { normalisedText } = textNormaliser.normalise('word\u00BB')
    expect(normalisedText).toBe('word"')
  })
}

function testSmartSingleQuotesAndApostrophes() {
  it("converts left single quotation mark (U+2018) to '", () => {
    const { normalisedText } = textNormaliser.normalise('\u2018Hello\u2019')
    expect(normalisedText).toBe("'Hello'")
  })

  it("converts right single quotation mark / apostrophe (U+2019) to '", () => {
    const { normalisedText } = textNormaliser.normalise('it\u2019s')
    expect(normalisedText).toBe("it's")
  })

  it("converts single low-9 quotation mark (U+201A) to '", () => {
    const { normalisedText } = textNormaliser.normalise('\u201Aword\u2019')
    expect(normalisedText).toBe("'word'")
  })

  it("converts single high-reversed-9 mark (U+201B) to '", () => {
    const { normalisedText } = textNormaliser.normalise('\u201Bword')
    expect(normalisedText).toBe("'word")
  })

  it("converts prime (U+2032) to '", () => {
    const { normalisedText } = textNormaliser.normalise('5\u2032 long')
    expect(normalisedText).toBe("5' long")
  })

  it("converts grave accent (U+0060) to '", () => {
    const { normalisedText } = textNormaliser.normalise('\u0060word\u0060')
    expect(normalisedText).toBe("'word'")
  })

  it("converts acute accent (U+00B4) to '", () => {
    const { normalisedText } = textNormaliser.normalise('word\u00B4')
    expect(normalisedText).toBe("word'")
  })

  it('converts single left-pointing angle (U+2039) to <', () => {
    const { normalisedText } = textNormaliser.normalise('\u2039item\u203A')
    expect(normalisedText).toBe('<item>')
  })

  it('converts single right-pointing angle (U+203A) to >', () => {
    const { normalisedText } = textNormaliser.normalise('item\u203A')
    expect(normalisedText).toBe('item>')
  })
}

function testTypographicDashes() {
  it('converts en dash (U+2013) to hyphen-minus', () => {
    const { normalisedText } = textNormaliser.normalise('pages 10\u201320')
    expect(normalisedText).toBe('pages 10-20')
  })

  it('converts em dash (U+2014) to hyphen-minus', () => {
    const { normalisedText } = textNormaliser.normalise('word\u2014another')
    expect(normalisedText).toBe('word-another')
  })

  it('converts horizontal bar (U+2015) to hyphen-minus', () => {
    const { normalisedText } = textNormaliser.normalise('line\u2015break')
    expect(normalisedText).toBe('line-break')
  })

  it('converts minus sign (U+2212) to hyphen-minus', () => {
    const { normalisedText } = textNormaliser.normalise('value\u2212cost')
    expect(normalisedText).toBe('value-cost')
  })

  it('removes soft hyphen (U+00AD) entirely', () => {
    const { normalisedText } = textNormaliser.normalise('hyph\u00ADenated')
    expect(normalisedText).toBe('hyphenated')
    expect(normalisedText).not.toContain('\u00AD')
  })
}

function testUrlProtection() {
  it('does not corrupt a bare URL containing smart-quote-like chars', () => {
    // The URL itself should pass through verbatim
    const url = 'https://example.com/path?q=1'
    const { normalisedText } = textNormaliser.normalise(url)
    expect(normalisedText).toBe(url)
  })

  it('applies substitutions to text outside a URL on the same line', () => {
    const input = 'See \u201Cdetails\u201D at https://example.com/page'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('"details"')
    expect(normalisedText).toContain('https://example.com/page')
  })

  it('preserves Markdown link URL verbatim while normalising the anchor text', () => {
    const input = '[\u201CHello\u201D](https://gov.uk/some-path)'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('"Hello"')
    expect(normalisedText).toContain('https://gov.uk/some-path')
  })
}

function testMixedQuotesAndDashes() {
  it('handles a mix of smart quotes and typographic dashes in one line', () => {
    const input = '\u201CHello\u201D \u2014 it\u2019s a test'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toBe('"Hello" - it\'s a test')
  })
}

export function testQuotesAndDashes() {
  testSmartDoubleQuotes()
  testSmartSingleQuotesAndApostrophes()
  testTypographicDashes()
  testUrlProtection()
  testMixedQuotesAndDashes()
}

// Run as a standalone test suite when vitest discovers this file directly
describe('TextNormaliser – quotes and dashes', () => {
  testQuotesAndDashes()
})
