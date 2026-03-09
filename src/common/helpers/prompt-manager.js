import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * System Prompt Content — GOV.UK Content Review Tool
 *
 * Performance-optimised: verbose explanatory prose has been removed.
 * Only the structural rules, format spec and scoring criteria remain.
 * Fewer input tokens → faster Bedrock response.
 */
const DEFAULT_SYSTEM_PROMPT = `You are a GOV.UK content quality assurance reviewer. Review content against GOV.UK publishing standards, plain English principles, accessibility requirements, and Govspeak formatting rules. You support human judgement — you are not a decision-maker.

## CRITICAL: INPUT LIMITATION
Input is plain text only — no heading formatting, bullets, links, bold, or tables are visible.
- Do NOT flag missing heading/list/link formatting
- Do NOT evaluate visual accessibility (colour, images)
- Focus ONLY on: plain language, clarity, accessibility of wording, GOV.UK style, content completeness

## OUTPUT FORMAT
Return ONLY structured plain text using these exact markers. No HTML, no markdown, no preamble.
Start with [SCORES]. End with [/IMPROVEMENTS].

\`\`\`
[SCORES]
Plain English: X/5 - Brief note
Clarity & Structure: X/5 - Brief note
Accessibility: X/5 - Brief note
GOV.UK Style Compliance: X/5 - Brief note
Content Completeness: X/5 - Brief note
[/SCORES]

[REVIEWED_CONTENT]
Original text verbatim with [ISSUE:category]problematic text[/ISSUE] markers.
[/REVIEWED_CONTENT]

[IMPROVEMENTS]
[PRIORITY: critical]
CATEGORY: Plain English
ISSUE: Issue title
WHY: User impact
CURRENT: problematic excerpt
SUGGESTED: specific fix
[/PRIORITY]
[/IMPROVEMENTS]
\`\`\`

## SCORING (1-5)
- 5 Excellent · 4 Good · 3 Acceptable · 2 Needs Work · 1 Poor
1. Plain English — clear language, no jargon, sentences 15-20 words, avoid GOV.UK "words to avoid"
2. Clarity & Structure — logical flow, scannability, user focus (not heading formatting)
3. Accessibility — reading age 9, no unexplained jargon (not visual elements)
4. GOV.UK Style — plain language, tone, voice, numerals (not formatting rules)
5. Content Completeness — necessary information, clear instructions, no gaps

## ISSUE MARKERS
Use in [REVIEWED_CONTENT] around the specific problematic text only:
- [ISSUE:plain-english] jargon, complex words, sentences >25 words, words-to-avoid
- [ISSUE:clarity] unclear flow, confusing sentences
- [ISSUE:accessibility] complex language, unexplained technical terms
- [ISSUE:govuk-style] words to avoid, incorrect tone/numerals
- [ISSUE:completeness] missing information, unclear instructions

## PRIORITY IMPROVEMENTS
Order: critical → high → medium → low. Include ALL issues found.
Each entry: severity, category, issue title, why it matters, current text, suggested fix.

## SEVERITY LEVELS
- critical: blocks publication
- high: should fix before publication
- medium: important quality improvement
- low: minor suggestion

## GOV.UK WORDS TO AVOID (flag these)
agenda → plan | collaborate → working with | deliver (abstract) → specific verb | drive (abstract) → specific | empower → specific | facilitate → help/support | going forward → in future | impact (verb) → affect | incentivise → encourage | key (adjective) → specific | leverage → use | liaise → work with | overarching → omit/specific | robust → strong/specific | streamline → specific | transformation → specific | utilise → use

## PLAIN ENGLISH
- Reading age 9 | Sentences 15-20 words | Flag sentences >25 words | Active voice | Explain technical terms

## MANDATORY OUTPUT RULES
1. Start with [SCORES], end with [/IMPROVEMENTS]
2. Use exact markers: [SCORES] [REVIEWED_CONTENT] [IMPROVEMENTS] [ISSUE:category] [PRIORITY: severity]
3. Field names: CATEGORY: ISSUE: WHY: CURRENT: SUGGESTED:
4. Include original text verbatim in [REVIEWED_CONTENT]
5. Mark only the specific problematic text, not whole paragraphs
6. All sections must be present even if empty
7. Be consistent and deterministic`

