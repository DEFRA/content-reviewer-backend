import { randomUUID } from 'node:crypto'
import { createLogger } from './logging/logger.js'
import {
  mapIssue,
  mapImprovement,
  snapToWordBoundary,
  normalizeCategoryDisplay,
  sortAndAlignPairs
} from './result-envelope-issue-mappers.js'
import {
  findNearestOccurrence,
  resolveIssuePosition
} from './result-envelope-position-resolver.js'
import {
  buildAnnotatedSections,
  mapScores
} from './result-envelope-sections.js'

const logger = createLogger()

/**
 * Build preliminary issue/improvement pairs from raw LLM output.
 * Pre-pairs each rawIssue with its corresponding parsedImprovement (by ref
 * first, index fallback) so mapIssue can use improvement.current as a
 * fallback text for position resolution.
 */
function buildPrelimPairs(
  rawIssues,
  parsedImprovements,
  canonicalText,
  sourceMap
) {
  // When the LLM returns no reviewedContent.issues (improvements-only response),
  // synthesize a placeholder raw issue for each improvement that has a non-empty
  // `current` field so resolveIssuePosition can locate it via text search.
  // Improvements with an empty `current` are skipped and will be discarded.
  const effectiveRawIssues =
    rawIssues.length > 0
      ? rawIssues
      : parsedImprovements
          .filter((imp) => imp.current && imp.current.trim().length > 0)
          .map((imp, idx) => ({
            start: 0,
            end: 0,
            text: imp.current,
            ref: imp.ref !== undefined ? imp.ref : idx
          }))

  const improvByRef = new Map()
  for (const imp of parsedImprovements) {
    if (imp.ref !== undefined && !improvByRef.has(imp.ref)) {
      improvByRef.set(imp.ref, imp)
    }
  }

  const prelimIssues = effectiveRawIssues.map((rawIssue, idx) => {
    const pairedImp =
      rawIssue.ref === undefined
        ? (parsedImprovements[idx] ?? null)
        : (improvByRef.get(rawIssue.ref) ?? parsedImprovements[idx] ?? null)
    return mapIssue(rawIssue, pairedImp, idx, canonicalText, sourceMap)
  })

  const prelimImprovements = parsedImprovements.map((parsedImprovement) =>
    mapImprovement(parsedImprovement, `issue-orphan-${randomUUID()}`)
  )

  return { prelimIssues, prelimImprovements }
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
 *   issueCount:        number   - total improvements found and located
 *   canonicalText:     string   - full normalised text (user content)
 *   annotatedSections: Array    - canonical text split into plain/highlighted spans:
 *     [{ text: string, issueIdx: number|null, category: string|null }]
 *     issueIdx is the 0-based index into improvements[] for highlighted spans.
 *   improvements: [
 *     {
 *       issueId:   string  - uuid
 *       issueIdx:  number  - 0-based index, matches annotatedSections issueIdx
 *       severity:  string  - e.g. "high"
 *       category:  string  - display name, e.g. "Plain English"
 *       issue:     string  - short title
 *       why:       string  - explanation
 *       current:   string  - exact problematic text found in document
 *       suggested: string  - replacement text
 *       start:     number  - resolved char offset in canonicalText
 *       end:       number  - resolved char offset in canonicalText (exclusive)
 *       ref:       number  - 1-based ref from LLM output
 *     }
 *   ],
 *   scores: {
 *     plainEnglish: number,   (1-5)
 *     plainEnglishNote: string,
 *     govukStyle: number,
 *     govukStyleNote: string
 *   }
 * }
 */
class ResultEnvelopeStore {
  // ─── Delegate methods (preserve test API) ─────────────────────────────────

  _mapScores(rawScores) {
    return mapScores(rawScores)
  }
  _findNearestOccurrence(searchText, canonicalText, hintMid) {
    return findNearestOccurrence(searchText, canonicalText, hintMid)
  }
  _resolveIssuePosition(
    start,
    end,
    issueText,
    canonicalText,
    fallbackText,
    sourceMap = null
  ) {
    return resolveIssuePosition(
      start,
      end,
      issueText,
      canonicalText,
      fallbackText,
      sourceMap
    )
  }
  _snapToWordBoundary(text, start, end) {
    return snapToWordBoundary(text, start, end)
  }
  _buildAnnotatedSections(canonicalText, sortedImprovements, linkMap) {
    return buildAnnotatedSections(canonicalText, sortedImprovements, linkMap)
  }
  _sortAndAlignPairs(canonicalText, issues, improvements) {
    return sortAndAlignPairs(canonicalText, issues, improvements)
  }

  /**
   * Build the full result envelope from the parsed Bedrock output.
   *
   * Improvements are the single source of truth — derived directly from the
   * LLM [IMPROVEMENTS] block. Character offsets are corrected by locating the
   * CURRENT text in the document, overriding any hallucinated START/END values
   * from the model.
   *
   * @param {string}     reviewId
   * @param {Object}     parsedReview   - { scores, improvements }
   * @param {Object}     bedrockUsage   - { totalTokens, inputTokens, outputTokens }
   * @param {string}     canonicalText  - normalised full text from documents/{reviewId}.json
   * @param {string}     [status]       - defaults to "completed"
   * @param {Array|null} [linkMap]      - array of { start, end, display } entries for URL
   *                                      sources; null for file/text sources without links.
   * @param {Array|null} [sourceMap]    - per-line offset entries from the canonical document;
   *                                      used to resolve imprecise LLM offsets via normalised
   *                                      line-region search.
   * @returns {Object} spec-compliant envelope
   */
  buildEnvelope(
    reviewId,
    parsedReview,
    bedrockUsage,
    canonicalText,
    status = 'completed',
    linkMap = null,
    sourceMap = null
  ) {
    const {
      scores = {},
      reviewedContent = {},
      improvements: parsedImprovements = []
    } = parsedReview

    const rawIssues = reviewedContent.issues || []

    // Step 1: Build preliminary spec issue objects (original AI order),
    // pre-paired with their corresponding improvements for position resolution.
    const { prelimIssues, prelimImprovements } = buildPrelimPairs(
      rawIssues,
      parsedImprovements,
      canonicalText,
      sourceMap
    )

    // Step 2: Sort both arrays together by text position, deduplicate overlaps,
    // and re-index sequentially.
    const { sortedImprovements } = canonicalText
      ? sortAndAlignPairs(canonicalText, prelimIssues, prelimImprovements)
      : { sortedImprovements: prelimImprovements }

    // Step 3: Build annotated sections using the sorted, re-indexed issues
    const annotatedSections = buildAnnotatedSections(
      canonicalText,
      sortedImprovements,
      linkMap
    )

    const mappedScores = mapScores(scores)

    logger.info(
      {
        reviewId,
        improvementCount: sortedImprovements.length,
        sectionCount: annotatedSections.length,
        scoreKeys: Object.keys(scores)
      },
      '[result-envelope] Envelope built — improvements are single source of truth'
    )

    return {
      documentId: reviewId,
      status,
      processedAt: new Date().toISOString(),
      tokenUsed: bedrockUsage?.totalTokens ?? 0,
      issueCount: sortedImprovements.length,
      canonicalText: canonicalText || '',
      annotatedSections,
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
      improvements: [],
      scores: {
        plainEnglish: 0,
        plainEnglishNote: '',
        govukStyle: 0,
        govukStyleNote: ''
      }
    }
  }
}

export const resultEnvelopeStore = new ResultEnvelopeStore()
