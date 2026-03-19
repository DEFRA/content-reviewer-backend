import { createLogger } from './logging/logger.js'

const logger = createLogger()

// ─────────────────────────────────────────────────────────────────────────────
// Compiled regexes (module-level, created once)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A TOC entry line: optional leading digits/whitespace, then text, then
 * a run of 4+ dots (with optional spaces between), then an optional page number.
 * e.g. "1. Origins of the Act ........... 4"
 *      "(i) Enhancing our environment .............. 5"
 */
const TOC_ENTRY_RE = /\.{4,}/

/**
 * Explicit "Table of Contents" header line (case-insensitive).
 * Matches: "Table of Contents", "Contents", "TABLE OF CONTENTS"
 */
const TOC_HEADER_RE = /^\s*(?:table\s+of\s+)?contents\s*$/i

/**
 * Title-page signals: lines that ONLY contain a Crown / Command Paper
 * reference number, e.g. "CP 1521", "Cm 7320", "HC 123"
 */
const CROWN_REF_RE = /^\s*(?:CP|Cm|HC|HL)\s+\d+\s*$/i

// Named constant for maximum substantive characters on a title page with Crown reference
const MAX_TITLE_PAGE_SUBSTANTIVE_CHARS = 150

/**
 * Copyright / imprint block signals.
 * We detect these by the presence of a copyright notice line.
 * e.g. "© Crown copyright 2026"
 */
const COPYRIGHT_LINE_RE = /©|Crown copyright|\(c\)\s+\d{4}/i

// Named constant for maximum substantive characters on the first page (was 120)
const MAX_FIRST_PAGE_SUBSTANTIVE_CHARS = 120

/**
 * "Presented to Parliament" — a reliable title-page signal on GOV.UK documents.
 */
const PRESENTED_TO_PARLIAMENT_RE = /presented to parliament/i

/**
 * ISBN / print reference line — indicates end of imprint block.
 * e.g. "ISBN 978-1-5286-6083-9"
 */
const ISBN_RE = /^\s*ISBN\s+[\d\-X]+/i

/**
 * A line consisting only of whitespace or a short standalone number
 * (PDF page-number artefact already handled by text-normaliser, kept here
 * as an additional guard during section detection).
 *
 * Security — ReDoS hardening:
 *   Original /^\s*\d{0,3}\s*$/ had two \s* quantifiers wrapping an optional
 *   \d{0,3}. On a long whitespace-only string with no newline terminator the
 *   engine must try every combination of how to distribute spaces between the
 *   leading and trailing \s*, causing catastrophic backtracking (O(2^n)).
 *
 *   Fix: replace with explicit alternation — each branch is O(n) linear and
 *   mutually exclusive so the engine never retries across branches:
 *     Branch 1  ^\s+$          — line is entirely whitespace (1+ chars)
 *     Branch 2  ^\s{0,10}\d{1,3}\s{0,10}$
 *                              — optional surrounding spaces (hard-capped at
 *                                10 each) around 1–3 digits; matches "  42  "
 *     Branch 3  ^$             — completely empty line
 *
 *   NOTE: \d{0,3} in the original allowed zero digits, making it equivalent
 *   to /^\s*$/ which is already covered by branch 1/3. We tighten to \d{1,3}
 *   (at least one digit) so the branches do not overlap.
 */
const BLANK_OR_PAGENUM_RE = /^(?:\s+|\s{0,10}\d{1,3}\s{0,10}|)$/

// ─────────────────────────────────────────────────────────────────────────────

/**
 * DocumentSectionStripper
 *
 * Identifies and removes front-matter sections from extracted document text
 * BEFORE PII redaction and normalisation so that the AI only receives
 * substantive body content.
 *
 * Sections stripped:
 *
 *  1. TITLE PAGE
 *     Detected by: "Presented to Parliament", Crown reference numbers (CP/Cm),
 *     or a very short opening page (< 120 chars of real text) before body.
 *
 *  2. COPYRIGHT / IMPRINT PAGE
 *     Detected by: copyright symbol (©), "Crown copyright", ISBN numbers.
 *     The entire paragraph-block containing these signals is removed.
 *
 *  3. TABLE OF CONTENTS
 *     Detected by: "Table of Contents" / "Contents" header, OR a dense run
 *     of lines containing dot-leader patterns ( ........... ).
 *     The entire TOC section (from its header to the last dot-leader line)
 *     is removed.
 *
 * What is preserved:
 *  - All body content (numbered paragraphs, headings, bullets, annexes)
 *  - No content is rewritten, summarised or reordered
 *  - Structure signals (blank lines between pages) are preserved
 *
 * The stripper works at the PAGE level because pdfjs-dist separates pages
 * with '\n\n' boundaries, giving reliable split points.
 *
 * @param {string} text   - Raw extracted text (pages joined by '\n\n')
 * @param {Object} [opts]
 * @param {boolean} [opts.stripTitlePage=true]
 * @param {boolean} [opts.stripCopyrightPage=true]
 * @param {boolean} [opts.stripTableOfContents=true]
 * @returns {{ strippedText: string, stats: SectionStripStats }}
 */
class DocumentSectionStripper {
  /**
   * Strip front-matter sections from extracted document text.
   *
   * @param {string} text
   * @param {object} [opts]
   * @returns {{ strippedText: string, stats: SectionStripStats }}
   */
  strip(
    text,
    {
      stripTitlePage = true,
      stripCopyrightPage = true,
      stripTableOfContents = true
    } = {}
  ) {
    if (!text || typeof text !== 'string') {
      return {
        strippedText: text ?? '',
        stats: this._emptyStats()
      }
    }

    const pages = text.split(/\n\n+/)
    const opts = { stripTitlePage, stripCopyrightPage, stripTableOfContents }
    const { kept, stripped } = this._processPages(pages, opts)

    const strippedText = kept.join('\n\n').trim()
    const stats = this._buildStats(text, strippedText, pages, kept, stripped)

    this._logResult(stripped, stats, pages.length)

    return { strippedText, stats }
  }

