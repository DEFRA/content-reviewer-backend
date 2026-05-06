import { createLogger } from './logging/logger.js'

const logger = createLogger()

// Fuzzy matching — minimum search length to attempt and required similarity
const FUZZY_MIN_SEARCH_LENGTH = 8
const FUZZY_SIMILARITY_THRESHOLD = 0.82

// Maximum number of characters from a text field to include in log output
const LOG_PREVIEW_LENGTH = 60

/**
 * Build a normalized version of text for fuzzy matching and a mapping array
 * from each normalized-string index back to its original-string index.
 *
 * Normalization: collapses runs of whitespace to a single space and converts
 * Unicode smart quotes/apostrophes to their ASCII equivalents.
 *
 * @param {string} text
 * @returns {{ normalized: string, indexMap: number[] }}
 */
export function buildNormalizedMapping(text) {
  let normalized = ''
  const indexMap = []
  let prevWasSpace = false

  for (let i = 0; i < text.length; i++) {
    let ch = text[i]
    if (ch === '\u2018' || ch === '\u2019') {
      ch = "'"
    }
    if (ch === '\u201C' || ch === '\u201D') {
      ch = '"'
    }

    if (/\s/.test(ch)) {
      if (!prevWasSpace) {
        normalized += ' '
        indexMap.push(i)
        prevWasSpace = true
      }
    } else {
      normalized += ch
      indexMap.push(i)
      prevWasSpace = false
    }
  }

  return { normalized, indexMap }
}

/**
 * Compute Levenshtein edit distance between strings a and b.
 * Uses a two-row rolling array — memory is O(n).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  if (m === 0) {
    return n
  }
  if (n === 0) {
    return m
  }

  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = Array.from({ length: n + 1 })

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1])
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/**
 * Slide a fixed-length window over normRegion and return the position with the
 * highest Levenshtein similarity to normSearch, provided it meets `threshold`.
 *
 * Called by findWithinSourceMapRegion when exact normalised indexOf fails.
 * normRegion is already a small slice (typically ±1 line around the hint) so
 * the O(region × search²) cost is acceptable in practice.
 *
 * @param {string}   normSearch    - whitespace/quote-normalised search text
 * @param {string}   normRegion    - whitespace/quote-normalised region text
 * @param {number[]} indexMap      - maps normRegion index → regionText index
 * @param {number}   regionStart   - offset of region within canonicalText
 * @param {number}   [threshold]   - minimum similarity score (default 0.82)
 * @returns {{ start: number, end: number } | null}
 */
export function fuzzySearchInRegion(
  normSearch,
  normRegion,
  indexMap,
  regionStart,
  threshold = FUZZY_SIMILARITY_THRESHOLD
) {
  if (normSearch.length < FUZZY_MIN_SEARCH_LENGTH) {
    return null
  }
  if (normRegion.length < normSearch.length) {
    return null
  }

  const searchLen = normSearch.length
  const maxAllowedDist = Math.floor(searchLen * (1 - threshold))

  let bestDist = maxAllowedDist + 1
  let bestIdx = -1

  for (let i = 0; i <= normRegion.length - searchLen; i++) {
    const dist = levenshtein(normSearch, normRegion.slice(i, i + searchLen))
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
      if (dist === 0) {
        break
      } // exact match, can't improve
    }
  }

  if (bestIdx === -1) {
    return null
  }

  const endIdx = bestIdx + searchLen - 1
  if (endIdx >= indexMap.length) {
    return null
  }

  const origStart = regionStart + indexMap[bestIdx]
  const origEnd = regionStart + indexMap[endIdx] + 1

  if (origEnd <= origStart) {
    return null
  }

  return { start: origStart, end: origEnd }
}

/**
 * Return true when the required inputs for a sourceMap region search are valid.
 * @param {string} searchText
 * @param {string} canonicalText
 * @param {Array}  sourceMap
 * @returns {boolean}
 */
function isValidRegionSearchInput(searchText, canonicalText, sourceMap) {
  return (
    Boolean(searchText) &&
    Boolean(canonicalText) &&
    Array.isArray(sourceMap) &&
    sourceMap.length > 0
  )
}

