import fs from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { Document, Packer, Paragraph, TextRun } from 'docx'

function shouldInsertSpace(prevText, nextText) {
  if (!prevText || !nextText) return false
  const end = String(prevText).slice(-1)
  const start = String(nextText).charAt(0)
  if (/\s/.test(end) || /\s/.test(start)) return false
  if (/[\/(\[.,:;)]/.test(start) || /[\/(\[.,:;)]/.test(end)) return false
  return true
}

/**
 * Parse document.xml -> paragraph objects with runs.
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
  if (!body) return []

  const rels = {}
  if (relsXml) {
    try {
      const relsDoc = parser.parse(relsXml)
      const relList = relsDoc.Relationships?.Relationship
      const items = Array.isArray(relList) ? relList : relList ? [relList] : []
      for (const r of items) if (r.Id && r.Target) rels[r.Id] = r.Target
    } catch (e) {
      /* ignore rel parse errors */
    }
  }

  const paragraphs = body['w:p']
    ? Array.isArray(body['w:p'])
      ? body['w:p']
      : [body['w:p']]
    : []
  const out = []

  // Strict extractor: only take real text nodes and descend element children.
  const extractTextAndFormatting = (node) => {
    if (!node) return ''
    if (Array.isArray(node)) return node.map(extractTextAndFormatting).join('')
    if (typeof node !== 'object') return String(node)

    // skip graphics
    if (
      node['w:drawing'] ||
      node['w:pict'] ||
      node['pic:pic'] ||
      node['a:graphic']
    ) {
      return ''
    }

    // Prefer w:instrText when present (clean keywords but keep numbers)
    if (node['w:instrText'] !== undefined) {
      const raw =
        typeof node['w:instrText'] === 'string'
          ? node['w:instrText']
          : node['w:instrText']['#text'] || ''
      const cleaned = String(raw).replace(
        /(?:\bPAGEREF\b|_Toc|\\h|\bbegin\b|\bend\b|MERGEFORMAT|\{|\})/gi,
        ''
      )
      return cleaned.replace(/\u00A0/g, ' ')
    }

    // fldChar structural - ignore
    if (node['w:fldChar'] !== undefined) return ''

    // w:t text node
    if (node['w:t'] !== undefined) {
      const raw =
        typeof node['w:t'] === 'string'
          ? node['w:t']
          : node['w:t']['#text'] || ''
      return String(raw).replace(/\u00A0/g, ' ')
    }

    // #text nodes (parser's text fallback)
    if (node['#text'] !== undefined) {
      return String(node['#text'])
    }

    // Descend only into child element objects — DO NOT include plain attribute string values.
    let text = ''
    for (const k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue
      const val = node[k]
      if (val == null) continue
      if (typeof val === 'object') {
        text += extractTextAndFormatting(val)
      }
      // plain string attribute values are skipped to avoid rsid/ID noise
    }
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
    const isToc = typeof pStyle === 'string' && /^TOC/i.test(pStyle)

    let runs = []

    const pushRun = (text, bold = false, italic = false, href = null) => {
      if (text === undefined || text === null) return
      let t = String(text).replace(/\u00A0/g, ' ')
      const artifactPattern =
        /(Picture\s*\d+)|http:\/\/schemas\.openxmlformats\.org|<w:drawing|<pic:|graphicData|{[0-9A-Fa-f-]{8,}}/
      if (artifactPattern.test(t) && t.length > 8) return
      if (t.length > 300 && !/\s/.test(t)) return
      runs.push({ text: t, bold, italic, href })
    }

    const processNode = (node, currentHref = null) => {
      if (!node) return
      if (Array.isArray(node)) {
        for (const n of node) processNode(n, currentHref)
        return
      }
      if (typeof node !== 'object') return

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

      if (node['w:r']) {
        const runList = Array.isArray(node['w:r']) ? node['w:r'] : [node['w:r']]
        for (const r of runList) {
          const text = extractTextAndFormatting(r)
          const bold = !!(r['w:rPr'] && r['w:rPr']['w:b'] !== undefined)
          const italic = !!(r['w:rPr'] && r['w:rPr']['w:i'] !== undefined)
          pushRun(text, bold, italic, currentHref)
        }
        return
      }

      if (node['w:t']) {
        const text = extractTextAndFormatting(node)
        pushRun(text)
        return
      }

      for (const k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue
        processNode(node[k], currentHref)
      }
    }

    processNode(p)

    // If this paragraph is a TOC entry, clean out long/internal numeric or hex tokens
    if (isToc && runs.length > 0) {
      runs = runs
        .map((r) => {
          // remove long pure-digit sequences (likely IDs) and hex control tokens like 00AF001C
          let t = (r.text || '')
            .replace(/\b\d{6,}\b/g, '') // long digit sequences
            .replace(/\b00[A-Fa-f0-9]{2}(?:[A-Fa-f0-9]{2})*\b/g, '') // hex-like tokens
            .replace(/\s{2,}/g, ' ') // collapse excess spaces
            .trim()
          return { ...r, text: t }
        })
        .filter((r) => r.text && r.text.length > 0)
    }

    const type = isToc
      ? 'toc'
      : isHeading
        ? 'heading'
        : isList
          ? 'list'
          : 'para'
    return { type, runs }
  }

  for (const p of paragraphs) {
    const paraObj = processParagraph(p)
    if (paraObj.runs.length > 0) out.push(paraObj)
  }

  return out
}