  /**
   * Iterate pages and split them into kept / stripped buckets.
   * @private
   */
  _processPages(
    pages,
    { stripTitlePage, stripCopyrightPage, stripTableOfContents }
  ) {
    const FRONT_MATTER_WINDOW = 8
    const kept = []
    const stripped = []

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]

      if (i >= FRONT_MATTER_WINDOW) {
        kept.push(page)
        continue
      }

      const classification = this._classifyPage(page, i)
      const shouldStrip =
        (classification === 'title' && stripTitlePage) ||
        (classification === 'copyright' && stripCopyrightPage) ||
        (classification === 'toc' && stripTableOfContents)

      if (shouldStrip) {
        stripped.push({ index: i, classification, charCount: page.length })
        logger.info(
          { pageIndex: i, classification, charCount: page.length },
          `DocumentSectionStripper: removed ${classification} page (index ${i})`
        )
      } else {
        kept.push(page)
      }
    }

    return { kept, stripped }
  }

  /**
   * Build the stats object after processing.
   * @private
   */
  _buildStats(originalText, strippedText, pages, kept, stripped) {
    return {
      originalLength: originalText.length,
      strippedLength: strippedText.length,
      charsRemoved: originalText.length - strippedText.length,
      sectionsRemoved: stripped.map((s) => s.classification),
      pageCount: pages.length,
      keptPageCount: kept.length,
      strippedPageCount: stripped.length
    }
  }

  /**
   * Log a summary of what was (or wasn't) stripped.
   * @private
   */
  _logResult(stripped, stats, pageCount) {
    if (stripped.length > 0) {
      logger.info(
        stats,
        `DocumentSectionStripper: removed ${stripped.length} front-matter section(s) — ` +
          stripped.map((s) => s.classification).join(', ')
      )
    } else {
      logger.info(
        { pageCount },
        'DocumentSectionStripper: no front-matter sections detected'
      )
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Classify a single page-block as 'title', 'copyright', 'toc', or 'body'.
   *
   * @param {string} page        - Text of the page block
   * @param {number} pageIndex   - 0-based index within the document
   * @returns {'title'|'copyright'|'toc'|'body'}
   * @private
   */
  _classifyPage(page, pageIndex) {
    const lines = page
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

    const nonEmptyText = lines.join(' ')

    if (this._hasMarkdownHeading(lines)) {
      return 'body'
    }
    if (this._isTocPage(lines)) {
      return 'toc'
    }
    if (this._isCopyrightPage(lines)) {
      return 'copyright'
    }
    if (this._isTitlePage(lines, nonEmptyText, pageIndex)) {
      return 'title'
    }

    return 'body'
  }

  /** @private */
  _hasMarkdownHeading(lines) {
    return lines.some((l) => /^#{1,6}\s/.test(l))
  }

  /** @private */
  _isTocPage(lines) {
    const DOT_LEADER_RATIO_THRESHOLD = 0.4
    const hasTocHeader = lines.some((l) => TOC_HEADER_RE.test(l))
    const dotLeaderLines = lines.filter((l) => TOC_ENTRY_RE.test(l))
    const dotLeaderRatio =
      lines.length > 0 ? dotLeaderLines.length / lines.length : 0
    return hasTocHeader || dotLeaderRatio > DOT_LEADER_RATIO_THRESHOLD
  }

  /** @private */
  _isCopyrightPage(lines) {
    const hasCopyright = lines.some((l) => COPYRIGHT_LINE_RE.test(l))
    const hasIsbn = lines.some((l) => ISBN_RE.test(l))
    return hasCopyright || hasIsbn
  }

  /** @private */
  _isTitlePage(_lines, _nonEmptyText, pageIndex) {
    const hasPresentedToParliament = _lines.some((l) =>
      PRESENTED_TO_PARLIAMENT_RE.test(l)
    )
    const hasCrownRef = _lines.some((l) => CROWN_REF_RE.test(l))
    const substantiveChars = _nonEmptyText.replace(
      BLANK_OR_PAGENUM_RE,
      ''
    ).length

    if (hasPresentedToParliament) {
      return true
    }
    if (hasCrownRef && substantiveChars < MAX_TITLE_PAGE_SUBSTANTIVE_CHARS) {
      return true
    }
    if (
      pageIndex === 0 &&
      substantiveChars < MAX_FIRST_PAGE_SUBSTANTIVE_CHARS
    ) {
      return true
    }
    return false
  }

  /** @private */
  _emptyStats() {
    return {
      originalLength: 0,
      strippedLength: 0,
      charsRemoved: 0,
      sectionsRemoved: [],
      pageCount: 0,
      keptPageCount: 0,
      strippedPageCount: 0
    }
  }
}

/**
 * @typedef {Object} SectionStripStats
 * @property {number}   originalLength    - Char count before stripping
 * @property {number}   strippedLength    - Char count after stripping
 * @property {number}   charsRemoved      - Difference
 * @property {string[]} sectionsRemoved   - e.g. ['title', 'copyright', 'toc']
 * @property {number}   pageCount         - Total page-blocks in document
 * @property {number}   keptPageCount     - Page-blocks kept
 * @property {number}   strippedPageCount - Page-blocks removed
 */

export const documentSectionStripper = new DocumentSectionStripper()
