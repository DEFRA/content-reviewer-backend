import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'
import { piiRedactor } from './pii-redactor.js'
import { textNormaliser } from './text-normaliser.js'
import { documentSectionStripper } from './document-section-stripper.js'

const logger = createLogger()

/**
 * Block-level HTML tag names whose closing tag marks a paragraph boundary.
 * Inline elements (span, a, strong, em, …) are NOT in this set — their
 * closing tags must not insert whitespace or words like "farm</span>ers"
 * become "farm ers".
 */
const BLOCK_TAG_NAMES = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'br',
  'caption',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'legend',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'title',
  'tr',
  'ul'
])

/**
 * Strip HTML tags from a string using a linear-time state machine.
 * Each character is visited exactly once — no backtracking is possible,
 * making this safe against ReDoS (SonarQube S5852).
 *
 * Block-level tags (p, div, h1–h6, li, …) insert a newline so that
 * paragraph structure is preserved in the output.  Inline tags (span,
 * a, strong, em, …) are removed without inserting any separator so that
 * words spanning tag boundaries (e.g. "farm<span>ers</span>") are
 * correctly joined rather than split.
 *
 * @param {string} input
 * @returns {string}
 */
function stripHtmlTags(input) {
  const out = []
  let inTag = false
  let tagBuf = '' // accumulates tag name characters

  for (const ch of input) {
    if (!inTag && ch !== '<') {
      out.push(ch)
    } else if (ch === '<') {
      inTag = true
      tagBuf = ''
    } else if (ch === '>') {
      // Determine whether the tag we just closed is a block element.
      // tagBuf may start with '/' (closing tag) or end with '/' (void closing).
      // Strip those and any attributes to get a clean tag name.
      const isClosingTag = tagBuf.startsWith('/')
      const rawName = tagBuf.split(/[\s/]/u)[0].replace(/^\//, '').toLowerCase()
      if (rawName === 'li' && !isClosingTag) {
        // Opening <li> gets a bullet prefix so list structure is preserved.
        // Closing </li> emits nothing — the next <li> or </ul> provides the break.
        out.push('\n• ')
      } else if (rawName !== 'li' && BLOCK_TAG_NAMES.has(rawName)) {
        out.push('\n')
      } else {
        // Inline tag or closing </li> — no output needed
      }
      inTag = false
      tagBuf = ''
    } else {
      // Character inside a tag — accumulate for block-element detection
      tagBuf += ch
    }
  }

  return out.join('')
}

/**
 * Source types for canonical documents
 */
export const SOURCE_TYPES = {
  FILE: 'file',
  URL: 'url',
  TEXT: 'text'
}

/**
 * Canonical document statuses
 */
export const CANONICAL_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
}

/**
 * Manages canonical document JSON files stored under documents/{documentId}.json in S3.
 *
 * The canonical document is the single source of truth for content submitted for review.
 * documentId === reviewId, wiring together S3, SQS and Bedrock AI.
 *
 * Processing pipeline:
 *
 *   raw input (extracted file text / URL body / text paste)
 *       │
 *       ▼
 *   [Step 0] Section stripping   — removes title page, copyright/imprint
 *                                  page and table of contents from file and
 *                                  URL sources (skipped for free-text pastes
 *                                  so user content is never silently dropped)
 *       │
 *       ▼
 *   [Step 1] PII redaction       — strips NI numbers, card numbers, etc.
 *       │
 *       ▼
 *   [Step 2] Text normalisation  — unicode NFC, ligatures, smart quotes,
 *                                  URL-safe whitespace, page-number removal,
 *                                  bullet/heading/link preservation
 *       │
 *       ▼
 *   [Step 3] sourceMap build     — per-span offsets mapping each line back
 *                                  to its block type (heading/bullet/line/blank)
 *       │
 *       ▼
 *   canonicalText  →  saved to S3 as documents/{documentId}.json
 *
 * Schema (matches API Technical Requirements):
 * {
 *   documentId:    string   - UUID, same as reviewId
 *   sourceType:    string   - "file" | "url" | "text"
 *   rawS3Key:      string   - S3 key of the original raw upload (audit trail)
 *   canonicalText: string   - Normalised, PII-redacted, structure-preserving text
 *                             (Markdown link syntax is stripped — clean prose for Bedrock)
 *   linkMap:       array?   - Present only for URL sources that contain at least one
 *                             hyperlink.  Each entry maps a hyperlink anchor back to its
 *                             original Markdown syntax:
 *                             { start: number, end: number, display: string }
 *                             start/end are char offsets into canonicalText;
 *                             display is the full "[anchor](url)" Markdown string.
 *                             Used by the results page to restore clickable links in
 *                             plain (non-highlighted) annotated sections.
 *   charCount:     number   - Length of canonicalText
 *   tokenEst:      number   - Approx charCount / 4
 *   sourceMap:     array    - Per-span offset entries:
 *                             { start, end, blockType, lineIndex, originType, originRef }
 *                             blockType: "heading" | "bullet" | "line" | "blank"
 *   createdAt:     string   - ISO 8601 timestamp
 *   status:        string   - "pending" | "processing" | "completed" | "failed"
 *   title:         string?  - Optional title / filename hint
 * }
 */
