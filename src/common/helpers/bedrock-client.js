import {
  BedrockRuntimeClient,
  ConverseCommand
} from '@aws-sdk/client-bedrock-runtime'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

const ERROR_MESSAGES = {
  SERIALIZE_ERROR: 'Could not serialize full error'
}

// 360 seconds — large documents (100k chars) can take 3-5 min
const BEDROCK_TIMEOUT_MS = 360_000

/**
 * CDP-Compliant Bedrock Client
 *
 * This client follows CDP platform guidelines:
 * - Uses inference profile ARN (not direct model access)
 * - Enforces mandatory guardrail usage
 * - Uses the Converse API for simpler integration
 * - Automatically tracks costs via inference profile
 */
class BedrockClient {
  constructor() {
    if (!config.get('bedrock.enabled')) {
      logger.info('Bedrock AI is disabled')
      this.enabled = false
      return
    }

    this.enabled = true
    this.modelName = config.get('bedrock.modelName')
    this.inferenceProfileArn = config.get('bedrock.inferenceProfileArn')
    this.guardrailArn = config.get('bedrock.guardrailArn')
    this.guardrailVersion = config.get('bedrock.guardrailVersion')
    this.region = config.get('aws.region')
    this.maxTokens = config.get('bedrock.maxTokens')
    this.temperature = config.get('bedrock.temperature')
    this.topP = config.get('bedrock.topP')
    this.timeout = BEDROCK_TIMEOUT_MS

    this.client = new BedrockRuntimeClient({
      region: this.region,
      requestHandler: {
        requestTimeout: this.timeout
      }
    })

    //Log model name
    logger.info(`Bedrock client initialized with model: ${this.modelName}`, {
      inferenceProfileArn: this.inferenceProfileArn,
      guardrailArn: this.guardrailArn
    })

    // Log temperature to validate environment variable configuration
    logger.info(
      `Bedrock client initialized with CDP inference profile (temperature: ${this.temperature})`,
      {
        inferenceProfileArn: this.inferenceProfileArn,
        guardrailArn: this.guardrailArn,
        region: this.region,
        nodeEnv: process.env.NODE_ENV
      }
    )
  }

  /**
   * Extract error details from AWS SDK errors
   * @private
   */
  _extractErrorDetails(error) {
    const errorDetails = {
      name: error.name,
      message: error.message,
      code: error.code,
      statusCode: error.$metadata?.httpStatusCode,
      requestId: error.$metadata?.requestId,
      extendedRequestId: error.$metadata?.extendedRequestId,
      $fault: error.$fault,
      $service: error.$service,
      stack: error.stack
    }

    try {
      errorDetails.fullError = JSON.stringify(error)
    } catch (serializeError) {
      logger.warn(ERROR_MESSAGES.SERIALIZE_ERROR, {
        error: serializeError.message
      })
      errorDetails.serializationError = ERROR_MESSAGES.SERIALIZE_ERROR
    }

    return errorDetails
  }

  /**
   * Handle specific AWS error types
   * @private
   */
  _handleAwsError(error) {
    if (error.name === 'CredentialsProviderError') {
      logger.error('AWS Credential diagnostics', {
        awsProfile: process.env.AWS_PROFILE || 'none',
        hasAccessKeyId: !!process.env.AWS_ACCESS_KEY_ID,
        hasSecretAccessKey: !!process.env.AWS_SECRET_ACCESS_KEY,
        hasSessionToken: !!process.env.AWS_SESSION_TOKEN,
        nodeEnv: process.env.NODE_ENV,
        awsRegion: this.region
      })
      throw new Error(
        'AWS credentials not found. In CDP, ensure EC2 instance has IAM role with Bedrock permissions.'
      )
    }

    if (error.name === 'AccessDeniedException') {
      throw new Error(
        'Access denied to Bedrock. Ensure IAM role has bedrock:InvokeModel permission.'
      )
    }

    if (error.name === 'ResourceNotFoundException') {
      throw new Error(
        `Bedrock resource not found. Check inference profile ARN: ${this.inferenceProfileArn}`
      )
    }

    if (error.name === 'ThrottlingException') {
      throw new Error(
        'Bedrock API token quota exceeded (too many tokens per minute). Please try again later.'
      )
    }

    if (error.name === 'ValidationException') {
      throw new Error(`Bedrock validation error: ${error.message}`)
    }

    if (error.name === 'ServiceUnavailableException') {
      throw new Error('Bedrock service temporarily unavailable. Please retry.')
    }

    if (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT') {
      throw new Error(
        'Bedrock API request timed out. The request took too long to process.'
      )
    }

    throw new Error(`Bedrock API error: ${error.message}`)
  }

