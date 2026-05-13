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
  /(Picture\s*\d+)|http:\/\/schemas\.openxmlformats\.org|<w:drawing|<pic:|graphicData|\{[\dA-Fa-f-]{8,}}/

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

function sanitizeRunText(v) {
  const raw = extractStringFromObject(v)
  // coerce to string, normalise NBSP, strip accidental object serialisation
  return String(raw ?? '')
    .replaceAll('\u00A0', ' ')
    .replaceAll('[object Object]', '')
}

/**
 * Read the text of a `w:t` value, which may be either a raw string or an
 * object wrapping `#text`.
 */
function readWtValue(wt) {
  return extractStringFromObject(wt)
}

/**
 * Safely extract a string from a nested object shape produced by the XML parser.
 * Traverses '#text' / '$text' keys and falls back to first primitive string child.
 */
function extractStringFromObject(obj) {
  if (obj == null) {
    return ''
  }
  if (typeof obj === 'string') {
    return obj
  }
  if (typeof obj !== 'object') {
    return String(obj)
  }

  // prefer explicit '#text' or '$text'
  if (Object.hasOwn(obj, '#text')) {
    return String(obj['#text'] ?? '')
  }
  if (Object.hasOwn(obj, '$text')) {
    return String(obj['$text'] ?? '')
  }

  // depth-first search for the first string-like child
  for (const [k, v] of Object.entries(obj)) {
    // skip attribute-like / namespace keys and explicit text keys
    const isAttributeLike =
      k === '#text' ||
      k === '$text' ||
      k.startsWith('@') ||
      k.startsWith('xml') ||
      k.startsWith('xmlns') ||
      k.includes(':')

    if (!isAttributeLike) {
      const s = extractStringFromObject(v)
      if (s) {
        return s
      }
    }
  }
  return ''
}

/**
 * Helper to extract a single child value from a node key/value pair.
 * Kept small and testable to reduce complexity of readDocxNodeText.
 */
