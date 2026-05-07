import { randomUUID } from 'node:crypto'
import { createLogger } from './logging/logger.js'
import {
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
 *     clarity: number,
 *     clarityNote: string,
 *     accessibility: number,
 *     accessibilityNote: string,
 *     govukStyle: number,
 *     govukStyleNote: string,
 *     completeness: number,
 *     completenessNote: string
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
    const { scores = {}, improvements: parsedImprovements = [] } = parsedReview

    // Step 1: Resolve the true character position of each improvement's CURRENT
    // text. The LLM's START/END offsets are unreliable — resolveIssuePosition
    // uses CURRENT as ground truth and finds the nearest real occurrence in the
    // document, correcting any hallucinated offsets.
    const resolved = parsedImprovements
      .filter((imp) => imp.current && imp.suggested)
      .map((imp) => {
        const pos = canonicalText
          ? resolveIssuePosition(
              imp.start ?? 0,
              imp.end ?? 0,
              imp.current,
              canonicalText,
              imp.current,
              sourceMap
            )
          : { start: imp.start ?? 0, end: imp.end ?? 0 }

        const snapped = canonicalText
          ? snapToWordBoundary(canonicalText, pos.start, pos.end)
          : pos

        return { ...imp, start: snapped.start, end: snapped.end }
      })
      .filter(
        (imp) =>
          typeof imp.start === 'number' &&
          typeof imp.end === 'number' &&
          imp.start >= 0 &&
          imp.end > imp.start &&
          imp.end <= (canonicalText?.length ?? Infinity)
      )

    // Step 2: Sort by resolved start offset, dedupe overlapping spans (earlier wins)
    resolved.sort((a, b) => a.start - b.start)
    const deduped = []
    let cursor = 0
    for (const imp of resolved) {
      if (imp.start >= cursor) {
        deduped.push(imp)
        cursor = imp.end
      } else {
        logger.warn(
          { start: imp.start, end: imp.end, cursor, ref: imp.ref },
          '[result-envelope] Dropping overlapping improvement span'
        )
      }
    }

    // Step 3: Build final improvements array with issueIdx aligned 1:1 with
    // annotatedSections highlighted spans
    const sortedImprovements = deduped.map((imp, idx) => ({
      issueId: `issue-${randomUUID()}`,
      issueIdx: idx,
      severity: imp.severity || 'medium',
      category: normalizeCategoryDisplay(imp.category),
      issue: imp.issue || '',
      why: imp.why || '',
      current: imp.current || '',
      suggested: imp.suggested || '',
      start: imp.start,
      end: imp.end,
      ref: imp.ref
    }))

    // Step 4: Build annotated sections directly from sorted improvements
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
        clarity: 0,
        clarityNote: '',
        accessibility: 0,
        accessibilityNote: '',
        govukStyle: 0,
        govukStyleNote: '',
        completeness: 0,
        completenessNote: ''
      }
    }
  }
}

export const resultEnvelopeStore = new ResultEnvelopeStore()