  /**
   * Extract per-policy detail from a single guardrail assessment object.
   * PII matched values are deliberately NOT logged — only the entity type
   * and action are recorded to avoid writing real PII to application logs.
   * @private
   */
  _extractAssessmentDetail(assessment, idx) {
    const detail = { assessmentIndex: idx }

    const contentFilters = assessment.contentPolicy?.filters ?? []
    if (contentFilters.length > 0) {
      detail.contentPolicy = contentFilters.map((f) => ({
        type: f.type,
        confidence: f.confidence,
        action: f.action
      }))
    }

    const topics = assessment.topicPolicy?.topics ?? []
    if (topics.length > 0) {
      detail.topicPolicy = topics.map((t) => ({
        name: t.name,
        type: t.type,
        action: t.action
      }))
    }

    const managedWords = assessment.wordPolicy?.managedWordLists ?? []
    const customWords = assessment.wordPolicy?.customWords ?? []
    if (managedWords.length > 0 || customWords.length > 0) {
      detail.wordPolicy = {
        managedWordLists: managedWords.map((w) => ({
          match: w.match,
          action: w.action
        })),
        customWords: customWords.map((w) => ({
          match: w.match,
          action: w.action
        }))
      }
    }

    const piiEntities = assessment.sensitiveInformationPolicy?.piiEntities ?? []
    const regexMatches = assessment.sensitiveInformationPolicy?.regexes ?? []
    if (piiEntities.length > 0 || regexMatches.length > 0) {
      detail.sensitiveInformationPolicy = {
        piiEntityTypes: piiEntities.map((e) => ({
          type: e.type,
          action: e.action
        })),
        regexMatches: regexMatches.map((r) => ({
          name: r.name,
          action: r.action
        }))
      }
    }

    const groundingFilters = assessment.contextualGroundingPolicy?.filters ?? []
    if (groundingFilters.length > 0) {
      detail.contextualGroundingPolicy = groundingFilters.map((f) => ({
        type: f.type,
        threshold: f.threshold,
        score: f.score,
        action: f.action
      }))
    }

    return detail
  }

  /**
   * Process Bedrock API response
   * @private
   */
  _processResponse(response) {
    const responseText = response.output?.message?.content?.[0]?.text || ''

    const usage = {
      inputTokens: response.usage?.inputTokens || 0,
      outputTokens: response.usage?.outputTokens || 0,
      totalTokens: response.usage?.totalTokens || 0
    }

    // Bedrock Converse API trace structure:
    //   response.trace.guardrail.inputAssessment  → Record<id, GuardrailAssessment>
    //   response.trace.guardrail.outputAssessments → Record<id, GuardrailAssessment[]>
    // There is NO top-level .action or .assessments array on the guardrail object.
    const guardrailTrace = response.trace?.guardrail ?? {}
    const inputAssessments = Object.values(guardrailTrace.inputAssessment ?? {})
    const outputAssessments = Object.values(
      guardrailTrace.outputAssessments ?? {}
    ).flat()
    const allAssessments = [...inputAssessments, ...outputAssessments]

    logger.info(
      {
        responseLength: responseText.length,
        inputTokens: usage.inputTokens,
        stopReason: response.stopReason
      },
      `Bedrock response received — ${responseText.length} chars, input: ${usage.inputTokens} tokens`
    )

    logger.info(
      {
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens
      },
      `Bedrock output: ${usage.outputTokens} tokens (total: ${usage.totalTokens})`
    )

    // Guardrail blocking is signalled by stopReason === 'guardrail_intervened'.
    // The trace.guardrail object has no top-level action field in the Converse API.
    if (response.stopReason === 'guardrail_intervened') {
      const policyBreakdown = allAssessments.map((a, idx) =>
        this._extractAssessmentDetail(a, idx)
      )

      logger.warn(
        {
          stopReason: response.stopReason,
          guardrailArn: this.guardrailArn,
          guardrailVersion: this.guardrailVersion,
          inputAssessmentCount: inputAssessments.length,
          outputAssessmentCount: outputAssessments.length,
          policyBreakdown
        },
        'Content blocked by guardrail — see policyBreakdown for triggered policies'
      )

      return {
        success: false,
        blocked: true,
        reason: 'Content was blocked by content safety guardrails',
        guardrailAssessment: { allAssessments }
      }
    }

    return {
      success: true,
      blocked: false,
      content: responseText,
      usage,
      guardrailAssessment: { allAssessments },
      stopReason: response.stopReason
    }
  }