function readDocxChildValue(key, val) {
  if (val == null) {
    return ''
  }
  if (Array.isArray(val) || typeof val === 'object') {
    return readDocxNodeText(val)
  }

  // explicit text/spaces handled verbatim
  if (key === 'w:t' || key === 'w:instrText' || key === '#text') {
    return String(val)
  }
  if (key === 'w:tab' || key === 'w:br' || key === 'w:cr') {
    return ' '
  }

  const s = String(val)
  // allow short numeric-like tokens (years, versions) as fallback
  if (/^\d[\d.,]{0,9}$/.test(s) && s.length <= 10) {
    return s
  }
  return ''
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

  // fast-path explicit nodes
  if (node['w:instrText'] !== undefined) {
    return String(node['w:instrText']).replaceAll('\u00A0', ' ')
  }
  if (node['w:t'] !== undefined) {
    return readWtValue(node['w:t']).replaceAll('\u00A0', ' ')
  }
  if (node['w:tab'] !== undefined) {
    return ' '
  }
  if (node['w:br'] !== undefined || node['w:cr'] !== undefined) {
    return ' '
  }
  if (node['#text'] !== undefined) {
    return String(node['#text'])
  }

  // Generic child iteration delegated to helper for lower complexity
  let text = ''
  for (const k of Object.keys(node)) {
    text += readDocxChildValue(k, node[k])
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
  if (!a) return b || ''
  if (!b) return a

  const endsWithSpace = /\s$/.test(a)
  const startsWithSpace = /^\s/.test(b)
  if (endsWithSpace || startsWithSpace) {
    return `${a}${b}`
  }

  const aLast = a.charAt(a.length - 1)
  const bFirst = b.charAt(0)

  // punctuation detection (non-word, non-space)
  const aIsPunct = /[^\w\s]/u.test(aLast)
  const bIsPunct = /[^\w\s]/u.test(bFirst)

  // digit detection
  const aIsDigit = /\d/.test(aLast)
  const bIsDigit = /\d/.test(bFirst)
  if (aIsDigit && bIsDigit) {
    // preserve contiguous digit runs without inserting spaces ("0" + "13" -> "013")
    return `${a}${b}`
  }

  // acronym+digits case: left ends with >1 uppercase letters and right starts with digits
  const leftLettersMatch = a.match(/([A-Z]+)$/)
  const rightDigitsMatch = b.match(/^(\d+)/)
  if (leftLettersMatch && leftLettersMatch[1].length >= 2 && rightDigitsMatch) {
    return `${a}${b}`
  }

  // alnum detection
  const aIsAlnum = /[A-Za-z0-9]/.test(aLast)
  const bIsAlnum = /[A-Za-z0-9]/.test(bFirst)

  // Insert a space when:
  // - neither side is punctuation, and
  // - at least one side is alphanumeric
  if (!aIsPunct && !bIsPunct && (aIsAlnum || bIsAlnum)) {
    return `${a} ${b}`
  }

  // default: join directly
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
  const t = sanitizeRunText(text)
  if (!t) {
    return
  }
  if (isArtifactRunText(t)) {
    return
  }
  runs.push({ text: t, bold, italic, href })
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
 * Resolve a relationship id from common attribute name variants.
 */
function resolveRelationshipId(node) {
  const keys = ['r:id', '@_r:id', '@_rId', 'r:embed', 'r:Id', 'r:ID']
  for (const k of keys) {
    if (Object.hasOwn(node, k) && node[k]) {
      return node[k]
    }
  }
  return null
}

/**
 * Process w:hyperlink entries in-place: resolve r:id -> href, emit inner runs
 * with the resolved href, and recurse remaining hyperlink children.
 */
function processHyperlinkEntries(hyperlinkVal, rels, runs) {
  for (const hp of ensureArray(hyperlinkVal)) {
    const rid = resolveRelationshipId(hp)

    let href = null
    if (rid && rels && Object.hasOwn(rels, rid)) {
      href = rels[rid]
    }

    // Emit direct runs inside the hyperlink at the current position
    if (hp['w:r']) {
      processDocxRuns(hp['w:r'], runs, href)
    }

    // Recurse other hyperlink children (rare) to capture nested text
    for (const [hk, hv] of Object.entries(hp)) {
      if (hk === 'w:r') continue
      walkParagraphNode(hv, rels, runs, href)
    }
  }
}

/**
 * Recursively walk a DOCX paragraph node, collecting runs into the array.
 * Delegates hyperlink processing to processHyperlinkEntries to reduce complexity.
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

  // Iterate keys in insertion order so we preserve sequence where possible
  for (const [key, val] of Object.entries(node)) {
    if (val == null) {
      // nothing to do for this key
    } else if (key === 'w:hyperlink') {
      processHyperlinkEntries(val, rels, runs)
    } else if (key === 'w:r') {
      processDocxRuns(val, runs, currentHref)
    } else if (key === 'w:t') {
      pushDocxRun(runs, readDocxNodeText(node), { href: currentHref })
    } else {
      // otherwise recurse into the child (preserves order as much as parser allows)
      walkParagraphNode(val, rels, runs, currentHref)
    }
  }
}

/**
 * Decide whether a paragraph looks like a TOC entry.
 */
function isParagraphToc(p, pStyle, visibleLine, rawParagraphJson) {
  const visibleHasTabPage = /\t\s*\d+\s*$/.test(visibleLine)
  const visibleHasDotsPage = /\.{2,}\s*\d+\s*$/.test(visibleLine)
  const looksLikeTocField =
    /(?:\bTOC\b|_Toc\b)/i.test(rawParagraphJson) ||
    rawParagraphJson.includes('"w:fldSimple"') ||
    rawParagraphJson.includes('"w:instrText"')
  return (
    (typeof pStyle === 'string' && /^TOC/i.test(pStyle)) ||
    looksLikeTocField ||
    visibleHasTabPage ||
    visibleHasDotsPage
  )
}

/**
 * Collect runs for a paragraph using the ordered preserved node when provided.
 */
function collectParagraphRuns(p, rels, preservedNode) {
  const runs = []
  if (preservedNode) {
    walkParagraphNode(preservedNode, rels, runs)
  } else {
    walkParagraphNode(p, rels, runs)
  }
  return runs
}

/**
 * Clean TOC-like runs by removing long numeric/hex tokens and collapsing whitespace.
 */
function cleanTocRuns(runs) {
  return runs
    .map((r) => {
      const raw = sanitizeRunText(r.text)
      const t = raw
        .replaceAll(/\b\d{6,}\b/g, '') // remove long digit sequences
        .replaceAll(/\b00[A-Fa-f0-9]{2}(?:[A-Fa-f0-9]{2})*\b/g, '') // hex-like tokens
        .replaceAll(/\s{2,}/g, ' ')
        .trim()
      return { ...r, text: t }
    })
    .filter((r) => r.text && r.text.length > 0)
}

/**
 * Convert a single DOCX paragraph into a { type, runs } block.
 * Complexity reduced by delegating subtasks to helpers.
 */
function processDocxParagraph(p, rels, preservedNode = null) {
  const pPr = p['w:pPr'] || {}
  const pStyle = extractParagraphStyle(pPr)
  const isHeading =
    typeof pStyle === 'string' && DOCX_HEADING_STYLE_REGEX.test(pStyle)
  const isList = !!pPr['w:numPr']

  const visibleLine = (readDocxNodeText(p) || '').replaceAll('\u00A0', ' ')
  const rawParagraphJson = JSON.stringify(p)

  const isToc = isParagraphToc(p, pStyle, visibleLine, rawParagraphJson)

  const runs = collectParagraphRuns(p, rels, preservedNode)

  // DIAGNOSTIC: log when digits are lost during run extraction (enabled via DOCX_DEBUG=1)
  if (process.env.DOCX_DEBUG === '1') {
    try {
      const rawDigits = (rawParagraphJson.match(/\d/g) || []).length
      const visibleDigits = (visibleLine.match(/\d/g) || []).length
      const runsRendered = runs.map((r) => String(r.text || '')).join('')
      const runsDigits = (runsRendered.match(/\d/g) || []).length
      if (
        (visibleDigits > 0 && runsDigits < visibleDigits) ||
        (rawDigits > 0 && runsDigits < rawDigits)
      ) {
        logger.warn(
          {
            reason: 'digits-lost',
            rawDigits,
            visibleDigits,
            runsDigits,
            previewVisibleLine: visibleLine.slice(0, 200),
            runsCount: runs.length
          },
          'DOCX diagnostic: paragraph appears to lose numeric characters'
        )
        const snippet =
          rawParagraphJson.length > 2000
            ? rawParagraphJson.slice(0, 2000) + '...'
            : rawParagraphJson
        // eslint-disable-next-line no-console
        console.log(
          '--- DOCX PARAGRAPH RAW SNIPPET ---\n',
          snippet,
          '\n--- END SNIPPET ---'
        )
        // eslint-disable-next-line no-console
        console.log(
          '--- DOCX PARAGRAPH RUNS (first 50) ---\n',
          JSON.stringify(runs.slice(0, 50), null, 2),
          '\n--- END RUNS ---'
        )
      }
    } catch (e) {
      // swallow diagnostics
    }
  }

  if (isToc && runs.length > 0) {
    const cleaned = cleanTocRuns(runs)
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

  // Ordered parser: preserves element order so runs/hyperlinks keep original positions
  const orderedParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
    ignoreNameSpace: false,
    preserveOrder: true
  })

  const doc = parser.parse(documentXml)
  const body = doc['w:document']?.['w:body']
  if (!body) {
    return []
  }

  const rels = parseDocxRels(parser, relsXml)
  // parse ordered representation and extract ordered paragraph nodes
  const preservedParagraphs = []
  try {
    const docPres = orderedParser.parse(documentXml)
    // helper to find first element with given tag in the preserved array
    const findFirst = (arr, tag) => {
      if (!Array.isArray(arr)) {
        return null
      }
      for (const item of arr) {
        if (
          item &&
          typeof item === 'object' &&
          Object.prototype.hasOwnProperty.call(item, tag)
        ) {
          return item[tag]
        }
      }
      return null
    }
    const docNode = findFirst(docPres, 'w:document')
    const bodyNode = findFirst(docNode || [], 'w:body')
    if (Array.isArray(bodyNode)) {
      // collect each w:p value in order
      for (const child of bodyNode) {
        if (child && typeof child === 'object' && Object.hasOwn(child, 'w:p')) {
          preservedParagraphs.push(child['w:p'])
        }
      }
    }
  } catch (err) {
    // if ordered parsing fails, continue without preserved paragraphs
    logger.debug(
      { err: err.message },
      'Ordered parse failed; falling back to unordered walk'
    )
  }
  const paragraphs = ensureArray(body['w:p'])
  const out = []

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    const preserved = preservedParagraphs[i] || null
    const paraObj = processDocxParagraph(p, rels, preserved)
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
    const rText = sanitizeRunText(r.text)
    if (r.href && current?.href === r.href) {
      // use smartConcat to preserve/insert necessary spacing
      current.text = smartConcat(current.text, rText)
    } else {
      current = { text: rText, href: r.href }
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
  // group adjacent runs that share the same href so anchors are emitted correctly
  const groups = groupDocxRunsByHref(block.runs)

  // render each group (anchors get [text](href))
  const pieces = groups.map((g) => renderDocxGroupedRun(g))

  // reduce pieces using smartConcat so run-boundary spacing rules apply across the whole paragraph
  const merged = pieces.reduce((acc, p) => smartConcat(acc, p), '')

  // ensure there are spaces around common dash characters so later collapse doesn't glue words
  const spacedDashes = String(merged).replace(/\s*([–—-])\s*/g, ' $1 ')

  // collapse internal whitespace to single spaces, then trim ends
  const text = spacedDashes.replace(/\s+/g, ' ').trim()
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
