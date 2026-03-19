import { describe, it, expect } from 'vitest'
import { documentSectionStripper } from './document-section-stripper.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Join page-blocks with the double-newline that pdfjs-dist uses between pages */
const pages = (...blocks) => blocks.join('\n\n')

const PRESENTED_TO_PARLIAMENT = 'Presented to Parliament'
const CROWN_COPYRIGHT = 'Crown copyright'

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('DocumentSectionStripper – edge cases', () => {
  it('returns empty string for null input', () => {
    const { strippedText, stats } = documentSectionStripper.strip(null)
    expect(strippedText).toBe('')
    expect(stats.sectionsRemoved).toEqual([])
  })

  it('returns empty string for undefined input', () => {
    const { strippedText } = documentSectionStripper.strip(undefined)
    expect(strippedText).toBe('')
  })

  it('returns empty string for empty string', () => {
    const { strippedText } = documentSectionStripper.strip('')
    expect(strippedText).toBe('')
  })

  it('returns the original text unchanged when no front-matter is detected', () => {
    const input =
      '## Introduction\n\nThis policy covers...\n\n## Background\n\nMore content.'
    const { strippedText, stats } = documentSectionStripper.strip(input)
    expect(strippedText).toBe(input.trim())
    expect(stats.sectionsRemoved).toEqual([])
    expect(stats.strippedPageCount).toBe(0)
  })
})

// ── stats shape ──────────────────────────────────────────────────────────────

describe('DocumentSectionStripper – stats object', () => {
  it('returns all expected stat keys', () => {
    const { stats } = documentSectionStripper.strip('Hello world')
    expect(stats).toMatchObject({
      originalLength: expect.any(Number),
      strippedLength: expect.any(Number),
      charsRemoved: expect.any(Number),
      sectionsRemoved: expect.any(Array),
      pageCount: expect.any(Number),
      keptPageCount: expect.any(Number),
      strippedPageCount: expect.any(Number)
    })
  })

  it('originalLength equals the input character count', () => {
    const input = 'Hello world\n\nSecond page'
    const { stats } = documentSectionStripper.strip(input)
    expect(stats.originalLength).toBe(input.length)
  })

  it('charsRemoved is consistent with strippedLength', () => {
    const input = pages(
      'Clean Government White Paper\nPresented to Parliament\nMarch 2026',
      '## Chapter 1\n\nBody content here.'
    )
    const { stats } = documentSectionStripper.strip(input)
    expect(stats.charsRemoved).toBe(stats.originalLength - stats.strippedLength)
  })

  it('keptPageCount + strippedPageCount equals pageCount', () => {
    const input = pages(
      'Clean Government White Paper\nPresented to Parliament\nMarch 2026',
      '## Chapter 1\n\nBody content.'
    )
    const { stats } = documentSectionStripper.strip(input)
    expect(stats.keptPageCount + stats.strippedPageCount).toBe(stats.pageCount)
  })
})

// ── Title page detection ─────────────────────────────────────────────────────