  /**
   * Build messages array for Bedrock API
   * @private
   */
  _buildMessages(userMessage, conversationHistory) {
    return [
      ...conversationHistory,
      {
        role: 'user',
        content: [{ text: userMessage }]
      }
    ]
  }

  /**
   * Build guardrail configuration
   * @private
   */
  _buildGuardrailConfig() {
    return {
      guardrailIdentifier: this.guardrailArn,
      guardrailVersion: this.guardrailVersion,
      trace: 'enabled'
    }
  }

  /**
   * Build inference configuration
   * @private
   */
  _buildInferenceConfig() {
    return {
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      topP: this.topP
    }
  }

  /**
   * Returns true for errors that are safe to retry (throttling, transient
   * service issues, timeouts). Other errors (auth, validation) fail fast.
   * @private
   */
  _isRetryableError(error) {
    return (
      error.name === 'ThrottlingException' ||
      error.name === 'ServiceUnavailableException' ||
      error.name === 'TimeoutError' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ECONNRESET'
    )
  }

  /**
   * Sleep for the given number of milliseconds.
   * @private
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Send a message to Claude and get a response.
   *
   * @param {string} userMessage          - The user's message/prompt
   * @param {Array}  conversationHistory  - Optional previous messages for context
   * @param {string} [systemPrompt]       - Optional system prompt passed via the
   *   Bedrock Converse `system` parameter (preferred over injecting as a message).
   *   When provided the prompt is NOT injected into the messages array.
   * @returns {Promise<Object>} Response with content, usage stats, and guardrail metrics
   */
  async sendMessage(
    userMessage,
    conversationHistory = [],
    systemPrompt = null
  ) {
    if (!this.enabled) {
      throw new Error('Bedrock AI is not enabled')
    }

    // No Bedrock-level retries — SQS re-delivery handles retries.
    const MAX_RETRIES = 0
    const BASE_BACKOFF_MS = 90_000
    const MAX_BACKOFF_MS = 180_000

    const messages = this._buildMessages(userMessage, conversationHistory)
    const guardrailConfig = this._buildGuardrailConfig()
    const inferenceConfig = this._buildInferenceConfig()

    const commandInput = {
      modelId: this.inferenceProfileArn,
      messages,
      inferenceConfig,
      guardrailConfig
    }

    if (systemPrompt) {
      commandInput.system = [{ text: systemPrompt }]
    }

    let lastError
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const command = new ConverseCommand(commandInput)
        const response = await this.client.send(command)
        return this._processResponse(response)
      } catch (error) {
        lastError = error

        if (!this._isRetryableError(error) || attempt >= MAX_RETRIES) {
          // Non-retryable error or final attempt — exit retry loop
          break
        }

        const backoffMs = Math.min(
          BASE_BACKOFF_MS * Math.pow(2, attempt),
          MAX_BACKOFF_MS
        )
        logger.warn(
          {
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            backoffMs,
            errorName: error.name,
            errorCode: error.code
          },
          `Bedrock ${error.name} — retrying in ${backoffMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`
        )
        await this._sleep(backoffMs)
      }
    }

    // All attempts exhausted or non-retryable error encountered
    const errorDetails = this._extractErrorDetails(lastError)
    logger.error('Bedrock API error', errorDetails)
    return this._handleAwsError(lastError)
  }

  /**
   * Review content for quality, clarity, and GOV.UK compliance
   *
   * @param {string} content - The content to review
   * @param {string} contentType - Type of content (e.g., 'web_page', 'document', 'guidance')
   * @returns {Promise<Object>} Review with suggestions and assessment
   */
  async reviewContent(content, contentType = 'general') {
    // Ultra-short prompt to maximize speed (must complete within 5 seconds for CDP nginx)
    const userPrompt = `Review this content for GOV.UK compliance. Assess clarity, plain English, structure. Provide: assessment, 2 strengths, 2 issues, 2 suggestions, score (0-10).

Content:
${content}`

    try {
      // Send direct message without conversation history to minimize processing time
      const result = await this.sendMessage(userPrompt, [])

      if (result.blocked) {
        return {
          success: false,
          error: 'Content review was blocked by safety guardrails',
          reason: result.reason
        }
      }

      return {
        success: true,
        review: result.content,
        usage: result.usage,
        contentType
      }
    } catch (error) {
      // Extract comprehensive error details
      const errorDetails = {
        name: error.name,
        message: error.message,
        code: error.code,
        statusCode: error.$metadata?.httpStatusCode,
        stack: error.stack
      }

      logger.error('Error reviewing content', errorDetails)

      throw error
    }
  }
}

// Export singleton instance
export const bedrockClient = new BedrockClient()