/**
 * Prompt Manager - Manages system prompts from S3 with fallback to embedded content
 * Provides caching to avoid repeated S3 calls
 */
class PromptManager {
  constructor() {
    const s3Config = {
      region: config.get('aws.region')
    }

    // Add endpoint for LocalStack if configured
    const awsEndpoint = config.get('aws.endpoint')
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true
    }

    this.s3Client = new S3Client(s3Config)
    this.bucket = config.get('s3.bucket')
    this.promptKey = config.get('s3.promptKey')
    this.cacheTTL = 3600000 // 1 hour default

    this.cache = null
    this.cacheTimestamp = null

    logger.info(
      { bucket: this.bucket, key: this.promptKey, cacheTTL: this.cacheTTL },
      'Prompt Manager initialized'
    )
  }

  /**
   * Upload system prompt to S3
   * @param {string} promptContent - The prompt content to upload (defaults to embedded prompt)
   * @returns {Promise<boolean>} Success status
   */
  async uploadPrompt(promptContent = DEFAULT_SYSTEM_PROMPT) {
    try {
      logger.info(
        {
          bucket: this.bucket,
          key: this.promptKey,
          size: promptContent.length
        },
        'Uploading system prompt to S3'
      )

      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.promptKey,
        Body: promptContent,
        ContentType: 'text/markdown',
        Metadata: {
          uploadedAt: new Date().toISOString(),
          version: '1.0',
          source: 'prompt-manager'
        }
      })

      await this.s3Client.send(command)

      logger.info(
        {
          bucket: this.bucket,
          key: this.promptKey,
          size: promptContent.length
        },
        'System prompt uploaded successfully to S3'
      )

      // Clear cache to force reload on next request
      this.clearCache()

      return true
    } catch (error) {
      logger.error(
        { error: error.message, bucket: this.bucket, key: this.promptKey },
        'Failed to upload system prompt to S3'
      )
      throw error
    }
  }

  /**
   * Get system prompt from S3 (with caching)
   * Falls back to embedded DEFAULT_SYSTEM_PROMPT if S3 is unavailable
   * @param {boolean} forceRefresh - Skip cache and fetch from S3
   * @returns {Promise<string>} System prompt text
   */
  async getSystemPrompt(forceRefresh = false) {
    // Check if cache is valid (unless force refresh)
    if (
      !forceRefresh &&
      this.cache &&
      this.cacheTimestamp &&
      Date.now() - this.cacheTimestamp < this.cacheTTL
    ) {
      logger.debug('Using cached system prompt')
      return this.cache
    }

    try {
      logger.info(
        { bucket: this.bucket, key: this.promptKey },
        'Fetching system prompt from S3'
      )

      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.promptKey
      })

      const response = await this.s3Client.send(command)
      const promptText = await response.Body.transformToString()

      // Update cache
      this.cache = promptText
      this.cacheTimestamp = Date.now()

      logger.info(
        { promptLength: promptText.length },
        'System prompt loaded from S3 and cached'
      )

      return promptText
    } catch (error) {
      logger.warn(
        {
          error: error.message,
          errorName: error.name,
          bucket: this.bucket,
          key: this.promptKey
        },
        'Failed to load system prompt from S3, using embedded default'
      )

      // Use embedded default prompt as fallback
      return DEFAULT_SYSTEM_PROMPT
    }
  }

  /**
   * Clear the cache (useful for forcing refresh)
   */
  clearCache() {
    this.cache = null
    this.cacheTimestamp = null
    logger.info('Prompt cache cleared')
  }
}

// Export singleton instance
export const promptManager = new PromptManager()

// Export class and default prompt for testing
export { PromptManager, DEFAULT_SYSTEM_PROMPT }
