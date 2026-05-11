import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

// pdfjs-dist v5 requires an explicit path to the worker — empty string no longer accepted.
// createRequire resolves the absolute path in node_modules; pathToFileURL converts it to
// a file:// URL that the Node.js Worker thread loader can consume on any OS/environment.
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve(
    'pdfjs-dist/legacy/build/pdf.worker.mjs'
  )
).href

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// pdfjs item.transform layout: [scaleX, skewY, skewX, scaleY, tx, ty]
const PDF_TRANSFORM_SCALE_Y = 3
const PDF_TRANSFORM_TX = 4
const PDF_TRANSFORM_TY = 5

// Heading detection: a line is a heading when its average font size exceeds
// max(HEADING_FONT_RATIO * median, median + HEADING_FONT_DELTA) AND it is
// shorter than HEADING_MAX_LINE_LENGTH characters.
const HEADING_FONT_RATIO = 1.25
const HEADING_FONT_DELTA = 1
const HEADING_MAX_LINE_LENGTH = 200

// Paragraph break detection: when the vertical gap between two lines exceeds
// max(median * GAP_MULTIPLIER, MIN_GAP) the running paragraph is flushed.
const PARAGRAPH_GAP_MULTIPLIER = 1.8
const PARAGRAPH_MIN_GAP = 12

// Bullet markers used to detect list lines in PDFs.
// • = bullet (•), – = en-dash (–), — = em-dash (—)
//
// Both regexes are deliberately simple — they check or strip a *bounded*
// prefix (one bullet character, optionally followed by whitespace). They are
// never executed against the full line; only the leading 1–2 characters are
// inspected. This keeps the matching strictly linear and avoids the
// super-linear runtime concern flagged by sonar S5852.
const LIST_MARKER_REGEX = /^[•\-–—]\s/
const BULLET_PREFIX_REGEX = /^[•\-–—]\s*/

// Suppress pdfjs console noise about missing CMap / standard fonts
const PDFJS_VERBOSITY_QUIET = 0

// ─────────────────────────────────────────────────────────────────────────────
// Geometry / numeric helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a text-item anchor point lies inside an annotation rectangle.
 * @param {number[]} rect - annotation rectangle [x1,y1,x2,y2]
 * @param {number[]} anchor - [tx, ty] text-item anchor point
 * @returns {boolean}
 */
function rectsOverlap(rect, anchor) {
  const [rx1, ry1, rx2, ry2] = rect
  const [tx, ty] = anchor
  return tx >= rx1 && tx <= rx2 && ty >= ry1 && ty <= ry2
}

/**
 * Compute the median of a number array. Returns 0 for an empty list.
 * @param {number[]} numbers
 * @returns {number}
 */
function computeMedian(numbers) {
  if (numbers.length === 0) {
    return 0
  }
  const sorted = [...numbers].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[mid]
  }
  return (sorted[mid - 1] + sorted[mid]) / 2
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF item parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a raw pdfjs text-item into a normalised shape with bold detection.
 * @param {Object} item
 * @param {Object} styles - textContent.styles map
 * @returns {{ str: string, tx: number, ty: number, fontSize: number, bold: boolean }}
 */
function parsePdfItem(item, styles) {
  const tx = Number(item.transform[PDF_TRANSFORM_TX] || 0)
  const ty = Number(item.transform[PDF_TRANSFORM_TY] || 0)
  const fontSize = Math.abs(item.transform[PDF_TRANSFORM_SCALE_Y]) || 0
  const style = styles?.[item.fontName] || {}
  const fontDesc =
    `${item.fontName || ''} ${style.fontFamily || ''}`.toLowerCase()
  const bold = /bold|black|heavy|700/.test(fontDesc)
  return { str: item.str || '', tx, ty, fontSize, bold }
}

/**
 * Group items by rounded y-coordinate and sort each group left-to-right,
 * then sort the resulting lines top-to-bottom.
 * @param {Array} items - parsed pdf items
 * @returns {Array<{ y:number, items:Array, avgFontSize:number }>}
 */
function groupItemsByLine(items) {
  const lineMap = new Map()
  for (const it of items) {
    const key = Math.round(it.ty)
    if (!lineMap.has(key)) {
      lineMap.set(key, [])
    }
    lineMap.get(key).push(it)
  }
  return Array.from(lineMap.entries())
    .map(([y, its]) => {
      its.sort((a, b) => a.tx - b.tx)
      const avgFont = its.reduce((s, x) => s + x.fontSize, 0) / its.length
      return { y: Number(y), items: its, avgFontSize: avgFont }
    })
    .sort((a, b) => b.y - a.y)
}

