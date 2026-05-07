import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import { createLogger } from './logging/logger.js'
import { textNormaliser } from './text-normaliser.js'
import { XMLParser } from 'fast-xml-parser'

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
  const pageBlocks = []

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    try {
      const [textContent, annotations] = await Promise.all([
        page.getTextContent(),
        page.getAnnotations()
      ])

      const linkAnnotations = (annotations || []).filter(
        (ann) => ann.subtype === 'Link' && ann.url
      )

      const TX_INDEX = 4
      const TY_INDEX = 5

      const items = (textContent.items || []).map((it) => {
        const tx = Number(it.transform[TX_INDEX] || 0)
        const ty = Number(it.transform[TY_INDEX] || 0)
        const fontSize = Math.abs(it.transform[3]) || 0
        // detect bold from fontName or style fontFamily
        const style = textContent.styles?.[it.fontName] || {}
        const fontDesc = (
          (it.fontName || '') +
          ' ' +
          (style.fontFamily || '')
        ).toLowerCase()
        const bold = /bold|black|heavy|700/.test(fontDesc)
        // preserve raw string (do not aggressively collapse internal spaces here)
        return { str: it.str || '', tx, ty, fontSize, bold }
      })

      if (items.length === 0) {
        pageBlocks.push([]) // page with no content -> keep separation
        continue
      }

      // median font size for page
      const fontSizes = items
        .map((x) => x.fontSize)
        .filter(Boolean)
        .sort((a, b) => a - b)

      let medianFontSize
      if (fontSizes.length === 0) {
        medianFontSize = 0
      } else if (fontSizes.length % 2 === 1) {
        medianFontSize = fontSizes[(fontSizes.length - 1) / 2]
      } else {
        const mid = fontSizes.length / 2
        medianFontSize = (fontSizes[mid - 1] + fontSizes[mid]) / 2
      }

      // group into lines by rounded y
      const lineMap = new Map()
      for (const it of items) {
        const key = Math.round(it.ty)
        if (!lineMap.has(key)) lineMap.set(key, [])
        lineMap.get(key).push(it)
      }

      const lines = Array.from(lineMap.entries())
        .map(([y, its]) => {
          its.sort((a, b) => a.tx - b.tx)
          const avgFont = its.reduce((s, x) => s + x.fontSize, 0) / its.length
          return { y: Number(y), items: its, avgFontSize: avgFont }
        })
        .sort((a, b) => b.y - a.y) // top-to-bottom

      // median gap
      const gaps = []
      for (let i = 0; i < lines.length - 1; i++)
        gaps.push(Math.abs(lines[i].y - lines[i + 1].y))
      gaps.sort((a, b) => a - b)
      let medianGap
      if (gaps.length === 0) {
        medianGap = 0
      } else if (gaps.length % 2 === 1) {
        medianGap = gaps[(gaps.length - 1) / 2]
      } else {
        const mid = gaps.length / 2
        medianGap = (gaps[mid - 1] + gaps[mid]) / 2
      }

      const findUrlForItem = (item) => {
        const matched = linkAnnotations.find((ann) =>
          rectsOverlap(ann.rect, [item.tx, item.ty])
        )
        return matched ? matched.url : null
      }

      // assemble blocks for page
      const blocks = []
      let currentParagraphRuns = []
      let lastLineY = null

      const flushParagraph = (type = 'para') => {
        if (currentParagraphRuns.length > 0) {
          blocks.push({ type, runs: currentParagraphRuns })
          currentParagraphRuns = []
        }
      }

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx]
        // build runs for this line preserving bold and links
        const runs = []
        for (const it of line.items) {
          // trim only leading/trailing but keep internal spacing as-is
          const text = String(it.str || '')
          if (!text || text.trim() === '') continue
          const url = findUrlForItem(it)
          runs.push({ text: text, bold: !!it.bold, href: url || null })
        }
        if (runs.length === 0) {
          // blank line -> paragraph separator
          flushParagraph()
          lastLineY = line.y
          continue
        }

        // build a textual representation for heuristics, inserting spaces between runs where appropriate
        const heuristicLineText = runs
          .map((r, i) => {
            const next = runs[i + 1]
            if (!next) return r.text.trim()
            const endChar = r.text.slice(-1)
            const startChar = next.text.charAt(0)
            const needsSpace =
              !/\s/.test(endChar) &&
              !/[\s\-\u2013\u2014\.,:;\/\)\(]/.test(startChar)
            return r.text + (needsSpace ? ' ' : '')
          })
          .join('')
          .replace(/\s+/g, ' ')
          .trim()

        const lineText = heuristicLineText
        const isHeading =
          medianFontSize > 0 &&
          line.avgFontSize >
            Math.max(1.25 * medianFontSize, medianFontSize + 1) &&
          lineText.length <= 200

        // Only treat explicit bullet characters as list markers (avoid turning "1. Intro" into list)
        const listMatch = lineText
          .trim()
          .match(/^([•\u2022\-\u2013\u2014])\s+(.*)$/)
        const isList = !!listMatch

        let largeGap = false
        if (lastLineY !== null && medianGap > 0) {
          const gap = Math.abs(lastLineY - line.y)
          if (gap > Math.max(medianGap * 1.8, 12)) largeGap = true
        }

        if (isHeading) {
          flushParagraph()
          // preserve/force bold for heading runs so heading appears as in source
          runs.forEach((r) => {
            r.bold = r.bold || true
          })
          // heading: single-line block with bolding preserved in runs
          blocks.push({ type: 'heading', runs })
        } else if (isList) {
          flushParagraph()
          // keep runs but remove bullet from first run text
          if (runs.length > 0) {
            runs[0].text = runs[0].text.replace(
              /^([•\u2022\-\u2013\u2014])\s*/,
              ''
            )
          }
          blocks.push({ type: 'list', runs })
        } else {
          if (largeGap) flushParagraph()
          // append runs to current paragraph (keep runs separate to preserve bold)
          currentParagraphRuns.push(...runs)
        }

        lastLineY = line.y
      }

      flushParagraph()
      // append page blocks
      pageBlocks.push(blocks)
    } finally {
      page.cleanup()
    }
  }

  await doc.cleanup()

  // flatten pages into blocks with empty page separator between pages
  const allBlocks = []
  for (const pb of pageBlocks) {
    if (pb.length === 0) {
      // preserve page break as empty separator
      allBlocks.push({ type: 'sep', runs: [] })
      continue
    }
    for (const b of pb) allBlocks.push(b)
    // add page separator
    allBlocks.push({ type: 'sep', runs: [] })
  }
  return allBlocks
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
        const zip = await JSZip.loadAsync(nodeBuffer)
        const docFile = zip.file('word/document.xml')
        if (!docFile) {
          throw new Error('DOCX zip missing word/document.xml')
        }
        const xml = await docFile.async('string')
        const relEntry = zip.file('word/_rels/document.xml.rels')
        const relsXml = relEntry ? await relEntry.async('string') : null

        const structured = this.docxXmlToParagraphObjects(xml, relsXml)
        // return an object shape compatible with mammoth result
        result = { value: structured, messages: [] }
      } catch (zipErr) {
        // keep original behaviour by throwing a clear error
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
   * Convert document.xml + rels XML into readable Markdown-ish text.
   * Handles paragraphs, simple headings, bullets, numbered lists, links, bold/italic inline.
   */
  docxXmlToParagraphObjects(documentXml, relsXml) {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      textNodeName: '#text',
      ignoreNameSpace: false
    })

    const doc = parser.parse(documentXml)
    const body = doc['w:document']?.['w:body']
    if (!body) return ''

    // build rels map
    const rels = {}
    if (relsXml) {
      try {
        const relsDoc = parser.parse(relsXml)
        const relList = relsDoc.Relationships?.Relationship
        const items = Array.isArray(relList)
          ? relList
          : relList
            ? [relList]
            : []
        for (const r of items) {
          if (r.Id && r.Target) rels[r.Id] = r.Target
        }
      } catch (e) {
        // ignore rel parse errors
      }
    }

    const paragraphs = body['w:p']
      ? Array.isArray(body['w:p'])
        ? body['w:p']
        : [body['w:p']]
      : []
    const out = []

    const extractTextAndFormatting = (runNode) => {
      if (!runNode) return ''
      if (Array.isArray(runNode))
        return runNode.map(extractTextAndFormatting).join('')
      if (typeof runNode !== 'object') return String(runNode)

      // ignore drawings/pictures and raw graphic nodes
      if (
        runNode['w:drawing'] ||
        runNode['w:pict'] ||
        runNode['pic:pic'] ||
        runNode['a:graphic']
      ) {
        return ''
      }

      if (runNode['w:t'] !== undefined) {
        if (typeof runNode['w:t'] === 'string') return runNode['w:t']
        return runNode['w:t']['#text'] || ''
      }

      let text = ''
      for (const k of Object.keys(runNode))
        text += extractTextAndFormatting(runNode[k])
      return text
    }

    const processParagraph = (p) => {
      const pPr = p['w:pPr'] || {}
      const pStyle =
        (pPr['w:pStyle'] &&
          (pPr['w:pStyle']['w:val'] || pPr['w:pStyle']['val'])) ||
        ''
      const isHeading = typeof pStyle === 'string' && /^Heading/i.test(pStyle)
      const isList = !!pPr['w:numPr']

      const runs = []

      const pushRun = (text, bold = false, italic = false, href = null) => {
        if (!text) return
        // filter out artifact-like strings
        const artifactPattern =
          /(Picture\s*\d+)|http:\/\/schemas\.openxmlformats\.org|<w:drawing|<pic:|graphicData|{[0-9A-Fa-f-]{8,}}/
        if (artifactPattern.test(text)) return
        // skip likely binary blobs
        if (text.length > 300 && !/\s/.test(text)) return
        runs.push({ text, bold, italic, href })
      }

      const processNode = (node, currentHref = null) => {
        if (!node) return
        if (Array.isArray(node)) {
          for (const n of node) processNode(n, currentHref)
          return
        }
        if (typeof node !== 'object') return

        // hyperlinks
        if (node['w:hyperlink']) {
          const arr = Array.isArray(node['w:hyperlink'])
            ? node['w:hyperlink']
            : [node['w:hyperlink']]
          for (const hp of arr) {
            const rid = hp['r:id'] || hp['r:embed'] || hp['r:Id'] || hp['r:ID']
            const href = rid ? rels[rid] || null : null
            const innerRuns = hp['w:r'] || hp
            const text = extractTextAndFormatting(innerRuns)
            pushRun(text, false, false, href)
          }
          return
        }

        // runs
        if (node['w:r']) {
          const runList = Array.isArray(node['w:r'])
            ? node['w:r']
            : [node['w:r']]
          for (const r of runList) {
            const text = extractTextAndFormatting(r)
            const bold = !!(r['w:rPr'] && r['w:rPr']['w:b'] !== undefined)
            const italic = !!(r['w:rPr'] && r['w:rPr']['w:i'] !== undefined)
            pushRun(text, bold, italic, currentHref)
          }
          return
        }

        // explicitly ignore drawings/pictures to avoid raw XML blobs

        // direct text node
        if (node['w:t']) {
          const text = extractTextAndFormatting(node)
          pushRun(text)
          return
        }

        for (const k of Object.keys(node)) processNode(node[k], currentHref)
      }

      processNode(p)

      const type = isHeading ? 'heading' : isList ? 'list' : 'para'
      return { type, runs }
    }

    for (const p of paragraphs) {
      const paraObj = processParagraph(p)
      // include only paragraphs with text
      if (paraObj.runs.length > 0) out.push(paraObj)
    }

    return out
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