describe('DocumentSectionStripper – title page detection', () => {
  it('strips a page containing "Presented to Parliament"', () => {
    const titlePage = `Clean Government\n${PRESENTED_TO_PARLIAMENT}\nby the Secretary of State\nMarch 2026`
    const body = '## Chapter 1\n\nThis section covers the policy rationale.'
    const input = pages(titlePage, body)
    const { strippedText, stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).toContain('title')
    expect(strippedText).not.toContain(PRESENTED_TO_PARLIAMENT)
    expect(strippedText).toContain('Chapter 1')
  })

  it('strips a page containing a Crown Paper reference (CP NNN)', () => {
    const titlePage = 'Government Policy Review\nCP 1521\nMarch 2026'
    const body = '## Introduction\n\nThe policy aims to...'
    const input = pages(titlePage, body)
    const { strippedText, stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).toContain('title')
    expect(strippedText).not.toContain('CP 1521')
    expect(strippedText).toContain('Introduction')
  })

  it('strips a page containing a Command Paper reference (Cm NNN)', () => {
    const titlePage = 'Environmental Policy\nCm 7320'
    const body = '## Section 1\n\nContent starts here.'
    const input = pages(titlePage, body)
    const { strippedText, stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).toContain('title')
    expect(strippedText).not.toContain('Cm 7320')
  })

  it('strips a page containing an HC reference (HC NNN)', () => {
    const titlePage = 'House of Commons Report\nHC 456'
    const body = 'This report examines...'
    const input = pages(titlePage, body)
    const { stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).toContain('title')
  })

  it('strips the very first page when it has very little content (< 120 substantive chars)', () => {
    const titlePage = 'White Paper\nMarch 2026' // short cover
    const body =
      "## Overview\n\nThis document sets out the government's approach to land management reform."
    const input = pages(titlePage, body)
    const { strippedText, stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).toContain('title')
    expect(strippedText).toContain('Overview')
  })

  it('does NOT strip the first page if it has substantial body content (>= 120 substantive chars)', () => {
    const bodyPage =
      "## Overview\n\nThis document sets out the government's approach to land management reform. " +
      'The new Environmental Land Management scheme will replace the Basic Payment Scheme and provide payments ' +
      'to farmers who deliver environmental goods and services.'
    const nextPage = '## Chapter 1\n\nMore detail here.'
    const input = pages(bodyPage, nextPage)
    const { stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).not.toContain('title')
  })

  it('respects stripTitlePage=false option', () => {
    const titlePage = 'Policy Paper\nPresented to Parliament\nMay 2026'
    const body = '## Chapter 1\n\nContent.'
    const input = pages(titlePage, body)
    const { stats } = documentSectionStripper.strip(input, {
      stripTitlePage: false
    })

    expect(stats.sectionsRemoved).not.toContain('title')
  })
})

// ── Copyright / imprint page detection ──────────────────────────────────────

describe('DocumentSectionStripper – copyright / imprint page detection', () => {
  it('strips a page containing the © symbol and "Crown copyright"', () => {
    const copyrightPage =
      '© Crown copyright 2026\nThis publication is licensed under the OGL.'
    const body = '## Chapter 1\n\nSubstantive content.'
    const input = pages(copyrightPage, body)
    const { strippedText } = documentSectionStripper.strip(input)

    expect(strippedText).not.toContain(CROWN_COPYRIGHT)
    expect(strippedText).toContain('Chapter 1')
  })

  it('strips a page containing an ISBN line', () => {
    const imprintPage =
      'Published by HMSO\nISBN 978-1-5286-6083-9\nPrinted in the UK'
    const body = '## Foreword\n\nThe Secretary of State writes...'
    const input = pages(imprintPage, body)
    const { strippedText, stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).toContain('copyright')
    expect(strippedText).not.toContain('ISBN')
    expect(strippedText).toContain('Foreword')
  })

  it('strips a page with "(c) 2024" copyright notation', () => {
    const copyrightPage =
      '(c) 2024 Department for Environment, Food and Rural Affairs'
    const body = 'Main body content here with substantial text.'
    const input = pages(copyrightPage, body)
    const { stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).toContain('copyright')
  })

  it('respects stripCopyrightPage=false option', () => {
    const copyrightPage =
      '© Crown copyright 2026\nThis publication is licensed under the OGL.'
    const body = '## Chapter 1\n\nContent.'
    const input = pages(copyrightPage, body)
    const { stats } = documentSectionStripper.strip(input, {
      stripCopyrightPage: false
    })

    expect(stats.sectionsRemoved).not.toContain('copyright')
  })
})

// ── Table of contents detection ──────────────────────────────────────────────

