import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import PDFDocument from 'pdfkit'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

// Configure pdf.worker (pdfjs-dist v2+/v3+ style)
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve(
    'pdfjs-dist/legacy/build/pdf.worker.mjs'
  )
).href

// Simple rectangle overlap: ann.rect is [x1,y1,x2,y2]
function rectsOverlap(rect, bbox) {
  if (!rect || rect.length < 4) return false
  const [rx1, ry1, rx2, ry2] = rect
  const [tx, ty] = bbox
  return (
    tx >= Math.min(rx1, rx2) &&
    tx <= Math.max(rx1, rx2) &&
    ty >= Math.min(ry1, ry2) &&
    ty <= Math.max(ry1, ry2)
  )
}

/**
 * Extract formatted paragraph blocks from PDF buffer.
 * Each block: { type: 'heading'|'list'|'para', runs: [{ text, bold, href }] }
 */
async function extractFormattedBlocksFromPDF(buffer) {
  const data = new Uint8Array(buffer)
  const loadingTask = pdfjsLib.getDocument({ data, verbosity: 0 })
  const doc = await loadingTask.promise
  const pageBlocks = []

  for (let pnum = 1; pnum <= doc.numPages; pnum++) {
    const page = await doc.getPage(pnum)
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
        const style =
          (textContent.styles && textContent.styles[it.fontName]) || {}
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
      const medianFontSize =
        fontSizes.length === 0
          ? 0
          : fontSizes.length % 2 === 1
            ? fontSizes[(fontSizes.length - 1) / 2]
            : (fontSizes[fontSizes.length / 2 - 1] +
                fontSizes[fontSizes.length / 2]) /
              2

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
      const medianGap =
        gaps.length === 0
          ? 0
          : gaps.length % 2 === 1
            ? gaps[(gaps.length - 1) / 2]
            : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2

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

/* helper: determine if we should insert a space between two runs when rendering */
function needsTrailingSpace(currText, nextText) {
  if (!currText || !nextText) return false
  const end = currText.slice(-1)
  const start = nextText.charAt(0)
  if (/\s/.test(end) || /\s/.test(start)) return false
  // don't add space if punctuation suggests no space
  if (
    /[-\u2013\u2014\/(\[.,:;)]/.test(start) ||
    /[-\u2013\u2014\/(\[.,:;)]/.test(end)
  )
    return false
  // default: add space
  return true
}

/* render block (paragraph) to PDFKit preserving bold runs and links and preserving spacing between runs */
function renderBlockToPdf(doc, block, pageWidth, margins) {
  const lineWidth = pageWidth - margins.left - margins.right

  if (block.type === 'sep') {
    doc.moveDown(1)
    return
  }

  const renderRunsInline = (runs) => {
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]
      const next = runs[i + 1]
      const font = run.bold ? 'Helvetica-Bold' : 'Helvetica'
      doc.font(font)
      const textToWrite = run.text
      const continued = i < runs.length - 1
      if (run.href) {
        // if link, ensure clickable region covers text and trailing space if needed
        const extraSpace =
          continued && needsTrailingSpace(run.text, next ? next.text : '')
            ? ' '
            : ''
        doc.fillColor('blue').text(textToWrite + extraSpace, {
          continued: continued,
          link: run.href,
          width: lineWidth
        })
        doc.fillColor('black')
      } else {
        const extraSpace =
          continued && needsTrailingSpace(run.text, next ? next.text : '')
            ? ' '
            : ''
        doc.fillColor('black').text(textToWrite + extraSpace, {
          continued: continued,
          width: lineWidth
        })
      }
    }
  }

  if (block.type === 'heading') {
    doc.fontSize(18)
    renderRunsInline(block.runs)
    doc.moveDown(0.6)
    return
  }

  if (block.type === 'list') {
    doc.fontSize(12)
    doc.font('Helvetica')
    doc.text('• ', { continued: true })
    // indent list runs: reduce available width by bullet width
    // render runs inline but treat first run as already started
    renderRunsInline(block.runs)
    doc.moveDown(0.4)
    return
  }

  // normal paragraph
  doc.fontSize(12)
  renderRunsInline(block.runs)
  doc.moveDown(0.6)
}

async function main() {
  const inArg = process.argv[2021] ? process.argv[2] : process.argv[2] // defensive
  const outArg = process.argv[3]

  if (!inArg) {
    console.error(
      'Usage: node scripts/test-extract-pdf.js <input.pdf> [output.pdf]'
    )
    process.exit(1)
  }

  const inputPath = path.resolve(inArg)
  const outputPath = outArg
    ? path.resolve(outArg)
    : path.resolve(
        path.dirname(inputPath),
        `${path.basename(inputPath, path.extname(inputPath))}-extracted.pdf`
      )

  try {
    const buffer = await fsPromises.readFile(inputPath)
    const blocks = await extractFormattedBlocksFromPDF(buffer)

    // Create PDF
    const doc = new PDFDocument({ autoFirstPage: false })
    const writeStream = fs.createWriteStream(outputPath)
    doc.pipe(writeStream)

    const pageOptions = { size: 'A4', margin: 72 }
    doc.addPage(pageOptions)
    const pageWidth = doc.page.width
    const margins = {
      left: doc.page.margins.left,
      right: doc.page.margins.right
    }

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      renderBlockToPdf(doc, b, pageWidth, margins)
      if (doc.y > doc.page.height - 72) {
        doc.addPage(pageOptions)
      }
    }

    doc.end()

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve)
      writeStream.on('error', reject)
    })

    console.log('Wrote formatted extracted PDF to', outputPath)
  } catch (err) {
    console.error('Failed:', err && err.stack ? err.stack : String(err))
    process.exit(2)
  }
}

main()
