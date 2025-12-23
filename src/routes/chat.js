import Boom from '@hapi/boom'
import { validateResponse, generateRetryPrompt } from '../common/helpers/response-validator.js'

/**
 * Chat API Routes
 * Handles content analysis requests and conversation management
 */

/**
 * Get LLM response (placeholder for actual LLM integration)
 * TODO: Replace this function when you integrate AWS Bedrock
 */
async function getLLMResponse(message) {
  // TODO: Replace with actual Bedrock InvokeModel call
  // For now, return a mock response for testing
  return generateBotResponse(message)
}

/**
 * Helper function to generate bot responses
 * This will be replaced with actual AI integration
 */
function generateBotResponse(userMessage) {
  const lowerMessage = userMessage.toLowerCase()

  if (lowerMessage.includes('standard') || lowerMessage.includes('guideline')) {
    return `GOV.UK content standards include:

- Write in plain English - avoid jargon and complex terms
- Use short sentences (no more than 25 words)
- Break content into clear sections with descriptive headings
- Use bullet points for lists
- Front-load important information
- Use active voice rather than passive
- Address the user directly using "you"
- Be concise and get to the point quickly

Would you like me to review specific content against these standards?`
  } else if (
    lowerMessage.includes('readability') ||
    lowerMessage.includes('plain english')
  ) {
    return `I can help check your content for readability. To review content, please:

1. Paste the text you want me to review
2. I'll analyze it for:
   - Sentence length and complexity
   - Use of plain English
   - Active vs passive voice
   - Reading level
   - Overall clarity

3. I'll provide specific suggestions for improvement

Go ahead and paste your content!`
  } else if (lowerMessage.includes('hello') || lowerMessage.includes('hi')) {
    return `Hello! I'm ready to help you review content for GOV.UK compliance. You can paste any text for me to review, or ask me about specific content standards.`
  } else if (lowerMessage.length > 50) {
    return `Thank you for sharing that content. I'll review it for GOV.UK standards.

Initial observations:
- The content is ${userMessage.split(' ').length} words long
- It contains ${userMessage.split('.').length - 1} sentences

Key recommendations:
1. Break long sentences into shorter ones (aim for 15-25 words)
2. Use subheadings to break up content
3. Consider using bullet points for lists of items
4. Check for passive voice and convert to active where possible
5. Replace complex words with simpler alternatives

Note: This is a demo response. Once the AI is integrated, I'll provide detailed, specific feedback on your content.`
  } else {
    return `I can help you with:

- Reviewing content against GOV.UK standards
- Checking readability and plain English usage
- Suggesting formatting improvements
- Answering questions about content guidelines

What would you like help with?`
  }
}

/**
 * Chat Routes Array
 * Exported for registration in plugins/router.js
 */
const chat = [
  {
    method: 'POST',
    path: '/api/chat/message',
    handler: async (request, h) => {
      try {
        const { message } = request.payload

        if (!message) {
          throw Boom.badRequest('Message is required')
        }

        // Get LLM response (currently mock, will be replaced with Bedrock)
        let llmResponse = await getLLMResponse(message)

        // Validate the LLM response
        let validationResult = validateResponse(llmResponse)

        // If validation fails critically, retry once
        if (
          validationResult.level === 'fail' &&
          validationResult.completeness < 90
        ) {
          request.logger.warn('Initial response failed validation. Retrying...')
          request.logger.warn('Errors:', validationResult.errors)

          // Generate retry prompt with specific issues
          const retryPrompt = generateRetryPrompt(validationResult, message)

          // Retry with more specific instructions
          llmResponse = await getLLMResponse(retryPrompt)
          validationResult = validateResponse(llmResponse)

          if (validationResult.level === 'fail') {
            request.logger.error('Retry also failed validation')
          }
        }

        // Prepare response with validation info
        const response = {
          success: true,
          response: llmResponse,
          validation: {
            level: validationResult.level,
            completeness: validationResult.completeness,
            warnings: validationResult.warnings,
            metadata: validationResult.metadata
          },
          timestamp: new Date().toISOString()
        }

        // Add warning message if validation had issues
        if (validationResult.level === 'warn') {
          response.warning =
            'The response may have minor issues. Please review carefully.'
        } else if (validationResult.level === 'fail') {
          response.warning =
            'The response is incomplete. Some sections may be missing.'
        }

        return h.response(response)
      } catch (error) {
        request.logger.error('Error in sendMessage:', error)
        throw Boom.internal('Error processing message')
      }
    },
    options: {
      description: 'Send a message for content analysis',
      notes: 'Analyzes content against GOV.UK standards with validation',
      tags: ['api', 'chat']
    }
  },
  {
    method: 'GET',
    path: '/api/chat/conversations',
    handler: async (request, h) => {
      try {
        // TODO: Retrieve conversations from MongoDB
        // For now, return empty array
        return h.response({
          success: true,
          conversations: []
        })
      } catch (error) {
        request.logger.error('Error in getConversations:', error)
        throw Boom.internal('Error retrieving conversations')
      }
    },
    options: {
      description: 'Get all user conversations',
      notes: 'Returns list of conversation history for the current user',
      tags: ['api', 'chat']
    }
  },
  {
    method: 'GET',
    path: '/api/chat/conversations/{id}',
    handler: async (request, h) => {
      try {
        const { id } = request.params

        // TODO: Retrieve specific conversation from MongoDB
        throw Boom.notFound('Conversation not found')
      } catch (error) {
        if (Boom.isBoom(error)) {
          throw error
        }
        request.logger.error('Error in getConversation:', error)
        throw Boom.internal('Error retrieving conversation')
      }
    },
    options: {
      description: 'Get a specific conversation',
      notes: 'Returns detailed conversation history',
      tags: ['api', 'chat']
    }
  },
  {
    method: 'POST',
    path: '/api/chat/conversations',
    handler: async (request, h) => {
      try {
        const newConversation = {
          id: Date.now().toString(),
          title: 'New conversation',
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }

        // TODO: Save to MongoDB

        return h.response({
          success: true,
          conversation: newConversation
        })
      } catch (error) {
        request.logger.error('Error in createConversation:', error)
        throw Boom.internal('Error creating conversation')
      }
    },
    options: {
      description: 'Create a new conversation',
      notes: 'Initializes a new conversation thread',
      tags: ['api', 'chat']
    }
  },
  {
    method: 'DELETE',
    path: '/api/chat/conversations/{id}',
    handler: async (request, h) => {
      try {
        const { id } = request.params

        // TODO: Delete from MongoDB

        return h.response({
          success: true,
          message: 'Conversation deleted'
        })
      } catch (error) {
        request.logger.error('Error in deleteConversation:', error)
        throw Boom.internal('Error deleting conversation')
      }
    },
    options: {
      description: 'Delete a conversation',
      notes: 'Permanently removes a conversation and its messages',
      tags: ['api', 'chat']
    }
  }
]

export { chat }