class CanonicalDocumentStore {
  constructor() {
    const s3Config = { region: config.get('aws.region') }

    const awsEndpoint = config.get('aws.endpoint')
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true
    }

    this.s3Client = new S3Client(s3Config)
    this.bucket = config.get('s3.bucket')
    this.prefix = 'documents'
  }

  /**
   * Build the S3 key for a canonical document.
   * @param {string} documentId - Same as reviewId
   * @returns {string} e.g. "documents/review_<uuid>.json"
   */
  getDocumentKey(documentId) {
    return `${this.prefix}/${documentId}.json`
  }

  /**
   * Create a canonical document from any source type and persist it to S3.
   *
   * This is the single entry point regardless of whether the content came
   * from a textarea, an uploaded file (text already extracted), or a URL.
   * The pipeline is always:
   *   raw text → PII redaction → normalisation → persist
   *
   * @param {Object}  options
   * @param {string}  options.documentId  - reviewId (primary key shared across S3/SQS/Bedrock)
   * @param {string}  options.text        - Raw text content (plain text paste OR extracted file text)
   * @param {string}  [options.sourceType] - SOURCE_TYPES.TEXT | SOURCE_TYPES.FILE | SOURCE_TYPES.URL
   * @param {string}  [options.title]     - Optional title / filename hint
   * @param {string}  [options.rawS3Key]  - S3 key of the original raw upload (audit trail)
   * @returns {Promise<Object>} { document, s3, durationMs }
   */
  async createCanonicalDocument({
    documentId,
    text,
    sourceType = SOURCE_TYPES.TEXT,
    title = null,
    rawS3Key = null
  }) {
    // Step 0, 1 & 2: Strip front-matter, redact PII, normalise
    const {
      redactionResult,
      canonicalText,
      linkMap,
      normStats,
      sectionStripStats,
      charCount,
      tokenEst,
      createdAt,
      originType
    } = this._redactAndNormalise({
      text,
      sourceType
    })

    // Step 3: Build sourceMap
    const sourceMap = this._buildSourceMap({
      canonicalText,
      originType,
      rawS3Key
    })

    // Compose document object
    const document = this._composeDocument({
      documentId,
      sourceType,
      rawS3Key,
      canonicalText,
      linkMap,
      charCount,
      tokenEst,
      sourceMap,
      createdAt,
      title
    })

    const key = this.getDocumentKey(documentId)

    this._logDocumentInfo({
      documentId,
      sourceType,
      charCount,
      tokenEst,
      redactionResult,
      normStats,
      sectionStripStats,
      rawS3Key,
      key
    })

    const { duration } = await this._persistDocumentToS3({
      document,
      key,
      metadata: {
        documentId,
        sourceType,
        charCount: charCount.toString(),
        createdAt,
        piiRedacted: redactionResult.hasPII ? 'true' : 'false',
        ...(rawS3Key ? { rawS3Key } : {})
      }
    })

    return {
      document,
      s3: {
        bucket: this.bucket,
        key,
        location: `s3://${this.bucket}/${key}`
      },
      durationMs: duration
    }
  }

  /**
   * Step 0, 1 & 2: Strip front-matter (file/url only), redact PII, normalise.
   * @private
   */
  _redactAndNormalise({ text, sourceType }) {
    // ── Step 0: Prepare working text ─────────────────────────────────────────
    // For URL sources: strip HTML tags, normalise whitespace, and keep a copy
    // of the text *before* Markdown link syntax is stripped (preStripText).
    // For FILE sources: front-matter stripping is deferred to step 0b below.
    // For TEXT sources: the input is used as-is.
    const { workingText: preparedText, preStripText } = this._prepareUrlText(
      text,
      sourceType
    )

    let workingText = preparedText

    // ── Step 0b: Front-matter stripping (file sources only) ─────────────────
    let sectionStripStats = null
    if (sourceType === SOURCE_TYPES.FILE) {
      const { strippedText, stats } = documentSectionStripper.strip(workingText)
      workingText = strippedText
      sectionStripStats = stats
    }

    // ── Step 1: PII redaction ────────────────────────────────────────────────
    const redactionResult = piiRedactor.redactUserContent(workingText)

    const redactedPreStripText =
      preStripText === null
        ? null
        : piiRedactor.redactUserContent(preStripText).redactedText

    // ── Step 2: Text normalisation ───────────────────────────────────────────
    const { normalisedText: canonicalText, stats: normStats } =
      textNormaliser.normalise(redactionResult.redactedText)

    const normalisedPreStripText =
      redactedPreStripText === null
        ? null
        : textNormaliser.normalise(redactedPreStripText).normalisedText

    // ── Step 2a: Build linkMap for URL sources ───────────────────────────────
    const linkMap = this._buildLinkMap(normalisedPreStripText)

    const charCount = canonicalText.length
    const tokenEst = Math.round(charCount / 4)
    const createdAt = new Date().toISOString()

    let originType
    if (sourceType === SOURCE_TYPES.FILE) {
      originType = 'page'
    } else if (sourceType === SOURCE_TYPES.URL) {
      originType = 'url'
    } else {
      originType = 'textarea'
    }

    return {
      redactionResult,
      canonicalText,
      linkMap,
      normStats,
      sectionStripStats,
      charCount,
      tokenEst,
      createdAt,
      originType
    }
  }

  /**
   * Replace common HTML entities with their plain-text equivalents.
   * @param {string} text
   * @returns {string}
   * @private
   */
  _stripEntities(text) {
    const entities = {
      '&nbsp;': ' ',
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'"
    }
    // Single-pass replacement so each entity is decoded exactly once.
    // Chained replaceAll calls would double-decode sequences like &amp;lt; → &lt; → <
    return text.replaceAll(
      /&(?:nbsp|amp|lt|gt|quot|#39);/gu,
      (match) => entities[match] ?? match
    )
  }

  /**
   * Collapse runs of horizontal whitespace within lines and remove excessive
   * blank lines (3+ consecutive newlines → 2).
   * @param {string} text
   * @returns {string}
   * @private
   */
  _collapseWhitespace(text) {
    return text
      .split('\n')
      .map((line) => line.replaceAll(/ {2,}/gu, ' ').trim())
      .join('\n')
      .replaceAll(/\n{3,}/gu, '\n\n')
      .trim()
  }

  /**
   * Pass A — re-join orphaned bullet markers separated from their text by a
   * blank line ('\n\n').  A paragraph that is exactly '•' is merged with the
   * following paragraph.
   * @param {string} text
   * @returns {string}
   * @private
   */
  _mergeOrphanedBulletsPassA(text) {
    const paras = text.split('\n\n')
    const merged = []
    let i = 0
    while (i < paras.length) {
      if (paras[i].trim() === '•' && i + 1 < paras.length) {
        merged.push(`• ${paras[i + 1].trim()}`)
        i += 2
      } else {
        merged.push(paras[i])
        i += 1
      }
    }
    return merged.join('\n\n')
  }

  /**
   * Pass B — re-join orphaned bullet markers separated from their text by a
   * single newline ('\n').  Within each paragraph, a line that is exactly '•'
   * is merged with the following line.
   * @param {string} text
   * @returns {string}
   * @private
   */
  _mergeOrphanedBulletsPassB(text) {
    return text
      .split('\n\n')
      .map((para) => {
        const lines = para.split('\n')
        const merged = []
        let i = 0
        while (i < lines.length) {
          if (lines[i].trim() === '•' && i + 1 < lines.length) {
            merged.push(`• ${lines[i + 1].trim()}`)
            i += 2
          } else {
            merged.push(lines[i])
            i += 1
          }
        }
        return merged.join('\n')
      })
      .join('\n\n')
  }

  /**
   * Merge consecutive bullet paragraphs (lines starting with '• ') that are
   * separated by blank lines into a single contiguous block.
   * @param {string} text
   * @returns {string}
   * @private
   */
  _mergeConsecutiveBullets(text) {
    return text
      .split('\n\n')
      .reduce((acc, para) => {
        const trimmedPara = para.trim()
        if (!trimmedPara) {
          return acc
        }
        const isBullet = trimmedPara.startsWith('• ')
        if (acc.length > 0 && isBullet) {
          const lastPara = acc.at(-1)
          const lastLine = lastPara.split('\n').findLast((l) => l.trim())
          if (lastLine?.trim().startsWith('• ')) {
            acc[acc.length - 1] = `${lastPara}\n${trimmedPara}`
            return acc
          }
        }
        acc.push(trimmedPara)
        return acc
      }, [])
      .join('\n\n')
  }

  /**
   * Step 0a: Prepare source text for the canonical pipeline.
   *
   * URL sources get the full treatment: HTML tag stripping, entity decoding,
   * whitespace collapse, bullet merging, and Markdown link extraction.
   *
   * TEXT (paste) sources get the same whitespace and bullet cleanup — but NOT
   * HTML tag stripping (users paste plain text intentionally) and NOT Markdown
   * link stripping (pasted text has no Markdown links).  This brings the two
   * paths close enough that Bedrock receives similarly structured canonical
   * text, reducing spurious differences in issue distribution.
   *
   * FILE sources are returned as-is; they are handled by documentSectionStripper
   * in the next step.
   *
   * Returns { workingText, preStripText } where preStripText is non-null only
   * for URL sources (used to build the linkMap after normalisation).
   *
   * @param {string} text
   * @param {string} sourceType
   * @returns {{ workingText: string, preStripText: string|null }}
   * @private
   */
  _prepareUrlText(text, sourceType) {
    // ── URL: full pipeline (HTML strip → entities → whitespace → bullets → links)
    if (sourceType === SOURCE_TYPES.URL) {
      // Strip HTML tags (linear-time state machine, ReDoS-safe) then entities
      let workingText = this._stripEntities(stripHtmlTags(text))

      // Collapse horizontal whitespace and excessive blank lines
      workingText = this._collapseWhitespace(workingText)

      // Re-join orphaned bullet markers (two-pass: blank-line then single-line)
      workingText = this._mergeOrphanedBulletsPassA(workingText)
      workingText = this._mergeOrphanedBulletsPassB(workingText)

      // Merge consecutive bullet paragraphs into a single block
      workingText = this._mergeConsecutiveBullets(workingText)

      // Snapshot the text with Markdown links still intact (for the linkMap)
      const preStripText = workingText

      // Strip Markdown links [anchor](url) → anchor for the canonical pipeline
      workingText = workingText.replaceAll(
        /\[([^\]]{0,2000})\]\([^)\s]{0,2048}\)/gu,
        '$1'
      )

      return { workingText, preStripText }
    }

    // ── TEXT (paste): entity decode + whitespace + bullets (no HTML strip, no links)
    // Applying the same structural cleanup as URL ensures both paths produce
    // similarly sized canonical text and comparable third boundaries for Bedrock.
    if (sourceType === SOURCE_TYPES.TEXT) {
      // Decode HTML entities that browsers insert on copy (&nbsp;, &amp;, etc.)
      let workingText = this._stripEntities(text)

      // Collapse multiple spaces and excessive blank lines
      workingText = this._collapseWhitespace(workingText)

      // Re-join orphaned bullet markers that copy-paste splits across lines
      workingText = this._mergeOrphanedBulletsPassA(workingText)
      workingText = this._mergeOrphanedBulletsPassB(workingText)

      // Merge consecutive bullet paragraphs into a single block
      workingText = this._mergeConsecutiveBullets(workingText)

      return { workingText, preStripText: null }
    }

    // ── FILE and any other source: pass through unchanged
    return { workingText: text, preStripText: null }
  }

  /**
   * Step 2a: Build a linkMap from normalisedPreStripText.
   *
   * Scans normalisedPreStripText for Markdown links and records each link's
   * position in the corresponding canonicalText (which has the Markdown links
   * stripped).  The parallel walk works because the two texts are byte-for-byte
   * identical outside of the (url) parts of Markdown links.
   *
   * Returns null when normalisedPreStripText is null or contains no links.
   *
   * @param {string|null} normalisedPreStripText
   * @returns {Array|null}  array of { start, end, display } or null
   * @private
   */
  _buildLinkMap(normalisedPreStripText) {
    if (normalisedPreStripText === null) {
      return null
    }

    const LINK_SCAN_RE = /\[([^\]]{0,2000})\]\([^)\s]{0,2048}\)/gu
    const entries = []
    let canonicalOffset = 0
    let lastPreStripPos = 0

    for (const match of normalisedPreStripText.matchAll(LINK_SCAN_RE)) {
      const matchStart = match.index
      const fullMatch = match[0] // "[anchor text](https://...)"
      const anchor = match[1] // "anchor text"

      // Gap characters are identical in both texts — advance both offsets
      canonicalOffset += matchStart - lastPreStripPos

      entries.push({
        start: canonicalOffset,
        end: canonicalOffset + anchor.length,
        display: fullMatch
      })

      canonicalOffset += anchor.length
      lastPreStripPos = matchStart + fullMatch.length
    }

    return entries.length > 0 ? entries : null
  }

  /**
   * Step 3: Build per-span sourceMap.
   * @private
   */
  _buildSourceMap({ canonicalText, originType, rawS3Key }) {
    return textNormaliser.buildSourceMap(
      canonicalText,
      originType,
      rawS3Key || null
    )
  }

  /**
   * Compose the canonical document object.
   * @private
   */
  _composeDocument({
    documentId,
    sourceType,
    rawS3Key,
    canonicalText,
    linkMap,
    charCount,
    tokenEst,
    sourceMap,
    createdAt,
    title
  }) {
    return {
      documentId,
      sourceType,
      ...(rawS3Key ? { rawS3Key } : {}),
      canonicalText,
      // linkMap is only present for URL sources that contain at least one hyperlink.
      // Each entry: { start, end, display } where start/end are char offsets into
      // canonicalText and display is the full [anchor](url) Markdown string.
      ...(Array.isArray(linkMap) && linkMap.length > 0 ? { linkMap } : {}),
      charCount,
      tokenEst,
      sourceMap,
      createdAt,
      status: CANONICAL_STATUS.PENDING,
      ...(title ? { title } : {})
    }
  }

  /**
   * Log document creation info.
   * @private
   */
  _logDocumentInfo({
    documentId,
    sourceType,
    charCount,
    tokenEst,
    redactionResult,
    normStats,
    sectionStripStats,
    rawS3Key,
    key
  }) {
    const strippedSections = sectionStripStats?.sectionsRemoved ?? []
    const sectionStripMsg =
      strippedSections.length > 0
        ? `, stripped front-matter=[${strippedSections.join(',')}]`
        : ''

    logger.info(
      {
        documentId,
        sourceType,
        charCount,
        tokenEst,
        hasPII: redactionResult.hasPII,
        piiRedactionCount: redactionResult.redactionCount,
        normCharsRemoved: normStats.charsRemoved,
        sectionStripStats: sectionStripStats ?? null,
        rawS3Key: rawS3Key || null,
        bucket: this.bucket,
        key
      },
      redactionResult.hasPII
        ? `[canonical-document] PII REDACTED (${redactionResult.redactionCount} instances), normalised${sectionStripMsg} | ${charCount} chars | sourceType=${sourceType}`
        : `[canonical-document] Normalised${sectionStripMsg} | ${charCount} chars | sourceType=${sourceType}`
    )
  }

  /**
   * Helper to persist a canonical document to S3 and log timing.
   * @private
   */
  async _persistDocumentToS3({ document, key, metadata }) {
    const startTime = performance.now()

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(document, null, 2),
        ContentType: 'application/json',
        Metadata: metadata
      })
    )

    const duration = Math.round(performance.now() - startTime)

    logger.info(
      {
        documentId: document.documentId,
        sourceType: document.sourceType,
        key,
        bucket: this.bucket,
        durationMs: duration
      },
      `[canonical-document] Persisted to S3 in ${duration}ms`
    )

    return { duration }
  }

  /**
   * Read a canonical document from S3 and return the parsed object.
   *
   * @param {string} documentId - Same as reviewId
   * @returns {Promise<Object>} Parsed canonical document
   */
  async getDocument(documentId) {
    const key = this.getDocumentKey(documentId)

    logger.info({ documentId, key }, '[canonical-document] Fetching from S3')

    const startTime = performance.now()

    const response = await this.s3Client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    )

    const chunks = []
    for await (const chunk of response.Body) {
      chunks.push(chunk)
    }
    const json = Buffer.concat(chunks).toString('utf-8')
    const document = JSON.parse(json)

    const duration = Math.round(performance.now() - startTime)

    logger.info(
      { documentId, charCount: document.charCount, durationMs: duration },
      `[canonical-document] Fetched in ${duration}ms`
    )

    return document
  }

  /**
   * Generate a unique document/review ID.
   * @returns {string}
   */
  static generateId() {
    return `review_${randomUUID()}`
  }
}

export const canonicalDocumentStore = new CanonicalDocumentStore()
