import { createLogger } from './logging/logger.js'

const logger = createLogger()

// Constants needed by helpers
const DOCX_TEXT_KEYS = new Set(['w:t', 'w:instrText', '#text'])
const DOCX_SPACE_KEYS = new Set(['w:tab', 'w:br', 'w:cr'])
const ASCII_UPPER_A = 65
const ASCII_UPPER_Z = 90
// Filter out runs that look like binary blobs (no whitespace, very long).
const DOCX_BINARY_BLOB_MIN_LENGTH = 300
// XML/Word artefact patterns we drop from extracted runs.
const DOCX_ARTIFACT_PATTERN =
  /(Picture\s*\d+)|http:\/\/schemas\.openxmlformats\.org|<w:drawing|<pic:|graphicData|\{[\dA-Fa-f-]{8,}}/

const ASCII_SPACE = 32
const ASCII_TAB = 9
const ASCII_LF = 10
const ASCII_VT = 11
const ASCII_FF = 12
const ASCII_CR = 13

export function ensureArray(value) {
  if (Array.isArray(value)) {
    return value
  }
  if (value) {
    return [value]
  }
  return []
}

export function classifyDocxBlock(isHeading, isList) {
  if (isHeading) {
    return 'heading'
  }
  if (isList) {
    return 'list'
  }
  return 'para'
}

export function hasOwn(obj, key) {
  if (typeof Object.hasOwn === 'function') {
    return Object.hasOwn(obj, key)
  }
  return Object.hasOwn(obj, key)
}

export function isAttributeLikeKey(k) {
  if (k === '#text' || k === '$text') {
    return true
  }
  if (typeof k !== 'string') {
    return false
  }
  return /(?:^(?:@|xml|xmlns)|:)/.test(k)
}

export function coercePrimitiveToString(obj) {
  if (obj == null) {
    return ''
  }
  if (typeof obj === 'string') {
    return obj
  }
  if (typeof obj !== 'object') {
    return String(obj)
  }
  return null
}

