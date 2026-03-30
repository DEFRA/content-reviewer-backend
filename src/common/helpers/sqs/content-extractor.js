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
   * Extract text content based on message type.
   *
   * For text_review messages the SQS key now points to a canonical document
   * (documents/{reviewId}.json).  We read `canonicalText` from that JSON.
   * If the key still points to a legacy plain-text file (content-uploads/…)
   * we fall back to reading the buffer as UTF-8 so old messages keep working.
   *
   * Returns { canonicalText, displayText } where displayText is the Markdown-
   * link-preserved version for URL sources (null for file/text sources).
   */
  async extractTextContent(reviewId, messageBody) {
    if (messageBody.messageType === 'file_review') {
      const text = await this.extractTextFromFile(reviewId, messageBody)
      return { canonicalText: text, displayText: null }
    }

    if (messageBody.messageType === 'text_review') {
      return this.extractTextFromCanonicalDocument(reviewId, messageBody)
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
   * Extract text from a canonical document stored in S3 as
   * documents/{reviewId}.json.
   *
   * Reads the JSON and returns the `canonicalText` field.
   * Falls back to treating the body as plain text for legacy keys
   * (content-uploads/…/Title.txt) so old SQS messages keep working.
   */
  async extractTextFromCanonicalDocument(reviewId, messageBody) {
    logger.info(
      {
        reviewId,
        s3Bucket: messageBody.s3Bucket,
        s3Key: messageBody.s3Key
      },
      'Canonical document download started'
    )

    const s3StartTime = performance.now()
    const buffer = await this.downloadFromS3(
      messageBody.s3Bucket,
      messageBody.s3Key
    )
    const s3Duration = Math.round(performance.now() - s3StartTime)
    const rawString = buffer.toString('utf-8')

    // Detect whether this is a canonical document (JSON) or legacy plain-text
    const isCanonicalDocument =
      messageBody.s3Key.startsWith('documents/') &&
      messageBody.s3Key.endsWith('.json')

    if (isCanonicalDocument) {
      let canonicalDoc
      try {
        canonicalDoc = JSON.parse(rawString)
      } catch (parseError) {
        logger.error(
          { reviewId, s3Key: messageBody.s3Key, error: parseError.message },
          'Failed to parse canonical document JSON — falling back to raw text'
        )
        return { canonicalText: rawString, displayText: null }
      }

      const canonicalText = canonicalDoc.canonicalText

      if (!canonicalText || typeof canonicalText !== 'string') {
        logger.error(
          {
            reviewId,
            s3Key: messageBody.s3Key,
            documentId: canonicalDoc.documentId,
            status: canonicalDoc.status
          },
          'Canonical document missing canonicalText field — falling back to raw document JSON'
        )
        return { canonicalText: rawString, displayText: null }
      }

      logger.info(
        {
          reviewId,
          s3Key: messageBody.s3Key,
          documentId: canonicalDoc.documentId,
          charCount: canonicalDoc.charCount,
          tokenEst: canonicalDoc.tokenEst,
          sourceType: canonicalDoc.sourceType,
          hasDisplayText: !!canonicalDoc.displayText,
          durationMs: s3Duration
        },
        `Canonical document read successfully in ${s3Duration}ms — using canonicalText (${canonicalDoc.charCount} chars)`
      )

      return {
        canonicalText,
        displayText: canonicalDoc.displayText ?? null
      }
    }

    // Legacy plain-text fallback (content-uploads/…/Title.txt)
    logger.info(
      {
        reviewId,
        s3Key: messageBody.s3Key,
        contentLength: rawString.length,
        durationMs: s3Duration
      },
      `Legacy plain-text S3 content read in ${s3Duration}ms`
    )

    return { canonicalText: rawString, displayText: null }
  }

  /**
   * @deprecated Use extractTextFromCanonicalDocument for text_review messages.
   * Kept for direct calls in tests / legacy paths only.
   */
  async extractTextFromS3(reviewId, messageBody) {
    logger.info(
      {
        reviewId,
        s3Bucket: messageBody.s3Bucket,
        s3Key: messageBody.s3Key
      },
      'S3 text content download started (legacy)'
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
