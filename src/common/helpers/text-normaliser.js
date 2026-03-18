import { createLogger } from './logging/logger.js'

const logger = createLogger()

// ─────────────────────────────────────────────────────────────────────────────
// Regex helpers (compiled once at module load)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects a bare URL anywhere on a line (http / https / ftp / mailto).
 * Used to skip typographic substitutions inside URL tokens so we never
 * corrupt link targets.
 */
// eslint-disable-next-line no-useless-escape
const URL_TOKEN_RE =
  /(?:https?|ftp|mailto):\/\/[^\s<>"{}|\\^`[\]]*[^\s<>"{}|\\^`[\].,;:!?)]/gi

/**
 * Detects a Markdown-style link: [anchor text](url)
 * Captures group 1 = anchor, group 2 = url.
 */
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g

/**
 * Heading patterns — Markdown ATX (#, ##, …) and SETEXT underlines (=== / ---).
 * A line is a heading if it starts with one or more # followed by a space,
 * OR if the NEXT line is all ===== or -----.
 */
const HEADING_ATX_RE = /^(#{1,6})\s+/
const HEADING_SETEXT_RE = /^[=-]{2,}\s*$/

/**
 * Bullet / list-item patterns.
 * Covers: -, *, +, •, ·, ◦, ▪, ▸, ➤, ➔, ➡, >, » and numbered lists (1. / 1))
 */
const BULLET_RE = /^(\s*)(?:[-*+•·◦▪▸➤➔➡>»]|\d+[.)]\s)\s*/

/**
 * Standalone page-number lines.
 * Matches lines that consist ONLY of an optional "Page"/"p." prefix
 * followed by one or more digits, e.g. "Page 1", "p. 12", "3", "- 4 -".
 * These are PDF/Word artefacts and must NOT appear in the canonical document.
 */
const PAGE_NUMBER_LINE_RE = /^[-\s]*(?:page\s*|p\.\s*)?\d+[-\s]*$/i

/**
 * Invisible / control characters to strip.
 * Listed individually using alternation (not inside a regex character class)
 * to avoid linter warnings about control characters inside character classes.
 */
// Characters removed:
//   U+FEFF  BOM
//   U+0000  null byte
//   U+000B  vertical tab
//   U+000C  form feed
//   U+200B  zero-width space
//   U+200C  zero-width non-joiner
//   U+200D  zero-width joiner
//   U+2060  word joiner
//   U+FFFC  object replacement character
//   U+FFFD  replacement character
// NOTE: Using alternation instead of a character class to avoid linter warnings
// about control characters inside character classes.
const CONTROL_CHAR_RE =
  /\uFEFF|\u0000|\u000B|\u000C|\u200B|\u200C|\u200D|\u2060|\uFFFC|\uFFFD/g

/**
 * URL placeholder sentinel pattern (used internally during per-line processing).
 * Uses a named capture group so we avoid a magic array index.
 */
const URL_PLACEHOLDER = '__URL__'
const URL_PLACEHOLDER_RE = new RegExp(
  String.raw`${URL_PLACEHOLDER}(?<idx>\d+)${URL_PLACEHOLDER}`,
  'g'
)

/**
 * Leading spaces on a line (for bullet indentation detection).
 */
const LEADING_SPACES_RE = /^( *)/

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Text Normaliser
 *
 * Converts raw extracted / pasted text into a clean, canonical UTF-8 string
 * that faithfully preserves ALL structural context needed for content review
 * while stripping only genuine artefacts and noise.
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  WHAT IS PRESERVED                                              ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  ✔  Link anchor text                                            ║
 * ║  ✔  Link URLs (never altered — substitutions are skipped        ║
 * ║       inside URL tokens and Markdown link targets)              ║
 * ║  ✔  Paragraph boundaries  (blank line = \n\n)                   ║
 * ║  ✔  Line boundaries       (single \n)                           ║
 * ║  ✔  Bullet / list markers (-, *, •, numbered, …)               ║
 * ║  ✔  Headings              (ATX # and SETEXT underlines)         ║
 * ║  ✔  UTF-8 encoding        (NFC composed, ligatures expanded)    ║
 * ║  ✔  Original order of text                                      ║
 * ║  ✔  Visible spacing       (single space preserved; leading      ║
 * ║       indentation on bullets preserved)                         ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  WHAT IS REMOVED / NORMALISED                                   ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  ❌  Invisible / control characters  (BOM, null, ZWS, …)        ║
 * ║  ❌  Page-number-only lines          ("Page 3", "- 4 -", …)     ║
 * ║  ❌  Extra intra-line whitespace     (2+ spaces → 1, except     ║
 * ║       inside URLs and leading bullet indentation)               ║
 * ║  ❌  Trailing whitespace per line                                ║
 * ║  ❌  3+ consecutive blank lines      → capped at 2              ║
 * ║  ❌  Typographic artefacts           (ligatures, curly quotes,   ║
 * ║       typographic dashes — outside URL tokens)                  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Normalisations applied (in order):
 *  1.  BOM / null-byte / invisible control-character stripping
 *  2.  Unicode NFC composition
 *  3.  Ligature expansion  (PDF artefacts: ﬁ → fi, ﬀ → ff, etc.)
 *  4.  Line-ending normalisation (CRLF / CR → LF)
 *  5.  Page-number-only line removal
 *  6.  Per-line structural normalisation (URL-safe):
 *        a. Tab → single space
 *        b. Smart quote & typographic dash normalisation (skipped inside URLs)
 *        c. Collapse intra-line multi-spaces (skipped inside URLs /
 *           leading bullet indentation preserved)
 *        d. Trailing whitespace trim
 *  7.  Blank-line deduplication (3+ consecutive → 2)
 *  8.  Leading / trailing document whitespace trim
 */
class TextNormaliser {
  constructor() {
    /**
     * Ligature map – common PDF extraction artefacts.
     * Unicode ligature block: U+FB00–U+FB06
     */
    this.ligatureMap = {
      '\uFB00': 'ff', // ﬀ
      '\uFB01': 'fi', // ﬁ
      '\uFB02': 'fl', // ﬂ
      '\uFB03': 'ffi', // ﬃ
      '\uFB04': 'ffl', // ﬄ
      '\uFB05': 'st', // ﬅ
      '\uFB06': 'st' // ﬆ
    }

    this.ligatureRegex = new RegExp(
      Object.keys(this.ligatureMap).join('|'),
      'g'
    )

    /**
     * Smart / typographic quotes → ASCII equivalents.
     * Applied per character outside URL tokens only.
     */
    this.smartQuoteMap = {
      '\u2018': "'", // '  LEFT SINGLE QUOTATION MARK
      '\u2019': "'", // '  RIGHT SINGLE QUOTATION MARK
      '\u201A': "'", // ‚  SINGLE LOW-9 QUOTATION MARK
      '\u201B': "'", // ‛  SINGLE HIGH-REVERSED-9 QUOTATION MARK
      '\u2032': "'", // ′  PRIME
      '\u0060': "'", // `  GRAVE ACCENT (used as open quote in some docs)
      '\u00B4': "'", // ´  ACUTE ACCENT (used as close quote)
      '\u2039': '<', // ‹  SINGLE LEFT-POINTING ANGLE QUOTATION MARK
      '\u203A': '>', // ›  SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
      '\u201C': '"', // "  LEFT DOUBLE QUOTATION MARK
      '\u201D': '"', // "  RIGHT DOUBLE QUOTATION MARK
      '\u201E': '"', // „  DOUBLE LOW-9 QUOTATION MARK
      '\u201F': '"', // ‟  DOUBLE HIGH-REVERSED-9 QUOTATION MARK
      '\u2033': '"', // ″  DOUBLE PRIME
      '\u00AB': '"', // «  LEFT-POINTING DOUBLE ANGLE QUOTATION MARK
      '\u00BB': '"' //  »  RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK
    }

    /**
     * Typographic dashes → ASCII hyphen-minus (applied outside URL tokens).
     * Soft hyphen is removed entirely (invisible).
     */
    this.dashMap = {
      '\u2013': '-', // –  EN DASH
      '\u2014': '-', // —  EM DASH
      '\u2015': '-', // ―  HORIZONTAL BAR
      '\u2212': '-', // −  MINUS SIGN
      '\u00AD': '' //   SOFT HYPHEN (invisible, remove entirely)
    }

    this.smartQuoteRegex = new RegExp(
      Object.keys(this.smartQuoteMap).join('|'),
      'g'
    )
    this.dashRegex = new RegExp(Object.keys(this.dashMap).join('|'), 'g')

    logger.info('TextNormaliser initialised')
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Normalise raw text content.
   *
   * Returns the normalised string plus lightweight stats.
   * Does NOT rewrite, summarise, invent or reorder any content.
   *
   * @param {string} text - Raw text (may be post-PII-redaction or raw)
   * @returns {{ normalisedText: string, stats: NormalisationStats }}
   */
  normalise(text) {
    if (!text || typeof text !== 'string') {
      return {
        normalisedText: text ?? '',
        stats: this._emptyStats()
      }
    }

    const originalLength = text.length
    let t = text

    // ── 1. Invisible / control character stripping ────────────────────────
    // Keeps: \t (tab), \n (LF), \r (CR) — handled in later steps.
    t = t.replaceAll(CONTROL_CHAR_RE, '')

    // ── 2. Unicode NFC normalisation ──────────────────────────────────────
    // Ensures composed characters are consistent (e.g. é = U+00E9, not
    // e + U+0301). Must be done BEFORE ligature / quote passes.
    t = t.normalize('NFC')

    // ── 3. Ligature expansion ─────────────────────────────────────────────
    // PDF extraction artefacts: ﬁ → fi, ﬀ → ff, etc.
    t = t.replaceAll(this.ligatureRegex, (match) => this.ligatureMap[match])

    // ── 4. Line-ending normalisation: CRLF / CR → LF ─────────────────────
    // Must happen BEFORE per-line processing so split('\n') is reliable.
    t = t.replaceAll('\r\n', '\n').replaceAll('\r', '\n')

    // ── 5. Page-number-only line removal ─────────────────────────────────
    // Removes standalone page-number artefacts (e.g. "Page 3", "- 4 -").
    t = t
      .split('\n')
      .filter((line) => !PAGE_NUMBER_LINE_RE.test(line))
      .join('\n')

    // ── 6. Per-line structural normalisation ─────────────────────────────
    t = t
      .split('\n')
      .map((line) => this._normaliseLine(line))
      .join('\n')

    // ── 7. Blank-line deduplication (3+ consecutive → 2) ─────────────────
    t = t.replaceAll(/\n{3,}/g, '\n\n')

    // ── 8. Leading / trailing document whitespace trim ────────────────────
    t = t.trim()

    const normalisedLength = t.length
    const charsRemoved = originalLength - normalisedLength
    const stats = { originalLength, normalisedLength, charsRemoved }

    if (charsRemoved !== 0) {
      logger.info(
        stats,
        charsRemoved > 0
          ? `Text normalised: ${charsRemoved} chars removed`
          : `Text normalised: ${Math.abs(charsRemoved)} chars added (ligature expansion)`
      )
    }

    return { normalisedText: t, stats }
  }

  /**
   * Build a sourceMap — an array of span entries that map character offsets
   * in the normalised text back to structural block types.
   *
   * Each span entry:
   * {
   *   start:      number  — inclusive char offset in canonicalText
   *   end:        number  — exclusive char offset in canonicalText
   *   blockType:  string  — "heading" | "bullet" | "line" | "blank"
   *   lineIndex:  number  — 0-based line number in normalised text
   *   originType: string  — "textarea" | "page" | "url"
   *   originRef:  string|null — rawS3Key or null
   * }
   *
   * @param {string} normalisedText - Output of normalise()
   * @param {string} [originType]   - "textarea" | "page" | "url"
   * @param {string|null} [originRef] - rawS3Key or null
   * @returns {Array<Object>}
   */
  buildSourceMap(normalisedText, originType = 'textarea', originRef = null) {
    if (!normalisedText) {
      return []
    }

    const lines = normalisedText.split('\n')
    const spans = []
    let offset = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineLen = line.length
      const start = offset
      const end = offset + lineLen // exclusive; \n is the separator

      const blockType = this._classifyLine(line, lines[i + 1])

      spans.push({ start, end, blockType, lineIndex: i, originType, originRef })

      offset += lineLen + 1 // +1 for the \n separator
    }

    return spans
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Normalise a single line.
   *
   * URL tokens and Markdown link targets are extracted, replaced with
   * sentinel placeholders, then restored AFTER typographic substitutions —
   * ensuring we never corrupt a URL.
   *
   * Leading indentation (spaces preceding a bullet marker) is preserved
   * so list hierarchy is not flattened.
   *
   * @param {string} line
   * @returns {string}
   * @private
   */
  _normaliseLine(line) {
    // a. Tab → space
    let l = line.replaceAll('\t', ' ')

    if (l.trim() === '') {
      return '' // preserve blank lines as-is
    }

    const urlPlaceholders = []

    l = l.replaceAll(MARKDOWN_LINK_RE, (_match, anchor, url) => {
      const idx = urlPlaceholders.length
      const normAnchor = this._applyTypographicSubs(anchor)
      urlPlaceholders.push(`[${normAnchor}](${url})`)
      return `${URL_PLACEHOLDER}${idx}${URL_PLACEHOLDER}`
    })

    l = l.replaceAll(URL_TOKEN_RE, (match) => {
      const idx = urlPlaceholders.length
      urlPlaceholders.push(match)
      return `${URL_PLACEHOLDER}${idx}${URL_PLACEHOLDER}`
    })
    // d. Apply typographic substitutions on the non-URL remainder
    l = this._applyTypographicSubs(l)

    // e. Collapse multiple intra-line spaces; preserve leading indentation
    const leadingMatch = LEADING_SPACES_RE.exec(l)
    const leadingSpaces = leadingMatch ? leadingMatch[1] : ''
    const rest = l.slice(leadingSpaces.length)
    l = leadingSpaces + rest.replaceAll(/ {2,}/g, ' ')

    // f. Trim trailing whitespace
    l = l.trimEnd()

    // g. Restore URL placeholders verbatim
    l = l.replaceAll(URL_PLACEHOLDER_RE, (_m, ...args) => {
      // Named groups are passed as the last object argument
      const groups = args.at(-1)
      return urlPlaceholders[Number(groups.idx)]
    })

    return l
  }

  /**
   * Apply smart-quote and typographic-dash substitutions to a fragment
   * that is guaranteed NOT to contain any URL tokens.
   *
   * @param {string} fragment
   * @returns {string}
   * @private
   */
  _applyTypographicSubs(fragment) {
    return fragment
      .replaceAll(this.smartQuoteRegex, (match) => this.smartQuoteMap[match])
      .replaceAll(this.dashRegex, (match) => this.dashMap[match])
  }

  /**
   * Classify a single line into a structural block type.
   *
   * @param {string} line       - Current line
   * @param {string} [nextLine] - Next line (for SETEXT heading detection)
   * @returns {'heading'|'bullet'|'blank'|'line'}
   * @private
   */
  _classifyLine(line, nextLine) {
    if (line.trim() === '') {
      return 'blank'
    }
    if (HEADING_ATX_RE.test(line)) {
      return 'heading'
    }
    if (nextLine !== undefined && HEADING_SETEXT_RE.test(nextLine)) {
      return 'heading'
    }
    if (BULLET_RE.test(line)) {
      return 'bullet'
    }
    return 'line'
  }

  /** @private */
  _emptyStats() {
    return { originalLength: 0, normalisedLength: 0, charsRemoved: 0 }
  }
}

/**
 * @typedef {Object} NormalisationStats
 * @property {number} originalLength
 * @property {number} normalisedLength
 * @property {number} charsRemoved
 */

/**
 * @typedef {Object} SourceSpan
 * @property {number} start         - Inclusive char offset in canonicalText
 * @property {number} end           - Exclusive char offset in canonicalText
 * @property {string} blockType     - "heading" | "bullet" | "line" | "blank"
 * @property {number} lineIndex     - 0-based line number
 * @property {string} originType    - "textarea" | "page" | "url"
 * @property {string|null} originRef - rawS3Key or null
 */

export const textNormaliser = new TextNormaliser()