/**
 * Search for searchText (after whitespace/quote normalisation) within the
 * region of canonicalText identified by the sourceMap lines that overlap the
 * LLM-hinted offsets (expanded by ±1 line to absorb small offset errors).
 *
 * Returns `{ start, end }` in canonicalText coordinates, or `null` when the
 * text cannot be located within the region.
 *
 * @param {string} searchText
 * @param {string} canonicalText
 * @param {Array}  sourceMap   - array of { start, end, lineIndex } entries
 * @param {number} llmStart    - LLM-reported start offset (hint)
 * @param {number} llmEnd      - LLM-reported end offset (hint)
 * @returns {{ start: number, end: number } | null}
 */
export function findWithinSourceMapRegion(
  searchText,
  canonicalText,
  sourceMap,
  llmStart,
  llmEnd
) {
  if (!isValidRegionSearchInput(searchText, canonicalText, sourceMap)) {
    return null
  }

  // Find entries whose range overlaps the LLM hint
  const overlapping = sourceMap.filter(
    (entry) => entry.end >= llmStart && entry.start <= llmEnd
  )
  if (!overlapping.length) {
    return null
  }

  // Expand ±1 line to absorb small offset errors from the model
  const minLine = Math.max(0, overlapping[0].lineIndex - 1)
  const maxLine = overlapping.at(-1).lineIndex + 1

  const expanded = sourceMap.filter(
    (entry) => entry.lineIndex >= minLine && entry.lineIndex <= maxLine
  )

  const regionStart = expanded[0].start
  const regionEnd = Math.min(expanded.at(-1).end, canonicalText.length)
  const regionText = canonicalText.slice(regionStart, regionEnd)

  const { normalized: normRegion, indexMap } =
    buildNormalizedMapping(regionText)
  const { normalized: normSearch } = buildNormalizedMapping(searchText)

  if (!normSearch.length) {
    return null
  }

  const idx = normRegion.indexOf(normSearch)
  if (idx === -1) {
    const fuzzyResult = fuzzySearchInRegion(
      normSearch,
      normRegion,
      indexMap,
      regionStart
    )
    if (fuzzyResult) {
      logger.info(
        {
          resolvedStart: fuzzyResult.start,
          resolvedEnd: fuzzyResult.end,
          llmStart,
          llmEnd,
          text: searchText.substring(0, LOG_PREVIEW_LENGTH)
        },
        '[result-envelope] Resolved position via fuzzy match within sourceMap region'
      )
    }
    return fuzzyResult
  }

  const endIdx = idx + normSearch.length - 1
  if (endIdx >= indexMap.length) {
    return null
  }

  const origStart = regionStart + indexMap[idx]
  const origEnd = regionStart + indexMap[endIdx] + 1

  if (origEnd <= origStart) {
    return null
  }

  return { start: origStart, end: origEnd }
}

/**
 * Search canonicalText for the nearest occurrence of `searchText` to `hintMid`.
 * Returns `{ start, end }` when found, or `null` when the text is not present.
 * @param {string} searchText
 * @param {string} canonicalText
 * @param {number} hintMid
 * @returns {{ start: number, end: number } | null}
 */
export function findNearestOccurrence(searchText, canonicalText, hintMid) {
  if (!searchText || !canonicalText) {
    return null
  }
  let bestStart = -1
  let bestDistance = Infinity
  let searchFrom = 0

  while (searchFrom <= canonicalText.length) {
    const found = canonicalText.indexOf(searchText, searchFrom)
    if (found === -1) {
      break
    }
    const mid = found + searchText.length / 2
    const dist = Math.abs(mid - hintMid)
    if (dist < bestDistance) {
      bestDistance = dist
      bestStart = found
    }
    searchFrom = found + 1
  }

  if (bestStart === -1) {
    return null
  }
  return { start: bestStart, end: bestStart + searchText.length }
}

/**
 * Return `{ start, end }` when the canonical text slice exactly matches issueText,
 * otherwise null.
 * @param {string} issueText
 * @param {string} canonicalText
 * @param {number} start
 * @param {number} end
 * @returns {{ start: number, end: number } | null}
 */
function resolveExactMatch(issueText, canonicalText, start, end) {
  if (issueText && canonicalText.slice(start, end) === issueText) {
    return { start, end }
  }
  return null
}

/**
 * Log a successful position resolution and return the resolved position.
 * Extracted from resolveIssuePosition to reduce repeated log+return blocks.
 * @param {{ start: number, end: number }} found
 * @param {number} originalStart
 * @param {number} originalEnd
 * @param {string} source
 * @param {string} textPreview
 * @param {string} msg
 * @returns {{ start: number, end: number }}
 */
