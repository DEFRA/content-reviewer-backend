import { randomUUID } from 'crypto'
import { config } from '../config.js'
import { sqsClient } from '../common/helpers/sqs-client.js'
import { reviewStatusTracker } from '../common/helpers/review-status-tracker.js'

/**
 * Text Review route plugin
 */
export const textReviewRoutes = {
  plugin: {
    name: 'text-review-routes',
    register: async (server) => {
      /**
       * POST /api/review-text
       * Submit text content for review
       */
      server.route({
        method: 'POST',
        path: '/api/review-text',
        options: {
          payload: {
            parse: true,
            allow: 'application/json'
          },
          cors: {
            origin: config.get('cors.origin'),
            credentials: config.get('cors.credentials')
          }
        },
        handler: async (request, h) => {
          let reviewId = null

          try {
            const data = request.payload

            // Log payload for debugging
            request.logger.info(
              {
                payloadKeys: data ? Object.keys(data) : 'null',
                hasTextContent: data ? !!data.textContent : false,
                textLength: data?.textContent?.length || 0
              },
              'Text review request received'
            )

            // Validate text content
            if (!data || !data.textContent) {
              return h
                .response({
                  success: false,
                  error: 'No text content provided'
                })
                .code(400)
            }

            const textContent = data.textContent.trim()

            // Validate minimum length
            if (textContent.length < 10) {
              return h
                .response({
                  success: false,
                  error:
                    'Text content too short. Please provide at least 10 characters.'
                })
                .code(400)
            }

            // Validate maximum length (50,000 characters)
            const maxLength = 50000
            if (textContent.length > maxLength) {
              return h
                .response({
                  success: false,
                  error: `Text content too long. Maximum ${maxLength} characters. Your content has ${textContent.length} characters.`
                })
                .code(400)
            }

            reviewId = randomUUID()
            const userId = data.userId || request.headers['x-user-id'] || 'anonymous'
            const sessionId = data.sessionId || request.headers['x-session-id'] || null

            // Create a descriptive filename from the first part of the text content
            // Take first 50 chars, remove newlines/special chars, and truncate to reasonable length
            const contentPreview = textContent
              .substring(0, 50)
              .replace(/[\r\n\t]+/g, ' ')  // Replace newlines/tabs with space
              .replace(/[^\w\s-]/g, '')     // Remove special characters except spaces and hyphens
              .trim()
              .replace(/\s+/g, '_')         // Replace spaces with underscores
              .substring(0, 40)             // Limit to 40 characters
            
            // Use content preview if available, otherwise use generic name
            const filename = contentPreview 
              ? `${contentPreview}.txt`
              : `Text_Content_${new Date().toISOString().slice(0, 10)}.txt`

            // Step 1: Create initial status in database
            await reviewStatusTracker.createStatus(reviewId, filename, userId, {
              sessionId,
              userAgent: request.headers['user-agent'],
              ipAddress: request.info.remoteAddress,
              contentType: 'text/plain',
              contentLength: textContent.length,
              reviewMethod: 'text_content'
            })

            request.logger.info({ reviewId }, 'Text review status created')

            // Step 2: Update status - processing text
            await reviewStatusTracker.updateStatus(
              reviewId,
              'uploaded',
              'Text content received',
              20
            )

            // Step 3: Send message to SQS queue for AI review
            try {
              const sqsResult = await sqsClient.sendMessage({
                uploadId: reviewId,
                filename,
                textContent, // Include the actual text content
                contentType: 'text/plain',
                fileSize: textContent.length,
                messageType: 'text_content', // Distinguish from file uploads
                userId,
                sessionId,
                // No S3 location for direct text content
                s3Bucket: null,
                s3Key: null,
                s3Location: null
              })

              request.logger.info(
                {
                  reviewId,
                  messageId: sqsResult.messageId,
                  queueUrl: sqsResult.queueUrl
                },
                'Text review message sent to SQS queue for AI processing'
              )

              // Step 4: Update status - queued for processing
              await reviewStatusTracker.updateStatus(
                reviewId,
                'queued',
                'Added to processing queue',
                30
              )
            } catch (sqsError) {
              // Log but mark as failed
              request.logger.error(
                {
                  reviewId,
                  error: sqsError.message
                },
                'Failed to send text review message to SQS queue'
              )

              // Mark as failed to queue
              await reviewStatusTracker.markFailed(
                reviewId,
                `Failed to queue: ${sqsError.message}`
              )

              return h
                .response({
                  success: false,
                  error: 'Failed to queue text content for review'
                })
                .code(500)
            }

            return h
              .response({
                success: true,
                reviewId,
                filename,
                contentLength: textContent.length,
                message: 'Text content submitted successfully for review'
              })
              .code(200)
          } catch (error) {
            request.logger.error(
              {
                reviewId,
                error: error.message,
                stack: error.stack
              },
              'Error processing text review request'
            )

            // Mark as failed if we have a reviewId
            if (reviewId) {
              await reviewStatusTracker.markFailed(
                reviewId,
                `Processing error: ${error.message}`
              )
            }

            return h
              .response({
                success: false,
                error: error.message || 'Internal server error'
              })
              .code(500)
          }
        }
      })
    }
  }
}