async function loadDocxAndParse(fileBuffer) {
  const zip = await JSZip.loadAsync(fileBuffer)
  const docFile = zip.file('word/document.xml')
  if (!docFile) throw new Error('DOCX zip missing word/document.xml')
  const xml = await docFile.async('string')
  const relEntry = zip.file('word/_rels/document.xml.rels')
  const relsXml = relEntry ? await relEntry.async('string') : null
  const paragraphs = docxXmlToParagraphObjects(xml, relsXml)
  return { paragraphs }
}

async function writeStructuredToDocx(outPath, paragraphs) {
  const docParas = []

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    const runsForPara = []
    for (let ri = 0; ri < p.runs.length; ri++) {
      const r = p.runs[ri]
      const opts = { text: r.text || '' }
      if (r.bold) opts.bold = true
      if (r.italic) opts.italics = true
      if (r.href) {
        opts.color = '0000FF'
        opts.underline = {}
      }
      if (runsForPara.length > 0) {
        const prevTextRun = runsForPara[runsForPara.length - 1]
        const prevText =
          prevTextRun && prevTextRun.text ? String(prevTextRun.text) : ''
        const curText = opts.text || ''
        if (shouldInsertSpace(prevText, curText)) {
          runsForPara.push(new TextRun({ text: ' ' }))
        }
      }
      runsForPara.push(new TextRun(opts))
    }

    if (runsForPara.length === 0) {
      if (
        i < paragraphs.length - 1 &&
        (p.type === 'para' || p.type === 'list')
      ) {
        docParas.push(
          new Paragraph({
            children: [new TextRun({ text: '\u00A0' })],
            spacing: { after: 240 }
          })
        )
      }
      continue
    }

    const baseSpacing = { before: 120, after: 120 }

    if (p.type === 'heading') {
      docParas.push(
        new Paragraph({ children: runsForPara, spacing: baseSpacing })
      )
    } else if (p.type === 'list') {
      const bulletPrefix = new TextRun({ text: '- ', bold: false })
      docParas.push(
        new Paragraph({
          children: [bulletPrefix, ...runsForPara],
          spacing: baseSpacing
        })
      )
    } else if (p.type === 'toc') {
      docParas.push(
        new Paragraph({ children: runsForPara, spacing: baseSpacing })
      )
    } else {
      docParas.push(
        new Paragraph({ children: runsForPara, spacing: baseSpacing })
      )
    }

    if (i < paragraphs.length - 1 && (p.type === 'para' || p.type === 'list')) {
      docParas.push(
        new Paragraph({
          children: [new TextRun({ text: '\u00A0' })],
          spacing: { after: 240 }
        })
      )
    }
  }

  const doc = new Document({ sections: [{ children: docParas }] })
  const buffer = await Packer.toBuffer(doc)
  await fs.writeFile(outPath, buffer)
}

async function main() {
  const fileArg = process.argv[2]
  const outArg = process.argv[3]
  if (!fileArg) {
    console.error(
      'Usage: node scripts/test-extract-docx.js <path-to-docx> [output-docx]'
    )
    process.exit(1)
  }
  const filePath = path.resolve(fileArg)
  const outPath = outArg
    ? path.resolve(outArg)
    : path.resolve(
        path.dirname(filePath),
        `${path.basename(filePath, '.docx')}-out.docx`
      )

  const buf = await fs.readFile(filePath)
  try {
    const { paragraphs } = await loadDocxAndParse(buf)
    console.log(`Parsed ${paragraphs.length} paragraphs`)
    await writeStructuredToDocx(outPath, paragraphs)
    console.log('Wrote formatted docx to', outPath)
  } catch (err) {
    console.error('Failed:', err && err.stack ? err.stack : String(err))
    process.exit(2)
  }
}

main()
