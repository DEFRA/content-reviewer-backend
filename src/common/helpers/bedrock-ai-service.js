import {
  BedrockRuntimeClient,
  InvokeModelCommand
} from '@aws-sdk/client-bedrock-runtime'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'
import { rulesRepository } from './rules-repository.js'
import { mockAIService } from './mock-ai-service.js'

const logger = createLogger()

/**
 * Bedrock AI Service
 * Handles content review using AWS Bedrock Claude 3.7 Sonnet
 * Or uses mock AI service for development/testing
 */
class BedrockAIService {
  constructor() {
    this.useMockAI = config.get('bedrock.useMockAI')
    
    if (this.useMockAI) {
      logger.warn('Using MOCK AI Service - for development/testing only!')
      return
    }

    const bedrockConfig = {
      region: config.get('bedrock.region') || 'eu-west-2'
    }

    // Add endpoint for LocalStack if configured (development only)
    const awsEndpoint =
      process.env.AWS_ENDPOINT || process.env.LOCALSTACK_ENDPOINT
    if (awsEndpoint && process.env.NODE_ENV !== 'production') {
      bedrockConfig.endpoint = awsEndpoint
    }

    this.bedrockClient = new BedrockRuntimeClient(bedrockConfig)

    // Configuration
    this.inferenceProfileArn =
      'arn:aws:bedrock:eu-west-2:332499610595:application-inference-profile/wrmld9jrycya'
    this.maxTokens = config.get('bedrock.maxTokens') || 8000
    this.temperature = config.get('bedrock.temperature') || 0.3
  }

  /**
   * Review content against GOV.UK standards using Bedrock AI
   * @param {string} documentContent - Extracted text from document
   * @param {string} filename - Original filename
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} Structured review result
   */
  async reviewContent(documentContent, filename, metadata = {}) {
    // Use mock AI service if configured
    if (this.useMockAI) {
      logger.info({ filename }, 'Using mock AI service for review')
      return await mockAIService.reviewContent(documentContent, filename)
    }

    try {
      logger.info(
        {
          filename,
          contentLength: documentContent.length,
          model: 'claude-3.7-sonnet'
        },
        'Starting Bedrock AI content review'
      )

      // Step 1: Load GOV.UK rules from S3
      const reviewRules = await rulesRepository.getDefaultRules()

      // Step 2: Build system prompt with rules
      const systemPrompt = rulesRepository.buildSystemPrompt(reviewRules)

      // Step 3: Prepare user message
      const userMessage = this.buildUserMessage(documentContent, filename)

      // Step 4: Call Bedrock AI
      const aiResponse = await this.invokeBedrockModel(
        systemPrompt,
        userMessage
      )

      // Step 5: Parse and structure the response
      const reviewResult = this.parseAIResponse(aiResponse, filename, metadata)

      logger.info(
        {
          filename,
          inputTokens: aiResponse.usage?.input_tokens,
          outputTokens: aiResponse.usage?.output_tokens,
          sectionsFound: Object.keys(reviewResult.sections || {}).length
        },
        'Bedrock AI review completed successfully'
      )

      return reviewResult
    } catch (error) {
      logger.error(
        {
          error: error.message,
          stack: error.stack,
          filename
        },
        'Bedrock AI review failed'
      )
      throw error
    }
  }

  /**
   * Invoke Bedrock AI model
   * @param {string} systemPrompt - System prompt with GOV.UK rules
   * @param {string} userMessage - User message with document content
   * @returns {Promise<Object>} AI response
   */
  async invokeBedrockModel(systemPrompt, userMessage) {
    try {
      const payload = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: systemPrompt, // GOV.UK rules included here
        messages: [
          {
            role: 'user',
            content: userMessage
          }
        ]
      }

      logger.debug(
        {
          inferenceProfile: this.inferenceProfileArn,
          maxTokens: this.maxTokens,
          temperature: this.temperature,
          systemPromptLength: systemPrompt.length,
          userMessageLength: userMessage.length
        },
        'Invoking Bedrock AI model'
      )

      const command = new InvokeModelCommand({
        modelId: this.inferenceProfileArn, // Using inference guardrail profile
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload)
      })

      const response = await this.bedrockClient.send(command)
      const responseBody = JSON.parse(new TextDecoder().decode(response.body))

      logger.info(
        {
          stopReason: responseBody.stop_reason,
          inputTokens: responseBody.usage?.input_tokens,
          outputTokens: responseBody.usage?.output_tokens
        },
        'Bedrock AI model invoked successfully'
      )

