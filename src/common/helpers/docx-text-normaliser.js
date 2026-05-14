import {
  ensureArray,
  groupDocxRunsByHref,
  renderDocxGroupedRun,
  smartConcat,
  walkParagraphNode,
  classifyDocxBlock,
  extractParagraphStyle,
  isAsciiWhitespaceCode
} from './docx-text-extractor.helpers.js'
import { createLogger } from './logging/logger.js'
const logger = createLogger()

const ASCII_DIGIT_0 = 48
const ASCII_DIGIT_9 = 57
const ASCII_DOT = 46
function canRedistributeTrailingCapital(cur, next) {
  if (!cur || !next) {
    return false
  }
  if (typeof cur.text !== 'string' || typeof next.text !== 'string') {
    return false
  }
  // do not move text across differing href boundaries
  if ((cur.href || null) !== (next.href || null)) {
    return false
  }
  const curText = cur.text
  const nextText = next.text
  // pattern: letter then uppercase at end of current, and next starts with optional whitespace + lowercase
  return /[A-Za-z][A-Z]$/.test(curText) && /^\s*[a-z]/.test(nextText)
}

function doRedistributeTrailingCapital(cur, next) {
  const moved = cur.text.slice(-1)
  cur.text = cur.text.slice(0, -1)
  next.text = moved + next.text.replace(/^\s+/, '')
}

export function redistributeTrailingCapital(runs) {
  if (!Array.isArray(runs) || runs.length < 2) {
    return
  }
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < runs.length - 1; i++) {
      const cur = runs[i]
      const next = runs[i + 1]
      if (canRedistributeTrailingCapital(cur, next)) {
        doRedistributeTrailingCapital(cur, next)
        changed = true
      }
    }
  }
}

function isSingleLetterRun(r) {
  if (!r || typeof r.text !== 'string') {
    return false
  }
  const t = r.text.trim()
  return t.length === 1 && /^[A-Za-z]$/.test(t)
}

function sameHref(a, b) {
  return (a?.href || null) === (b?.href || null)
}

function ensurePrevEndsWithSpace(prev) {
  if (!prev) {
    return
  }
  if (!/\s$/.test(String(prev.text || ''))) {
    prev.text = String(prev.text || '') + ' '
  }
}

function attachToNext(runs, idx, letter) {
  const next = runs[idx + 1]
  if (!next || typeof next.text !== 'string') {
    return false
  }
  // attach letter to next run (strip next leading spaces)
  next.text = letter + next.text.replace(/^\s+/, '')
  runs.splice(idx, 1)
  return true
}

function removeTrailingSingleAttachedToPrev(runs, idx) {
  const prev = runs[idx - 1]
  if (!prev) {
    return false
  }
  ensurePrevEndsWithSpace(prev)
  runs.splice(idx, 1)
  return true
}

export function normalizeSingleLetterFragments(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return
  }

  let i = 0
  while (i < runs.length) {
    const cur = runs[i]
    if (!isSingleLetterRun(cur)) {
      i += 1
      continue
    }

    const letter = cur.text.trim()
    const next = runs[i + 1]
    const prev = runs[i - 1]

    if (next && typeof next.text === 'string' && sameHref(cur, next)) {
      ensurePrevEndsWithSpace(prev)
      attachToNext(runs, i, letter)
      // attachToNext removes current entry; do not advance index
    } else if (prev && sameHref(cur, prev)) {
      removeTrailingSingleAttachedToPrev(runs, i)
      // removeTrailingSingleAttachedToPrev removes current entry; do not advance index
    } else {
      // Nothing to do for this single-letter fragment (preserve boundaries)
      i += 1
    }
  }
}

/* Table processing */

