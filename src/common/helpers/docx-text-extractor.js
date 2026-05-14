import mammoth from 'mammoth'
import { XMLParser } from 'fast-xml-parser'
import JSZip from 'jszip'
import { createLogger } from './logging/logger.js'
import {
  ensureArray,
  groupDocxRunsByHref,
  renderDocxGroupedRun,
  smartConcat,
  spaceAroundDashes
} from './docx-text-extractor.helpers.js'
import { extractPreservedParagraphsSafe } from './docx-text-normaliser.js'

const logger = createLogger()

// Constants
const DOCX_ZIP_HEADER_BYTES = 4
const MAX_ZIP_ENTRIES = 1000
const MAX_XML_SIZE_MB = 50
const MAX_EXTRACTED_XML_BYTES = MAX_XML_SIZE_MB * 1024 * 1024
const MAX_INPUT_BUFFER_BYTES = MAX_XML_SIZE_MB * 1024 * 1024

/* Normalisation helpers */

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

function buildCombos(fnNames, optsList) {
  return optsList.flatMap((opts) => fnNames.map((fn) => ({ opts, fn })))
}

async function attemptMammothCall(opts, fn) {
  try {
    return await mammoth[fn](opts)
  } catch (err) {
    logger.info(
      {
        fn,
        optionKeys: Object.keys(opts),
        error: err.message
      },
      'DOCX mammoth attempt failed'
    )
    return null
  }
}

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

async function safelyLoadDocxZip(nodeBuffer) {
  if (nodeBuffer.length > MAX_INPUT_BUFFER_BYTES) {
    throw new Error(
      `DOCX buffer is ${nodeBuffer.length} bytes (limit ${MAX_INPUT_BUFFER_BYTES}) — refusing to expand`
    )
  }
  return JSZip.loadAsync(nodeBuffer) // NOSONAR: input size checked above
}

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

export function blocksToDocxText(blocks) {
  return blocks.map(renderDocxBlock).filter(Boolean).join('\n\n')
}

function renderDocxBlock(block) {
  if (!block) {
    return ''
  }
  if (block.type === 'table') {
    return renderTableBlock(block)
  }
  const groups = groupDocxRunsByHref(block.runs || [])
  const pieces = groups.map((g) => renderDocxGroupedRun(g))
  const merged = pieces.reduce((acc, p) => smartConcat(acc, p), '')
  const spacedDashes = spaceAroundDashes(String(merged))
  const text = spacedDashes.replace(/\s+/g, ' ').trim()
  if (!text) {
    return ''
  }
  if (block.type === 'list') {
    return `- ${text}`
  }
  return text
}

function renderTableBlock(block) {
  // block.table is array of rows (array of cell strings)
  const rows = block.table || []
  if (!Array.isArray(rows) || rows.length === 0) {
    return ''
  }

  const lines = rows.map((r) => {
    const cells = Array.isArray(r) ? r : []
    return cells.join(' | ')
  })

  return lines.join('\n')
}

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

/**
 * Build paragraph objects from document.xml + rels XML.
 */
export function docxXmlToParagraphObjects(documentXml, relsXml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
    ignoreNameSpace: false
  })

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

  const rels = parseDocxRelsSafe(relsXml, parser)

  // Fallback: previous behaviour (paragraphs first, then tables)
  return extractPreservedParagraphsSafe(documentXml, orderedParser, rels, body)
}

function parseDocxRelsSafe(relsXml, parser) {
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

export function buildDocxRelsMap(relsDoc) {
  const rels = {}
  const relList = relsDoc?.Relationships?.Relationship
  for (const r of ensureArray(relList)) {
    if (r.Id && r.Target) {
      rels[r.Id] = r.Target
    }
  }
  return rels
}
