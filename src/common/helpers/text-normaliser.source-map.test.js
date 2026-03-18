/**
 * text-normaliser.source-map.test.js
 *
 * Tests for the buildSourceMap() method.
 *
 * Each span in the returned array must conform to:
 * {
 *   start:      number   — inclusive char offset
 *   end:        number   — exclusive char offset
 *   blockType:  string   — "heading" | "bullet" | "line" | "blank"
 *   lineIndex:  number   — 0-based
 *   originType: string   — "textarea" | "page" | "url"
 *   originRef:  string|null
 * }
 */

import { describe, it, expect } from 'vitest'
import { textNormaliser } from './text-normaliser.js'

function testEmptyAndFalsyInput() {
  it('returns an empty array for empty string', () => {
    expect(textNormaliser.buildSourceMap('')).toEqual([])
  })

  it('returns an empty array for null', () => {
    expect(textNormaliser.buildSourceMap(null)).toEqual([])
  })

  it('returns an empty array for undefined', () => {
    expect(textNormaliser.buildSourceMap(undefined)).toEqual([])
  })
}

function testSingleLineDocument() {
  const SINGLE_LINE_TEXT = 'Hello world.'

  it('returns one span for a single-line document', () => {
    const spans = textNormaliser.buildSourceMap(SINGLE_LINE_TEXT)
    expect(spans).toHaveLength(1)
  })

  it('span for a single-line document has start=0', () => {
    const spans = textNormaliser.buildSourceMap(SINGLE_LINE_TEXT)
    expect(spans[0].start).toBe(0)
  })

  it('span end equals the line length', () => {
    const text = SINGLE_LINE_TEXT
    const spans = textNormaliser.buildSourceMap(text)
    expect(spans[0].end).toBe(text.length)
  })

  it('single plain line is classified as "line"', () => {
    const spans = textNormaliser.buildSourceMap('Some plain text.')
    expect(spans[0].blockType).toBe('line')
  })
}

function testHeadingClassification() {
  it('ATX H1 is classified as "heading"', () => {
    const spans = textNormaliser.buildSourceMap('# Title')
    expect(spans[0].blockType).toBe('heading')
  })

  it('ATX H2 is classified as "heading"', () => {
    const spans = textNormaliser.buildSourceMap('## Section')
    expect(spans[0].blockType).toBe('heading')
  })

  it('SETEXT === underline causes the preceding line to be classified as "heading"', () => {
    const spans = textNormaliser.buildSourceMap('Title\n=====')
    // Line 0 (Title) should be 'heading' because line 1 is a SETEXT underline
    expect(spans[0].blockType).toBe('heading')
  })

  it('SETEXT --- underline causes the preceding line to be classified as "heading"', () => {
    const spans = textNormaliser.buildSourceMap('Subtitle\n--------')
    expect(spans[0].blockType).toBe('heading')
  })
}

function testBulletClassification() {
  it('hyphen bullet is classified as "bullet"', () => {
    const spans = textNormaliser.buildSourceMap('- item')
    expect(spans[0].blockType).toBe('bullet')
  })

  it('asterisk bullet is classified as "bullet"', () => {
    const spans = textNormaliser.buildSourceMap('* item')
    expect(spans[0].blockType).toBe('bullet')
  })

  it('numbered list item is classified as "bullet"', () => {
    const spans = textNormaliser.buildSourceMap('1. First')
    expect(spans[0].blockType).toBe('bullet')
  })
}

function testBlankClassification() {
  it('empty line is classified as "blank"', () => {
    const spans = textNormaliser.buildSourceMap('Line one\n\nLine two')
    const blankSpan = spans.find((s) => s.blockType === 'blank')
    expect(blankSpan).toBeDefined()
  })
}

function testOffsetCorrectness() {
  it('offsets are contiguous (end of span N + 1 = start of span N+1)', () => {
    const text = 'Line one\nLine two\nLine three'
    const spans = textNormaliser.buildSourceMap(text)
    for (let i = 0; i < spans.length - 1; i++) {
      // end + 1 (for the \n separator) = next start
      expect(spans[i].end + 1).toBe(spans[i + 1].start)
    }
  })

  it('each span.start..span.end maps to the correct line content', () => {
    const text = 'Alpha\nBeta\nGamma'
    const spans = textNormaliser.buildSourceMap(text)
    for (const span of spans) {
      const lineContent = text.slice(span.start, span.end)
      const expectedLine = text.split('\n')[span.lineIndex]
      expect(lineContent).toBe(expectedLine)
    }
  })

  it('lineIndex is 0-based and sequential', () => {
    const text = 'A\nB\nC'
    const spans = textNormaliser.buildSourceMap(text)
    spans.forEach((span, idx) => {
      expect(span.lineIndex).toBe(idx)
    })
  })
}

function testOriginTypeAndRef() {
  it('defaults originType to "textarea"', () => {
    const spans = textNormaliser.buildSourceMap('Hello')
    expect(spans[0].originType).toBe('textarea')
  })

  it('defaults originRef to null', () => {
    const spans = textNormaliser.buildSourceMap('Hello')
    expect(spans[0].originRef).toBeNull()
  })

  it('accepts a custom originType', () => {
    const spans = textNormaliser.buildSourceMap('Hello', 'page')
    expect(spans[0].originType).toBe('page')
  })

  it('accepts a custom originRef', () => {
    const spans = textNormaliser.buildSourceMap('Hello', 'page', 'raw/doc.pdf')
    expect(spans[0].originRef).toBe('raw/doc.pdf')
  })
}

function testMixedContentDocument() {
  it('builds a correct source map for a mixed-content document', () => {
    const text = '# Heading\n\n- Bullet\n\nBody text.'
    const spans = textNormaliser.buildSourceMap(text)
    const types = spans.map((s) => s.blockType)
    expect(types).toEqual(['heading', 'blank', 'bullet', 'blank', 'line'])
  })

  it('number of spans equals number of lines in the text', () => {
    const text = 'Line A\nLine B\nLine C\nLine D'
    const spans = textNormaliser.buildSourceMap(text)
    expect(spans).toHaveLength(text.split('\n').length)
  })
}

export function testBuildSourceMap() {
  testEmptyAndFalsyInput()
  testSingleLineDocument()
  testHeadingClassification()
  testBulletClassification()
  testBlankClassification()
  testOffsetCorrectness()
  testOriginTypeAndRef()
  testMixedContentDocument()
}

// Run as a standalone test suite when vitest discovers this file directly
describe('TextNormaliser – buildSourceMap', () => {
  testBuildSourceMap()
})