export function processTableNode(tblNode, rels) {
  if (!tblNode || typeof tblNode !== 'object') {
    return null
  }
  const rows = []
  const trList = ensureArray(tblNode['w:tr'])
  for (const tr of trList) {
    const cells = []
    const tcList = ensureArray(tr['w:tc'])
    for (const tc of tcList) {
      // cell text can be composed of multiple paragraphs/runs — use readDocxNodeText to flatten
      const cellText = renderCellFromTc(tc, rels) || ''
      if (cellText) {
        cells.push(cellText)
      } else {
        cells.push('')
      }
    }
    if (cells.length > 0) {
      rows.push(cells)
    }
  }
  if (rows.length === 0) {
    return null
  }

  return { type: 'table', table: rows }
}

/**
 * Render text for a single table cell node (w:tc):
 * - collects sanitized runs via walkParagraphNode
 * - groups runs by href, renders them, smart-concats pieces
 * - collapses any internal newlines/whitespace to single spaces
 * - returns an empty string for empty cells
 */
function renderCellFromTc(tc, rels) {
  const runs = []
  walkParagraphNode(tc, rels, runs)

  if (runs.length === 0) {
    return ''
  }

  const groups = groupDocxRunsByHref(runs)
  const pieces = groups.map((g) => renderDocxGroupedRun(g))
  const merged = pieces.reduce((acc, p) => smartConcat(acc, p), '')
  // collapse internal whitespace/newlines into single spaces and trim
  let normalized = String(merged).replace(/\s+/g, ' ').trim()
  // remove long numeric/artifact sequences which appear injected into table cells
  // - hex-like blobs starting with 00 (e.g. 00A1B2...) — remove
  // - any sequence of 6 or more digits (e.g. 5000499120, 00621707, 77777777) — remove
  // Replace with a single space to preserve separation between adjacent words
  normalized = normalized
    .replace(/00[A-Fa-f0-9]{2}(?:[A-Fa-f0-9]{2})*/g, ' ')
    .replace(/\d{6,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return normalized
}
export function extractPreservedParagraphsSafe(
  documentXml,
  orderedParser,
  rels,
  body
) {
  // const preservedParagraphs = extractPreservedParagraphsSafe(
  //   documentXml,
  //   orderedParser
  // )
  // const paragraphs = ensureArray(body['w:p'])
  // return buildParagraphsFromNodes(paragraphs, preservedParagraphs, rels, body)
  // Try to use an ordered parse so we can emit paragraphs and tables
  // in the exact sequence they appear in the document.xml body.
  try {
    const preserved = orderedParser.parse(documentXml)

    // helper: find first preserved node that contains the given tag
    const findFirstPreserved = (arr, tag) => {
      if (!Array.isArray(arr)) return null
      for (const node of arr) {
        if (
          node &&
          typeof node === 'object' &&
          Object.prototype.hasOwnProperty.call(node, tag)
        ) {
          return node[tag]
        }
      }
      return null
    }

    const docNode = findFirstPreserved(preserved, 'w:document')
    const bodyNode = findFirstPreserved(docNode || [], 'w:body')

    if (Array.isArray(bodyNode)) {
      const out = []
      const paragraphs = ensureArray(body['w:p'])
      const tables = ensureArray(body['w:tbl'])
      let pIndex = 0
      let tIndex = 0
      for (const child of bodyNode) {
        if (!child || typeof child !== 'object') {
          continue
        }
        if (Object.prototype.hasOwnProperty.call(child, 'w:p')) {
          const preserved = child['w:p']
          const originalP = paragraphs[pIndex++] || preserved
          const paraObj = buildParagraphObjectFromNode(
            originalP,
            preserved,
            rels
          )
          if (paraObj) {
            out.push(paraObj)
          }
          continue
        }

        if (Object.prototype.hasOwnProperty.call(child, 'w:tbl')) {
          // prefer the original parsed table node (to match processTableNode expectations)
          const originalTbl = tables[tIndex++] || child['w:tbl']
          const tableBlock = processTableNode(originalTbl, rels)
          if (tableBlock) {
            out.push(tableBlock)
          }
          continue
        }
      }
      return out
    }
  } catch (err) {
    logger.info(
      { err: err.message },
      'Ordered parse failed; falling back to unordered walk'
    )
    return []
  }
}

function buildParagraphObjectFromNode(p, preserved, rels) {
  const pPr = p['w:pPr'] || {}
  const pStyle = extractParagraphStyle(pPr)
  const isHeading = typeof pStyle === 'string' && /^Heading/i.test(pStyle)
  const isList = !!pPr['w:numPr']
  //const visibleLine = (readDocxNodeText(p) || '').replaceAll('\u00A0', ' ')
  //const rawParagraphJson = JSON.stringify(p)
  //const toc = isParagraphToc(pStyle, visibleLine, rawParagraphJson)
  const runs = []
  if (preserved) {
    walkParagraphNode(preserved, rels, runs)
  } else {
    walkParagraphNode(p, rels, runs)
  }
  //   if (toc && runs.length > 0) {
  //     return {
  //       type: classifyDocxBlock(isHeading, isList),
  //       runs: cleanTocRuns(runs)
  //     }
  //   }
  if (runs.length > 0) {
    return { type: classifyDocxBlock(isHeading, isList), runs }
  }
  return null
}

function cleanTocRuns(runs) {
  return runs
    .map((r) => {
      const raw = sanitizeRunText(r.text)
      const t = raw
        .replaceAll(/\b\d{6,}\b/g, '')
        .replaceAll(/\b00[A-Fa-f0-9]{2}(?:[A-Fa-f0-9]{2})*\b/g, '')
        .replaceAll(/\s{2,}/g, ' ')
        .trim()
      return { ...r, text: t }
    })
    .filter((r) => r?.text?.length > 0)
}
function isParagraphToc(pStyle, visibleLine, rawParagraphJson) {
  const visibleHasTabPage = visibleLineHasTabPage(visibleLine)
  const visibleHasDotsPage = visibleLineHasDotsPage(visibleLine)
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

function visibleLineHasDotsPage(visibleLine) {
  let i = trimTrailingWhitespaceIndex(visibleLine)
  const { digitCount, nextIndex } = countTrailingDigitsFromIndex(visibleLine, i)
  if (digitCount === 0) {
    return false
  }

  i = skipWhitespaceReverse(visibleLine, nextIndex)
  const dotCount = countTrailingDotsFromIndex(visibleLine, i)
  if (dotCount < 2) {
    return false
  }

  return true
}

function visibleLineHasTabPage(visibleLine) {
  const tabIdx = visibleLine.lastIndexOf('\t')
  if (tabIdx === -1) {
    return false
  }

  const len = visibleLine.length
  let i = nextNonWhitespaceIndex(visibleLine, tabIdx + 1)
  if (i >= len) {
    return false
  }

  const { digitCount, indexAfterDigits } = countDigitsFrom(visibleLine, i)
  if (digitCount === 0) {
    return false
  }

  i = nextNonWhitespaceIndex(visibleLine, indexAfterDigits)
  return i === len
}

function nextNonWhitespaceIndex(str, from) {
  const len = str.length
  let i = from
  while (i < len && isAsciiWhitespaceCode(str.codePointAt(i))) {
    i++
  }
  return i
}

function trimTrailingWhitespaceIndex(str) {
  const len = str.length
  let i = len - 1
  while (i >= 0 && isAsciiWhitespaceCode(str.codePointAt(i))) {
    i--
  }
  return i
}

function countTrailingDigitsFromIndex(str, index) {
  let i = index
  let digitCount = 0
  while (i >= 0) {
    const cp = str.codePointAt(i)
    if (cp >= ASCII_DIGIT_0 && cp <= ASCII_DIGIT_9) {
      digitCount++
      i--
    } else {
      break
    }
  }
  return { digitCount, nextIndex: i }
}

function skipWhitespaceReverse(str, index) {
  let i = index
  while (i >= 0 && isAsciiWhitespaceCode(str.codePointAt(i))) {
    i--
  }
  return i
}

function countTrailingDotsFromIndex(str, index) {
  let i = index
  let dotCount = 0
  while (i >= 0 && str.codePointAt(i) === ASCII_DOT) {
    dotCount++
    i--
  }
  return dotCount
}
