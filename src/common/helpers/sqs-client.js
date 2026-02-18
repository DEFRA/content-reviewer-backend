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
      region: config.get('aws.region')
    }

    // Add endpoint for LocalStack if configured
    const awsEndpoint = config.get('aws.endpoint')
    if (awsEndpoint) {
      sqsConfig.endpoint = awsEndpoint
    }

    this.sqsClient = new SQSClient(sqsConfig)
    this.queueUrl = config.get('sqs.queueUrl')
    this.queueName = config.get('sqs.queueName')
  }

  /**
   * Build message body from message data
   * @param {Object} messageData - Data to send to queue
   * @returns {Object} Message body
   */
  _buildMessageBody(messageData) {
    return {
      uploadId: messageData.uploadId,
      reviewId: messageData.reviewId || messageData.uploadId,
      filename: messageData.filename,
      s3Bucket: messageData.s3Bucket,
      s3Key: messageData.s3Key,
      s3Location: messageData.s3Location,
      contentType: messageData.contentType,
      fileSize: messageData.fileSize,
      uploadedAt: new Date().toISOString(),
      messageType: messageData.messageType || 'file_upload',
      textContent: messageData.textContent || null,
      userId: messageData.userId || 'anonymous',
      sessionId: messageData.sessionId || null
    }
  }

  /**
   * Create SQS send command
   * @param {Object} messageData - Message data
   * @param {Object} messageBody - Message body
   * @returns {SendMessageCommand} SQS command
   */
  _createSendCommand(messageData, messageBody) {
    return new SendMessageCommand({
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
    })
  }

  /**
   * Send message to SQS queue for content review
   * @param {Object} messageData - Data to send to queue
   * @returns {Promise<Object>} Send result
   */
  async sendMessage(messageData) {
    const messageBody = this._buildMessageBody(messageData)

    logger.info(
      {
        uploadId: messageData.uploadId,
        reviewId: messageData.reviewId,
        messageType: messageData.messageType,
        queueUrl: this.queueUrl,
        queueName: this.queueName,
        s3Key: messageData.s3Key,
        fileSize: messageData.fileSize
      },
      'Sending message to SQS queue'
    )

    const startTime = performance.now()
    const command = this._createSendCommand(messageData, messageBody)

    try {
      const result = await this.sqsClient.send(command)
      const duration = Math.round(performance.now() - startTime)

      logger.info({
        messageId: result.MessageId,
        uploadId: messageData.uploadId,
        reviewId: messageData.reviewId,
        queueUrl: this.queueUrl,
        queueName: this.queueName,
        durationMs: duration
      })

      return {
        success: true,
        messageId: result.MessageId,
        queueUrl: this.queueUrl
      }
    } catch (error) {
      const duration = Math.round(performance.now() - startTime)

      logger.error(
        {
          error: error.message,
          errorName: error.name,
          errorCode: error.Code,
          uploadId: messageData.uploadId,
          reviewId: messageData.reviewId,
          queueUrl: this.queueUrl,
          queueName: this.queueName,
          durationMs: duration
        },
        `SQS message send failed after ${duration}ms: ${error.message}`
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
