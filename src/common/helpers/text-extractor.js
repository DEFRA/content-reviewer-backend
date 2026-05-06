import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import { createLogger } from './logging/logger.js'
import { textNormaliser } from './text-normaliser.js'

// pdfjs-dist v5 requires an explicit path to the worker — empty string no longer accepted.
// createRequire resolves the absolute path in node_modules; pathToFileURL converts it to
// a file:// URL that the Node.js Worker thread loader can consume on any OS/environment.
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve(
    'pdfjs-dist/legacy/build/pdf.worker.mjs'
  )
).href

const logger = createLogger()

// ─────────────────────────────────────────────────────────────────────────────
// PDF link extraction helpers (pdfjs-dist)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether two axis-aligned rectangles overlap.
 * PDF rectangles are [x1, y1, x2, y2] in bottom-left origin coordinates.
 *
 * @param {number[]} rect - annotation rectangle [x1,y1,x2,y2]
 * @param {number[]} bbox - text-item transform bounding box [x, y, w, h]
 *                          where x,y is the bottom-left corner of the glyph.
 * @returns {boolean}
 */
function rectsOverlap(rect, bbox) {
  const [rx1, ry1, rx2, ry2] = rect
  const [tx, ty] = bbox
  // Treat each text item as a point (its baseline anchor) for matching —
  // sufficient because PDF annotation rects are drawn tightly around the
  // visible link text.
  return tx >= rx1 && tx <= rx2 && ty >= ry1 && ty <= ry2
}

/**
 * Extract text from a single PDF page, weaving in hyperlink URLs wherever
 * link annotations spatially overlap with text items.
 *
 * Result format for linked spans:  anchorText [url]
 * This is then post-processed by reassemblePdfText() into proper Markdown.
 *
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @returns {Promise<string>} Plain text for the page, links as [anchor](url)
 */
async function extractPageTextWithLinks(page) {
  const [textContent, annotations] = await Promise.all([
    page.getTextContent(),
    page.getAnnotations()
  ])

  // Build lookup: only URI-type link annotations with a real URL
  const linkAnnotations = annotations.filter(
    (ann) => ann.subtype === 'Link' && ann.url?.startsWith('http')
  )

  if (linkAnnotations.length === 0) {
    // Fast path: no links on this page — join text items as normal
    return textContent.items.map((item) => item.str).join('')
  }

  // For each text item, check if it falls inside a link annotation rect.
  // pdfjs transform = [scaleX, skewY, skewX, scaleY, tx, ty]
  // Index 4 = tx (horizontal position), index 5 = ty (vertical position)
  const TX_INDEX = 4
  const TY_INDEX = 5
  const parts = []
  // Track which annotation is currently "open" so multi-item links are grouped
  let currentLink = null
  let currentAnchor = []

  const flush = (nextLink) => {
    if (currentLink && currentAnchor.length > 0) {
      const anchorText = currentAnchor.join('').trim()
      if (anchorText) {
        parts.push(`[${anchorText}](${currentLink})`)
      }
      currentAnchor = []
    }
    currentLink = nextLink
  }

  for (const item of textContent.items) {
    const tx = item.transform[TX_INDEX]
    const ty = item.transform[TY_INDEX]

    // Find which link annotation (if any) this item's anchor point falls in
    const matchedLink = linkAnnotations.find((ann) =>
      rectsOverlap(ann.rect, [tx, ty])
    )
    const matchedUrl = matchedLink ? matchedLink.url : null

    if (matchedUrl !== currentLink) {
      flush(matchedUrl)
    }

    if (matchedUrl) {
      currentAnchor.push(item.str)
    } else {
      parts.push(item.str)
    }
  }

  flush(null) // close any trailing link

  return parts.join('')
}

/**
 * Extract all text from a PDF buffer, preserving hyperlinks as
 * Markdown [anchor text](url) inline syntax.
 *
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function extractPdfWithLinks(buffer) {
  const data = new Uint8Array(buffer)
  const loadingTask = pdfjsLib.getDocument({
    data,
    // Suppress pdfjs console noise about missing CMap / standard fonts
    verbosity: 0
  })

  const doc = await loadingTask.promise
  const pageTexts = []

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const pageText = await extractPageTextWithLinks(page)
    pageTexts.push(pageText)
    page.cleanup()
  }

  await doc.cleanup()

  return pageTexts.join('\n\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// TextExtractor class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract structured plain text (with Markdown hyperlinks) from
 * PDF, DOCX and plain-text files.
 *
 * Hyperlink handling:
 *   • PDF  — pdfjs-dist annotation layer; links become [anchor](url)
 *   • DOCX — mammoth convertToMarkdown(); links already [anchor](url)
 *   • TXT  — raw text, no hyperlink extraction needed
 *
 * The output is passed to textNormaliser.normalise() which explicitly
 * preserves [anchor](url) tokens verbatim so URLs are never mangled.
 */
