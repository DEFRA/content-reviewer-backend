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
      displayText,
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
      displayText,
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
    // ── Step 0a: HTML tag stripping (URL sources only) ───────────────────────
    // URL submissions arrive as a <!DOCTYPE html> document with <section>,
    // <div>, <p>, <a> etc. tags.  We convert these to plain text before any
    // further processing so that canonicalText is clean prose that Bedrock can
    // read and annotate with character offsets.
    //
    // <a> tags are special: we keep their text content so link labels are
    // preserved in the reviewed text (e.g. "read more about planning permission"
    // rather than losing the link entirely).  The href values are stripped at
    // this stage because they would pollute the character-offset calculations.
    // The original HTML (with full href values) is stored in the raw S3 archive
    // (content-uploads/{reviewId}/title.html) for reference.
    let workingText = text

    if (sourceType === SOURCE_TYPES.URL) {
      // Strip HTML tags using a linear-time state machine instead of a regex
      // so that malformed or adversarial input cannot trigger super-linear
      // backtracking (SonarQube S5852).  Block-level tags (p, div, h1–h6 …)
      // emit a newline so paragraph boundaries are preserved; inline tags
      // (span, a, strong …) are removed without any separator so words that
      // span tag boundaries are not split.
      workingText = stripHtmlTags(workingText)
        .replaceAll('&nbsp;', ' ')
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")

      // Normalise whitespace while preserving paragraph structure:
      //  1. Collapse runs of horizontal whitespace (spaces/tabs) on each line
      //     to a single space — but do NOT collapse newlines.
      //  2. Collapse 3+ consecutive newlines to 2 (paragraph break) so the
      //     output never has more blank lines than a single empty paragraph.
      workingText = workingText
        .split('\n')
        .map((line) => line.replaceAll(/ {2,}/gu, ' ').trim())
        .join('\n')
        .replaceAll(/\n{3,}/gu, '\n\n')
        .trim()

      // Collapse paragraph breaks between consecutive bullet lines into single
      // newlines so that list items from the same <ul> element remain grouped
      // in one block rather than being split into separate paragraphs.
      workingText = workingText
        .split('\n\n')
        .reduce((acc, para) => {
          const trimmedPara = para.trim()
          if (!trimmedPara) {
            return acc
          }
          const isBullet = trimmedPara.startsWith('• ')
          if (acc.length > 0 && isBullet) {
            const lastPara = acc[acc.length - 1]
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

    // ── Step 0a(ii): Capture displayText for URL sources ────────────────────
    // displayText preserves Markdown link syntax [anchor](url) for use in the
    // results page so plain (non-highlighted) sections remain clickable.
    // canonicalText will have Markdown links stripped to anchor-text only so
    // that Bedrock sees clean prose and character offsets are accurate.
    //
    // Both texts diverge only at this one point — everything before (HTML tag
    // stripping, entity unescaping, whitespace normalisation) is identical, and
    // everything after (PII redaction, text normalisation) is applied to both
    // so they stay structurally in sync.
    let displayText = null
    if (sourceType === SOURCE_TYPES.URL) {
      // Save the working text with Markdown links intact
      displayText = workingText
      // Strip Markdown links [anchor](url) → anchor for canonicalText only
      workingText = workingText.replaceAll(
        /\[([^\]]{0,2000})\]\([^)\s]{0,2048}\)/gu,
        '$1'
      )
    }

    // ── Step 0b: Front-matter stripping (file sources only) ─────────────────
    // Title pages, copyright/imprint pages and tables of contents are structural
    // boilerplate found in PDFs/uploaded files that add noise for the AI.
    // URL sources are explicitly excluded: GOV.UK pages do not have PDF-style
    // front-matter, and the section stripper would falsely classify the page
    // H1 (short first "page") as a title page and the navigation contents list
    // as a TOC, stripping legitimate reviewable content.
    // Free-text pastes (SOURCE_TYPES.TEXT) are also skipped — direct user input
    // must never be silently discarded.
    let sectionStripStats = null

    const shouldStrip = sourceType === SOURCE_TYPES.FILE

    if (shouldStrip) {
      const { strippedText, stats } = documentSectionStripper.strip(workingText)
      workingText = strippedText
      sectionStripStats = stats
    }

    // ── Step 1: PII redaction ────────────────────────────────────────────────
    const redactionResult = piiRedactor.redactUserContent(workingText)

    // Also redact PII from displayText (URL sources only) so that any PII
    // in link anchor text is not surfaced in the rendered results page.
    let redactedDisplayText = null
    if (displayText !== null) {
      redactedDisplayText =
        piiRedactor.redactUserContent(displayText).redactedText
    }

    // ── Step 2: Text normalisation ───────────────────────────────────────────
    const { normalisedText: canonicalText, stats: normStats } =
      textNormaliser.normalise(redactionResult.redactedText)

    // Normalise displayText through the same pipeline so structural whitespace,
    // ligatures and typographic characters are consistent with canonicalText.
    const normalisedDisplayText =
      redactedDisplayText !== null
        ? textNormaliser.normalise(redactedDisplayText).normalisedText
        : null

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
      displayText: normalisedDisplayText,
      normStats,
      sectionStripStats,
      charCount,
      tokenEst,
      createdAt,
      originType
    }
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
    displayText,
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
      ...(displayText !== null && displayText !== undefined
        ? { displayText }
        : {}),
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