export function sanitizeRunText(v) {
  const raw = extractStringFromObject(v)
  // normalize NBSP -> space, collapse consecutive whitespace to single spaces,
  // remove accidental "[object Object]" and trim leading/trailing whitespace
  return String(raw ?? '')
    .replaceAll('\u00A0', ' ')
    .replaceAll('[object Object]', '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractStringFromObject(obj) {
  const primitive = coercePrimitiveToString(obj)
  if (primitive !== null) {
    return primitive
  }

  if (hasOwn(obj, '#text')) {
    return String(obj['#text'] ?? '')
  }
  if (hasOwn(obj, '$text')) {
    return String(obj['$text'] ?? '')
  }

  for (const [k, v] of Object.entries(obj)) {
    if (isAttributeLikeKey(k)) {
      continue
    }
    const s = extractStringFromObject(v)
    if (s) {
      return s
    }
  }
  return ''
}

export function isGraphicNode(node) {
  if (!node) {
    return false
  }
  if (
    node['w:drawing'] ||
    node['w:pict'] ||
    node['pic:pic'] ||
    node['a:graphic']
  ) {
    return true
  }
  return false
}

export function readWtValue(wt) {
  return extractStringFromObject(wt)
}

export function readDocxChildValue(key, val) {
  if (val == null) {
    return ''
  }
  if (Array.isArray(val) || typeof val === 'object') {
    return readDocxNodeText(val)
  }
  if (DOCX_TEXT_KEYS.has(key)) {
    return String(val)
  }
  if (DOCX_SPACE_KEYS.has(key)) {
    return ' '
  }
  const s = String(val)
  if (/^\d[\d.,]{0,9}$/.test(s) && s.length <= 10) {
    return s
  }
  return ''
}

export function getDocxNodeFastText(node) {
  if (!node || typeof node !== 'object') {
    return null
  }
  if (isGraphicNode(node)) {
    return ''
  }
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
  return null
}

export function readDocxNodeText(node) {
  if (!node) {
    return ''
  }
  if (Array.isArray(node)) {
    return node.map(readDocxNodeText).join('')
  }
  if (typeof node !== 'object') {
    return String(node)
  }

  const fast = getDocxNodeFastText(node)
  if (fast !== null) {
    return fast
  }

  let text = ''
  for (const k of Object.keys(node)) {
    text += readDocxChildValue(k, node[k])
  }
  return text
}

export function extractParagraphStyle(pPr) {
  const pStyle = pPr?.['w:pStyle']
  if (!pStyle) {
    return ''
  }
  return pStyle['w:val'] || pStyle.val || ''
}

export function isPunctChar(ch) {
  if (typeof ch !== 'string' || ch.length === 0) {
    return false
  }
  return /[^\w\s]/u.test(ch)
}
export function isDigitChar(ch) {
  if (typeof ch !== 'string' || ch.length === 0) {
    return false
  }
  return /\d/.test(ch)
}
export function isAlnumChar(ch) {
  if (typeof ch !== 'string' || ch.length === 0) {
    return false
  }
  return /[A-Za-z0-9]/.test(ch)
}
// new helper: detect ASCII/Latin letters (used to avoid inserting spaces between split letters)
export function isLetterChar(ch) {
  if (typeof ch !== 'string' || ch.length === 0) {
    return false
  }
  return /[A-Za-z]/.test(ch)
}

export function endsWithUpperAcronym(s) {
  const str = String(s ?? '')
  let i = str.length - 1
  let count = 0
  while (i >= 0) {
    const code = str.codePointAt(i) || 0
    if (code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z) {
      count += 1
      i -= 1
    } else {
      break
    }
  }
  return count >= 2
}

export function shouldPreserveExplicitWhitespace(a, b) {
  return /\s$/.test(a) || /^\s/.test(b)
}
export function shouldKeepContiguousDigits(a, b) {
  const aLast = a.charAt(a.length - 1)
  const bFirst = b.charAt(0)
  return isDigitChar(aLast) && isDigitChar(bFirst)
}
export function shouldKeepAcronymDigits(a, b) {
  return endsWithUpperAcronym(a) && /^\d/.test(b)
}
export function shouldInsertSpaceBetween(a, b) {
  const aLast = a.charAt(a.length - 1)
  const bFirst = b.charAt(0)
  const aIsP = isPunctChar(aLast)
  const bIsP = isPunctChar(bFirst)
  const aIsAl = isAlnumChar(aLast)
  const bIsAl = isAlnumChar(bFirst)
  // Prevent inserting spaces between adjacent letters that were split into separate runs
  const aIsAlpha = isLetterChar(aLast)
  const bIsAlpha = isLetterChar(bFirst)
  if (aIsAlpha && bIsAlpha) {
    // If exactly one side is a single-letter fragment, it's likely a run-split inside a word:
    //   e.g. 'pos' + 'e' -> should join -> suppress space
    // If both sides are multi-letter or both are single-letter words, keep the space.
    const aIsSingle = a.length === 1
    const bIsSingle = b.length === 1
    if (aIsSingle !== bIsSingle) {
      return false
    }
    return true
  }
  return !aIsP && !bIsP && (aIsAl || bIsAl)
}

export function smartConcat(a, b) {
  if (!a) {
    return b || ''
  }
  if (!b) {
    return a
  }
  if (shouldPreserveExplicitWhitespace(a, b)) {
    return `${a}${b}`
  }
  if (shouldKeepContiguousDigits(a, b)) {
    return `${a}${b}`
  }
  if (shouldKeepAcronymDigits(a, b)) {
    return `${a}${b}`
  }
  if (shouldInsertSpaceBetween(a, b)) {
    return `${a} ${b}`
  }
  return `${a}${b}`
}

// Linear, ReDoS-safe whitespace/dot/tab detection helpers
export function isAsciiWhitespaceCode(cp) {
  return (
    cp === ASCII_SPACE ||
    cp === ASCII_TAB ||
    cp === ASCII_LF ||
    cp === ASCII_VT ||
    cp === ASCII_FF ||
    cp === ASCII_CR
  )
}

// Linear, safe dash-spacing implementation
export function spaceAroundDashes(s) {
  if (!s) {
    return s
  }
  const dashSet = new Set(['–', '—', '-'])
  let out = ''
  const len = s.length
  let i = 0
  while (i < len) {
    const ch = s[i]
    if (!dashSet.has(ch)) {
      out += ch
      i += 1
      continue
    }
    if (out.length === 0) {
      out += ch
    } else if (out.endsWith(' ')) {
      out += ch
    } else {
      out += ' ' + ch
    }
    let j = i + 1
    while (j < len && /\s/.test(s[j])) {
      j++
    }
    out += ' '
    i = j
  }
  return out
}

// Grouping/render helpers used by blocksToDocxText
export function groupDocxRunsByHref(runs) {
  // sanitize once and operate on a shallow copy to avoid mutating caller data
  const normalizedRuns = runs.map((r) => ({
    ...r,
    text: sanitizeRunText(r.text)
  }))

  // redistribute chained uppercase residues into following runs, then attach single-letter fragments
  redistributeTrailingCapital(normalizedRuns)
  normalizeSingleLetterFragments(normalizedRuns)
  const groups = []
  let current = null
  for (const r of normalizedRuns) {
    const rText = sanitizeRunText(r.text)
    if (r.href && current?.href === r.href) {
      current.text = smartConcat(current.text, rText)
    } else {
      current = { text: rText, href: r.href }
      groups.push(current)
    }
  }
  return groups
}

export function renderDocxGroupedRun(group) {
  if (group.href) {
    return `[${group.text}](${group.href})`
  }
  return group.text
}

/* Paragraph building helpers */

export function pushDocxRun(
  runs,
  text,
  { bold = false, italic = false, href = null } = {}
) {
  const t = sanitizeRunText(text)
  if (!t) {
    return
  }
  if (/^\d{5,}$/.test(t)) {
    return
  }
  if (/^(\d{1,3})\1+$/.test(t)) {
    return
  }
  if (/^00[A-Fa-f0-9]{2}(?:[A-Fa-f0-9]{2})*$/.test(t)) {
    return
  }
  if (isArtifactRunText(t)) {
    return
  }

  runs.push({ text: t, bold, italic, href })
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

export function processDocxRuns(runNode, runs, currentHref) {
  for (const r of ensureArray(runNode)) {
    const text = readDocxNodeText(r)
    const rPr = r?.['w:rPr']
    const bold = rPr?.['w:b'] !== undefined
    const italic = rPr?.['w:i'] !== undefined
    pushDocxRun(runs, text, { bold, italic, href: currentHref })
  }
}

export function resolveRelationshipId(node) {
  const keys = ['r:id', '@_r:id', '@_rId', 'r:embed', 'r:Id', 'r:ID']
  for (const k of keys) {
    if (hasOwn(node, k) && node[k]) {
      return node[k]
    }
  }
  return null
}

export function processHyperlinkEntries(hyperlinkVal, rels, runs) {
  for (const hp of ensureArray(hyperlinkVal)) {
    const rid = resolveRelationshipId(hp)
    let href = null
    if (rid && rels && hasOwn(rels, rid)) {
      href = rels[rid]
    }
    if (hp['w:r']) {
      processDocxRuns(hp['w:r'], runs, href)
    }
    for (const [hk, hv] of Object.entries(hp)) {
      if (hk === 'w:r') {
        continue
      }
      walkParagraphNode(hv, rels, runs, href)
    }
  }
}

export function walkParagraphNode(node, rels, runs, currentHref = null) {
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
  for (const [key, val] of Object.entries(node)) {
    if (val == null) {
      // nothing
    } else if (key === 'w:hyperlink') {
      processHyperlinkEntries(val, rels, runs)
    } else if (key === 'w:r') {
      processDocxRuns(val, runs, currentHref)
    } else if (key === 'w:t') {
      pushDocxRun(runs, readDocxNodeText(node), { href: currentHref })
    } else {
      walkParagraphNode(val, rels, runs, currentHref)
    }
  }
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

function redistributeTrailingCapital(runs) {
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

function normalizeSingleLetterFragments(runs) {
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
