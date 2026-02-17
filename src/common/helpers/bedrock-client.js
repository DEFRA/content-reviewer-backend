import {
  BedrockRuntimeClient,
  ConverseCommand
} from '@aws-sdk/client-bedrock-runtime'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

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
    this.inferenceProfileArn = config.get('bedrock.inferenceProfileArn')
    this.guardrailArn = config.get('bedrock.guardrailArn')
    this.guardrailVersion = config.get('bedrock.guardrailVersion')
    this.region = config.get('aws.region')
    this.maxTokens = config.get('bedrock.maxTokens')
    this.temperature = config.get('bedrock.temperature')
    this.topP = config.get('bedrock.topP')
    this.timeout = 180000 // 180 seconds timeout for Bedrock API calls

    this.client = new BedrockRuntimeClient({
      region: this.region,
      requestHandler: {
        requestTimeout: this.timeout
      }
    })

    // Log temperature to validate environment variable configuration
    logger.info(
      `Bedrock client initialized with CDP inference profile (temperature: ${this.temperature})`,
      {
        inferenceProfileArn: this.inferenceProfileArn,
        guardrailArn: this.guardrailArn,
        region: this.region,
        awsProfile: process.env.AWS_PROFILE || 'none',
        hasAccessKeyId: !!process.env.AWS_ACCESS_KEY_ID,
        hasSecretAccessKey: !!process.env.AWS_SECRET_ACCESS_KEY,
        hasSessionToken: !!process.env.AWS_SESSION_TOKEN,
        nodeEnv: process.env.NODE_ENV
      }
    )
  }

  /**
   * Extract error details from AWS SDK error
   */
  extractErrorDetails(error) {
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
      errorDetails.fullError = JSON.stringify(
        error,
        Object.getOwnPropertyNames(error),
        2
      )
    } catch (serializeError) {
      logger.warn('Could not serialize full error', {
        serializationError: serializeError.message
      })
      errorDetails.serializationError = 'Could not serialize full error'
    }

    return errorDetails
  }

  /**
   * Handle AWS-specific errors
   */
  handleAwsError(error) {
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
   * Process Bedrock API response
   */
  processResponse(response) {
    const responseText = response.output?.message?.content?.[0]?.text || ''
    const usage = {
      inputTokens: response.usage?.inputTokens || 0,
      outputTokens: response.usage?.outputTokens || 0,
      totalTokens: response.usage?.totalTokens || 0
    }
    const guardrailAssessment = {
      action: response.trace?.guardrail?.action || 'NONE',
      assessments: response.trace?.guardrail?.assessments || []
    }

    logger.info('Received response from Bedrock', {
      responseLength: responseText.length,
      usage,
      guardrailAction: guardrailAssessment.action
    })

    if (guardrailAssessment.action === 'BLOCKED') {
      logger.warn('Content blocked by guardrail', { guardrailAssessment })
      return {
        success: false,
        blocked: true,
        reason: 'Content was blocked by content safety guardrails',
        guardrailAssessment
      }
    }

    return {
      success: true,
      blocked: false,
      content: responseText,
      usage,
      guardrailAssessment,
      stopReason: response.stopReason
    }
  }

  /**
   * Send a message to Claude and get a response
   *
   * @param {string} userMessage - The user's message/prompt
   * @param {Array} conversationHistory - Optional previous messages for context
   * @returns {Promise<Object>} Response with content, usage stats, and guardrail metrics
   */
  async sendMessage(userMessage, conversationHistory = []) {
    if (!this.enabled) {
      throw new Error('Bedrock AI is not enabled')
    }

    try {
      const messages = [
        ...conversationHistory,
        {
          role: 'user',
          content: [{ text: userMessage }]
        }
      ]

      const command = new ConverseCommand({
        modelId: this.inferenceProfileArn,
        messages,
        inferenceConfig: {
          maxTokens: this.maxTokens,
          temperature: this.temperature,
          topP: this.topP
        },
        guardrailConfig: {
          guardrailIdentifier: this.guardrailArn,
          guardrailVersion: this.guardrailVersion,
          trace: 'enabled'
        }
      })

      const response = await this.client.send(command)
      return this.processResponse(response)
    } catch (error) {
      const errorDetails = this.extractErrorDetails(error)
      logger.error('Error calling Bedrock API', errorDetails)
      return this.handleAwsError(error)
    }
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
