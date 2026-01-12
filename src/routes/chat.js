import Boom from '@hapi/boom'
import { bedrockClient } from '../common/helpers/bedrock-client.js'
import { createLogger } from '../common/helpers/logging/logger.js'
import { config } from '../config.js'

const logger = createLogger()

/**
 * Chat endpoint - Send messages to AI for content review
 */
const chatController = {
  options: {
    auth: false,
    cors: {
      origin: config.get('cors.origin'),
      credentials: config.get('cors.credentials')
    }
  },
  handler: async (request, h) => {
    try {
      const { message, conversationHistory = [] } = request.payload

      if (
        !message ||
        typeof message !== 'string' ||
        message.trim().length === 0
      ) {
        throw Boom.badRequest(
          'Message is required and must be a non-empty string'
        )
      }

      logger.info('Processing chat message', {
        messageLength: message.length,
        historyLength: conversationHistory.length
      })

      // Send to Bedrock via CDP inference profile
      const result = await bedrockClient.sendMessage(
        message,
        conversationHistory
      )

      if (result.blocked) {
        logger.warn('Message blocked by guardrails', { reason: result.reason })
        return h
          .response({
            success: false,
            blocked: true,
            message: result.reason,
            guardrailAssessment: result.guardrailAssessment
          })
          .code(200) // Still return 200 as the request was processed
      }

      logger.info('Chat response generated successfully', {
        responseLength: result.content.length,
        tokensUsed: result.usage.totalTokens
      })

      return h
        .response({
          success: true,
          blocked: false,
          response: result.content,
          usage: result.usage,
          stopReason: result.stopReason
        })
        .code(200)
    } catch (error) {
      // Extract comprehensive error details
      const errorDetails = {
        name: error.name,
        message: error.message,
        code: error.code,
        isBoom: Boom.isBoom(error),
        statusCode: error.output?.statusCode,
        stack: error.stack
      }

      logger.error('Error in chat endpoint', errorDetails)

      if (Boom.isBoom(error)) {
        throw error
      }

      throw Boom.internal('Failed to process chat message')
    }
  }
}

/**
 * Content review endpoint - Review content for quality and GOV.UK compliance
 * Note: CDP nginx has a 5-second timeout for this endpoint
 */
const reviewController = {
  options: {
    auth: false,
    cors: {
      origin: config.get('cors.origin'),
      credentials: config.get('cors.credentials')
    },
    timeout: {
      server: 4500 // 4.5 seconds - must complete before nginx 5s timeout
    }
    // No timeout override - let nginx handle the 5s timeout
  },
  handler: async (request, h) => {
    try {
      const { content, contentType = 'general' } = request.payload

      if (
        !content ||
        typeof content !== 'string' ||
        content.trim().length === 0
      ) {
        throw Boom.badRequest(
          'Content is required and must be a non-empty string'
        )
      }

      if (content.length > 50000) {
        throw Boom.badRequest('Content is too long. Maximum 50,000 characters.')
      }

      logger.info('Processing content review', {
        contentLength: content.length,
        contentType
      })

      // Review content using Bedrock
      const result = await bedrockClient.reviewContent(content, contentType)

      if (!result.success) {
        logger.warn('Content review blocked', { reason: result.reason })
        return h
          .response({
            success: false,
            error: result.error,
            reason: result.reason
          })
          .code(200)
      }

      logger.info('Content review completed successfully', {
        tokensUsed: result.usage.totalTokens
      })

      return h
        .response({
          success: true,
          review: result.review,
          usage: result.usage,
          contentType: result.contentType
        })
        .code(200)
    } catch (error) {
      // Extract comprehensive error details
      const errorDetails = {
        name: error.name,
        message: error.message,
        code: error.code,
        isBoom: Boom.isBoom(error),
        statusCode: error.output?.statusCode,
        stack: error.stack
      }

      logger.error('Error in review endpoint', errorDetails)

      if (Boom.isBoom(error)) {
        throw error
      }

      // Check for timeout errors
      if (
        error.message?.includes('timeout') ||
        error.name === 'TimeoutError' ||
        error.code === 'ETIMEDOUT'
      ) {
        throw Boom.gatewayTimeout(
          'Content review took too long to process. Please try with shorter content or contact support.'
        )
      }

      throw Boom.internal('Failed to process content review')
    }
  }
}

export { chatController, reviewController }
