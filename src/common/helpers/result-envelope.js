import { randomUUID } from 'node:crypto'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

// Bedrock scores are 0-5; spec requires 0-100
const SCORE_SCALE_FACTOR = 20

/**
 * Derive the evidence text for an issue: prefer slicing canonicalText by offset,
 * fall back to the raw issue's text field.
 * @param {number} start
 * @param {number} end
 * @param {string} canonicalText
 * @param {string} fallbackText
 * @returns {string}
 */
function deriveEvidence(start, end, canonicalText, fallbackText) {
  if (canonicalText && start < end) {
    return canonicalText.slice(start, end)
  }
  return fallbackText || ''
}

/**
 * Derive the category for an issue from the raw issue type or improvement category.
 * Returns a lowercase-hyphenated value used for CSS class names.
 * @param {Object} rawIssue
 * @param {Object|null} improvement
 * @returns {string}
 */
function deriveCategory(rawIssue, improvement) {
  return (rawIssue.type || improvement?.category || 'general').toLowerCase()
}

/**
 * Map a raw category value (either a type key like "plain-english" or a display
 * name like "Plain English") to the canonical Title Case display name shown in
 * the Priority Improvements badge.
 * @param {string} raw
 * @returns {string}
 */
const DISPLAY_PLAIN_ENGLISH = 'Plain English'
const DISPLAY_CLARITY = 'Clarity & Structure'
const DISPLAY_GOVUK_STYLE = 'GOV.UK Style Compliance'
const DISPLAY_COMPLETENESS = 'Content Completeness'

const CATEGORY_DISPLAY_NAMES = {
  'plain-english': DISPLAY_PLAIN_ENGLISH,
  'plain english': DISPLAY_PLAIN_ENGLISH,
  clarity: DISPLAY_CLARITY,
  'clarity & structure': DISPLAY_CLARITY,
  accessibility: 'Accessibility',
  'govuk-style': DISPLAY_GOVUK_STYLE,
  'govuk style': DISPLAY_GOVUK_STYLE,
  'govuk style compliance': DISPLAY_GOVUK_STYLE,
  'gov.uk style compliance': DISPLAY_GOVUK_STYLE,
  completeness: DISPLAY_COMPLETENESS,
  'content completeness': DISPLAY_COMPLETENESS
}

function normalizeCategoryDisplay(raw) {
  if (!raw) {
    return ''
  }
  return CATEGORY_DISPLAY_NAMES[raw.toLowerCase()] || raw
}

/**
 * Builds the spec-compliant result envelope.
 * The envelope is stored as the `envelope` field inside reviews/{reviewId}.json
 * by the review repository — no separate S3 file is written.
 *
 * Schema (per API Technical Requirements):
 * {
 *   documentId:        string   - same as reviewId
 *   status:            string   - "pending" | "processing" | "completed" | "failed"
 *   processedAt:       string   - ISO 8601
 *   tokenUsed:         number   - total tokens consumed by Bedrock
 *   issueCount:        number   - total issues found
 *   canonicalText:     string   - full normalised text (user content)
 *   annotatedSections: Array    - the canonical text split into plain/highlighted spans:
 *     [{ text: string, issueIdx: number|null, category: string|null }]
 *     issueIdx is the 0-based index into issues[] for highlighted spans, null for plain text.
 *   issues: [
 *     {
 *       issueId:   string  - uuid
 *       absStart:  number  - char offset in canonicalText
 *       absEnd:    number  - char offset in canonicalText
 *       category:  string  - e.g. "clarity"
 *       severity:  string  - e.g. "medium"
 *       why:       string  - explanation
 *       suggested: string  - replacement text
 *       evidence:  string  - the exact problematic span (slice of canonicalText)
 *       chunkIdx:  number  - 0-based index
 *     }
 *   ],
 *   improvements: [
 *     {
 *       issueId:   string  - matches issues[i].issueId
 *       severity:  string
 *       category:  string
 *       issue:     string  - short title
 *       why:       string  - explanation
 *       current:   string  - problematic text
 *       suggested: string  - replacement text
 *     }
 *   ],
 *   scores: {
 *     accessibility: number,   (0-100)
 *     style:         number,
 *     tone:          number,
 *     overall:       number
 *   }
 * }
 */
