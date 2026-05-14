import {
  ensureArray,
  groupDocxRunsByHref,
  renderDocxGroupedRun,
  smartConcat,
  walkParagraphNode,
  hasOwn
} from './docx-text-extractor.helpers.js'
import { createLogger } from './logging/logger.js'
const logger = createLogger()

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
export function extractPreservedParagraphsSafe(documentXml, orderedParser) {
  try {
    const docPres = orderedParser.parse(documentXml)
    const docNode = findFirstPreserved(docPres, 'w:document')
    if (!docNode) {
      return []
    }
    const bodyNode = findFirstPreserved(docNode || [], 'w:body')
    return collectPreservedParagraphsFromBody(bodyNode)
  } catch (err) {
    logger.error(
      { err: err.message },
      'Ordered parse failed; falling back to unordered walk'
    )
    return []
  }
}

function findFirstPreserved(arr, tag) {
  if (!Array.isArray(arr)) {
    return null
  }
  for (const item of arr) {
    if (item && typeof item === 'object' && hasOwn(item, tag)) {
      return item[tag]
    }
  }
  return null
}

function collectPreservedParagraphsFromBody(bodyNode) {
  if (!Array.isArray(bodyNode)) {
    return []
  }
  return bodyNode
    .filter(
      (child) => child && typeof child === 'object' && hasOwn(child, 'w:p')
    )
    .map((child) => child['w:p'])
}
