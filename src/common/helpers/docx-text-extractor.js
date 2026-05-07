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
  /(Picture\s*\d+)|http:\/\/schemas.openxmlformats.org|<w:drawing|<pic:|graphicData|\{[0-9A-Fa-f-]{8,}}/

// Paragraph-style names that mark headings.
const DOCX_HEADING_STYLE_REGEX = /^Heading/i

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

// ─────────────────────────────────────────────────────────────────────────────
// XML node walking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively read text from a DOCX XML node, ignoring drawings/pictures.
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
  if (
    node['w:drawing'] ||
    node['w:pict'] ||
    node['pic:pic'] ||
    node['a:graphic']
  ) {
    return ''
  }
  if (node['w:t'] !== undefined) {
    if (typeof node['w:t'] === 'string') {
      return node['w:t']
    }
    return node['w:t']['#text'] || ''
  }
  let text = ''
  for (const k of Object.keys(node)) {
    text += readDocxNodeText(node[k])
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
    const bold = !!(rPr && rPr['w:b'] !== undefined)
    const italic = !!(rPr && rPr['w:i'] !== undefined)
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

  const runs = []
  walkParagraphNode(p, rels, runs)

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
 * Convert document.xml + rels XML into readable Markdown-ish paragraph objects.
 */
function docxXmlToParagraphObjects(documentXml, relsXml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
    ignoreNameSpace: false
  })

  const doc = parser.parse(documentXml)
  const body = doc['w:document']?.['w:body']
  if (!body) {
    return ''
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
 * ZIP+XML fallback used when mammoth cannot parse the DOCX.
 */
async function runDocxZipFallback(nodeBuffer) {
  try {
    const zip = await JSZip.loadAsync(nodeBuffer)
    const docFile = zip.file('word/document.xml')
    if (!docFile) {
      throw new Error('DOCX zip missing word/document.xml')
    }
    const xml = await docFile.async('string')
    const relEntry = zip.file('word/_rels/document.xml.rels')
    const relsXml = relEntry ? await relEntry.async('string') : null
    const structured = docxXmlToParagraphObjects(xml, relsXml)
    return { value: structured, messages: [] }
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
 * @returns {Promise<string|Array>} mammoth Markdown string or an array of
 *                                  `{ type, runs }` blocks (ZIP fallback path)
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
