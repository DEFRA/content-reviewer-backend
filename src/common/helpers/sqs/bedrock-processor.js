import { createLogger } from '../logging/logger.js'
import { bedrockClient } from '../bedrock-client.js'
import { promptManager } from '../prompt-manager.js'
import { parseBedrockResponse } from '../review-parser.js'

const logger = createLogger()

/**
 * Bedrock Review Processor - handles AI review processing
 */
export class BedrockReviewProcessor {
  /**
   * Load system prompt from S3
   */
  async loadSystemPrompt(reviewId) {
    const promptLoadStartTime = performance.now()
    const systemPrompt = await promptManager.getSystemPrompt()
    const promptLoadDuration = Math.round(
      performance.now() - promptLoadStartTime
    )

    logger.info(
      {
        reviewId,
        systemPromptLength: systemPrompt.length,
        durationMs: promptLoadDuration
      },
      `System prompt loaded from S3 in ${promptLoadDuration}ms | ReviewId: ${reviewId} | Length: ${systemPrompt.length} chars`
    )

    return { systemPrompt, promptLoadDuration }
  }

  /**
   * Send request to Bedrock AI.
   *
   * Performance improvement: the system prompt is now passed via the native
   * Converse API `system` field instead of as fake user/assistant turns.
   * This eliminates the ~2-turn overhead and reduces input token count.
   * An empty conversationHistory is used for single-shot reviews.
   */
  async sendBedrockRequest(reviewId, userPrompt, systemPrompt) {
    const bedrockStartTime = performance.now()

    logger.info(
      {
        reviewId,
        userPromptLength: userPrompt.length,
        systemPromptLength: systemPrompt.length
      },
      '[BEDROCK] Sending request to Bedrock AI - START'
    )

    // Pass systemPrompt via the dedicated parameter; no fake conversation turns.
    const bedrockResponse = await bedrockClient.sendMessage(
      userPrompt,
      [], // empty history – single-shot review
      systemPrompt
    )

    const bedrockDuration = Math.round(performance.now() - bedrockStartTime)

    if (!bedrockResponse.success) {
      logger.error(
        {
          reviewId,
          blocked: bedrockResponse.blocked,
          reason: bedrockResponse.reason,
          durationMs: bedrockDuration
        },
        `[BEDROCK] AI review FAILED after ${bedrockDuration}ms`
      )

      throw new Error(
        bedrockResponse.blocked
          ? 'Content blocked by guardrails'
          : 'Bedrock review failed'
      )
    }

    logger.info(
      {
        reviewId,
        responseLength: bedrockResponse.content.length,
        inputTokens: bedrockResponse.usage?.inputTokens,
        outputTokens: bedrockResponse.usage?.outputTokens,
        totalTokens: bedrockResponse.usage?.totalTokens,
        durationMs: bedrockDuration
      },
      `[BEDROCK] AI review COMPLETED successfully in ${bedrockDuration}ms (Tokens: ${bedrockResponse.usage?.inputTokens}→${bedrockResponse.usage?.outputTokens})`
    )

    return { bedrockResponse, bedrockDuration }
  }

  /**
   * Perform Bedrock AI review.
   *
   * Performance: the user prompt is kept concise – verbose preamble text
   * ('Please review the following content...') adds input tokens without
   * improving output quality.  The system prompt already instructs the model
   * on exactly what to do, so the user turn only needs to supply the content.
   */
  async performBedrockReview(reviewId, textContent) {
    // Trim whitespace to avoid wasting tokens on leading/trailing blank lines
    const trimmedContent = textContent.trim()

    // Concise user prompt – the system prompt carries all the instructions
    const userPrompt = `Review the following content:\n\n${trimmedContent}`

    logger.info(
      {
        reviewId,
        promptLength: userPrompt.length,
        textContentLength: trimmedContent.length
      },
      `User prompt prepared for Bedrock AI review | ReviewId: ${reviewId} | Length: ${userPrompt.length} chars`
    )

    const { systemPrompt } = await this.loadSystemPrompt(reviewId)
    return this.sendBedrockRequest(reviewId, userPrompt, systemPrompt)
  }

  /**
   * Parse Bedrock response data
   */
  async parseBedrockResponseData(reviewId, bedrockResult) {
    const parseStart = performance.now()
    const finalReviewContent = bedrockResult.bedrockResponse.content
    // If reviewContent is available in bedrockResult, pass as fallback
    const fallbackRawResponse =
      bedrockResult.bedrockResponse.reviewContent || finalReviewContent
    const parsedReview = parseBedrockResponse(
      finalReviewContent,
      fallbackRawResponse
    )
    const parseDuration = Math.round(performance.now() - parseStart)

    logger.info(
      {
        reviewId,
        parsedScoreCount: Object.keys(parsedReview.scores || {}).length,
        parsedIssueCount: parsedReview.reviewedContent?.issues?.length || 0,
        parsedImprovementCount: parsedReview.improvements?.length || 0,
        hasParseError: !!parsedReview.parseError,
        durationMs: parseDuration
      },
      `Bedrock response parsed in ${parseDuration}ms`
    )

    return { parsedReview, parseDuration, finalReviewContent }
  }
}
