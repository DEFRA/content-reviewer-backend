import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * SQS Client for sending messages to content review queue
 */
class SQSClientHelper {
  constructor() {
    const sqsConfig = {
      region: config.get('sqs.region')
    }

    // Add endpoint for LocalStack if configured
    const sqsEndpoint = config.get('sqs.endpoint')
    if (sqsEndpoint) {
      console.log(`[SQSClient] Using custom SQS endpoint: ${sqsEndpoint}`)
      sqsConfig.endpoint = sqsEndpoint
    }

    this.sqsClient = new SQSClient(sqsConfig)
    this.queueUrl = config.get('sqs.queueUrl')
    this.queueName = config.get('sqs.queueName')
    
    console.log(`[SQSClient] Queue Name: ${this.queueName}`)
    console.log(`[SQSClient] Queue URL: ${this.queueUrl}`)
    console.log(`[SQSClient] Environment: ${config.get('cdpEnvironment')}`)
  }

  /**
   * Send message to SQS queue for content review
   * @param {Object} messageData - Data to send to queue
   * @returns {Promise<Object>} Send result
   */
  async sendMessage(messageData) {
    const messageBody = {
      uploadId: messageData.uploadId,
      filename: messageData.filename,
      s3Bucket: messageData.s3Bucket,
      s3Key: messageData.s3Key,
      s3Location: messageData.s3Location,
      contentType: messageData.contentType,
      fileSize: messageData.fileSize,
      uploadedAt: new Date().toISOString(),
      messageType: messageData.messageType || 'file_upload', // 'file_upload' or 'text_content'
      textContent: messageData.textContent || null,
      userId: messageData.userId || 'anonymous',
      sessionId: messageData.sessionId || null
    }

    // Check if this is a FIFO queue (ends with .fifo)
    const isFifoQueue = this.queueName.endsWith('.fifo')

    const commandParams = {
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(messageBody),
      MessageAttributes: {
        UploadId: {
          DataType: 'String',
          StringValue: messageData.uploadId
        },
        MessageType: {
          DataType: 'String',
          StringValue: messageData.messageType || 'file_upload'
        },
        ContentType: {
          DataType: 'String',
          StringValue: messageData.contentType || 'text/plain'
        }
      }
    }

    // Add FIFO-specific parameters only if it's a FIFO queue
    if (isFifoQueue) {
      commandParams.MessageGroupId = messageData.uploadId // Group by upload ID
      commandParams.MessageDeduplicationId = `${messageData.uploadId}-${Date.now()}` // Ensure uniqueness
    }

    const command = new SendMessageCommand(commandParams)

    try {
      const result = await this.sqsClient.send(command)

      logger.info(
        {
          messageId: result.MessageId,
          uploadId: messageData.uploadId,
          queueUrl: this.queueUrl
        },
        'Message sent to SQS queue successfully'
      )

      return {
        success: true,
        messageId: result.MessageId,
        queueUrl: this.queueUrl
      }
    } catch (error) {
      logger.error(
        {
          error: error.message,
          uploadId: messageData.uploadId,
          queueUrl: this.queueUrl
        },
        'Failed to send message to SQS queue'
      )
      throw new Error(`SQS send failed: ${error.message}`)
    }
  }

  /**
   * Send text content for review (no file)
   * @param {Object} contentData - Text content data
   * @returns {Promise<Object>} Send result
   */
  async sendTextContent(contentData) {
    const uploadId = contentData.uploadId || `text-${Date.now()}`

    return this.sendMessage({
      uploadId,
      filename: null,
      s3Bucket: null,
      s3Key: null,
      s3Location: null,
      contentType: 'text/plain',
      fileSize: contentData.textContent?.length || 0,
      messageType: 'text_content',
      textContent: contentData.textContent,
      userId: contentData.userId,
      sessionId: contentData.sessionId
    })
  }
}

export const sqsClient = new SQSClientHelper()
