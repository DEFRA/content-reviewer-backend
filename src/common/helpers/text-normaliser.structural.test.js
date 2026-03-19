/**
 * text-normaliser.structural.test.js
 *
 * Tests that structural markers — headings (ATX & SETEXT), bullet / list items,
 * paragraph boundaries, and nested list indentation — are fully preserved
 * through the normalisation pipeline.
 */

import { describe, it, expect } from 'vitest'
import { textNormaliser } from './text-normaliser.js'

export function testStructuralPreservation() {
  testATXHeadings()
  testSetextHeadings()
  testBulletListItems()
  testNestedBulletIndentation()
  testParagraphBoundaries()
  testCompleteDocumentStructure()
}

// ── ATX headings (# … ######) ────────────────────────────────────────────
function testATXHeadings() {
  it('preserves H1 ATX heading marker', () => {
    const { normalisedText } = textNormaliser.normalise('# Main Title')
    expect(normalisedText).toBe('# Main Title')
  })

  it('preserves H2 ATX heading', () => {
    const { normalisedText } = textNormaliser.normalise('## Section heading')
    expect(normalisedText).toBe('## Section heading')
  })

  it('preserves H3 through H6 ATX headings', () => {
    const levels = ['### H3', '#### H4', '##### H5', '###### H6']
    for (const heading of levels) {
      const { normalisedText } = textNormaliser.normalise(heading)
      expect(normalisedText).toBe(heading)
    }
  })

  it('normalises smart quotes in an ATX heading', () => {
    const { normalisedText } = textNormaliser.normalise(
      '# \u201CHello\u201D world'
    )
    expect(normalisedText).toBe('# "Hello" world')
  })
}

// ── SETEXT headings (underline with === / ---) ───────────────────────────
function testSetextHeadings() {
  it('preserves SETEXT === underline', () => {
    const input = 'Title\n====='
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toBe('Title\n=====')
  })

  it('preserves SETEXT --- underline', () => {
    const input = 'Subtitle\n--------'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toBe('Subtitle\n--------')
  })
}

// ── Bullet list items ────────────────────────────────────────────────────
function testBulletListItems() {
  it('preserves hyphen bullet item', () => {
    const { normalisedText } = textNormaliser.normalise('- item one')
    expect(normalisedText).toBe('- item one')
  })

  it('preserves asterisk bullet item', () => {
    const { normalisedText } = textNormaliser.normalise('* item one')
    expect(normalisedText).toBe('* item one')
  })

  it('preserves plus bullet item', () => {
    const { normalisedText } = textNormaliser.normalise('+ item one')
    expect(normalisedText).toBe('+ item one')
  })

  it('preserves Unicode bullet • item', () => {
    const { normalisedText } = textNormaliser.normalise('\u2022 bullet point')
    expect(normalisedText).toBe('\u2022 bullet point')
  })

  it('preserves numbered list item (1.)', () => {
    const { normalisedText } = textNormaliser.normalise('1. First item')
    expect(normalisedText).toBe('1. First item')
  })

  it('preserves numbered list item (2))', () => {
    const { normalisedText } = textNormaliser.normalise('2) Second item')
    expect(normalisedText).toBe('2) Second item')
  })

  it('normalises smart quote content within a bullet item', () => {
    const { normalisedText } = textNormaliser.normalise(
      '- \u201CHello\u201D world'
    )
    expect(normalisedText).toBe('- "Hello" world')
  })
}

// ── Nested bullet indentation is preserved ───────────────────────────────
function testNestedBulletIndentation() {
  // Leading spaces are preserved per-line but the document-level trim (Step 8)
  // removes them when the indented line is the only content. Test in a real
  // multi-line context to exercise the actual indentation-preservation path.

  it('preserves two-space indent before a nested bullet in a multi-line document', () => {
    const input = '- top\n  - nested item'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('  - nested item')
  })

  it('preserves four-space indent before a deeply nested bullet in a multi-line document', () => {
    const input = '- top\n  - mid\n    - deep item'
    const { normalisedText } = textNormaliser.normalise(input)
    expect(normalisedText).toContain('    - deep item')
  })

  it('collapses extra intra-line spaces AFTER the bullet marker', () => {
    const { normalisedText } = textNormaliser.normalise('-  too  many  spaces')
    expect(normalisedText).toBe('- too many spaces')
  })
}

// ── Paragraph boundaries ─────────────────────────────────────────────────
function testParagraphBoundaries() {
  it('preserves a single blank line between paragraphs', () => {
    const text = 'Para one.\n\nPara two.'
    const { normalisedText } = textNormaliser.normalise(text)
    expect(normalisedText).toBe(text)
  })

  it('preserves a heading followed by body text with a blank line separator', () => {
    const text = '## Introduction\n\nThis is the body text.'
    const { normalisedText } = textNormaliser.normalise(text)
    expect(normalisedText).toBe(text)
  })
}

// ── Complete document structure ───────────────────────────────────────────
function testCompleteDocumentStructure() {
  it('preserves a multi-section document structure end-to-end', () => {
    const doc = [
      '# Annual Report 2025',
      '',
      '## Executive Summary',
      '',
      'This year we achieved significant progress.',
      '',
      '## Key Findings',
      '',
      '- Finding one',
      '- Finding two',
      '  - Sub-finding A',
      '',
      '### Next Steps',
      '',
      '1. Action item one',
      '2. Action item two'
    ].join('\n')

    const { normalisedText } = textNormaliser.normalise(doc)
    expect(normalisedText).toContain('# Annual Report 2025')
    expect(normalisedText).toContain('## Executive Summary')
    expect(normalisedText).toContain('## Key Findings')
    expect(normalisedText).toContain('- Finding one')
    expect(normalisedText).toContain('  - Sub-finding A')
    expect(normalisedText).toContain('1. Action item one')
  })
}

// Run as a standalone test suite when vitest discovers this file directly
describe('TextNormaliser – structural preservation', () => {
  testStructuralPreservation()
})
