/**
 * text-normaliser.real-world.test.js
 *
 * End-to-end normalisation tests using realistic GOV.UK / policy document
 * content — verifying that the full pipeline produces expected canonical text.
 */

import { describe, it, expect } from 'vitest'
import { textNormaliser } from './text-normaliser.js'

function testGovUkPolicyDocumentExcerpt() {
  it('normalises a typical GOV.UK policy document excerpt', () => {
    const raw = [
      '\uFEFF', // BOM at start
      '# Environmental Policy Statement\r\n', // CRLF heading
      '\r\n',
      'The Secretary of State has determined that\u2014consistent with',
      'the Government\u2019s commitment to net zero\u2014the following',
      'measures shall apply.\r\n',
      '\r\n',
      '## Key Objectives\r\n',
      '\r\n',
      '- Reduce carbon emissions by 2030\r\n',
      '- Protect biodiversity in coastal zones\r\n',
      '- Ensure equitable access to green spaces\r\n'
    ].join('')

    const { normalisedText } = textNormaliser.normalise(raw)

    // BOM stripped
    expect(normalisedText).not.toContain('\uFEFF')
    // CRLF removed
    expect(normalisedText).not.toContain('\r')
    // Smart quote → ASCII
    expect(normalisedText).toContain("Government's")
    // Em dash → hyphen
    expect(normalisedText).toContain('-consistent')
    // Headings preserved
    expect(normalisedText).toContain('# Environmental Policy Statement')
    expect(normalisedText).toContain('## Key Objectives')
    // Bullets preserved
    expect(normalisedText).toContain('- Reduce carbon emissions by 2030')
    expect(normalisedText).toContain('- Protect biodiversity in coastal zones')
  })
}

function testPdfExtractedText() {
  it('normalises PDF-extracted text with page numbers and ligatures', () => {
    const raw = [
      'Chapter 1: Introduction\n',
      '\n',
      'Page 1\n',
      '\n',
      'The o\uFB03cial guidance on \uFB01nancial regulation is as follows.\n',
      '\n',
      '- 2 -\n',
      '\n',
      'All institutions must comply.\n'
    ].join('')

    const { normalisedText } = textNormaliser.normalise(raw)

    // Page numbers stripped
    expect(normalisedText).not.toContain('Page 1')
    expect(normalisedText).not.toContain('- 2 -')
    // Ligatures expanded
    expect(normalisedText).toContain('official')
    expect(normalisedText).toContain('financial')
    // Body content preserved
    expect(normalisedText).toContain('Chapter 1: Introduction')
    expect(normalisedText).toContain('All institutions must comply.')
  })
}

function testMixedLineEndingDocument() {
  it('normalises a mixed line-ending document', () => {
    const raw =
      'Title: Annual Review\r\n' +
      '\r\n' +
      'Scope\r\n' +
      '=====\r\n' +
      '\r\n' +
      'This review covers the period January\u2013December 2025.\r\n' +
      '\r\n' +
      '1. Objective one\r\n' +
      '2. Objective two\r\n'

    const { normalisedText } = textNormaliser.normalise(raw)

    expect(normalisedText).not.toContain('\r')
    expect(normalisedText).toContain('January-December 2025')
    expect(normalisedText).toContain('Scope\n=====')
    expect(normalisedText).toContain('1. Objective one')
    expect(normalisedText).toContain('2. Objective two')
  })
}

function testDocumentWithUrlsAndSmartQuotes() {
  it('normalises a document that mixes prose, URLs and smart quotes', () => {
    const raw = [
      '## Useful Links\n',
      '\n',
      '\u201CFor full details\u201D see https://www.gov.uk/guidance/example.\n',
      '\n',
      'More information: [Guidance document](https://gov.uk/doc?ref=1&ver=2)\n'
    ].join('')

    const { normalisedText } = textNormaliser.normalise(raw)

    expect(normalisedText).toContain('"For full details"')
    expect(normalisedText).toContain('https://www.gov.uk/guidance/example')
    expect(normalisedText).toContain(
      '[Guidance document](https://gov.uk/doc?ref=1&ver=2)'
    )
  })
}

function testDocumentWithExcessiveBlankLines() {
  it('normalises a document with excessive blank lines between sections', () => {
    const raw = 'Section A.\n\n\n\n\n\nSection B.\n\n\n\nSection C.'
    const { normalisedText } = textNormaliser.normalise(raw)

    expect(normalisedText).toBe('Section A.\n\nSection B.\n\nSection C.')
  })
}

function testDocumentWithControlCharactersAndNoise() {
  it('strips all noise from a heavily artefact-laden string', () => {
    const raw =
      '\uFEFF\u0000Some\u000B title\u000C text\r\n' +
      '\u201CHello\u201D \u2014 world\u2019s leading.\n' +
      'Page 5\n' +
      'o\uFB03cial\n'

    const { normalisedText } = textNormaliser.normalise(raw)

    expect(normalisedText).not.toContain('\uFEFF')
    expect(normalisedText).not.toContain('\u0000')
    expect(normalisedText).not.toContain('\u000B')
    expect(normalisedText).not.toContain('\u000C')
    expect(normalisedText).not.toContain('\r')
    expect(normalisedText).toContain('"Hello"')
    expect(normalisedText).toContain('-')
    expect(normalisedText).toContain("world's")
    expect(normalisedText).not.toContain('Page 5')
    expect(normalisedText).toContain('official')
  })
}

function testStatsForComplexDocuments() {
  it('stats.normalisedLength matches actual output length for a complex doc', () => {
    const raw =
      '\uFEFF# Title\r\n\r\nSome \u201Cquoted\u201D text \u2014 with dashes.\r\n'
    const { normalisedText, stats } = textNormaliser.normalise(raw)
    expect(stats.normalisedLength).toBe(normalisedText.length)
  })

  it('stats.charsRemoved is correct for a complex doc', () => {
    const raw =
      '\uFEFF# Title\r\n\r\nSome \u201Cquoted\u201D text \u2014 with dashes.\r\n'
    const { normalisedText, stats } = textNormaliser.normalise(raw)
    expect(stats.charsRemoved).toBe(raw.length - normalisedText.length)
  })
}

export function testRealWorldScenarios() {
  testGovUkPolicyDocumentExcerpt()
  testPdfExtractedText()
  testMixedLineEndingDocument()
  testDocumentWithUrlsAndSmartQuotes()
  testDocumentWithExcessiveBlankLines()
  testDocumentWithControlCharactersAndNoise()
  testStatsForComplexDocuments()
}

// Run as a standalone test suite when vitest discovers this file directly
describe('TextNormaliser – real-world scenarios', () => {
  testRealWorldScenarios()
})
