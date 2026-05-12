import mammoth from 'mammoth'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// DOCX zip-magic preview length (first 4 bytes shown in debug log)
const DOCX_ZIP_HEADER_BYTES = 4

// Filter out runs that look like binary blobs (no whitespace, very long).
const DOCX_BINARY_BLOB_MIN_LENGTH = 300

// XML/Word artefact patterns we drop from extracted runs.
const DOCX_ARTIFACT_PATTERN =
  /(Picture\s*\d+)|http:\/\/schemas\.openxmlformats\.org|<w:drawing|<pic:|graphicData|\{[0-9A-Fa-f-]{8,}}/

// Paragraph-style names that mark headings.
const DOCX_HEADING_STYLE_REGEX = /^Heading/i

// Zip-bomb mitigations for the DOCX ZIP fallback path (sonar S5042).
// A real DOCX has well under 100 entries; > 1000 indicates a malicious archive
// designed to exhaust memory by packing many tiny files.
const MAX_ZIP_ENTRIES = 1000

// Maximum size in megabytes for each individual extracted XML stream.
const MAX_XML_SIZE_MB = 50
// 50 MB cap on each individual extracted XML stream. Real-world DOCX
// document.xml / rels.xml are < 5 MB even for very large documents; anything
// above this almost certainly indicates a zip bomb expanding far beyond the
// upload size limit.
const MAX_EXTRACTED_XML_BYTES = MAX_XML_SIZE_MB * 1024 * 1024

// Hard cap on the input buffer size accepted by the ZIP fallback.
// Uploads are already capped at 10 MB upstream; this is an in-module
// belt-and-braces check that runs *before* JSZip.loadAsync, so a malicious
// caller cannot ask the zip library to ingest an arbitrarily large blob.
const MAX_INPUT_BUFFER_BYTES = MAX_XML_SIZE_MB * 1024 * 1024

// ─────────────────────────────────────────────────────────────────────────────
// Generic helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce a value into an array.
 * @template T
 * @param {T|T[]|null|undefined} value
 * @returns {T[]}
 */
function ensureArray(value) {
  if (Array.isArray(value)) {
    return value
  }
  if (value) {
    return [value]
  }
  return []
}

/**
 * Map a (heading, list) flag pair to the spec block type.
 */
function classifyDocxBlock(isHeading, isList) {
  if (isHeading) {
    return 'heading'
  }
  if (isList) {
    return 'list'
  }
  return 'para'
}

/**
 * Decide whether a candidate run text is an XML artefact or a binary blob.
 */
function isArtifactRunText(text) {
  if (DOCX_ARTIFACT_PATTERN.test(text)) {
    return true
  }
  // Long strings without any whitespace are almost always base64/binary blobs.
  return text.length > DOCX_BINARY_BLOB_MIN_LENGTH && !/\s/.test(text)
}

