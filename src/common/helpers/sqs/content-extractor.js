import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { config } from '../../../config.js'
import { createLogger } from '../logging/logger.js'
import { textExtractor } from '../text-extractor.js'

const logger = createLogger()

const AWS_REGION = 'aws.region'
const AWS_ENDPOINT = 'aws.endpoint'

/**
 * Content Extractor - handles S3 downloads and text extraction
 */
export class ContentExtractor {
  constructor() {
    const s3Config = {
      region: config.get(AWS_REGION)
    }

    const awsEndpoint = config.get(AWS_ENDPOINT)
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true
    }

    this.s3Client = new S3Client(s3Config)
  }

  /**
   * Download file from S3 and return as buffer
   */
  async downloadFromS3(bucket, key) {
    const s3Response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key
      })
    )

    const chunks = []
    for await (const chunk of s3Response.Body) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  /**
   * Extract text content based on message type
   */
  async extractTextContent(reviewId, messageBody) {
    if (messageBody.messageType === 'file_review') {
      return this.extractTextFromFile(reviewId, messageBody)
    }

    if (messageBody.messageType === 'text_review') {
      return this.extractTextFromS3(reviewId, messageBody)
    }

    throw new Error(`Unknown message type: ${messageBody.messageType}`)
  }

  /**
   * Extract text from uploaded file
   */
  async extractTextFromFile(reviewId, messageBody) {
    logger.info(
      {
        reviewId,
        s3Bucket: messageBody.s3Bucket,
        s3Key: messageBody.s3Key
      },
      'S3 file download started'
    )

    const s3StartTime = performance.now()
    const buffer = await this.downloadFromS3(
      messageBody.s3Bucket,
      messageBody.s3Key
    )
    const s3Duration = Math.round(performance.now() - s3StartTime)

    logger.info(
      {
        reviewId,
        s3Key: messageBody.s3Key,
        downloadedBytes: buffer.length,
        durationMs: s3Duration
      },
      `S3 file downloaded in ${s3Duration}ms`
    )

    logger.info(
      {
        reviewId,
        mimeType: messageBody.contentType,
        fileSize: buffer.length
      },
      'Text extraction started'
    )

    const extractStartTime = performance.now()
    const textContent = await textExtractor.extractText(
      buffer,
      messageBody.contentType,
      messageBody.filename
    )
    const extractDuration = Math.round(performance.now() - extractStartTime)

    logger.info(
      {
        reviewId,
        extractedLength: textContent.length,
        wordCount: textExtractor.countWords(textContent),
        durationMs: extractDuration
      },
      `Text extracted successfully in ${extractDuration}ms`
    )

    return textContent
  }

  /**
   * Extract text content from S3
   */
  async extractTextFromS3(reviewId, messageBody) {
    logger.info(
      {
        reviewId,
        s3Bucket: messageBody.s3Bucket,
        s3Key: messageBody.s3Key
      },
      'S3 text content download started'
    )

    const s3StartTime = performance.now()
    const buffer = await this.downloadFromS3(
      messageBody.s3Bucket,
      messageBody.s3Key
    )
    const textContent = buffer.toString('utf-8')
    const s3Duration = Math.round(performance.now() - s3StartTime)

    logger.info(
      {
        reviewId,
        contentLength: textContent.length,
        durationMs: s3Duration
      },
      `S3 text content downloaded in ${s3Duration}ms`
    )

    return textContent
  }
}