      return responseBody
    } catch (error) {
      logger.error(
        {
          error: error.message,
          errorCode: error.name,
          stack: error.stack
        },
        'Failed to invoke Bedrock AI model'
      )
      throw new Error(`Bedrock AI invocation failed: ${error.message}`)
    }
  }

  /**
   * Build user message for AI
   * @param {string} documentContent - Extracted document text
   * @param {string} filename - Original filename
   * @returns {string} Formatted user message
   */
  buildUserMessage(documentContent, filename) {
    return `Please review the following content against GOV.UK standards.

**Document:** ${filename}
**Content Length:** ${documentContent.length} characters

---

${documentContent}

---

Please provide a comprehensive review following the required 13-section structure defined in the system prompt.`
  }

  /**
   * Parse Bedrock AI response into structured review result
   * @param {Object} aiResponse - Raw Bedrock response
   * @param {string} filename - Original filename
   * @param {Object} metadata - Additional metadata
   * @returns {Object} Structured review result
   */
  parseAIResponse(aiResponse, filename, metadata = {}) {
    try {
      // Extract the AI's review text
      const reviewText = aiResponse.content?.[0]?.text || ''

      if (!reviewText) {
        throw new Error('No review text in AI response')
      }

      // Parse sections from the review
      const sections = {
        executiveSummary: this.extractSection(reviewText, 'Executive Summary'),
        contentSuitability: this.extractSection(
          reviewText,
          'Content Suitability & User Need'
        ),
        titleAnalysis: this.extractSection(reviewText, 'Title Analysis'),
        summaryEvaluation: this.extractSection(
          reviewText,
          'Summary.*Evaluation'
        ),
        issueRegister: this.extractSection(reviewText, 'Issue Register'),
        plainEnglishReview: this.extractSection(
          reviewText,
          'Plain English.*Review'
        ),
        bodyTextAnalysis: this.extractSection(reviewText, 'Body Text Analysis'),
        styleGuideCompliance: this.extractSection(
          reviewText,
          'Style Guide Compliance'
        ),
        govspeakReview: this.extractSection(reviewText, 'Govspeak.*Review'),
        accessibilityReview: this.extractSection(
          reviewText,
          'Accessibility Review'
        ),
        passiveVoiceReview: this.extractSection(
          reviewText,
          'Passive Voice Review'
        ),
        summaryOfFindings: this.extractSection(
          reviewText,
          'Summary of Findings'
        ),
        exampleImprovements: this.extractSection(
          reviewText,
          'Example Improvements'
        )
      }

      // Extract key metrics
      const metrics = this.extractMetrics(reviewText, sections)

      // Determine overall status
      const overallStatus = this.determineOverallStatus(reviewText, sections)

      return {
        filename,
        status: 'completed',
        reviewText, // Full review text
        sections, // Parsed sections
        metrics, // Extracted metrics
        overallStatus,
        aiMetadata: {
          model: 'claude-3.7-sonnet',
          inferenceProfile: this.inferenceProfileArn,
          inputTokens: aiResponse.usage?.input_tokens,
          outputTokens: aiResponse.usage?.output_tokens,
          stopReason: aiResponse.stop_reason
        },
        processedAt: new Date().toISOString(),
        ...metadata
      }
    } catch (error) {
      logger.error(
        {
          error: error.message,
          filename
        },
        'Failed to parse AI response'
      )

      // Return partial result with error
      return {
        filename,
        status: 'completed_with_errors',
        reviewText: aiResponse.content?.[0]?.text || '',
        parseError: error.message,
        aiMetadata: {
          model: 'claude-3.7-sonnet',
          inferenceProfile: this.inferenceProfileArn,
          inputTokens: aiResponse.usage?.input_tokens,
          outputTokens: aiResponse.usage?.output_tokens
        },
        processedAt: new Date().toISOString(),
        ...metadata
      }
    }
  }

  /**
   * Extract a specific section from the AI review text
   * @param {string} text - Full review text
   * @param {string} sectionName - Name of section to extract (can be regex pattern)
   * @returns {string} Section content
   */
  extractSection(text, sectionName) {
    try {
      // Match section headers with various formats:
      // ### 1. Executive Summary
      // ## Executive Summary
      // 1. Executive Summary
      const regex = new RegExp(
        `(?:###?|\\d+\\.)\\s*${sectionName}[\\s\\S]*?(?=(?:###?|\\d+\\.\\s+[A-Z])|$)`,
        'i'
      )
      const match = text.match(regex)

      if (match) {
        return match[0].trim()
      }

      logger.warn({ sectionName }, 'Section not found in AI response')
      return ''
    } catch (error) {
      logger.error(
        {
          error: error.message,
          sectionName
        },
        'Error extracting section'
      )
      return ''
    }
  }

  /**
   * Extract key metrics from the review
   * @param {string} reviewText - Full review text
   * @param {Object} sections - Parsed sections
   * @returns {Object} Extracted metrics
   */
  extractMetrics(reviewText, sections) {
    const metrics = {
      totalIssues: 0,
      criticalIssues: 0,
      automatedIssues: 0,
      humanJudgementRequired: 0,
      wordsToAvoidCount: 0,
      passiveSentencesCount: 0,
      longSentencesCount: 0
    }

    try {
      // Count issues from Issue Register
      if (sections.issueRegister) {
        const issueMatches = sections.issueRegister.match(/\*\*Category\*\*/g)
        metrics.totalIssues = issueMatches ? issueMatches.length : 0

        const automatedMatches =
          sections.issueRegister.match(/Type:.*Automated/gi)
        metrics.automatedIssues = automatedMatches ? automatedMatches.length : 0

        const humanMatches = sections.issueRegister.match(
          /Type:.*Human judgement/gi
        )
        metrics.humanJudgementRequired = humanMatches ? humanMatches.length : 0
      }

      // Count words to avoid
      if (sections.plainEnglishReview) {
        const wordMatches =
          sections.plainEnglishReview.match(/\*\*Word used\*\*/g)
        metrics.wordsToAvoidCount = wordMatches ? wordMatches.length : 0
      }

      // Count passive sentences
      if (sections.passiveVoiceReview) {
        const passiveMatches = sections.passiveVoiceReview.match(
          /\* .* (was|were|is|are|been) /g
        )
        metrics.passiveSentencesCount = passiveMatches
          ? passiveMatches.length
          : 0
      }

      // Count long sentences (>25 words)
      if (sections.bodyTextAnalysis) {
        const longSentenceMatches =
          sections.bodyTextAnalysis.match(/exceeding 25 words/gi)
        metrics.longSentencesCount = longSentenceMatches
          ? longSentenceMatches.length
          : 0
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Error extracting metrics')
    }

    return metrics
  }

  /**
   * Determine overall review status
   * @param {string} reviewText - Full review text
   * @param {Object} sections - Parsed sections
   * @returns {Object} Overall status
   */
  determineOverallStatus(reviewText, sections) {
    const status = {
      readyForPublication: false,
      hasBlockers: false,
      requiresRevision: false,
      requiresHumanReview: true, // Always require human review
      priority: 'medium',
      summary: ''
    }

    try {
      const executiveSummary = sections.executiveSummary.toLowerCase()

      // Check for blockers
      if (
        executiveSummary.includes('blocker') ||
        executiveSummary.includes('must not') ||
        executiveSummary.includes('cannot be published')
      ) {
        status.hasBlockers = true
        status.priority = 'high'
        status.requiresRevision = true
      }

      // Check for high-priority issues
      if (
        executiveSummary.includes('high-priority') ||
        executiveSummary.includes('urgent') ||
        executiveSummary.includes('critical')
      ) {
        status.priority = 'high'
        status.requiresRevision = true
      }

      // Check if ready (with caveats)
      if (
        executiveSummary.includes('minor issues only') ||
        executiveSummary.includes('ready for publication') ||
        executiveSummary.includes('no significant issues')
      ) {
        status.readyForPublication = true
        status.priority = 'low'
      }

      // Extract summary from executive summary (first few sentences)
      const summaryMatch = executiveSummary.match(/^.*?[.!?]\s+.*?[.!?]/)
      status.summary = summaryMatch
        ? summaryMatch[0]
        : 'Content review completed.'
    } catch (error) {
      logger.error({ error: error.message }, 'Error determining overall status')
      status.summary = 'Review completed but status could not be determined.'
    }

    return status
  }

  /**
   * Get service health status
   * @returns {Promise<Object>} Health status
   */
  async getHealth() {
    try {
      // Try a minimal test call
      const testPayload = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'test' }]
      }

      const command = new InvokeModelCommand({
        modelId: this.inferenceProfileArn,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(testPayload)
      })

      await this.bedrockClient.send(command)

      return {
        status: 'ok',
        service: 'bedrock-ai',
        model: 'claude-3.7-sonnet',
        inferenceProfile: this.inferenceProfileArn,
        region: this.bedrockClient.config.region
      }
    } catch (error) {
      return {
        status: 'error',
        service: 'bedrock-ai',
        error: error.message
      }
    }
  }
}

// Create singleton instance
export const bedrockAIService = new BedrockAIService()

// Export class for testing
export { BedrockAIService }