/* Heuristic: decide whether to insert a space between adjacent fragments */
function shouldInsertSpace(prevText, nextText) {
  if (prevText == null || nextText == null) return false
  const a = String(prevText)
  const b = String(nextText)
  if (a.length === 0 || b.length === 0) return false

  const end = a.slice(-1)
  const start = b.charAt(0)

  // preserve explicit whitespace
  if (/\s/.test(end) || /\s/.test(start)) return false

  // don't insert before opening punctuation
  if (/^[('"“‘\[\{]/u.test(start)) return false

  // don't insert around explicit joining characters
  if (/[-\u2013\u2014\/]$/.test(end) || /^[-\u2013\u2014\/]/.test(start))
    return false

  const isLetter = (ch) => /\p{L}/u.test(ch)
  const isDigit = (ch) => /\p{N}/u.test(ch)
  const isAlphaNum = (ch) => isLetter(ch) || isDigit(ch)

  // If punctuation (like period/comma) at end followed by alnum, insert space
  if (/[.,:;)]$/.test(end) && isAlphaNum(start)) return true

  // Insert space when digit is followed by a letter
  // e.g. "CW013Separately" -> keep "CW013 Separately"
  if (isDigit(end) && isLetter(start)) return true

  // Do NOT insert a space between:
  // - letter -> letter (likely same word split across runs)
  // - letter -> digit (codes like "CW013")
  // - digit -> digit (numeric tokens split across runs)
  if (
    (isLetter(end) && isLetter(start)) ||
    (isLetter(end) && isDigit(start)) ||
    (isDigit(end) && isDigit(start))
  ) {
    return false
  }

  // Fallback: don't insert by default
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// XML node walking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when the node represents a drawing / picture / graphic — ignored by
 * text extraction because their inner XML is binary or structural noise.
 */
function isGraphicNode(node) {
  return !!(
    node['w:drawing'] ||
    node['w:pict'] ||
    node['pic:pic'] ||
    node['a:graphic']
  )
}

/**
 * Read the text of a `w:t` value, which may be either a raw string or an
 * object wrapping `#text`.
 */
function readWtValue(wt) {
  if (typeof wt === 'string') {
    return wt
  }
  return wt['#text'] || ''
}

/**
 * Recursively read text from a DOCX XML node, ignoring drawings/pictures
 * and avoiding inclusion of plain attribute string values that represent rsid/IDs.
 *
 * Only explicit text-bearing keys (w:t, w:instrText, #text) and child element
 * objects/arrays are considered. Plain attribute strings are skipped to avoid
 * leaking internal IDs into output (fixes TOC numbers like "195021778").
 */
function readDocxNodeText(node) {
  if (!node) {
    return ''
  }
  if (Array.isArray(node)) {
    return node.map(readDocxNodeText).join('')
  }
  if (typeof node !== 'object') {
    return String(node)
  }
  if (isGraphicNode(node)) {
    return ''
  }

  const cleanInstr = (instr) => {
    const raw = typeof instr === 'string' ? instr : instr['#text'] || ''
    return String(raw)
      .replaceAll(
        /(?:\bPAGEREF\b|_Toc|\\h|\bbegin\b|\bend\b|MERGEFORMAT|\{|\})/gi,
        ''
      )
      .replaceAll('\u00A0', ' ')
  }

  // fast-path explicit nodes
  if (node['w:instrText'] !== undefined) {
    return cleanInstr(node['w:instrText'])
  }
  if (node['w:t'] !== undefined) {
    return readWtValue(node['w:t']).replaceAll('\u00A0', ' ')
  }
  if (node['#text'] !== undefined) {
    return String(node['#text'])
  }

  // helper to handle a single child value
  const extractChild = (key, val) => {
    if (val == null) {
      return ''
    }
    if (Array.isArray(val) || typeof val === 'object') {
      return readDocxNodeText(val)
    }
    // accept plain strings only when key explicitly denotes text (defensive)
    if (key === 'w:t' || key === 'w:instrText' || key === '#text') {
      return String(val)
    }
    return ''
  }

  let text = ''
  for (const k of Object.keys(node)) {
    text += extractChild(k, node[k])
  }
  return text
}

/**
 * Extract the paragraph style identifier (e.g. "Heading1") from a w:pPr node.
 */
function extractParagraphStyle(pPr) {
  const pStyle = pPr['w:pStyle']
  if (!pStyle) {
    return ''
  }
  return pStyle['w:val'] || pStyle.val || ''
}

/**
 * Walk a relationships XML document and build a Map of rel-id → target URL.
 */
function buildDocxRelsMap(relsDoc) {
  const rels = {}
  const relList = relsDoc.Relationships?.Relationship
  for (const r of ensureArray(relList)) {
    if (r.Id && r.Target) {
      rels[r.Id] = r.Target
    }
  }
  return rels
}

/**
 * Append a run to the runs array, dropping artefact / blob text.
 */
function pushDocxRun(
  runs,
  text,
  { bold = false, italic = false, href = null } = {}
) {
  if (!text || isArtifactRunText(text)) {
    return
  }
  runs.push({ text, bold, italic, href })
}

/**
 * Read text from each w:r in a w:hyperlink and append a run for each.
 */
function processDocxHyperlinks(hyperlinkNode, rels, runs) {
  for (const hp of ensureArray(hyperlinkNode)) {
    const rid = hp['r:id'] || hp['r:embed'] || hp['r:Id'] || hp['r:ID']
    const href = rid ? rels[rid] || null : null
    const innerRuns = hp['w:r'] || hp
    const text = readDocxNodeText(innerRuns)
    pushDocxRun(runs, text, { bold: false, italic: false, href })
  }
}

/**
 * Extract text from each w:r child and push as a run.
 */
function processDocxRuns(runNode, runs, currentHref) {
  for (const r of ensureArray(runNode)) {
    const text = readDocxNodeText(r)
    const rPr = r['w:rPr']
    const bold = rPr?.['w:b'] !== undefined
    const italic = rPr?.['w:i'] !== undefined
    pushDocxRun(runs, text, { bold, italic, href: currentHref })
  }
}

/**
 * Recursively walk a DOCX paragraph node, collecting runs into the array.
 */
function walkParagraphNode(node, rels, runs, currentHref = null) {
  if (!node) {
    return
  }
  if (Array.isArray(node)) {
    for (const n of node) {
      walkParagraphNode(n, rels, runs, currentHref)
    }
    return
  }
  if (typeof node !== 'object') {
    return
  }

  if (node['w:hyperlink']) {
    processDocxHyperlinks(node['w:hyperlink'], rels, runs)
    return
  }
  if (node['w:r']) {
    processDocxRuns(node['w:r'], runs, currentHref)
    return
  }
  if (node['w:t']) {
    pushDocxRun(runs, readDocxNodeText(node))
    return
  }

  for (const k of Object.keys(node)) {
    walkParagraphNode(node[k], rels, runs, currentHref)
  }
}

/**
 * Convert a single DOCX paragraph into a { type, runs } block.
 */
function processDocxParagraph(p, rels) {
  const pPr = p['w:pPr'] || {}
  const pStyle = extractParagraphStyle(pPr)
  const isHeading =
    typeof pStyle === 'string' && DOCX_HEADING_STYLE_REGEX.test(pStyle)
  const isList = !!pPr['w:numPr']
  const isToc = typeof pStyle === 'string' && /^TOC/i.test(pStyle)

  const runs = []
  walkParagraphNode(p, rels, runs)

  // If paragraph is a TOC entry, strip long/internal numeric and hex tokens
  // that come from attributes/rsids and collapse excess whitespace.
  if (isToc && runs.length > 0) {
    const cleaned = runs
      .map((r) => {
        const t = (r.text || '')
          // remove long digit sequences (>5 digits) likely internal IDs
          .replaceAll(/\b\d{6,}\b/g, '')
          // remove hex-like control tokens e.g. 00AF001C
          .replaceAll(/\b00[A-Fa-f0-9]{2}(?:[A-Fa-f0-9]{2})*\b/g, '')
          // collapse excess whitespace
          .replaceAll(/\s{2,}/g, ' ')
          .trim()
        return { ...r, text: t }
      })
      .filter((r) => r.text && r.text.length > 0)
    return { type: classifyDocxBlock(isHeading, isList), runs: cleaned }
  }

  return { type: classifyDocxBlock(isHeading, isList), runs }
}

// ─────────────────────────────────────────────────────────────────────────────
// Block → Markdown string serialisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Group adjacent runs that share the same non-null href into a single anchor.
 */
function groupDocxRunsByHref(runs) {
  const groups = []
  let current = null
  for (const r of runs) {
    if (r.href && current?.href === r.href) {
      current.text += r.text
    } else {
      current = { text: r.text, href: r.href }
      groups.push(current)
    }
  }
  return groups
}

/**
 * Render a grouped run as Markdown — `[text](href)` for anchors, raw text
 * otherwise.
 */
function renderDocxGroupedRun(group) {
  if (group.href) {
    return `[${group.text.trim()}](${group.href})`
  }
  return group.text
}

/**
 * Render a single block as a single line of text. List blocks get a `- `
 * prefix; blocks whose runs collapse to whitespace are returned as empty.
 */
function renderDocxBlock(block) {
  const text = groupDocxRunsByHref(block.runs)
    .map(renderDocxGroupedRun)
    .join('')
    .trim()
  if (!text) {
    return ''
  }
  if (block.type === 'list') {
    return `- ${text}`
  }
  return text
}

/**
 * Serialise an array of paragraph blocks into a Markdown string with
 * paragraph breaks. Empty blocks are dropped.
 *
 * @param {Array<{ type: string, runs: Array }>} blocks
 * @returns {string}
 */
export function blocksToDocxText(blocks) {
  return blocks.map(renderDocxBlock).filter(Boolean).join('\n\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Buffer normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise various buffer-like inputs into an ArrayBuffer.
 */
function normalizeToArrayBuffer(buf) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Mammoth attempts + ZIP fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build [opts, fn] combos for iteration.
 */
function buildCombos(fnNames, optsList) {
  return optsList.flatMap((opts) => fnNames.map((fn) => ({ opts, fn })))
}

/**
 * Attempt a single mammoth invocation and return result or null.
 */
async function attemptMammothCall(opts, fn) {
  return mammoth[fn](opts).catch((err) => {
    logger.info(
      {
        fn,
        optionKeys: Object.keys(opts),
        error: err.message
      },
      'DOCX mammoth attempt failed'
    )
    return null
  })
}

/**
 * Try a sequence of mammoth functions with given option shapes, return first success.
 */
async function tryMammoth(fnNames, optsList) {
  const combos = buildCombos(fnNames, optsList)
  for (const { opts, fn } of combos) {
    const res = await attemptMammothCall(opts, fn)
    if (res) {
      return res
    }
  }
  return null
}

/**
 * Read a single zip entry as a UTF-8 string, rejecting payloads that exceed
 * the per-file size cap. Returns null when the entry does not exist.
 *
 * Zip-bomb mitigation (sonar S5042): we cap each extracted stream so a
 * crafted DOCX cannot expand a small upload into a multi-gigabyte string.
 */
async function readZipEntryAsString(zip, path) {
  const entry = zip.file(path)
  if (!entry) {
    return null
  }
  const content = await entry.async('string')
  if (content.length > MAX_EXTRACTED_XML_BYTES) {
    throw new Error(
      `DOCX entry "${path}" exceeds ${MAX_EXTRACTED_XML_BYTES} bytes — refusing to expand`
    )
  }
  return content
}

/**
 * Safely open a DOCX archive from a Node Buffer.
 *
 * Zip-bomb mitigation (sonar S5042) is enforced in three layers across this
 * helper and `readZipEntryAsString` below:
 *   1. Input buffer size is capped at MAX_INPUT_BUFFER_BYTES *here*, before
 *      the archive is ever opened — the zip library never sees an oversized
 *      blob. (Upstream uploads are already capped at 10 MB; this is an
 *      in-module belt-and-braces guard.)
 *   2. Entry count is capped at MAX_ZIP_ENTRIES by the caller, immediately
 *      after this returns and before any reads are issued.
 *   3. Each individual extracted stream is capped at MAX_EXTRACTED_XML_BYTES
 *      inside `readZipEntryAsString` — rejects high-compression-ratio bombs
 *      that decompress to gigabytes.
 *
 * Worst-case memory consumption is therefore bounded to approximately
 * 2 × MAX_EXTRACTED_XML_BYTES regardless of the archive's contents.
 *
 * @param {Buffer} nodeBuffer
 * @returns {Promise<import('jszip')>}
 */
async function safelyLoadDocxZip(nodeBuffer) {
  if (nodeBuffer.length > MAX_INPUT_BUFFER_BYTES) {
    throw new Error(
      `DOCX buffer is ${nodeBuffer.length} bytes (limit ${MAX_INPUT_BUFFER_BYTES}) — refusing to expand`
    )
  }
  // NOSONAR S5042: input size is bounded by the check above; entry count and
  // per-entry extracted size are bounded by the caller and readZipEntryAsString.
  return JSZip.loadAsync(nodeBuffer) // NOSONAR
}

/**
 * ZIP+XML fallback used when mammoth cannot parse the DOCX.
 * Archive opening is delegated to `safelyLoadDocxZip` (see its docstring for
 * the full zip-bomb mitigation contract — sonar S5042).
 */
async function runDocxZipFallback(nodeBuffer) {
  try {
    const zip = await safelyLoadDocxZip(nodeBuffer)

    const entryCount = Object.keys(zip.files).length
    if (entryCount > MAX_ZIP_ENTRIES) {
      throw new Error(
        `DOCX zip has ${entryCount} entries (limit ${MAX_ZIP_ENTRIES}) — refusing to expand`
      )
    }

    const xml = await readZipEntryAsString(zip, 'word/document.xml')
    if (!xml) {
      throw new Error('DOCX zip missing word/document.xml')
    }
    const relsXml = await readZipEntryAsString(
      zip,
      'word/_rels/document.xml.rels'
    )

    const structured = docxXmlToParagraphObjects(xml, relsXml)
    return { value: blocksToDocxText(structured), messages: [] }
  } catch (zipErr) {
    throw new Error(`mammoth failed and ZIP fallback failed: ${zipErr.message}`)
  }
}

/**
 * Core orchestration for DOCX extraction. Returns the mammoth result object.
 */
async function runDocxExtraction(buffer) {
  const arrayBuffer = normalizeToArrayBuffer(buffer)
  const nodeBuffer = Buffer.from(arrayBuffer)

  const attempts = [{ arrayBuffer }, { buffer: nodeBuffer }]

  let result = await tryMammoth(['convertToMarkdown'], attempts)
  if (!result) {
    result = await tryMammoth(['extractRawText'], attempts)
  }
  if (!result) {
    result = await runDocxZipFallback(nodeBuffer)
  }

  if (!result) {
    throw new Error(
      'mammoth failed to parse DOCX with any supported input shape'
    )
  }

  return result
}

function parseDocxRels(parser, relsXml) {
  if (!relsXml) return {}
  try {
    const relsDoc = parser.parse(relsXml)
    return buildDocxRelsMap(relsDoc)
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to parse DOCX relationships XML')
    return {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Replacement: paragraph extraction logic adapted from scripts/text-extract-docx.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert document.xml + rels XML into an array of `{ type, runs }` paragraph
 * objects using a conservative, parser-assisted extraction routine. This
 * implementation mirrors the logic used by scripts/text-extract-docx.js.
 *
 * @param {string} documentXml
 * @param {string|null} relsXml
 * @returns {Array<{ type: string, runs: Array }>}
 */
export function docxXmlToParagraphObjects(documentXml, relsXml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
    ignoreNameSpace: false,
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false
  })

  const rels = parseDocxRels(parser, relsXml)

  // helper: extract visible text from paragraph xml string
  const extractVisibleTextFromParagraph = (pXml) => {
    if (!pXml) return ''
    let xml = pXml
      .replace(/<[^>]*:tab\b[^>]*\/?>/gi, '<w:tab/>')
      .replace(/<[^>]*:br\b[^>]*\/?>/gi, '<w:br/>')
      .replace(/<[^>]*:cr\b[^>]*\/?>/gi, '<w:cr/>')

    xml = xml.replace(/<w:tab\b[^>]*\/?>/gi, '\t')
    xml = xml.replace(/<w:br\b[^>]*\/?>/gi, '\n')
    xml = xml.replace(/<w:cr\b[^>]*\/?>/gi, '\n')

    const tRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi
    let m
    let out = ''
    while ((m = tRegex.exec(xml)) !== null) {
      out += m[1] || ''
    }

    if (!out) {
      let safe = xml
        .replace(
          /<[^>:\s]+:instrText\b[^>]*>[\s\S]*?<\/[^>:\s]+:instrText>/gi,
          ''
        )
        .replace(
          /<[^>:\s]+:fldSimple\b[^>]*>[\s\S]*?<\/[^>:\s]+:fldSimple>/gi,
          ''
        )
        .replace(/<\/?[^>]+>/g, '')
        .replace(/[<>]/g, '')
      out = safe
    }

    return out.replace(/\u00A0/g, ' ').replace(/\r\n|\r/g, '\n')
  }

  const sanitizeTitle = (visible, rawVisible) => {
    if (!visible) return ''
    let out = String(visible)
      .replace(/\u00A0/g, ' ')
      .replace(/\r\n|\r/g, '\n')

    if (rawVisible && rawVisible.includes('\t')) {
      out = out.split('\t')[0]
    } else {
      if (rawVisible && /\.{2,}\s*\d+\s*$/.test(rawVisible)) {
        out = out.replace(/\.{2,}.*$/s, '')
      }
    }

    out = out.trim()

    const trailingMatch = out.match(/(\d{1,4})\s*$/u)
    if (trailingMatch) {
      const numStr = trailingMatch[1]
      const numLen = numStr.length
      const rawHasTabOrDots = !!(
        rawVisible &&
        (rawVisible.includes('\t') || /\.{2,}\s*\d+\s*$/.test(rawVisible))
      )
      if (rawHasTabOrDots) {
        out = out.slice(0, -numStr.length).trim()
      } else if (numLen <= 3) {
        out = out.slice(0, -numStr.length).trim()
      } else if (numLen === 4) {
        const n = parseInt(numStr, 10)
        if (Number.isFinite(n) && (n < 1900 || n > 2100)) {
          out = out.slice(0, -numStr.length).trim()
        }
      }
    }

    out = out.replace(
      /\b(?:beginTOC|endTOC|begin|end|TOC\d*|TOC|_Toc[^\s]*|separate)\b/gi,
      ' '
    )
    out = out.replace(/\bpreserve\d*\b/gi, ' ')
    out = out.replace(
      /\b(?:minorthansi|minoreastasia|minorbidi|contextualhyperlink|hyperlink|standard)\b/gi,
      ' '
    )
    out = out.replace(/\b\d{6,}\b/g, ' ')
    out = out.replace(/\s{2,}/g, ' ').trim()
    out = out.replace(/^[\W_]+|[\W_]+$/g, '').trim()
    return out
  }

  const paraRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  const paraMatches = documentXml.match(paraRegex) || []
  const out = []

  const extractRunPropsFromParsed = (parsedRun, currentHref = null) => {
    const rObj = parsedRun['w:r'] || parsedRun

    if (rObj) {
      if (
        rObj['w:drawing'] ||
        rObj['w:pict'] ||
        rObj['v:imagedata'] ||
        rObj['pic:pic'] ||
        (rObj['w:rPr'] && rObj['w:rPr']['w:noProof'])
      ) {
        return {
          text: '',
          bold: false,
          italic: false,
          href: currentHref,
          underline: false
        }
      }
      try {
        const str = JSON.stringify(rObj)
        if (
          /\bblip\b/i.test(str) ||
          /\bimagedata\b/i.test(str) ||
          /\bdrawing\b/i.test(str) ||
          /\bpict\b/i.test(str)
        ) {
          return {
            text: '',
            bold: false,
            italic: false,
            href: currentHref,
            underline: false
          }
        }
      } catch (e) {}
    }

    const getText = (node) => {
      if (node == null) return ''
      if (typeof node === 'string' || typeof node === 'number')
        return String(node)
      if (Array.isArray(node)) return node.map(getText).join('')
      if (typeof node === 'object') {
        if (node['#text'] !== undefined) return String(node['#text'])
        if (node['w:t'] !== undefined) {
          const t = node['w:t']
          if (typeof t === 'string' || typeof t === 'number') return String(t)
          if (t && typeof t === 'object' && t['#text'] !== undefined)
            return String(t['#text'])
        }
        if (node['w:tab'] !== undefined) return '\t'
        if (node['w:br'] !== undefined) return '\n'
        if (node['w:cr'] !== undefined) return '\n'
        let s = ''
        for (const k of Object.keys(node)) {
          if (!Object.prototype.hasOwnProperty.call(node, k)) continue
          if (k.startsWith('@') || k.startsWith('xmlns') || k.includes(':'))
            continue
          s += getText(node[k])
        }
        return s
      }
      return ''
    }

    const text = getText(rObj).replace(/\u00A0/g, ' ')
    const bold = !!(rObj && rObj['w:rPr'] && rObj['w:rPr']['w:b'] !== undefined)
    const italic = !!(
      rObj &&
      rObj['w:rPr'] &&
      rObj['w:rPr']['w:i'] !== undefined
    )
    const underline = !!(
      rObj &&
      rObj['w:rPr'] &&
      rObj['w:rPr']['w:u'] !== undefined &&
      rObj['w:rPr']['w:u'] !== null
    )
    return { text, bold, italic, href: currentHref, underline }
  }

  for (const pXml of paraMatches) {
    const pPrMatch = pXml.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/)
    const pPrXml = pPrMatch ? pPrMatch[1] : ''
    const pStyleMatch = pPrXml.match(/<w:pStyle\b[^>]*w:val=['"]([^'"]+)['"]/i)
    const pStyle = pStyleMatch ? pStyleMatch[1] : ''
    const isHeading = typeof pStyle === 'string' && /^Heading/i.test(pStyle)
    const isList = /<w:numPr\b/i.test(pPrXml)

    let safeXml = pXml
      .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/gi, '')
      .replace(/<w:fldSimple\b[^>]*>[\s\S]*?<\/w:fldSimple>/gi, '')
      .replace(/<w:fldChar\b[^>]*>[\s\S]*?<\/w:fldChar>/gi, '')

    const visibleLine = extractVisibleTextFromParagraph(safeXml).trim()

    const looksLikeTocField =
      /<w:fldSimple\b[^>]*instr=["'][^"']*TOC[^"']*["']|<w:instrText\b[^>]*>[^<]*TOC[^<]*<\/w:instrText>|<w:fldChar\b[^>]*fldCharType=['"]begin['"]/i.test(
        pXml
      )
    const visibleHasTabPage = /\t\s*\d+\s*$/.test(visibleLine)
    const visibleHasDotsPage = /\.{2,}\s*\d+\s*$/.test(visibleLine)
    const visibleEndsWithNumber = /\s\d+\s*$/.test(visibleLine)
    const isToc =
      (typeof pStyle === 'string' && /^TOC/i.test(pStyle)) ||
      looksLikeTocField ||
      visibleHasTabPage ||
      visibleHasDotsPage ||
      visibleEndsWithNumber

    const runs = []

    const childRegex =
      /<w:hyperlink\b[^>]*>[\s\S]*?<\/w:hyperlink>|<w:fldSimple\b[^>]*>[\s\S]*?<\/w:fldSimple>|<w:r\b[^>]*>[\s\S]*?<\/w:r>|<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>|<w:t\b[^>]*>[\s\S]*?<\/w:t>/g
    const childMatches = pXml.match(childRegex) || []

    for (const childXml of childMatches) {
      if (
        /^<[^>:\s]+:instrText\b/i.test(childXml) ||
        /^<w:instrText\b/i.test(childXml) ||
        /^<w:fldSimple\b/i.test(childXml)
      ) {
        continue
      }

      if (
        /<w:drawing\b/i.test(childXml) ||
        /<w:pict\b/i.test(childXml) ||
        /<v:imagedata\b/i.test(childXml) ||
        /<pic:pic\b/i.test(childXml) ||
        /\bblip:embed\b/i.test(childXml) ||
        /<a:blip\b/i.test(childXml)
      ) {
        continue
      }

      if (/^<w:hyperlink\b/i.test(childXml)) {
        const ridMatch = childXml.match(
          /r:(?:id|Id|ID|embed)=["']([^"']+)['"]/i
        )
        const rid = ridMatch ? ridMatch[1] : null
        const href = rid ? rels[rid] || null : null

        const innerRunRegex =
          /<w:r\b[^>]*>[\s\S]*?<\/w:r>|<w:t\b[^>]*>[\s\S]*?<\/w:t>/g
        const innerMatches = childXml.match(innerRunRegex) || []
        const children = []
        for (const inner of innerMatches) {
          try {
            const parsedInner = parser.parse(inner)
            const rp = extractRunPropsFromParsed(parsedInner, href)
            if (rp.text && rp.text.length > 0) children.push(rp)
          } catch (e) {}
        }
        if (children.length > 0) {
          runs.push({ href, children })
        } else {
          const textMatch = childXml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/)
          if (textMatch)
            runs.push({
              text: textMatch[1].replace(/\u00A0/g, ' '),
              bold: false,
              italic: false,
              href
            })
        }
        continue
      }

      if (/^<w:r\b/i.test(childXml)) {
        try {
          const parsedRun = parser.parse(childXml)
          const rp = extractRunPropsFromParsed(parsedRun, null)
          if (rp.text && rp.text.length > 0) runs.push(rp)
        } catch (e) {}
        continue
      }

      if (/^<w:t\b/i.test(childXml)) {
        const txt = childXml.replace(/<[^>]+>/g, '').replace(/\u00A0/g, ' ')
        if (txt && txt.length > 0)
          runs.push({ text: txt, bold: false, italic: false, href: null })
        continue
      }
    }

    if (isToc && runs.length > 0) {
      const last = runs[runs.length - 1]
      const lastText = last
        ? last.text ||
          (last.children ? last.children.map((c) => c.text || '').join('') : '')
        : ''
      if (/^\s*\d{1,4}\s*$/.test(lastText)) {
        runs.pop()
      }
    }

    let cleanedRuns = runs

    if (isToc) {
      const title = sanitizeTitle(visibleLine, visibleLine)
      if (title && title.length > 0) {
        cleanedRuns = [{ text: title, bold: false, italic: false, href: null }]
      } else {
        const combined = runs.map((r) => r.text || '').join('')
        const fallbackTitle = sanitizeTitle(combined, combined)
        if (fallbackTitle && fallbackTitle.length > 0) {
          cleanedRuns = [
            { text: fallbackTitle, bold: false, italic: false, href: null }
          ]
        } else {
          cleanedRuns = []
        }
      }
    }

    const type = isToc
      ? 'toc'
      : isHeading
        ? 'heading'
        : isList
          ? 'list'
          : 'para'
    out.push({ type, runs: cleanedRuns })
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract structured text from a DOCX buffer. Uses mammoth where possible and
 * falls back to direct ZIP+XML parsing when mammoth cannot read the file.
 *
 * @param {Buffer} buffer
 * @returns {Promise<string>} Markdown string (with `[text](url)` hyperlinks).
 *                            Empty string when no content could be located.
 */
export async function extractDocxText(buffer) {
  try {
    logger.info(
      {
        isBuffer: Buffer.isBuffer(buffer),
        bufferLength: buffer.length,
        zipSignature: buffer.subarray(0, DOCX_ZIP_HEADER_BYTES).toString('hex')
      },
      'DOCX buffer received'
    )

    const result = await runDocxExtraction(buffer)

    if (result.messages && result.messages.length > 0) {
      logger.warn(
        { warnings: result.messages.map((m) => m.message || m) },
        'DOCX extraction had warnings'
      )
    }

    return result.value || ''
  } catch (error) {
    logger.error({ error: error.message }, 'DOCX extraction failed')
    throw new Error(`Failed to extract text from DOCX: ${error.message}`)
  }
}
