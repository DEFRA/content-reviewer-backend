/**
 * text-normaliser.url-protection.test.js
 *
 * Tests that URL tokens and Markdown link targets are extracted before
 * typographic substitutions are applied and then restored verbatim —
 * ensuring link targets are never corrupted.
 *
 * URL_TOKEN_RE   matches bare https?/ftp/mailto URLs
 * MARKDOWN_LINK_RE  matches [anchor](url)
 */

import { describe, it, expect } from 'vitest'
import { textNormaliser } from './text-normaliser.js'

function testBareUrls() {
  it('preserves a plain https URL verbatim', () => {
    const url = 'https://www.gov.uk/guidance/some-policy'
    const { normalisedText } = textNormaliser.normalise(url)
    expect(normalisedText).toBe(url)
  })

  it('preserves a plain http URL verbatim', () => {
    const url = 'http://example.com/path?query=1&other=2'
    const { normalisedText } = textNormaliser.normalise(url)
    expect(normalisedText).toBe(url)
  })

  it('preserves a ftp URL verbatim', () => {
    const url = 'ftp://files.example.com/archive.zip'
    const { normalisedText } = textNormaliser.normalise(url)
    expect(normalisedText).toBe(url)
  })

  it('preserves a mailto URL verbatim', () => {
    const url = 'mailto:user@example.com'
    const { normalisedText } = textNormaliser.normalise(url)
    expect(normalisedText).toBe(url)
  })

  it('does not collapse spaces inside a URL', () => {
    // A URL should never have spaces but check the guard holds
    const input = 'Visit https://gov.uk/page for details.'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('https://gov.uk/page')
  })

  it('does not apply smart-quote substitution inside a URL', () => {
    // This should not be transformed even if the URL contains quote-like chars
    const input = 'See https://example.com/it%27s-fine for more.'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('https://example.com/it%27s-fine')
  })

  it('preserves two URLs on the same line', () => {
    const input = 'https://one.example.com and https://two.example.com'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('https://one.example.com')
    expect(normalisedText).toContain('https://two.example.com')
  })
}

function testMarkdownLinks() {
  it('normalises smart quotes in Markdown anchor text', () => {
    const input = '[\u201CHello\u201D](https://gov.uk/page)'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('"Hello"')
    expect(normalisedText).toContain('https://gov.uk/page')
  })

  it('leaves the Markdown link URL untouched', () => {
    const input = '[Link text](https://example.com/path?a=1&b=2)'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toBe('[Link text](https://example.com/path?a=1&b=2)')
  })

  it('converts typographic dashes in anchor text but not in URL', () => {
    const input = '[Value\u2013range](https://example.com/range--check)'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('[Value-range]')
    expect(normalisedText).toContain('https://example.com/range--check')
  })

  it('handles multiple Markdown links on the same line', () => {
    const input = '[one](https://a.com) and [two](https://b.com)'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('https://a.com')
    expect(normalisedText).toContain('https://b.com')
  })
}

function testMixedProseAndUrls() {
  it('applies typographic subs to prose part but preserves URL', () => {
    // The em dash must be separated from the URL by whitespace so it is NOT
    // captured inside the URL token — otherwise the URL regex absorbs it.
    const input = '\u201CRead more\u201D at https://gov.uk/policy \u2014 today.'
    const { normalisedText } = textNormaliser.normalise(input)
    // prose part normalised
    expect(normalisedText).toContain('"Read more"')
    expect(normalisedText).toContain('- today.')
    // URL preserved
    expect(normalisedText).toContain('https://gov.uk/policy')
  })

  it('collapses extra spaces around URL in prose but not inside the URL', () => {
    const input = 'See   https://example.com/page   for info.'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('https://example.com/page')
    // Leading/trailing spaces around URL collapsed
    expect(normalisedText).not.toMatch(/ {2,}https/)
  })
}

function testTrailingPunctuationUrls() {
  it('preserves a URL that ends just before trailing punctuation', () => {
    // The regex stops before ., ; ! ? ) etc. at end
    const input = 'Go to https://example.com/page. Done.'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('https://example.com/page')
  })
}

export function testUrlProtection() {
  testBareUrls()
  testMarkdownLinks()
  testMixedProseAndUrls()
  testTrailingPunctuationUrls()
}

// Run as a standalone test suite when vitest discovers this file directly
describe('TextNormaliser – URL protection', () => {
  testUrlProtection()
})