class TextExtractor {
  /**
   * Extract text (with embedded Markdown hyperlinks) from a file buffer.
   *
   * @param {Buffer} buffer   - File content
   * @param {string} mimeType - MIME type of the file
   * @param {string} [fileName='unknown']
   * @returns {Promise<string>} Normalised text with links as [anchor](url)
   */
  async extractText(buffer, mimeType, fileName = 'unknown') {
    logger.info(
      `Extracting text from file: ${fileName} with MIME type: ${mimeType}`
    )

    try {
      let text = ''

      switch (mimeType) {
        case 'application/pdf':
          text = await this.extractFromPDF(buffer)
          break

        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          text = await this.extractFromDocx(buffer)
          break

        case 'application/msword':
          throw new Error(
            'Legacy .doc format is not supported. Please use .docx format.'
          )

        case 'text/plain':
          text = buffer.toString('utf-8')
          break

        default:
          throw new Error(`Unsupported file type: ${mimeType}`)
      }

      // Pass through the normaliser: cleans artefacts while preserving
      // all [anchor](url) tokens, headings, bullets and paragraph breaks.
      text = this.cleanText(text)

      logger.info(
        { extractedLength: text.length, fileName },
        'Text extraction completed'
      )

      if (!text || text.trim().length === 0) {
        throw new Error('No text content could be extracted from the file')
      }

      return text
    } catch (error) {
      logger.error(
        { error: error.message, mimeType, fileName },
        'Text extraction failed'
      )
      throw new Error(`Failed to extract text: ${error.message}`)
    }
  }

  /**
   * Extract text from a PDF buffer.
   *
   * Uses pdfjs-dist to read both the text content layer and the annotation
   * layer.  Any URI link annotation whose rectangle overlaps a text-item
   * anchor point is rendered as inline Markdown: [anchor text](url).
   *
   * This ensures the LLM sees the actual destination URL and does NOT treat
   * hyperlinked anchor text as a missing reference.
   *
   * @param {Buffer} buffer
   * @returns {Promise<string>}
   */
  async extractFromPDF(buffer) {
    try {
      const text = await extractPdfWithLinks(buffer)

      logger.info(
        `PDF text + hyperlinks extracted via pdfjs-dist with length: ${text.length}`
      )

      return text
    } catch (error) {
      logger.error(`PDF extraction failed: ${error.message}`)
      throw new Error(`Failed to extract text from PDF: ${error.message}`)
    }
  }

  /**
   * Extract text from a DOCX buffer.
   *
   * Uses mammoth.convertToMarkdown() (instead of extractRawText) so that
   * hyperlinks are emitted as [anchor text](url) Markdown inline syntax,
   * and headings/bullets are rendered as ATX Markdown (#, -, *).
   *
   * @param {Buffer} buffer
   * @returns {Promise<string>}
   */
  async extractFromDocx(buffer) {
    try {
      // light debug info
      logger.info(
        `isBuffer: ${Buffer.isBuffer(buffer)},  buffer length: ${buffer.length}, zip signature: ${buffer.slice(0, 4).toString('hex')}`
      )

      const result = await this.runDocxExtraction(buffer)

      if (result.messages && result.messages.length > 0) {
        logger.warn(
          `DOCX extraction had warnings: ${result.messages.map((m) => m.message).join('; ')}`
        )
      }

      return result.value || ''
    } catch (error) {
      logger.error(`DOCX extraction failed: ${error.message}`)
      throw new Error(`Failed to extract text from DOCX: ${error.message}`)
    }
  }

  /**
   * Normalise various buffer-like inputs into an ArrayBuffer.
   */
  normalizeToArrayBuffer(buf) {
    if (buf instanceof ArrayBuffer) {
      return buf
    }
    if (ArrayBuffer.isView(buf)) {
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    }
    if (Buffer.isBuffer(buf)) {
      if (
        buf.buffer &&
        typeof buf.byteOffset === 'number' &&
        typeof buf.byteLength === 'number'
      ) {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      }
      return Uint8Array.from(buf).buffer
    }
    throw new Error('Unsupported input type for DOCX extraction')
  }

  /**
   * Build [opts, fn] combos for iteration.
   */
  buildCombos(fnNames, optsList) {
    return optsList.flatMap((opts) => fnNames.map((fn) => ({ opts, fn })))
  }

  /**
   * Attempt a single mammoth invocation and return result or null.
   */
  async attemptMammothCall(opts, fn) {
    // eslint-disable-next-line no-await-in-loop
    return mammoth[fn](opts).catch((err) => {
      logger.info(
        `DOCX ${fn} attempt failed with options keys: ${Object.keys(opts).join(', ')} - ${err.message}`
      )
      return null
    })
  }

  /**
   * Try a sequence of mammoth functions with given option shapes, return first success.
   */
  async tryMammoth(fnNames, optsList) {
    const combos = this.buildCombos(fnNames, optsList)
    for (const { opts, fn } of combos) {
      const res = await this.attemptMammothCall(opts, fn)
      if (res) {
        return res
      }
    }
    return null
  }

