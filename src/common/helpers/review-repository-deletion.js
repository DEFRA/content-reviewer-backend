import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * Delete uploaded content file from S3
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} reviewId - Review ID
 * @param {string} s3Key - S3 key of the content file
 * @param {Array} deletedKeys - Array to track deleted keys
 * @returns {Promise<void>}
 */
export async function deleteUploadedContent(
  s3Client,
  bucket,
  reviewId,
  s3Key,
  deletedKeys
) {
  try {
    const deleteContentCommand = new DeleteObjectCommand({
      Bucket: bucket,
      Key: s3Key
    })

    await s3Client.send(deleteContentCommand)
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
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} reviewKey - S3 key for review metadata
 * @param {string} reviewId - Review ID
 * @param {Array} deletedKeys - Array to track deleted keys
 * @returns {Promise<void>}
 */
export async function deleteReviewMetadataFile(
  s3Client,
  bucket,
  reviewKey,
  reviewId,
  deletedKeys
) {
  const deleteReviewCommand = new DeleteObjectCommand({
    Bucket: bucket,
    Key: reviewKey
  })

  await s3Client.send(deleteReviewCommand)
  deletedKeys.push(reviewKey)

  logger.info({ reviewId, reviewKey }, 'Deleted review metadata from S3')
}

/**
 * Delete all S3 objects for a specific review
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} prefix - Reviews prefix
 * @param {Object} review - Review object to delete
 * @returns {Promise<boolean>} True if deleted successfully, false otherwise
 */
export async function deleteSingleOldReview(s3Client, bucket, prefix, review) {
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
      Bucket: bucket,
      Prefix: `${prefix}${reviewId}/`
    })

    const listResponse = await s3Client.send(listCommand)

    if (listResponse.Contents && listResponse.Contents.length > 0) {
      // Delete all objects for this review
      const deletePromises = listResponse.Contents.map((obj) => {
        const deleteCommand = new DeleteObjectCommand({
          Bucket: bucket,
          Key: obj.Key
        })
        return s3Client.send(deleteCommand)
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
 * Delete reviews older than a specified age
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} prefix - Reviews prefix
 * @param {Function} getRecentReviewsFn - Function to get recent reviews
 * @param {number} maxAgeInDays - Maximum age of reviews to keep (default 30 days / 1 month)
 * @returns {Promise<number>} Number of reviews deleted
 */
export async function deleteOldReviews(
  s3Client,
  bucket,
  prefix,
  getRecentReviewsFn,
  maxAgeInDays = 30
) {
  try {
    logger.info(
      { maxAgeInDays },
      'Checking if review cleanup is needed (by age)'
    )

    // Get all reviews (fetch up to 1000 to check all old ones)
    const { reviews } = await getRecentReviewsFn({ limit: 1000 })

    // Calculate cutoff date (reviews older than this will be deleted)
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeInDays)
    const cutoffTimestamp = cutoffDate.getTime()

    logger.info(
      {
        maxAgeInDays,
        cutoffDate: cutoffDate.toISOString(),
        cutoffTimestamp
      },
      `Reviews older than ${cutoffDate.toISOString()} will be deleted`
    )

    // Filter reviews older than cutoff date
    const reviewsToDelete = reviews.filter((review) => {
      // Use createdAt or uploadedAt timestamp
      const reviewDate = new Date(review.createdAt || review.uploadedAt)
      const reviewTimestamp = reviewDate.getTime()
      return reviewTimestamp < cutoffTimestamp
    })

    if (reviewsToDelete.length === 0) {
      logger.info(
        { totalReviews: reviews.length, maxAgeInDays },
        'No cleanup needed - no reviews older than cutoff date'
      )
      return 0
    }

    logger.info(
      {
        totalReviews: reviews.length,
        maxAgeInDays,
        cutoffDate: cutoffDate.toISOString(),
        deleteCount: reviewsToDelete.length
      },
      `Starting cleanup of reviews older than ${maxAgeInDays} days`
    )

    let deletedCount = 0

    // Delete old reviews
    for (const review of reviewsToDelete) {
      const deleted = await deleteSingleOldReview(
        s3Client,
        bucket,
        prefix,
        review
      )
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