/**
 * Compute the median vertical gap between adjacent lines (top-to-bottom order).
 * @param {Array<{ y:number }>} lines
 * @returns {number}
 */
function computeMedianLineGap(lines) {
  const gaps = []
  for (let i = 0; i < lines.length - 1; i++) {
    gaps.push(Math.abs(lines[i].y - lines[i + 1].y))
  }
  return computeMedian(gaps)
}

// ─────────────────────────────────────────────────────────────────────────────
// Run/line construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a textual line for heading/list heuristics, inserting spaces between
 * runs when the boundary between two runs is letter-to-letter.
 * @param {Array<{ text:string }>} runs
 * @returns {string}
 */
function buildHeuristicLineText(runs) {
  return runs
    .map((r, i) => {
      const next = runs[i + 1]
      if (!next) {
        return r.text.trim()
      }
      const endChar = r.text.slice(-1)
      const startChar = next.text.charAt(0)
      const needsSpace =
        !/\s/.test(endChar) && !/[\s\-–—.,:;/)(]/.test(startChar)
      return r.text + (needsSpace ? ' ' : '')
    })
    .join('')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

/**
 * Build the run array for a single line, attaching href URLs where the item's
 * anchor point falls inside a link annotation rectangle.
 * @param {{ items: Array }} line
 * @param {(item: Object) => string|null} findUrlForItem
 * @returns {Array<{ text:string, bold:boolean, href:string|null }>}
 */
function buildLineRuns(line, findUrlForItem) {
  const runs = []
  for (const it of line.items) {
    const text = String(it.str || '')
    text = text.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ')
    if (!text || text.trim() === '') {
      continue
    }
    const url = findUrlForItem(it)
    runs.push({ text, bold: !!it.bold, href: url || null })
  }
  return runs
}

// ─────────────────────────────────────────────────────────────────────────────
// Block classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ avgFontSize:number }} line
 * @param {string} lineText
 * @param {number} medianFontSize
 * @returns {boolean}
 */
function isHeadingLine(line, lineText, medianFontSize) {
  if (medianFontSize <= 0) {
    return false
  }
  const fontThreshold = Math.max(
    HEADING_FONT_RATIO * medianFontSize,
    medianFontSize + HEADING_FONT_DELTA
  )
  return (
    line.avgFontSize > fontThreshold &&
    lineText.length <= HEADING_MAX_LINE_LENGTH
  )
}

/**
 * @param {number} currentY
 * @param {number|null} lastLineY
 * @param {number} medianGap
 * @returns {boolean}
 */
function isLargeGap(currentY, lastLineY, medianGap) {
  if (lastLineY === null || medianGap <= 0) {
    return false
  }
  const gap = Math.abs(lastLineY - currentY)
  return gap > Math.max(medianGap * PARAGRAPH_GAP_MULTIPLIER, PARAGRAPH_MIN_GAP)
}

/**
 * Push a heading block, forcing all runs bold.
 */
function pushHeadingBlock(blocks, runs, flushParagraph) {
  flushParagraph()
  for (const r of runs) {
    r.bold = true
  }
  blocks.push({ type: 'heading', runs })
}

/**
 * Push a list block, stripping the leading bullet from the first run.
 */
function pushListBlock(blocks, runs, flushParagraph) {
  flushParagraph()
  if (runs.length > 0) {
    runs[0].text = runs[0].text.replace(BULLET_PREFIX_REGEX, '')
  }
  blocks.push({ type: 'list', runs })
}

/**
 * Iterate each line and assemble heading / list / paragraph blocks for a page.
 * @returns {Array}
 */
function buildPageBlocks(lines, medianFontSize, medianGap, findUrlForItem) {
  const blocks = []
  let currentParagraphRuns = []
  let lastLineY = null

  const flushParagraph = (type = 'para') => {
    if (currentParagraphRuns.length > 0) {
      blocks.push({ type, runs: currentParagraphRuns })
      currentParagraphRuns = []
    }
  }

  for (const line of lines) {
    const runs = buildLineRuns(line, findUrlForItem)
    if (runs.length === 0) {
      flushParagraph()
      lastLineY = line.y
      continue
    }

    const lineText = buildHeuristicLineText(runs)
    const heading = isHeadingLine(line, lineText, medianFontSize)
    const isList = LIST_MARKER_REGEX.test(lineText)

    if (heading) {
      pushHeadingBlock(blocks, runs, flushParagraph)
    } else if (isList) {
      pushListBlock(blocks, runs, flushParagraph)
    } else {
      if (isLargeGap(line.y, lastLineY, medianGap)) {
        flushParagraph()
      }
      currentParagraphRuns.push(...runs)
    }

    lastLineY = line.y
  }

  flushParagraph()
  return blocks
}

// ─────────────────────────────────────────────────────────────────────────────
// Page-level extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a function that, given an item, returns the URL of the link
 * annotation whose rectangle contains the item's anchor point — or null.
 */
function buildUrlFinder(annotations) {
  const linkAnnotations = (annotations || []).filter(
    (ann) => ann.subtype === 'Link' && ann.url?.startsWith('http')
  )
  return (item) => {
    const matched = linkAnnotations.find((ann) =>
      rectsOverlap(ann.rect, [item.tx, item.ty])
    )
    return matched ? matched.url : null
  }
}

/**
 * Extract heading / list / paragraph blocks for a single PDF page.
 * Returns an empty array when the page has no text.
 */
async function extractPageBlocks(page) {
  const [textContent, annotations] = await Promise.all([
    page.getTextContent(),
    page.getAnnotations()
  ])

  const findUrlForItem = buildUrlFinder(annotations)

  const items = (textContent.items || []).map((it) =>
    parsePdfItem(it, textContent.styles)
  )
  if (items.length === 0) {
    return []
  }

  const fontSizes = items.map((x) => x.fontSize).filter(Boolean)
  const medianFontSize = computeMedian(fontSizes)

  const lines = groupItemsByLine(items)
  const medianGap = computeMedianLineGap(lines)

  return buildPageBlocks(lines, medianFontSize, medianGap, findUrlForItem)
}

// ─────────────────────────────────────────────────────────────────────────────
// Page → flattened block array
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flatten an array of per-page block arrays into a single block list, inserting
 * a `sep` block between pages and for blank pages.
 */
function flattenPageBlocks(pageBlocks) {
  const allBlocks = []
  for (const pb of pageBlocks) {
    if (pb.length === 0) {
      allBlocks.push({ type: 'sep', runs: [] })
      continue
    }
    for (const b of pb) {
      allBlocks.push(b)
    }
    allBlocks.push({ type: 'sep', runs: [] })
  }
  return allBlocks
}

// ─────────────────────────────────────────────────────────────────────────────
// Block → Markdown string serialisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Group adjacent runs that share the same non-null href into a single anchor —
 * e.g. two consecutive items inside one link annotation become `[Go here](url)`
 * rather than `[Go](url)[ here](url)`.
 */
function groupRunsByHref(runs) {
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
function renderGroupedRun(group) {
  if (group.href) {
    return `[${group.text.trim()}](${group.href})`
  }
  return group.text
}

/**
 * Render a single block as a single line of text. Returns an empty string for
 * `sep` blocks and for blocks whose runs collapse to whitespace.
 */
function renderBlock(block) {
  if (block.type === 'sep') {
    return ''
  }
  const text = groupRunsByHref(block.runs).map(renderGroupedRun).join('').trim()
  if (!text) {
    return ''
  }
  if (block.type === 'list') {
    return `- ${text}`
  }
  return text
}

/**
 * Serialise an array of blocks into a Markdown string with paragraph breaks.
 * Empty / `sep` blocks are dropped — the `\n\n` join produces the page-break
 * spacing the rest of the pipeline expects.
 */
function blocksToText(blocks) {
  return blocks.map(renderBlock).filter(Boolean).join('\n\n')
}

/**
 * Extract Markdown-formatted text from a PDF buffer, preserving hyperlinks
 * as inline `[anchor](url)` syntax. Pages are separated by a blank line.
 *
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export async function extractPdfWithLinks(buffer) {
  const data = new Uint8Array(buffer)
  const loadingTask = pdfjsLib.getDocument({
    data,
    verbosity: PDFJS_VERBOSITY_QUIET
  })
  const doc = await loadingTask.promise
  const pageBlocks = []

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    try {
      const blocks = await extractPageBlocks(page)
      pageBlocks.push(blocks)
    } finally {
      page.cleanup()
    }
  }

  await doc.cleanup()
  return blocksToText(flattenPageBlocks(pageBlocks))
}
