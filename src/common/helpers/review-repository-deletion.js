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
 * Delete old reviews to maintain storage limits
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} prefix - Reviews prefix
 * @param {Function} getRecentReviewsFn - Function to get recent reviews
 * @param {number} keepCount - Number of most recent reviews to keep
 * @returns {Promise<number>} Number of reviews deleted
 */
export async function deleteOldReviews(
  s3Client,
  bucket,
  prefix,
  getRecentReviewsFn,
  keepCount = 100
) {
  try {
    logger.info(
      { maxReviews: keepCount },
      'Checking if review cleanup is needed'
    )

    // Get all reviews sorted by most recent first (max 100 reviews in system)
    const { reviews } = await getRecentReviewsFn({ limit: 100 })

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
