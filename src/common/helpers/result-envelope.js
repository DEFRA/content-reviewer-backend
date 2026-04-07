import { randomUUID } from 'node:crypto'
import { createLogger } from './logging/logger.js'
import {
  mapIssue,
  mapImprovement,
  sortAndAlignPairs,
  findNearestOccurrence,
  resolveIssuePosition,
  snapToWordBoundary,
  hasRefFields
} from './result-envelope-issue-mappers.js'
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
  // ─── Delegate methods (preserve test API) ─────────────────────────────────

  _mapScores(rawScores) {
    return mapScores(rawScores)
  }
  _hasRefFields(issues, improvements) {
    return hasRefFields(issues, improvements)
  }
  _findNearestOccurrence(searchText, canonicalText, hintMid) {
    return findNearestOccurrence(searchText, canonicalText, hintMid)
  }
  _resolveIssuePosition(start, end, issueText, canonicalText, fallbackText) {
    return resolveIssuePosition(
      start,
      end,
      issueText,
      canonicalText,
      fallbackText
    )
  }
  _snapToWordBoundary(text, start, end) {
    return snapToWordBoundary(text, start, end)
  }
  _buildAnnotatedSections(canonicalText, sortedIssues, linkMap) {
    return buildAnnotatedSections(canonicalText, sortedIssues, linkMap)
  }
  _sortAndAlignPairs(canonicalText, issues, improvements) {
    return sortAndAlignPairs(canonicalText, issues, improvements)
  }

  /**
   * Build the full result envelope from the parsed Bedrock output.
   *
   * @param {string}     reviewId
   * @param {Object}     parsedReview   - { scores, reviewedContent, improvements }
   * @param {Object}     bedrockUsage   - { totalTokens, inputTokens, outputTokens }
   * @param {string}     canonicalText  - normalised full text from documents/{reviewId}.json
   * @param {string}     [status]       - defaults to "completed"
   * @param {Array|null} [linkMap]      - array of { start, end, display } entries for URL
   *                                      sources; null for file/text sources without links.
   * @returns {Object} spec-compliant envelope
   */
  buildEnvelope(
    reviewId,
    parsedReview,
    bedrockUsage,
    canonicalText,
    status = 'completed',
    linkMap = null
  ) {
    const {
      scores = {},
      reviewedContent = {},
      improvements: parsedImprovements = []
    } = parsedReview

    const rawIssues = reviewedContent.issues || []

    // Step 1: Build preliminary spec issue objects (original AI order).
    // Pre-pair each rawIssue with its corresponding parsedImprovement (by ref
    // first, index fallback) so that mapIssue can use improvement.current as
    // a fallback text for position resolution.
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
      return mapIssue(rawIssue, pairedImp, idx, canonicalText)
    })

    const prelimImprovements = parsedImprovements.map((parsedImprovement) =>
      mapImprovement(parsedImprovement, `issue-orphan-${randomUUID()}`)
    )

    // Step 2: Sort both arrays together by text position, deduplicate overlaps,
    // and re-index sequentially.
    const { sortedIssues, sortedImprovements } = canonicalText
      ? sortAndAlignPairs(canonicalText, prelimIssues, prelimImprovements)
      : { sortedIssues: prelimIssues, sortedImprovements: prelimImprovements }

    // Step 3: Build annotated sections using the sorted, re-indexed issues
    const annotatedSections = buildAnnotatedSections(
      canonicalText,
      sortedIssues,
      linkMap
    )

    const mappedScores = mapScores(scores)

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
