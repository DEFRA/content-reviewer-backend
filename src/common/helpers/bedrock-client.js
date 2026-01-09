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
    this.region = config.get('bedrock.region')
    this.maxTokens = config.get('bedrock.maxTokens')
    this.temperature = config.get('bedrock.temperature')

    this.client = new BedrockRuntimeClient({
      region: this.region
    })

    logger.info('Bedrock client initialized with CDP inference profile', {
      inferenceProfileArn: this.inferenceProfileArn,
      guardrailArn: this.guardrailArn,
      region: this.region,
      awsProfile: process.env.AWS_PROFILE || 'none',
      hasAccessKeyId: !!process.env.AWS_ACCESS_KEY_ID,
      hasSecretAccessKey: !!process.env.AWS_SECRET_ACCESS_KEY,
      hasSessionToken: !!process.env.AWS_SESSION_TOKEN,
      nodeEnv: process.env.NODE_ENV
    })
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
      // Build messages array (conversation history + new message)
      const messages = [
        ...conversationHistory,
        {
          role: 'user',
          content: [{ text: userMessage }]
        }
      ]

      // Create guardrail configuration
      const guardrailConfig = {
        guardrailIdentifier: this.guardrailArn,
        guardrailVersion: this.guardrailVersion,
        trace: 'enabled'
      }

      // Build inference configuration
      const inferenceConfig = {
        maxTokens: this.maxTokens,
        temperature: this.temperature
      }

      // Create the Converse command
      const command = new ConverseCommand({
        modelId: this.inferenceProfileArn, // Use inference profile ARN, not model ID
        messages,
        inferenceConfig,
        guardrailConfig
      })

      logger.info('Sending request to Bedrock via CDP inference profile', {
        messageLength: userMessage.length,
        historyLength: conversationHistory.length
      })

      // Call Bedrock
      const response = await this.client.send(command)

      // Extract the text content from the response
      const responseText = response.output?.message?.content?.[0]?.text || ''

      // Extract usage statistics
      const usage = {
        inputTokens: response.usage?.inputTokens || 0,
        outputTokens: response.usage?.outputTokens || 0,
        totalTokens: response.usage?.totalTokens || 0
      }

      // Extract guardrail assessment
      const guardrailAssessment = {
        action: response.trace?.guardrail?.action || 'NONE',
        assessments: response.trace?.guardrail?.assessments || []
      }

      logger.info('Received response from Bedrock', {
        responseLength: responseText.length,
        usage,
        guardrailAction: guardrailAssessment.action
      })

      // Check if content was blocked by guardrail
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
    } catch (error) {
      // Extract all possible error properties from AWS SDK errors
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

      // Try to serialize the full error object
      try {
        errorDetails.fullError = JSON.stringify(
          error,
          Object.getOwnPropertyNames(error),
          2
        )
      } catch (serializeError) {
        errorDetails.serializationError = 'Could not serialize full error'
      }

      // Log with all extracted details
      logger.error('Error calling Bedrock API', errorDetails)

      // Also log to console for immediate visibility
      console.error('=== BEDROCK API ERROR ===')
      console.error('Error Name:', error.name)
      console.error('Error Message:', error.message)
      console.error('Error Code:', error.code || 'undefined')
      console.error(
        'HTTP Status:',
        error.$metadata?.httpStatusCode || 'undefined'
      )
      console.error('Request ID:', error.$metadata?.requestId || 'undefined')
      console.error('Full Error:', error)
      console.error('=========================')

      // Handle credential errors with extra diagnostics
      if (error.name === 'CredentialsProviderError') {
        console.error('=== CREDENTIAL DIAGNOSTICS ===')
        console.error('AWS Profile:', process.env.AWS_PROFILE || 'none')
        console.error('Has Access Key ID:', !!process.env.AWS_ACCESS_KEY_ID)
        console.error(
          'Has Secret Access Key:',
          !!process.env.AWS_SECRET_ACCESS_KEY
        )
        console.error('Has Session Token:', !!process.env.AWS_SESSION_TOKEN)
        console.error('Node Env:', process.env.NODE_ENV)
        console.error('AWS Region:', this.region)
        console.error('==============================')

        throw new Error(
          'AWS credentials not found. In CDP, ensure EC2 instance has IAM role with Bedrock permissions.'
        )
      }

      // Handle specific AWS errors
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
          'Bedrock API rate limit exceeded. Please try again later.'
        )
      }

      if (error.name === 'ValidationException') {
        throw new Error(`Bedrock validation error: ${error.message}`)
      }

      if (error.name === 'ServiceUnavailableException') {
        throw new Error(
          'Bedrock service temporarily unavailable. Please retry.'
        )
      }

      throw new Error(`Bedrock API error: ${error.message}`)
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
    const systemPrompt = `You are a content quality reviewer for GOV.UK services. Your role is to assess content for:

1. **Clarity**: Is the content clear and easy to understand?
2. **Plain English**: Does it follow GOV.UK plain English guidelines?
3. **Structure**: Is it well-organized with clear headings and sections?
4. **Accessibility**: Is it accessible to all users?
5. **Action-oriented**: Does it help users complete their task?
6. **Tone**: Is the tone appropriate (friendly, professional, helpful)?

Provide your review in the following format:

**Overall Assessment**: [Brief summary]

**Strengths**:
- [List key strengths]

**Issues Found**:
- [List specific issues with line references if applicable]

**Suggestions**:
- [Actionable suggestions for improvement]

**Compliance Score**: [Score out of 10]`

    const userPrompt = `Please review the following ${contentType} content:

---
${content}
---

Provide a detailed quality review following GOV.UK content standards.`

    try {
      // Build conversation history with system prompt setup
      const conversationHistory = [
        {
          role: 'user',
          content: [{ text: systemPrompt }]
        },
        {
          role: 'assistant',
          content: [
            {
              text: 'I understand. I will review content according to GOV.UK standards.'
            }
          ]
        }
      ]

      // Send the actual review request with the system context
      const result = await this.sendMessage(userPrompt, conversationHistory)

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

      // Also log to console for debugging
      console.error('=== CONTENT REVIEW ERROR ===')
      console.error('Error:', error)
      console.error('============================')

      throw error
    }
  }
}

// Export singleton instance
export const bedrockClient = new BedrockClient()