describe('DocumentSectionStripper – table of contents detection', () => {
  it('strips a page with an explicit "Contents" header', () => {
    const tocPage = [
      'Contents',
      '',
      '1. Introduction ........... 3',
      '2. Background ............. 5',
      '3. Policy options ......... 8',
      '4. Conclusion ............. 12'
    ].join('\n')
    const body = '## 1. Introduction\n\nThis report explores...'
    const input = pages(tocPage, body)
    const { strippedText, stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).toContain('toc')
    expect(strippedText).not.toContain('Contents')
    expect(strippedText).not.toContain('...........')
    expect(strippedText).toContain('Introduction')
  })

  it('strips a page with a "Table of Contents" header', () => {
    const tocPage = [
      'Table of Contents',
      '',
      '1. Overview .............. 2',
      '2. Analysis .............. 7'
    ].join('\n')
    const body = '## Overview\n\nBody text.'
    const input = pages(tocPage, body)
    const { strippedText, stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).toContain('toc')
    expect(strippedText).not.toContain('Table of Contents')
  })

  it('strips a page with "TABLE OF CONTENTS" (uppercase)', () => {
    const tocPage =
      'TABLE OF CONTENTS\n\n1. Policy ............. 1\n2. Context ............ 3'
    const body = '## Policy\n\nSubstantive content.'
    const input = pages(tocPage, body)
    const { stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).toContain('toc')
  })

  it('strips a page where 40%+ of lines have dot-leaders (no explicit header)', () => {
    // More than 40% of non-empty lines have ..... patterns
    const tocPage = [
      '1. Origins of the Act ........... 4',
      '(i) Enhancing our environment .............. 5',
      '2. Policy framework ............. 8',
      '3. Implementation ............... 11'
    ].join('\n')
    const body = '## 1. Origins of the Act\n\nThe Act was introduced...'
    const input = pages(tocPage, body)
    const { stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).toContain('toc')
  })

  it('does NOT strip a body page that happens to contain one dotted line', () => {
    // The stripper splits on \n\n, so the body page must NOT use \n\n internally
    // (blank lines would create separate page-blocks, each assessed individually).
    // Use single \n between lines so this entire block is one page to the stripper.
    // Only 1 out of 5 non-empty lines has dots — ratio 0.2 < 0.4, no TOC header.
    const bodyPage = [
      '## Chapter 2',
      'This chapter discusses the findings.',
      'See section 3 .............. for further detail',
      'More explanation follows here in full sentences.',
      'Additional context and analysis is provided below.'
    ].join('\n')
    const nextPage = '## Chapter 3\n\nAnother section.'
    const input = pages(bodyPage, nextPage)
    const { stats } = documentSectionStripper.strip(input)

    expect(stats.sectionsRemoved).not.toContain('toc')
  })

  it('respects stripTableOfContents=false option', () => {
    const tocPage = 'Contents\n\n1. Intro .......... 2\n2. Findings ....... 5'
    const body = '## Intro\n\nContent.'
    const input = pages(tocPage, body)
    const { stats } = documentSectionStripper.strip(input, {
      stripTableOfContents: false
    })

    expect(stats.sectionsRemoved).not.toContain('toc')
  })
})

// ── Multi-section stripping ──────────────────────────────────────────────────

describe('DocumentSectionStripper – multi-section stripping', () => {
  it('strips title page, copyright page and TOC in one pass', () => {
    // Note: each "page" is a single-line block (no internal \n\n) so the
    // page-block count is unambiguous: 4 input blocks → 3 stripped, 1 kept.
    const titlePage =
      'Clean Air Strategy\nPresented to Parliament\nJanuary 2026'
    const copyrightPage =
      '© Crown copyright 2026\nISBN 978-1-5286-1234-5\nPrinted in the UK'
    const tocPage =
      '1. Introduction ....... 3\n2. Analysis ........... 7\n3. Conclusion ......... 14'
    const body = '## 1. Introduction\nAir quality has improved significantly.'
    const input = pages(titlePage, copyrightPage, tocPage, body)

    const { strippedText, stats } = documentSectionStripper.strip(input)

    const EXPECTED_STRIPPED_PAGE_COUNT = 3
    const EXPECTED_KEPT_PAGE_COUNT = 1
    expect(stats.sectionsRemoved).toContain('title')
    expect(stats.sectionsRemoved).toContain('copyright')
    expect(stats.sectionsRemoved).toContain('toc')
    expect(stats.strippedPageCount).toBe(EXPECTED_STRIPPED_PAGE_COUNT)
    expect(stats.keptPageCount).toBe(EXPECTED_KEPT_PAGE_COUNT)
    expect(strippedText).toContain('Introduction')
    expect(strippedText).not.toContain('Presented to Parliament')
    expect(strippedText).not.toContain('Crown copyright')
  })

  it('preserves all body content after front-matter removal', () => {
    const title = `Report Title\n${PRESENTED_TO_PARLIAMENT}`
    const toc =
      'Contents\n\n1. Policy Background ..... 2\n2. Data Analysis ......... 5'
    const body1 =
      '## 1. Policy Background\n\nParagraph one.\n\n- Bullet one\n- Bullet two'
    const body2 = '## 2. Data Analysis\n\nThe data shows that...'
    const input = pages(title, toc, body1, body2)

    const { strippedText } = documentSectionStripper.strip(input)

    expect(strippedText).toContain('Policy Background')
    expect(strippedText).toContain('Bullet one')
    expect(strippedText).toContain('Bullet two')
    expect(strippedText).toContain('Data Analysis')
  })

  it('does not strip anything when all options are false', () => {
    const title = 'Paper Title\nPresented to Parliament'
    const copyright = '© Crown copyright 2026\nISBN 978-0-0000-0000-0'
    const toc = 'Contents\n\n1. Intro ..... 1'
    const body = '## Intro\n\nSome content here.'
    const input = pages(title, copyright, toc, body)

    const { stats } = documentSectionStripper.strip(input, {
      stripTitlePage: false,
      stripCopyrightPage: false,
      stripTableOfContents: false
    })

    expect(stats.sectionsRemoved).toEqual([])
    expect(stats.strippedPageCount).toBe(0)
  })
})

