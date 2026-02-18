import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand
} from '@aws-sdk/client-s3'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'
import { piiRedactor } from './pii-redactor.js'

const logger = createLogger()

/**
 * S3-based repository for content reviews
 * Stores review data as JSON files in S3
 */
class ReviewRepositoryS3 {
  constructor() {
    const s3Config = {
      region: config.get('aws.region')
    }

    // Add endpoint for LocalStack if configured
    const awsEndpoint = config.get('aws.endpoint')
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true // Required for LocalStack
      logger.info(
        { endpoint: awsEndpoint },
        'Using custom AWS endpoint (LocalStack)'
      )
    }

    this.s3Client = new S3Client(s3Config)

    this.bucket = config.get('s3.bucket')
    this.prefix = 'reviews/'

    logger.info(
      {
        bucket: this.bucket,
        prefix: this.prefix,
        endpoint: awsEndpoint || 'AWS'
      },
      'Review repository initialized with S3'
    )
  }

  /**
   * Generate S3 key for a review
   * @param {string} reviewId - Review ID
   * @returns {string} S3 key
   */
  getReviewKey(reviewId) {
    // Organize by date for easier browsing: reviews/2026/01/13/review_123.json
    return `${this.prefix}${reviewId}.json`
  }

  /**
   * Connect to S3 (no-op, kept for interface compatibility)
   */
  async connect() {
    // S3 doesn't need explicit connection
    logger.info('S3 client ready')
    return true
  }

  /**
   * Create a new review record
   * @param {Object} reviewData - Review data
   * @returns {Promise<Object>} Created review
   */
  async createReview(reviewData) {
    const now = new Date().toISOString()

    logger.info(
      {
        reviewId: reviewData.id,
        sourceType: reviewData.sourceType,
        fileName: reviewData.fileName,
        fileSize: reviewData.fileSize,
        hasS3Key: !!reviewData.s3Key
      },
      'Creating review in repository'
    )

    const review = {
      id: reviewData.id,
      status: 'pending', // pending, processing, completed, failed
      createdAt: now,
      updatedAt: now,
      sourceType: reviewData.sourceType, // 'file' or 'text'
      fileName: reviewData.fileName || null,
      fileSize: reviewData.fileSize || null,
      mimeType: reviewData.mimeType || null,
      s3Key: reviewData.s3Key || null, // S3 reference for both files AND text content
      result: null,
      error: null,
      processingStartedAt: null,
      processingCompletedAt: null,
      bedrockUsage: null
    }

    logger.info(
      {
        reviewId: review.id,
        fileName: review.fileName,
        createdAt: review.createdAt,
        s3Key: review.s3Key,
        sourceType: review.sourceType
      },
      'Creating review'
    )

    await this.saveReview(review)

    // Trigger async cleanup to keep only recent 100 reviews (don't wait for it)
    this.deleteOldReviews(100).catch((error) => {
      logger.error(
        { error: error.message },
        'Background cleanup failed (non-critical)'
      )
    })

    return review
  }

  /**
   * Redact PII from review improvements
   * @param {Array} improvements - Array of improvement objects
   * @returns {Array} Redacted improvements
   */
  redactImprovements(improvements) {
    return improvements.map((improvement) => {
      const redactedImprovement = { ...improvement }
      if (improvement.current) {
        const redacted = piiRedactor.redact(improvement.current, {
          preserveFormat: false
        })
        redactedImprovement.current = redacted.redactedText
      }
      if (improvement.suggested) {
        const redacted = piiRedactor.redact(improvement.suggested, {
          preserveFormat: false
        })
        redactedImprovement.suggested = redacted.redactedText
      }
      return redactedImprovement
    })
  }

  /**
   * Redact PII from review results
   * @param {Object} review - Review object
   * @returns {Object} PII redaction information
   */
  redactPIIFromReview(review) {
    let piiRedactionInfo = { hasPII: false, redactionCount: 0 }

    if (!review.result) {
      return piiRedactionInfo
    }

    // Redact PII from raw response
    if (review.result.rawResponse) {
      const redactionResult = piiRedactor.redactBedrockResponse(
        review.result.rawResponse
      )
      review.result.rawResponse = redactionResult.redactedText
      piiRedactionInfo = {
        hasPII: redactionResult.hasPII,
        redactionCount: redactionResult.redactionCount,
        detectedPII: redactionResult.detectedPII
      }
    }

    // Redact PII from reviewData
    if (review.result.reviewData) {
      if (Array.isArray(review.result.reviewData.improvements)) {
        review.result.reviewData.improvements = this.redactImprovements(
          review.result.reviewData.improvements
        )
      }

      if (review.result.reviewData.reviewedContent?.plainText) {
        const redacted = piiRedactor.redact(
          review.result.reviewData.reviewedContent.plainText,
          { preserveFormat: false }
        )
        review.result.reviewData.reviewedContent.plainText =
          redacted.redactedText
      }
    }

    return piiRedactionInfo
  }

  /**
   * Save review to S3
   * @param {Object} review - Review object
   * @returns {Promise<void>}
   */
  async saveReview(review) {
    const key = this.getReviewKey(review.id)

    // Redact PII from review results before saving to S3
    const piiRedactionInfo = this.redactPIIFromReview(review)

    logger.info(
      {
        reviewId: review.id,
        fileName: review.fileName,
        createdAt: review.createdAt,
        status: review.status,
        hasResult: !!review.result,
        s3Key: review.s3Key,
        piiRedacted: piiRedactionInfo.hasPII,
        piiRedactionCount: piiRedactionInfo.redactionCount
      },
      piiRedactionInfo.hasPII
        ? `Saving review to S3 - PII REDACTED (${piiRedactionInfo.redactionCount} instances)`
        : 'Saving review to S3'
    )

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: JSON.stringify(review, null, 2),
      ContentType: 'application/json',
      Metadata: {
        reviewId: review.id,
        status: review.status,
        sourceType: review.sourceType,
        piiRedacted: piiRedactionInfo.hasPII ? 'true' : 'false'
      }
    })

    try {
      await this.s3Client.send(command)
      logger.info({
        reviewId: review.id,
        key,
        fileName: review.fileName,
        createdAt: review.createdAt
      })
    } catch (error) {
      logger.error(
        { error: error.message, reviewId: review.id },
        'Failed to save review to S3'
      )
      throw error
    }
  }

  /**
   * Get a review by ID
   * @param {string} reviewId - Review ID
   * @returns {Promise<Object|null>} Review or null if not found
   */
  async getReview(reviewId) {
    // Try to find the review by searching with the prefix pattern
    // Since we don't know the exact date, we'll try recent dates or search

    try {
      // Strategy 1: Try today first
      const key = this.getReviewKey(reviewId)

      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      })

      const response = await this.s3Client.send(command)
      const body = await response.Body.transformToString()
      return JSON.parse(body)
    } catch (error) {
      if (error.name === 'NoSuchKey') {
        // Strategy 2: Search for the review in recent days
        return this.searchReview(reviewId)
      }
      logger.error(
        { error: error.message, reviewId },
        'Failed to get review from S3'
      )
      throw error
    }
  }

  /**
   * Search for a review across multiple days
   * @param {string} reviewId - Review ID
   * @returns {Promise<Object|null>} Review or null if not found
   */
  async searchReview(reviewId) {
    try {
      const SEARCH_DAYS_BACK = 7
      for (let daysAgo = 0; daysAgo < SEARCH_DAYS_BACK; daysAgo++) {
        const review = await this.searchReviewForDay(reviewId, daysAgo)
        if (review) {
          return review
        }
      }

      logger.warn({ reviewId }, 'Review not found in S3 (searched last 7 days)')
      return null
    } catch (error) {
      logger.error(
        { error: error.message, reviewId },
        'Failed to search for review'
      )
      throw error
    }
  }

  /**
   * Search for a review in a specific day
   * @param {string} reviewId - Review ID
   * @param {number} daysAgo - Number of days back to search
   * @returns {Promise<Object|null>} Review or null if not found
   */
  async searchReviewForDay(reviewId, daysAgo) {
    const date = new Date()
    date.setDate(date.getDate() - daysAgo)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const prefix = `${this.prefix}${year}/${month}/${day}/`

    const listCommand = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      MaxKeys: 1000
    })

    const listResponse = await this.s3Client.send(listCommand)

    if (!listResponse.Contents) {
      return null
    }

    const matchingKey = listResponse.Contents.find((obj) =>
      obj.Key.includes(reviewId)
    )

    if (!matchingKey) {
      return null
    }

    return this.fetchReviewByKey(matchingKey.Key)
  }

  /**
   * Fetch a review by its S3 key
   * @param {string} key - S3 key
   * @returns {Promise<Object>} Review object
   */
  async fetchReviewByKey(key) {
    const getCommand = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key
    })

    const response = await this.s3Client.send(getCommand)
    const body = await response.Body.transformToString()
    return JSON.parse(body)
  }

  /**
   * Update review metadata (tags, custom fields, etc.)
   * @param {string} reviewId - Review ID
   * @param {Object} metadata - Metadata to add/update
   * @returns {Promise<void>}
   */
  async updateReviewMetadata(reviewId, metadata) {
    const review = await this.getReview(reviewId)

    if (!review) {
      throw new Error(`Review not found: ${reviewId}`)
    }

    logger.info(
      {
        reviewId,
        metadataKeys: Object.keys(metadata)
      },
      'Updating review metadata'
    )

    // Initialize metadata object if it doesn't exist
    if (!review.metadata) {
      review.metadata = {}
    }

    // Merge metadata
    review.metadata = {
      ...review.metadata,
      ...metadata
    }

    review.updatedAt = new Date().toISOString()

    await this.saveReview(review)
    logger.info({ reviewId }, 'Review metadata updated in S3')
  }

  /**
   * Preserve immutable fields from a review
   * @param {Object} review - Review object
   * @returns {Object} Preserved immutable fields
   */
  preserveImmutableFields(review) {
    return {
      fileName: review.fileName,
      createdAt: review.createdAt,
      s3Key: review.s3Key,
      id: review.id,
      sourceType: review.sourceType
    }
  }

  /**
   * Remove immutable fields from additional data and log warnings
   * @param {Object} additionalData - Additional data to sanitize
   * @param {string} reviewId - Review ID for logging
   * @param {Object} preservedFields - Preserved immutable fields
   * @returns {Object} Sanitized additional data
   */
  sanitizeAdditionalData(additionalData, reviewId, preservedFields) {
    const safeData = { ...additionalData }
    const immutableKeys = ['fileName', 'createdAt', 's3Key', 'id', 'sourceType']

    immutableKeys.forEach((key) => {
      if (additionalData[key] !== undefined) {
        logger.warn(
          {
            reviewId,
            [`attempted${key.charAt(0).toUpperCase() + key.slice(1)}`]:
              additionalData[key],
            [`preserved${key.charAt(0).toUpperCase() + key.slice(1)}`]:
              preservedFields[key]
          },
          `Blocked attempt to overwrite ${key} in additionalData`
        )
        delete safeData[key]
      }
    })

    return safeData
  }

  /**
   * Restore immutable fields to review object
   * @param {Object} review - Review object to restore fields to
   * @param {Object} preservedFields - Preserved immutable fields
   * @param {string} reviewId - Review ID for logging
   */
  restoreImmutableFields(review, preservedFields, reviewId) {
    Object.entries(preservedFields).forEach(([key, value]) => {
      review[key] = value

      if (!review[key] && value) {
        logger.warn(
          {
            reviewId,
            [`preserved${key.charAt(0).toUpperCase() + key.slice(1)}`]: value
          },
          `Restored ${key} after merge`
        )
      }
    })
  }

  /**
   * Update processing timestamps based on status
   * @param {Object} review - Review object
   * @param {string} status - New status
   * @param {string} now - Current timestamp
   */
  updateProcessingTimestamps(review, status, now) {
    if (status === 'processing' && !review.processingStartedAt) {
      review.processingStartedAt = now
    }
    if (
      (status === 'completed' || status === 'failed') &&
      !review.processingCompletedAt
    ) {
      review.processingCompletedAt = now
    }
  }

  /**
   * Update review status
   * @param {string} reviewId - Review ID
   * @param {string} status - New status
   * @param {Object} additionalData - Additional data to update
   * @returns {Promise<void>}
   */
  async updateReviewStatus(reviewId, status, additionalData = {}) {
    const review = await this.getReview(reviewId)

    if (!review) {
      throw new Error(`Review not found: ${reviewId}`)
    }

    logger.info(
      {
        reviewId,
        statusBefore: review.status,
        statusAfter: status,
        fileNameBefore: review.fileName,
        createdAtBefore: review.createdAt
      },
      'Updating review status'
    )

    const now = new Date().toISOString()
    const preservedFields = this.preserveImmutableFields(review)

    // Update mutable fields
    review.status = status
    review.updatedAt = now

    // Sanitize and merge additional data
    const safeAdditionalData = this.sanitizeAdditionalData(
      additionalData,
      reviewId,
      preservedFields
    )
    Object.assign(review, safeAdditionalData)

    // Restore immutable fields
    this.restoreImmutableFields(review, preservedFields, reviewId)

    // Update processing timestamps
    this.updateProcessingTimestamps(review, status, now)

    logger.info(
      {
        reviewId,
        status: review.status,
        fileNameAfter: review.fileName,
        createdAtAfter: review.createdAt,
        updatedAt: review.updatedAt
      },
      'Updating review status'
    )

    await this.saveReview(review)
    logger.info({ reviewId, status }, 'Review status updated in S3')
  }

  /**
   * Save review result
   * @param {string} reviewId - Review ID
   * @param {Object} result - Review result from Bedrock
   * @param {Object} usage - Bedrock usage statistics
   * @returns {Promise<void>}
   */
  async saveReviewResult(reviewId, result, usage) {
    // Update review status to 'completed' and add result + usage
    // This saves the COMPLETE review object with fileName, createdAt, etc.
    await this.updateReviewStatus(reviewId, 'completed', {
      result,
      bedrockUsage: usage
    })

    // ❌ REMOVED: resultsStorage.storeResult() was overwriting the review file
    // with only {jobId, status, result, completedAt}, losing fileName and createdAt
    // The updateReviewStatus() already saves the complete review via saveReview()

    logger.info({ reviewId, hasResult: !!result, hasUsage: !!usage })
  }

  /**
   * Save review error
   * @param {string} reviewId - Review ID
   * @param {string|Error} error - Error message or Error object
   * @returns {Promise<void>}
   */
  async saveReviewError(reviewId, error) {
    const errorMessage = typeof error === 'string' ? error : error.message
    const errorStack = typeof error === 'string' ? null : error.stack

    logger.info(
      {
        reviewId,
        errorMessage,
        hasStack: !!errorStack
      },
      'Saving review error to S3'
    )

    try {
      await this.updateReviewStatus(reviewId, 'failed', {
        error: {
          message: errorMessage,
          stack: errorStack
        }
      })

      logger.info(
        {
          reviewId,
          errorMessage
        },
        'Review error saved successfully to S3'
      )
    } catch (updateError) {
      logger.error(
        {
          reviewId,
          errorMessage,
          updateError: updateError.message,
          updateErrorStack: updateError.stack
        },
        'Failed to update review status to failed in S3'
      )
      throw updateError
    }
  }

  /**
   * Get recent reviews (paginated)
   * @param {Object} options - Query options
   * @param {number} options.limit - Maximum number of reviews to return
   * @param {string} options.continuationToken - Token for pagination
   * @returns {Promise<Object>} Reviews and pagination info
   */
  async getRecentReviews({ limit = 20, continuationToken = null } = {}) {
    try {
      // Fetch enough objects to ensure we can properly sort and limit
      // System maintains max 100 reviews, so always fetch all 100 to ensure accurate sorting
      const fetchLimit = 100

      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.prefix,
        MaxKeys: fetchLimit,
        ContinuationToken: continuationToken || undefined
      })

      const response = await this.s3Client.send(listCommand)

      if (!response.Contents || response.Contents.length === 0) {
        return {
          reviews: [],
          hasMore: false,
          nextToken: null
        }
      }

      // First, sort ALL S3 objects by LastModified (most recent first)
      // This ensures we process the most recent files without mutating the original array
      const sortedContents = response.Contents.slice().sort((a, b) => {
        return (
          new Date(b.LastModified).getTime() -
          new Date(a.LastModified).getTime()
        )
      })

      // Fetch the actual review data for the most recent objects
      // Now we take the limit AFTER sorting, ensuring we get the truly most recent
      const reviewPromises = sortedContents.slice(0, limit).map(async (obj) => {
        try {
          const getCommand = new GetObjectCommand({
            Bucket: this.bucket,
            Key: obj.Key
          })
          const reviewResponse = await this.s3Client.send(getCommand)
          const body = await reviewResponse.Body.transformToString()
          const review = JSON.parse(body)
          // Add S3 LastModified to the review object for accurate sorting/display
          review.lastModified = obj.LastModified?.toISOString()
          return review
        } catch (error) {
          logger.warn(
            { key: obj.Key, error: error.message },
            'Failed to load review'
          )
          return null
        }
      })

      const reviews = (await Promise.all(reviewPromises)).filter(
        (r) => r !== null
      )

      // Sort reviews by lastModified (S3 LastModified) for most accurate ordering
      // This ensures reviews are sorted by their actual modification time in S3
      reviews.sort((a, b) => {
        const aTime = new Date(
          a.lastModified || a.updatedAt || a.createdAt
        ).getTime()
        const bTime = new Date(
          b.lastModified || b.updatedAt || b.createdAt
        ).getTime()
        return bTime - aTime // Most recent first
      })

      logger.info(
        {
          fetchedCount: response.Contents.length,
          requestedLimit: limit,
          returnedCount: reviews.length
        },
        'Retrieved and sorted reviews from S3'
      )

      return {
        reviews,
        hasMore: response.IsTruncated || false,
        nextToken: response.NextContinuationToken || null
      }
    } catch (error) {
      logger.error(
        { error: error.message },
        'Failed to get recent reviews from S3'
      )
      throw error
    }
  }

  /**
   * Get reviews by status
   * @param {string} status - Status to filter by
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Array of reviews
   */
  async getReviewsByStatus(status, options = {}) {
    const { reviews } = await this.getRecentReviews(options)
    return reviews.filter((review) => review.status === status)
  }

  /**
   * Get all reviews (paginated)
   * @param {number} limit - Maximum number of reviews to return
   * @param {number} skip - Number of reviews to skip (for pagination)
   * @returns {Promise<Array>} Array of reviews
   */
  async getAllReviews(limit = 50, skip = 0) {
    try {
      // Get more than needed to handle skip
      const fetchLimit = limit + skip
      const { reviews } = await this.getRecentReviews({ limit: fetchLimit })
      logger.info(
        {
          count: reviews.length,
          reviewIds: reviews.map((r) => r.id),
          statuses: reviews.map((r) => r.status)
        },
        'Retrieved reviews from S3'
      )
      // Apply skip and limit
      return reviews.slice(skip, skip + limit)
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get all reviews')
      throw error
    }
  }

  /**
   * Get total count of reviews
   * @returns {Promise<number>} Total number of reviews
   */
  async getReviewCount() {
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.prefix
      })

      let count = 0
      let continuationToken = null

      do {
        listCommand.input.ContinuationToken = continuationToken
        const response = await this.s3Client.send(listCommand)
        count += response.KeyCount || 0
        continuationToken = response.NextContinuationToken
      } while (continuationToken)

      return count
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get review count')
      throw error
    }
  }

  /**
   * Delete uploaded content file from S3
   * @param {string} reviewId - Review ID
   * @param {string} s3Key - S3 key of the content file
   * @param {Array} deletedKeys - Array to track deleted keys
   * @returns {Promise<void>}
   */
  async deleteUploadedContent(reviewId, s3Key, deletedKeys) {
    try {
      const deleteContentCommand = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: s3Key
      })

      await this.s3Client.send(deleteContentCommand)
      deletedKeys.push(s3Key)

      logger.info({ reviewId, s3Key }, 'Deleted uploaded content from S3')
    } catch (error) {
      logger.error(
        {
          reviewId,
          s3Key,
          error: error.message
        },
        'Failed to delete uploaded content (may not exist)'
      )
      // Continue even if content deletion fails
    }
  }

  /**
   * Delete review metadata file from S3
   * @param {string} reviewId - Review ID
   * @param {Array} deletedKeys - Array to track deleted keys
   * @returns {Promise<void>}
   */
  async deleteReviewMetadataFile(reviewId, deletedKeys) {
    const reviewKey = this.getReviewKey(reviewId)

    const deleteReviewCommand = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: reviewKey
    })

    await this.s3Client.send(deleteReviewCommand)
    deletedKeys.push(reviewKey)

    logger.info({ reviewId, reviewKey }, 'Deleted review metadata from S3')
  }

  /**
   * Delete a review and its associated content from S3
   * @param {string} reviewId - Review ID to delete
   * @returns {Promise<Object>} Deletion result with details
   */
  async deleteReview(reviewId) {
    try {
      logger.info({ reviewId }, 'Deleting review and associated content')

      const review = await this.getReview(reviewId)

      if (!review) {
        logger.warn({ reviewId }, 'Review not found for deletion')
        throw new Error(`Review not found: ${reviewId}`)
      }

      const deletedKeys = []

      // Delete the uploaded content file if it exists
      if (review.s3Key) {
        await this.deleteUploadedContent(reviewId, review.s3Key, deletedKeys)
      }

      // Delete the review metadata file
      await this.deleteReviewMetadataFile(reviewId, deletedKeys)

      logger.info(
        {
          reviewId,
          deletedKeys,
          deletedCount: deletedKeys.length
        },
        'Review and associated content deleted successfully'
      )

      return {
        success: true,
        reviewId,
        deletedKeys,
        deletedCount: deletedKeys.length,
        fileName: review.fileName,
        status: review.status
      }
    } catch (error) {
      logger.error(
        {
          reviewId,
          error: error.message,
          stack: error.stack
        },
        'Failed to delete review'
      )
      throw error
    }
  }

  /**
   * Delete all S3 objects for a specific review
   * @param {Object} review - Review object to delete
   * @returns {Promise<boolean>} True if deleted successfully, false otherwise
   */
  async deleteSingleOldReview(review) {
    try {
      const reviewId = review.id || review.reviewId

      if (!reviewId) {
        logger.warn(
          {
            hasId: !!review.id,
            hasReviewId: !!review.reviewId,
            status: review.status,
            createdAt: review.createdAt
          },
          'Skipping review without ID'
        )
        return false
      }

      // List all objects for this review
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: `${this.prefix}${reviewId}/`
      })

      const listResponse = await this.s3Client.send(listCommand)

      if (listResponse.Contents && listResponse.Contents.length > 0) {
        // Delete all objects for this review
        const deletePromises = listResponse.Contents.map((obj) => {
          const deleteCommand = new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: obj.Key
          })
          return this.s3Client.send(deleteCommand)
        })

        await Promise.all(deletePromises)

        logger.info(
          {
            reviewId,
            filesDeleted: listResponse.Contents.length,
            createdAt: review.createdAt
          },
          'Deleted old review'
        )
        return true
      }

      return false
    } catch (deleteError) {
      logger.error(
        { error: deleteError.message, reviewId: review.id },
        'Failed to delete individual review'
      )
      return false
    }
  }

  /**
   * Delete old reviews to maintain storage limits
   * @param {number} keepCount - Number of most recent reviews to keep
   * @returns {Promise<number>} Number of reviews deleted
   */
  async deleteOldReviews(keepCount = 100) {
    try {
      logger.info(
        { maxReviews: keepCount },
        'Checking if review cleanup is needed'
      )

      // Get all reviews sorted by most recent first (max 100 reviews in system)
      const { reviews } = await this.getRecentReviews({ limit: 100 })

      if (reviews.length <= keepCount) {
        logger.info(
          { currentCount: reviews.length, maxReviews: keepCount },
          'No cleanup needed - review count within limit'
        )
        return 0
      }

      // Get reviews to delete (everything after the first maxReviews)
      const reviewsToDelete = reviews.slice(keepCount)

      logger.info(
        {
          totalReviews: reviews.length,
          keepCount,
          deleteCount: reviewsToDelete.length
        },
        'Starting cleanup of old reviews'
      )

      let deletedCount = 0

      // Delete old reviews
      for (const review of reviewsToDelete) {
        const deleted = await this.deleteSingleOldReview(review)
        if (deleted) {
          deletedCount++
        }
      }

      logger.info(
        { deletedCount, requestedDelete: reviewsToDelete.length },
        'Review cleanup completed'
      )

      return deletedCount
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to delete old reviews')
      throw error
    }
  }

  /**
   * Disconnect (no-op for S3)
   */
  async disconnect() {
    logger.info('S3 client disconnected (no-op)')
  }
}

// Export singleton instance
export const reviewRepository = new ReviewRepositoryS3()