class ResultEnvelopeStore {
  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Search canonicalText for the nearest occurrence of `searchText` to
   * `hintMid`.  Returns `{ start, end }` when found, or `null` when the
   * text is not present in canonicalText.
   *
   * @param {string} searchText
   * @param {string} canonicalText
   * @param {number} hintMid  - midpoint of the originally-reported span (used
   *   to disambiguate when searchText appears more than once)
   * @returns {{ start: number, end: number } | null}
   */
  _findNearestOccurrence(searchText, canonicalText, hintMid) {
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
   * Resolve the best character-offset pair for a raw issue.
   *
   * Bedrock sometimes produces `start`/`end` values that are off (e.g. the
   * model counted from a different baseline or the document was pre-processed
   * differently).  When the canonical text slice at the given offsets does not
   * match the expected text, the method tries the following in order:
   *
   *   1. Fast path  — the slice at [start, end) already equals issueText.
   *   2. issueText search — find issueText anywhere in canonicalText.
   *   3. fallbackText search — find the improvement's `current` field text,
   *      which Bedrock always fills with the verbatim problematic phrase.
   *
   * @param {number} start
   * @param {number} end
   * @param {string} issueText      - rawIssue.text from [ISSUE_POSITIONS]
   * @param {string} canonicalText
   * @param {string|null} [fallbackText]  - improvement.current (verbatim
   *   problematic text from the document; used when issueText search fails)
   * @returns {{ start: number, end: number }}
   */
  _resolveIssuePosition(
    start,
    end,
    issueText,
    canonicalText,
    fallbackText = null
  ) {
    // Fast path: offsets are already correct
    if (issueText && canonicalText.slice(start, end) === issueText) {
      return { start, end }
    }

    const hintMid = (start + end) / 2

    // First attempt: search using the verbatim text from [ISSUE_POSITIONS]
    if (issueText) {
      const found = this._findNearestOccurrence(
        issueText,
        canonicalText,
        hintMid
      )
      if (found) {
        logger.info(
          {
            originalStart: start,
            originalEnd: end,
            resolvedStart: found.start,
            resolvedEnd: found.end,
            source: 'issueText',
            text: issueText.substring(0, 60)
          },
          '[result-envelope] Resolved issue position via issueText search'
        )
        return found
      }
    }

    // Second attempt: use the improvement's current field as a fallback.
    // The prompt instructs Bedrock to set current = the full sentence or phrase
    // from the document that contains the problem, so this is always verbatim.
    if (fallbackText) {
      const found = this._findNearestOccurrence(
        fallbackText,
        canonicalText,
        hintMid
      )
      if (found) {
        logger.info(
          {
            originalStart: start,
            originalEnd: end,
            resolvedStart: found.start,
            resolvedEnd: found.end,
            source: 'fallbackText (improvement.current)',
            text: fallbackText.substring(0, 60)
          },
          '[result-envelope] Resolved issue position via improvement.current fallback'
        )
        return found
      }
    }

    // Text not found by any method — return original offsets; the
    // _buildPairs validity filter will discard them if they are out of range.
    return { start, end }
  }

  /**
   * Map a parsed issue + its paired improvement into the spec issue object.
   *
   * The `evidence` field is always taken from the canonical text slice
   * (canonicalText.slice(start, end)) so it is guaranteed to match the
   * annotatedSections, regardless of what the model returned in its text field.
   *
   * @param {Object} rawIssue     - { start, end, type, text } from ISSUE_POSITIONS
   * @param {Object} improvement  - { severity, category, issue, why, current, suggested }
   * @param {number} idx
   * @param {string} canonicalText
   * @returns {Object}
   */
  _mapIssue(rawIssue, improvement, idx, canonicalText) {
    let start = rawIssue.start ?? 0
    let end = rawIssue.end ?? 0

    // Attempt to resolve the true position using the verbatim text field as
    // ground truth, with improvement.current as a secondary fallback.
    // This corrects cases where Bedrock's offsets are wrong but the text
    // fields are accurate (e.g. offsets counted from the message start rather
    // than from the content text).
    if (canonicalText) {
      const resolved = this._resolveIssuePosition(
        start,
        end,
        rawIssue.text || '',
        canonicalText,
        improvement?.current || null
      )
      start = resolved.start
      end = resolved.end
    }

    return {
      issueId: `issue-${randomUUID()}`,
      absStart: start,
      absEnd: end,
      category: deriveCategory(rawIssue, improvement),
      severity: improvement?.severity || 'medium',
      why: improvement?.why || improvement?.issue || '',
      suggested: improvement?.suggested || '',
      evidence: deriveEvidence(start, end, canonicalText, rawIssue.text),
      chunkIdx: idx,
      ref: rawIssue.ref // preserve for ref-based matching; undefined when absent
    }
  }

  /**
   * Build an improvement object that mirrors its parsed improvement.
   * Preserves the `ref` field so _sortAndAlignPairs can match by ref.
   *
   * @param {Object} parsedImprovement  - from parseBedrockResponse improvements[]
   * @param {string} issueId            - temporary issueId (re-linked after matching)
   * @returns {Object}
   */
  _mapImprovement(parsedImprovement, issueId) {
    return {
      issueId,
      severity: parsedImprovement?.severity || 'medium',
      category: normalizeCategoryDisplay(parsedImprovement?.category),
      issue: parsedImprovement?.issue || '',
      why: parsedImprovement?.why || '',
      current: parsedImprovement?.current || '',
      suggested: parsedImprovement?.suggested || '',
      ref: parsedImprovement?.ref // preserve for ref-based matching; undefined when absent
    }
  }

  /**
   * Snap a character offset to the nearest word boundary in canonicalText.
   *
   * The AI model occasionally returns start/end offsets that land in the
   * middle of a word (e.g. "Currently" becomes "Cur" + "rently").  This
   * helper expands a [start, end) pair outward so that both boundaries sit
   * at a word-character transition, preventing partial-word highlights.
   *
   * Rules:
   *  • start is moved LEFT  until it hits a non-word character (or pos 0).
   *  • end   is moved RIGHT until it hits a non-word character (or end of string).
   *  • Whitespace-only characters (\s) at the edges of the expanded span are
   *    trimmed back so we never include a leading/trailing space in the highlight.
   *
   * @param {string} text
   * @param {number} start  - raw start offset (inclusive)
   * @param {number} end    - raw end offset (exclusive)
   * @returns {{ start: number, end: number }}
   */
  _snapToWordBoundary(text, start, end) {
    const wordChar = /\w/

    // Expand start left while the character to the left of start is a word char
    let s = start
    while (s > 0 && wordChar.test(text[s - 1])) {
      s--
    }

    // Expand end right while the character at end is a word char
    let e = end
    while (e < text.length && wordChar.test(text[e])) {
      e++
    }

    // Trim trailing whitespace from the expanded end
    while (e > s && /\s/.test(text[e - 1])) {
      e--
    }

    // Trim leading whitespace from the expanded start
    while (s < e && /\s/.test(text[s])) {
      s++
    }

    return { start: s, end: e }
  }

  /**
   * Determine whether all issues carry a valid `ref` field AND at least one
   * improvement also carries a `ref` field.  Both conditions must be true for
   * ref-based matching to be used; otherwise the code falls back to
   * index-based pairing (Approach 2 behaviour — no improvements are dropped).
   *
   * @param {Array} issues
   * @param {Array} improvements
   * @returns {boolean}
   */
  _hasRefFields(issues, improvements) {
    if (issues.length === 0) {
      return false
    }
    const allIssuesHaveRef = issues.every(
      (i) => i.ref !== undefined && !Number.isNaN(i.ref)
    )
    const anyImprovementHasRef = improvements.some(
      (imp) => imp.ref !== undefined && !Number.isNaN(imp.ref)
    )
    return allIssuesHaveRef && anyImprovementHasRef
  }

  /**
   * Build a ref → improvement lookup map from the improvements array.
   * Only the first improvement for each ref value is kept (duplicates ignored).
   * Returns an empty Map when not using ref-based matching.
   * @param {Array}   improvements
   * @param {boolean} useRefMatching
   * @returns {Map}
   */
  _buildRefMap(improvements, useRefMatching) {
    const refMap = new Map()
    if (!useRefMatching) {
      return refMap
    }
    for (const imp of improvements) {
      if (imp.ref !== undefined && !refMap.has(imp.ref)) {
        refMap.set(imp.ref, imp)
      }
    }
    return refMap
  }

  /**
   * Map issues to (snapped-offset issue, improvement) pairs, filter invalid
   * spans, then sort by ascending absStart.
   * @param {string}  canonicalText
   * @param {Array}   issues
   * @param {Array}   improvements
   * @param {boolean} useRefMatching
   * @param {Map}     refMap
   * @returns {Array}
   */
  _buildPairs(canonicalText, issues, improvements, useRefMatching, refMap) {
    return issues
      .map((issue, idx) => {
        const snapped = this._snapToWordBoundary(
          canonicalText,
          issue.absStart ?? 0,
          issue.absEnd ?? 0
        )
        const improvement = useRefMatching
          ? refMap.get(issue.ref) || null
          : improvements[idx] || null
        return {
          issue: { ...issue, absStart: snapped.start, absEnd: snapped.end },
          improvement,
          originalIdx: idx
        }
      })
      .filter(({ issue }) => {
        const { absStart, absEnd } = issue
        return (
          typeof absStart === 'number' &&
          typeof absEnd === 'number' &&
          absStart >= 0 &&
          absEnd > absStart &&
          absEnd <= canonicalText.length
        )
      })
      .sort((a, b) => a.issue.absStart - b.issue.absStart)
  }

  /**
   * Remove overlapping issue spans from a sorted pairs array.
   * Earlier spans take precedence; later overlapping spans are dropped.
   * @param {Array} sortedPairs
   * @returns {Array}
   */
  _dedupeOverlaps(sortedPairs) {
    const deduped = []
    let cursor = 0
    for (const pair of sortedPairs) {
      if (pair.issue.absStart < cursor) {
        logger.warn(
          {
            absStart: pair.issue.absStart,
            absEnd: pair.issue.absEnd,
            cursor,
            originalIdx: pair.originalIdx,
            ref: pair.issue.ref
          },
          '[result-envelope] Dropping overlapping issue span'
        )
        continue
      }
      deduped.push(pair)
      cursor = pair.issue.absEnd
    }
    return deduped
  }

  /**
   * Return true when an improvement is displayable: it must have a non-empty
   * suggested rewrite that differs from its current text, and its issue title
   * must not be the generic "Issue identified" fallback.
   * @param {Object|null} improvement
   * @returns {boolean}
   */
  _isValidImprovement(improvement) {
    if (!improvement) {
      return false
    }
    const hasSuggested =
      improvement.suggested && improvement.suggested.trim().length > 0
    const hasRealTitle =
      improvement.issue &&
      improvement.issue.trim().toLowerCase() !== 'issue identified'
    return hasSuggested && hasRealTitle
  }

  /**
   * Build sortedIssues and sortedImprovements from deduplicated pairs.
   *
   * Only pairs with a valid improvement (non-empty suggested text, non-generic
   * title) are included — this enforces strict 1:1 mapping between highlighted
   * spans and improvement cards.  Pairs with an invalid improvement and
   * improvements without a paired highlight (unmatched) are both discarded so
   * no orphan highlight or orphan improvement card ever appears.
   *
   * @param {Array}   deduped
   * @param {Array}   improvements
   * @param {boolean} useRefMatching
   * @returns {{ sortedIssues: Array, sortedImprovements: Array }}
   */
  _buildSortedResults(deduped, improvements, useRefMatching) {
    // Keep only pairs that have a displayable improvement
    const validPairs = deduped.filter((pair) =>
      this._isValidImprovement(pair.improvement)
    )

    const droppedCount = deduped.length - validPairs.length
    if (droppedCount > 0) {
      logger.warn(
        { droppedCount },
        '[result-envelope] Dropped pairs with invalid/missing improvements (no highlight or improvement card will appear)'
      )
    }

    const sortedIssues = validPairs.map((pair, seqIdx) => ({
      ...pair.issue,
      chunkIdx: seqIdx
    }))

    const sortedImprovements = validPairs.map((pair, seqIdx) => ({
      ...pair.improvement,
      issueId: sortedIssues[seqIdx].issueId
    }))

    // Count and log unmatched improvements that are silently discarded
    const matchedRefs = new Set(
      validPairs
        .filter((p) => p.improvement !== null)
        .map((p) =>
          useRefMatching ? p.issue.ref : improvements.indexOf(p.improvement)
        )
    )
    const unmatchedCount = useRefMatching
      ? improvements.filter(
          (imp) => imp.ref !== undefined && !matchedRefs.has(imp.ref)
        ).length
      : Math.max(0, improvements.length - deduped.length)

    if (unmatchedCount > 0) {
      logger.warn(
        { unmatchedCount, useRefMatching },
        '[result-envelope] Unmatched improvements discarded (no corresponding highlight in text)'
      )
    }

    return { sortedIssues, sortedImprovements }
  }

  /**
   * Sort and align issues with their paired improvements using ref-based
   * matching (primary) or index-based pairing (fallback).
   *
   * PRIMARY PATH — ref-based matching (Approach 3):
   *   Used when every issue carries a `ref` field and at least one improvement
   *   also carries a `ref` field.  Issues are linked to improvements by ref
   *   value, not array position.  Unmatched improvements are appended without
   *   a highlight so they are never silently dropped.
   *
   * FALLBACK PATH — index-based pairing (Approach 2):
   *   Used when ref fields are absent.  Excess improvements beyond the issue
   *   count are appended without highlights rather than silently dropped.
   *
   * @param {string} canonicalText
   * @param {Array}  issues        - spec issue objects from _mapIssue
   * @param {Array}  improvements  - spec improvement objects from _mapImprovement
   * @returns {{ sortedIssues: Array, sortedImprovements: Array }}
   */
  _sortAndAlignPairs(canonicalText, issues, improvements) {
    const useRefMatching = this._hasRefFields(issues, improvements)

    logger.info(
      {
        useRefMatching,
        issueCount: issues.length,
        improvementCount: improvements.length
      },
      `[result-envelope] Pairing strategy: ${useRefMatching ? 'ref-based' : 'index-based (fallback)'}`
    )

    const refMap = this._buildRefMap(improvements, useRefMatching)
    const pairs = this._buildPairs(
      canonicalText,
      issues,
      improvements,
      useRefMatching,
      refMap
    )
    const deduped = this._dedupeOverlaps(pairs)
    return this._buildSortedResults(deduped, improvements, useRefMatching)
  }

  /**
   * Split the canonical text into a sequence of plain and highlighted spans
   * based on the issue offsets.  Issues MUST already be sorted by absStart
   * and free of overlaps (i.e. produced by _sortAndAlignPairs).
   *
   * Each span:
   *   { text: string, issueIdx: number|null, category: string|null }
   *
   * issueIdx is the sequential 0-based index into both issues[] AND
   * improvements[] — guaranteed 1:1 because _sortAndAlignPairs produced them.
   *
   * @param {string} canonicalText
   * @param {Array}  sortedIssues  - already-sorted, deduped spec issue objects
   * @returns {Array}
   */
  _buildAnnotatedSections(canonicalText, sortedIssues) {
    if (!canonicalText) {
      return []
    }

    const sections = []
    let cursor = 0

    for (let seqIdx = 0; seqIdx < sortedIssues.length; seqIdx++) {
      const { absStart, absEnd, category } = sortedIssues[seqIdx]

      // Plain text before this issue
      if (absStart > cursor) {
        sections.push({
          text: canonicalText.slice(cursor, absStart),
          issueIdx: null,
          category: null
        })
      }

      // Highlighted span — issueIdx is the sequential index into issues[] and improvements[]
      sections.push({
        text: canonicalText.slice(absStart, absEnd),
        issueIdx: seqIdx,
        category
      })

      cursor = absEnd
    }

    // Remaining plain text after the last issue
    if (cursor < canonicalText.length) {
      sections.push({
        text: canonicalText.slice(cursor),
        issueIdx: null,
        category: null
      })
    }

    return sections
  }

  /**
   * Derive the flat 0-100 scores object from Bedrock's scored map.
   *
   * Maps all five Bedrock scoring categories into the four canonical score
   * keys stored in the envelope.  Notes are preserved so the frontend
   * scorecard can display the model's brief explanation alongside each score.
   *
   * Bedrock categories → envelope keys:
   *   "plain english"              → plainEnglish
   *   "clarity & structure"        → clarity
   *   "accessibility"              → accessibility
   *   "govuk style compliance"     → govukStyle
   *   "content completeness"       → completeness
   *
   * The legacy three-key schema (accessibility / style / tone) is also
   * populated for backwards compatibility with older frontend builds.
   *
   * @param {Object} rawScores  e.g. { "Plain English": { score: 3, note: "..." } }
   * @returns {Object}
   */
  _mapScores(rawScores) {
    const scoreMap = {} // lowercase key → { value: 0-100, note: string }

    for (const [key, val] of Object.entries(rawScores || {})) {
      const lk = key.toLowerCase()
      scoreMap[lk] = {
        value: Math.round((val.score || 0) * SCORE_SCALE_FACTOR),
        note: val.note || ''
      }
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
    const clarity = pick(['clarity & structure', 'clarity', 'structure'])
    const accessibility = pick(['accessibility', 'accessible'])
    const govukStyle = pick([
      'gov.uk style compliance',
      'govuk style compliance',
      'govuk style',
      'style',
      'formatting'
    ])
    const completeness = pick(['content completeness', 'completeness'])

    // Compute overall from the five categories (average of non-zero values)
    const all = [plainEnglish, clarity, accessibility, govukStyle, completeness]
    const nonZero = all.filter((s) => s.value > 0)
    const overallValue =
      nonZero.length > 0
        ? Math.round(
            nonZero.reduce((sum, s) => sum + s.value, 0) / nonZero.length
          )
        : 0

    return {
      // Canonical five-category schema
      plainEnglish: plainEnglish.value,
      plainEnglishNote: plainEnglish.note,
      clarity: clarity.value,
      clarityNote: clarity.note,
      accessibility: accessibility.value,
      accessibilityNote: accessibility.note,
      govukStyle: govukStyle.value,
      govukStyleNote: govukStyle.note,
      completeness: completeness.value,
      completenessNote: completeness.note,
      overall: overallValue,
      // Legacy three-key schema (backwards compatibility)
      style: govukStyle.value,
      tone: clarity.value
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Build the full result envelope from the parsed Bedrock output.
   *
   * This is the definitive merge of:
   *   canonicalText        (from documents/{reviewId}.json)
   *   positions offsets    (from positions/{reviewId}.json, already merged into
   *                         parsedReview.reviewedContent.issues)
   *   improvements         (from parsedReview.improvements)
   *   scores               (from parsedReview.scores)
   *
   * @param {string} reviewId
   * @param {Object} parsedReview   - { scores, reviewedContent, improvements }
   * @param {Object} bedrockUsage   - { totalTokens, inputTokens, outputTokens }
   * @param {string} canonicalText  - normalised full text from documents/{reviewId}.json
   * @param {string} [status]       - defaults to "completed"
   * @returns {Object} spec-compliant envelope
   */
  buildEnvelope(
    reviewId,
    parsedReview,
    bedrockUsage,
    canonicalText,
    status = 'completed'
  ) {
    const {
      scores = {},
      reviewedContent = {},
      improvements: parsedImprovements = []
    } = parsedReview

    const rawIssues = reviewedContent.issues || []

    // Step 1: Build preliminary spec issue objects (original AI order).
    // Pre-pair each rawIssue with its corresponding parsedImprovement (by ref
    // first, index fallback) so that _mapIssue can use improvement.current as
    // a fallback text for position resolution.  The definitive pairing is still
    // performed by _sortAndAlignPairs — this early pairing is only for
    // position resolution.
    const improvByRef = new Map()
    for (const imp of parsedImprovements) {
      if (imp.ref !== undefined && !improvByRef.has(imp.ref)) {
        improvByRef.set(imp.ref, imp)
      }
    }

    const prelimIssues = rawIssues.map((rawIssue, idx) => {
      const pairedImp =
        rawIssue.ref === undefined
          ? (parsedImprovements[idx] ?? null)
          : (improvByRef.get(rawIssue.ref) ?? parsedImprovements[idx] ?? null)
      return this._mapIssue(rawIssue, pairedImp, idx, canonicalText)
    })

    // Build improvement objects independently — all improvements are preserved
    // at this stage; none are discarded due to array length mismatch.
    const prelimImprovements = parsedImprovements.map((parsedImprovement) =>
      this._mapImprovement(parsedImprovement, `issue-orphan-${randomUUID()}`)
    )

    // Step 2: Sort both arrays together by text position, deduplicate overlaps,
    // and re-index sequentially — this guarantees strict 1:1 alignment between
    // the highlighted spans in annotatedSections and the improvements list.
    const { sortedIssues, sortedImprovements } = canonicalText
      ? this._sortAndAlignPairs(canonicalText, prelimIssues, prelimImprovements)
      : { sortedIssues: prelimIssues, sortedImprovements: prelimImprovements }

    // Step 3: Build annotated sections using the sorted, re-indexed issues
    const annotatedSections = this._buildAnnotatedSections(
      canonicalText,
      sortedIssues
    )

    const mappedScores = this._mapScores(scores)

    logger.info(
      {
        reviewId,
        rawIssueCount: rawIssues.length,
        rawImprovementCount: parsedImprovements.length,
        alignedIssueCount: sortedIssues.length,
        alignedImprovementCount: sortedImprovements.length,
        unmatchedImprovements: sortedImprovements.filter((i) => i.unmatched)
          .length,
        sectionCount: annotatedSections.length,
        scoreKeys: Object.keys(scores)
      },
      '[result-envelope] Envelope built — issues and improvements are 1:1 aligned'
    )

    return {
      documentId: reviewId,
      status,
      processedAt: new Date().toISOString(),
      tokenUsed: bedrockUsage?.totalTokens ?? 0,
      issueCount: sortedIssues.length,
      canonicalText: canonicalText || '',
      annotatedSections,
      issues: sortedIssues,
      improvements: sortedImprovements,
      scores: mappedScores
    }
  }

  /**
   * Build an in-progress stub envelope.
   *
   * @param {string} reviewId
   * @param {string} status  - "pending" | "processing" | "failed"
   * @returns {Object}
   */
  buildStubEnvelope(reviewId, status) {
    return {
      documentId: reviewId,
      status,
      processedAt: null,
      tokenUsed: 0,
      issueCount: 0,
      canonicalText: '',
      annotatedSections: [],
      issues: [],
      improvements: [],
      scores: {
        plainEnglish: 0,
        plainEnglishNote: '',
        clarity: 0,
        clarityNote: '',
        accessibility: 0,
        accessibilityNote: '',
        govukStyle: 0,
        govukStyleNote: '',
        completeness: 0,
        completenessNote: '',
        overall: 0,
        style: 0,
        tone: 0
      }
    }
  }
}

export const resultEnvelopeStore = new ResultEnvelopeStore()