// ── Front-matter window boundary ─────────────────────────────────────────────

describe('DocumentSectionStripper – front-matter window (only first 8 page-blocks examined)', () => {
  it('does NOT strip a "Presented to Parliament" page if it appears after the 8th page-block', () => {
    // 8 body pages, each with an internal \n\n, plus 1 late title-like page.
    // Each body page "## Section N\n\nContent..." splits into 2 blocks = 16
    // body blocks; the late page adds 1 more = 17 total blocks kept.
    // The key assertion is that no 'title' section is removed.
    const bodyBlocks = Array.from(
      { length: 8 },
      (_, i) => `## Section ${i + 1}\n\nContent for section ${i + 1}.`
    )
    const lateTitleLikePage =
      'Annex A\nPresented to Parliament\nSome reference material.'
    const input = pages(...bodyBlocks, lateTitleLikePage)

    const { stats } = documentSectionStripper.strip(input)

    // The late page is beyond the front-matter window — must NOT be stripped
    expect(stats.sectionsRemoved).not.toContain('title')
    // All blocks are kept: 8 body pages × 2 sub-blocks + 1 late page = 17
    const EXPECTED_KEPT_PAGE_COUNT = 8 * 2 + 1
    expect(stats.keptPageCount).toBe(EXPECTED_KEPT_PAGE_COUNT)
  })
})

// ── Body content is never mangled ────────────────────────────────────────────

describe('DocumentSectionStripper – body content is never mangled', () => {
  it('preserves numbered sections and sub-sections', () => {
    const title = `Policy Document\n${PRESENTED_TO_PARLIAMENT}`
    const body = [
      '## 1. Introduction',
      '',
      '### 1.1 Background',
      '',
      'The policy was introduced in 2020.',
      '',
      '### 1.2 Scope',
      '',
      'This applies to all land managers in England.'
    ].join('\n')
    const input = pages(title, body)
    const { strippedText } = documentSectionStripper.strip(input)

    expect(strippedText).toContain('1. Introduction')
    expect(strippedText).toContain('1.1 Background')
    expect(strippedText).toContain('1.2 Scope')
  })

  it('preserves bullet lists in body content', () => {
    const copyright = '© Crown copyright 2026'
    const body =
      '## Objectives\n\n- Reduce emissions\n- Improve biodiversity\n- Support farmers'
    const input = pages(copyright, body)
    const { strippedText } = documentSectionStripper.strip(input)

    expect(strippedText).toContain('- Reduce emissions')
    expect(strippedText).toContain('- Improve biodiversity')
    expect(strippedText).toContain('- Support farmers')
  })

  it('preserves paragraph structure with blank-line boundaries', () => {
    const toc = 'Contents\n\n1. Intro ........ 2'
    const body = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
    const input = pages(toc, body)
    const { strippedText } = documentSectionStripper.strip(input)

    expect(strippedText).toContain('First paragraph.')
    expect(strippedText).toContain('Second paragraph.')
    expect(strippedText).toContain('Third paragraph.')
  })

  it('does not alter the text content of kept pages', () => {
    const copyright = '© Crown copyright 2026\nISBN 978-0-0000-0000-0'
    const body = 'The quick brown fox jumps over the lazy dog.'
    const input = pages(copyright, body)
    const { strippedText } = documentSectionStripper.strip(input)

    expect(strippedText).toBe(body.trim())
  })
})