function logResolution(
  found,
  originalStart,
  originalEnd,
  source,
  textPreview,
  msg
) {
  logger.info(
    {
      originalStart,
      originalEnd,
      resolvedStart: found.start,
      resolvedEnd: found.end,
      source,
      text: textPreview
    },
    msg
  )
  return found
}

/**
 * Steps 2–3: try to locate issueText in canonicalText via nearest-occurrence
 * search then sourceMap region search. Returns { start, end } or null.
 * @param {string}     issueText
 * @param {string}     canonicalText
 * @param {Array|null} sourceMap
 * @param {number}     start
 * @param {number}     end
 * @param {number}     hintMid
 * @returns {{ start: number, end: number } | null}
 */
function resolveByIssueText(
  issueText,
  canonicalText,
  sourceMap,
  start,
  end,
  hintMid
) {
  const nearest = findNearestOccurrence(issueText, canonicalText, hintMid)
  if (nearest) {
    return logResolution(
      nearest,
      start,
      end,
      'issueText',
      issueText.substring(0, LOG_PREVIEW_LENGTH),
      '[result-envelope] Resolved issue position via issueText search'
    )
  }
  const region = sourceMap
    ? findWithinSourceMapRegion(issueText, canonicalText, sourceMap, start, end)
    : null
  if (region) {
    return logResolution(
      region,
      start,
      end,
      'sourceMap-region-normalised',
      issueText.substring(0, LOG_PREVIEW_LENGTH),
      '[result-envelope] Resolved issue position via normalised sourceMap region search'
    )
  }
  return null
}

/**
 * Steps 4–5: try to locate fallbackText (improvement.current) in canonicalText
 * via nearest-occurrence search then sourceMap region search. Returns { start, end } or null.
 * @param {string}     fallbackText
 * @param {string}     canonicalText
 * @param {Array|null} sourceMap
 * @param {number}     start
 * @param {number}     end
 * @param {number}     hintMid
 * @returns {{ start: number, end: number } | null}
 */
function resolveByFallbackText(
  fallbackText,
  canonicalText,
  sourceMap,
  start,
  end,
  hintMid
) {
  const nearest = findNearestOccurrence(fallbackText, canonicalText, hintMid)
  if (nearest) {
    return logResolution(
      nearest,
      start,
      end,
      'fallbackText (improvement.current)',
      fallbackText.substring(0, LOG_PREVIEW_LENGTH),
      '[result-envelope] Resolved issue position via improvement.current fallback'
    )
  }
  const region = sourceMap
    ? findWithinSourceMapRegion(
        fallbackText,
        canonicalText,
        sourceMap,
        start,
        end
      )
    : null
  if (region) {
    return logResolution(
      region,
      start,
      end,
      'sourceMap-region-normalised-fallback',
      fallbackText.substring(0, LOG_PREVIEW_LENGTH),
      '[result-envelope] Resolved issue position via normalised sourceMap region search (improvement.current fallback)'
    )
  }
  return null
}

/**
 * Resolve the best character-offset pair for a raw issue using verbatim text
 * fields as ground truth.  Falls back to the original offsets if not found.
 *
 * Resolution order:
 *   1. Exact slice match at the reported offsets
 *   2. Nearest exact occurrence of issueText in full canonicalText
 *   3. Normalised (whitespace/quote) search within the sourceMap line region
 *   4. Nearest exact occurrence of fallbackText (improvement.current) in full canonicalText
 *   5. Normalised search of fallbackText within the sourceMap line region
 *   6. Original offsets as-is (last resort)
 *
 * @param {number}      start
 * @param {number}      end
 * @param {string}      issueText
 * @param {string}      canonicalText
 * @param {string|null} [fallbackText]
 * @param {Array|null}  [sourceMap]
 * @returns {{ start: number, end: number }}
 */
export function resolveIssuePosition(
  start,
  end,
  issueText,
  canonicalText,
  fallbackText = null,
  sourceMap = null
) {
  const exact = resolveExactMatch(issueText, canonicalText, start, end)
  if (exact) {
    return exact
  }

  const hintMid = (start + end) / 2

  if (issueText) {
    const result = resolveByIssueText(
      issueText,
      canonicalText,
      sourceMap,
      start,
      end,
      hintMid
    )
    if (result) {
      return result
    }
  }

  if (fallbackText) {
    const result = resolveByFallbackText(
      fallbackText,
      canonicalText,
      sourceMap,
      start,
      end,
      hintMid
    )
    if (result) {
      return result
    }
  }

  return { start, end }
}
