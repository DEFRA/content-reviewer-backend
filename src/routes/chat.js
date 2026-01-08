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
      logger.error('Error in chat endpoint', {
        error: error.message,
        stack: error.stack
      })

      if (Boom.isBoom(error)) {
        throw error
      }

      throw Boom.internal('Failed to process chat message')
    }
  }
}

/**
 * Content review endpoint - Review content for quality and GOV.UK compliance
 */
const reviewController = {
  options: {
    auth: false,
    cors: {
      origin: config.get('cors.origin'),
      credentials: config.get('cors.credentials')
    }
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
      logger.error('Error in review endpoint', {
        error: error.message,
        stack: error.stack
      })

      if (Boom.isBoom(error)) {
        throw error
      }

      throw Boom.internal('Failed to process content review')
    }
  }
}

export { chatController, reviewController }
