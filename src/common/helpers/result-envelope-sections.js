import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * Return true when a linkMap entry has valid types and in-range offsets.
 * @param {Object} e
 * @param {number} textLength
 * @returns {boolean}
 */
export function isValidLinkEntry(e, textLength) {
  if (typeof e.start !== 'number' || typeof e.end !== 'number') {
    return false
  }
  if (e.start < 0 || e.end <= e.start || e.end > textLength) {
    return false
  }
  return typeof e.display === 'string' && e.display.length > 0
}

/**
 * Validate and sort linkMap entries for use in plain-span reconstruction.
 * @param {string}     canonicalText
 * @param {Array|null} linkMap
 * @returns {Array}
 */
export function validatedLinks(canonicalText, linkMap) {
  if (!Array.isArray(linkMap) || linkMap.length === 0) {
    return []
  }
  return linkMap
    .filter((e) => isValidLinkEntry(e, canonicalText.length))
    .slice()
    .sort((a, b) => a.start - b.start)
}

/**
 * Reconstruct the display version of a plain slice [from, to) of
 * canonicalText, substituting Markdown link display strings for any link
 * anchors wholly contained within the slice.
 * @param {string} canonicalText
 * @param {Array}  links   - validated, sorted link entries
 * @param {number} from
 * @param {number} to
 * @returns {string}
 */
export function buildPlainSpan(canonicalText, links, from, to) {
  if (links.length === 0) {
    return canonicalText.slice(from, to)
  }

  const parts = []
  let pos = from

  for (const link of links) {
    const afterRange = link.start >= to
    const beforeRange = link.end <= from
    const whollyWithin = link.start >= from && link.end <= to

    if (afterRange) {
      break // eslint-disable-line no-restricted-syntax
    }

    if (!beforeRange && whollyWithin) {
      if (link.start > pos) {
        parts.push(canonicalText.slice(pos, link.start))
      }
      parts.push(link.display)
      pos = link.end
    }
  }

  if (pos < to) {
    parts.push(canonicalText.slice(pos, to))
  }

  return parts.join('')
}

/**
 * Split the canonical text into a sequence of plain and highlighted spans
 * based on improvement offsets. Improvements MUST already be sorted by start
 * and free of overlaps (i.e. produced by buildEnvelope).
 * @param {string}       canonicalText
 * @param {Array}        sortedImprovements
 * @param {Array|null}   [linkMap]
 * @returns {Array}
 */
export function buildAnnotatedSections(
  canonicalText,
  sortedImprovements,
  linkMap = null
) {
  if (!canonicalText) {
    return []
  }

  const links = validatedLinks(canonicalText, linkMap)
  const sections = []
  let cursor = 0

  for (let seqIdx = 0; seqIdx < sortedImprovements.length; seqIdx++) {
    const { start, end, category } = sortedImprovements[seqIdx]

    if (start > cursor) {
      sections.push({
        text: buildPlainSpan(canonicalText, links, cursor, start),
        issueIdx: null,
        category: null
      })
    }

    sections.push({
      text: canonicalText.slice(start, end),
      issueIdx: seqIdx,
      category
    })

    cursor = end
  }

  if (cursor < canonicalText.length) {
    sections.push({
      text: buildPlainSpan(canonicalText, links, cursor, canonicalText.length),
      issueIdx: null,
      category: null
    })
  }

  return sections
}

/**
 * Derive the flat scores object from Bedrock's scored map.
 * Values are stored as 1–5 matching the LLM output and the frontend display.
 * @param {Object} rawScores
 * @returns {Object}
 */
export function mapScores(rawScores) {
  const scoreMap = {}

  for (const [key, val] of Object.entries(rawScores || {})) {
    const lk = key.toLowerCase()
    scoreMap[lk] = { value: val.score || 0, note: val.note || '' }
  }

  const pick = (keys) => {
    for (const k of keys) {
      if (scoreMap[k] !== undefined) {
        return scoreMap[k]
      }
    }
    return { value: 0, note: '' }
  }

  const plainEnglish = pick(['plain english', 'plain-english'])
  const govukStyle = pick([
    'gov.uk style compliance',
    'govuk style compliance',
    'govuk style'
  ])

  return {
    plainEnglish: plainEnglish.value,
    plainEnglishNote: plainEnglish.note,
    govukStyle: govukStyle.value,
    govukStyleNote: govukStyle.note
  }
}
