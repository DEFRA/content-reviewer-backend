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
  const s = String(text ?? '')
  if (!s) {
    return false
  }
  if (DOCX_ARTIFACT_PATTERN.test(s)) {
    return true
  }
  // Long strings without any whitespace are almost always base64/binary blobs.
  return s.length > DOCX_BINARY_BLOB_MIN_LENGTH && !/\s/.test(s)
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
 * Smartly concatenate two text fragments ensuring a space is inserted when
 * both sides are alphanumeric and neither side already has separating whitespace.
 */
function smartConcat(a, b) {
  if (!a) {
    return b || ''
  }
  if (!b) {
    return a
  }
  const endsWithSpace = /\s$/.test(a)
  const startsWithSpace = /^\s/.test(b)
  if (endsWithSpace || startsWithSpace) {
    return `${a}${b}`
  }
  // If both end/start with alphanumeric, insert single space
  const alphaNumEnd = /[A-Za-z0-9]$/.test(a)
  const alphaNumStart = /^[A-Za-z0-9]/.test(b)
  if (alphaNumEnd && alphaNumStart) {
    return `${a} ${b}`
  }
  return `${a}${b}`
}

/**
 * Append a run to the runs array, dropping artefact / blob text.
 */
function pushDocxRun(
  runs,
  text,
  { bold = false, italic = false, href = null } = {}
) {
  const t = String(text ?? '')
  if (!t) {
    return
  }
  if (isArtifactRunText(t)) {
    return
  }
  runs.push({ text: t, bold, italic, href })
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

/**
 * Parse the rels XML into a rel-id → target URL map.
 * Logs (but does not throw) when the rels XML cannot be parsed —
 * the document is still usable without hyperlinks.
 */
function parseDocxRels(parser, relsXml) {
  if (!relsXml) {
    return {}
  }
  try {
    const relsDoc = parser.parse(relsXml)
    return buildDocxRelsMap(relsDoc)
  } catch (err) {
    logger.warn(
      { error: err.message },
      'Failed to parse DOCX rels XML — hyperlinks will not be resolved'
    )
    return {}
  }
}

/**
 * Convert document.xml + rels XML into an array of `{ type, runs }` paragraph
 * objects. Returns an empty array when the body cannot be located so callers
 * never need to handle a mixed string/array return type.
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
    ignoreNameSpace: false
  })

  const doc = parser.parse(documentXml)
  const body = doc['w:document']?.['w:body']
  if (!body) {
    return []
  }

  const rels = parseDocxRels(parser, relsXml)
  const paragraphs = ensureArray(body['w:p'])
  const out = []

  for (const p of paragraphs) {
    const paraObj = processDocxParagraph(p, rels)
    if (paraObj.runs.length > 0) {
      out.push(paraObj)
    }
  }

  return out
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
      // use smartConcat to preserve/insert necessary spacing
      current.text = smartConcat(current.text, r.text)
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
    return `[${group.text}](${group.href})`
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
    // collapse internal whitespace to single spaces, then trim ends
    .replace(/\s+/g, ' ')
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
        { warnings: result.messages.map((m) => m.message) },
        'DOCX extraction had warnings'
      )
    }

    return result.value || ''
  } catch (error) {
    logger.error({ error: error.message }, 'DOCX extraction failed')
    throw new Error(`Failed to extract text from DOCX: ${error.message}`)
  }
}