  /**
   * Safely inspect / extract specific DOCX entries without writing to disk.
   * - nodeBuffer: Buffer of the .docx file
   * - opts.maxEntries: max file entries to allow
   * - opts.maxUncompressed: max total uncompressed bytes allowed
   * Returns { entries, documentXml, totalUncompressed }
   */
  async safeInspectDocx(nodeBuffer, opts = {}) {
    const { maxEntries = 1000, maxUncompressed = 50 * 1024 * 1024 } = opts

    if (
      !Buffer.isBuffer(nodeBuffer) ||
      nodeBuffer.length < 4 ||
      nodeBuffer.slice(0, 4).toString('hex') !== '504b0304'
    ) {
      throw new Error('Not a ZIP archive / invalid DOCX')
    }

    const zip = await JSZip.loadAsync(nodeBuffer)
    const entries = Object.keys(zip.files)

    if (entries.length === 0) throw new Error('Empty archive')
    if (entries.length > maxEntries)
      throw new Error('Archive has too many entries')

    const whitelistPrefixes = [
      'word/',
      'word/_rels/',
      '_rels/',
      'docProps/',
      '[Content_Types].xml'
    ]
    let totalUncompressed = 0
    let documentXml = null

    for (const name of entries) {
      const normalized = name.replace(/\\/g, '/')
      if (normalized.includes('..'))
        throw new Error(`Rejected unsafe entry path: ${name}`)

      const allowed = whitelistPrefixes.some(
        (p) => normalized === p || normalized.startsWith(p)
      )
      if (!allowed) continue

      const fileEntry = zip.files[name]

      if (name === 'word/document.xml') {
        const xml = await fileEntry.async('string')
        totalUncompressed += Buffer.byteLength(xml, 'utf8')
        if (totalUncompressed > maxUncompressed)
          throw new Error('Archive uncompressed size exceeds limit')
        documentXml = xml
      } else {
        const arr = await fileEntry.async('uint8array')
        totalUncompressed += arr.length
        if (totalUncompressed > maxUncompressed)
          throw new Error('Archive uncompressed size exceeds limit')
      }
    }

    return { entries, documentXml, totalUncompressed }
  }

  /**
   * Core orchestration for DOCX extraction. Returns the mammoth result object.
   */
  async runDocxExtraction(buffer) {
    const arrayBuffer = this.normalizeToArrayBuffer(buffer)
    const nodeBuffer = Buffer.from(arrayBuffer)

    const attempts = [{ arrayBuffer }, { buffer: nodeBuffer }]

    // preferred: convertToMarkdown, fallback: extractRawText
    let result = await this.tryMammoth(['convertToMarkdown'], attempts)
    if (!result) {
      result = await this.tryMammoth(['extractRawText'], attempts)
    }
    // If mammoth failed, try a ZIP+XML fallback (JSZip)
    if (!result) {
      try {
        const { documentXml } = await this.safeInspectDocx(nodeBuffer, {
          maxEntries: 1000,
          maxUncompressed: 50 * 1024 * 1024
        })

        if (!documentXml) {
          throw new Error('DOCX zip missing word/document.xml')
        }

        const text = Array.from(documentXml.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/g))
          .map((m) => m[1])
          .join(' ')

        result = { value: text, messages: [] }
      } catch (zipErr) {
        throw new Error(
          `mammoth failed and ZIP fallback failed: ${zipErr.message}`
        )
      }
    }

    if (!result) {
      throw new Error(
        'mammoth failed to parse DOCX with any supported input shape'
      )
    }

    return result
  }

  /**
   * Normalise raw extracted text through the full TextNormaliser pipeline.
   *
   * TextNormaliser preserves [anchor](url) tokens verbatim — URLs are never
   * altered by whitespace collapse, dash substitution or quote substitution.
   *
   * @param {string} text
   * @returns {string}
   */
  cleanText(text) {
    if (!text) {
      return ''
    }
    return textNormaliser.normalise(text).normalisedText
  }

  /**
   * Get text preview (first N characters).
   * @param {string} text
   * @param {number} [maxLength=500]
   * @returns {string}
   */
  getPreview(text, maxLength = 500) {
    if (!text || text.length <= maxLength) {
      return text
    }
    return text.substring(0, maxLength) + '...'
  }

  /**
   * Count words in text.
   * @param {string} text
   * @returns {number}
   */
  countWords(text) {
    if (!text) {
      return 0
    }
    return text.trim().split(/\s+/).filter(Boolean).length
  }

  /**
   * Get text statistics.
   * @param {string} text
   * @returns {{ characters: number, words: number, lines: number, paragraphs: number }}
   */
  getStatistics(text) {
    if (!text) {
      return { characters: 0, words: 0, lines: 0, paragraphs: 0 }
    }
    return {
      characters: text.length,
      words: this.countWords(text),
      lines: text.split('\n').length,
      paragraphs: text.split(/\n\n+/).filter(Boolean).length
    }
  }
}

export const textExtractor = new TextExtractor()
