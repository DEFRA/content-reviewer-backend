import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'
import { DEFAULT_SYSTEM_PROMPT } from './default-system-prompt.js'

// Re-export so existing consumers that import DEFAULT_SYSTEM_PROMPT from here
// continue to work without changes.
export { DEFAULT_SYSTEM_PROMPT } from './default-system-prompt.js'

const logger = createLogger()

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

      // Auto-sync: if S3 content differs from the embedded default, upload the
      // embedded version so that S3 stays in step with the deployed code.
      if (promptText !== DEFAULT_SYSTEM_PROMPT) {
        logger.info(
          {
            s3Length: promptText.length,
            embeddedLength: DEFAULT_SYSTEM_PROMPT.length
          },
          'S3 prompt differs from embedded default — auto-syncing S3'
        )
        await this.uploadPrompt() // uploads DEFAULT_SYSTEM_PROMPT and calls clearCache()
        // Repopulate cache so the next call doesn't trigger another S3 round-trip
        this.cache = DEFAULT_SYSTEM_PROMPT
        this.cacheTimestamp = Date.now()
        return DEFAULT_SYSTEM_PROMPT
      }

      // S3 matches embedded — cache and return
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
        'Failed to load system prompt from S3 — attempting to seed S3 with embedded default'
      )

      // Best-effort: push the embedded default to S3 so future requests succeed.
      // Do not await — if S3 is genuinely unavailable this will also fail, and
      // we still want to return the embedded prompt without delaying the review.
      this.uploadPrompt().catch((uploadError) => {
        logger.warn(
          { error: uploadError.message },
          'Auto-seed of S3 prompt also failed — will retry on next cache miss'
        )
      })

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

// Export class for testing
export { PromptManager }