// ── Real-world document patterns ─────────────────────────────────────────────

describe('DocumentSectionStripper – ELM-style white paper', () => {
  it('handles a full ELM-style white paper', () => {
    const title = [
      'Environmental Land Management Schemes',
      'More Moorland, Better Uplands',
      `${PRESENTED_TO_PARLIAMENT} by the Secretary of State`,
      'for Environment, Food and Rural Affairs',
      'by Command of His Majesty',
      'July 2026',
      'CP 1234'
    ].join('\n')

    const copyright = [
      '© Crown copyright 2026',
      '',
      'This publication is licensed under the terms of the Open Government Licence v3.0.',
      '',
      'ISBN 978-1-5286-9999-1',
      'E02999999 07/26',
      '',
      'Printed on paper containing 40% recycled fibre content minimum',
      'Printed in the UK by HH Associates Ltd, on behalf of the Controller of HMSO'
    ].join('\n')

    const toc = [
      'Contents',
      '',
      'Foreword by the Secretary of State .............................. 3',
      '1. Origins of the Act ........................................... 4',
      '2. Enhanced animal health and welfare standards .................. 5',
      '3. Enhancing our natural environment ............................. 7',
      '4. Improving farm productivity ................................... 9',
      '5. Conclusions .................................................. 12'
    ].join('\n')

    const body = [
      '## Foreword',
      '',
      'The Environmental Land Management scheme represents a once-in-a-generation',
      'opportunity to transform the way we support farmers and land managers.',
      '',
      '## 1. Origins of the Act',
      '',
      'The Agriculture Act 2020 set out a new framework for agricultural policy.'
    ].join('\n')

    const input = pages(title, copyright, toc, body)
    const { strippedText, stats } = documentSectionStripper.strip(input)

    // Three front-matter sections should be gone
    const FRONT_MATTER_SECTION_COUNT = 3
    expect(stats.sectionsRemoved).toContain('title')
    expect(stats.sectionsRemoved).toContain('copyright')
    expect(stats.sectionsRemoved).toContain('toc')
    // The front-matter blocks (which include sub-blocks from internal blank
    // lines) are all stripped; body blocks are all kept.
    expect(stats.strippedPageCount).toBeGreaterThanOrEqual(
      FRONT_MATTER_SECTION_COUNT
    )
    expect(strippedText).not.toContain('CP 1234')
    expect(strippedText).not.toContain(CROWN_COPYRIGHT)
    expect(strippedText).not.toContain('ISBN')
    expect(strippedText).toContain('Foreword')
    expect(strippedText).toContain('Origins of the Act')
    expect(strippedText).toContain('Agriculture Act 2020')
  })
})

describe('DocumentSectionStripper – pure body document', () => {
  it('handles a document with NO front-matter gracefully (pure body)', () => {
    const doc = [
      '## Executive Summary',
      '',
      '## 1. Background',
      '',
      'The survey was conducted across England and Wales.',
      '',
      '## 2. Key Findings',
      '',
      '- Uptake increased by 30% year-on-year',
      '- Biodiversity metrics improved in 85% of surveyed farms'
    ].join('\n')

    const { strippedText, stats } = documentSectionStripper.strip(doc)

    expect(stats.sectionsRemoved).toEqual([])
    expect(stats.strippedPageCount).toBe(0)
    expect(strippedText).toContain('Executive Summary')
    expect(strippedText).toContain('Key Findings')
  })
})
