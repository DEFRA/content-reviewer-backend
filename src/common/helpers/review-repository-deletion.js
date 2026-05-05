import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

function buildCutoffDate(maxAgeInDays) {
  const cutoffDate = new Date()
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - maxAgeInDays)
  cutoffDate.setUTCHours(0, 0, 0, 0)
  return cutoffDate
}

async function deleteOrphanedFilesInPrefix(
  s3Client,
  bucket,
  prefix,
  cutoffTimestamp,
  label
) {
  let deletedCount = 0
  let continuationToken

  logger.info(
    { prefix, cutoffDate: new Date(cutoffTimestamp).toISOString() },
    `Checking for old ${label} files to delete`
  )

  try {
    do {
      const listResponse = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(continuationToken && { ContinuationToken: continuationToken })
        })
      )

      for (const object of listResponse.Contents ?? []) {
        if (
          object.LastModified &&
          object.LastModified.getTime() < cutoffTimestamp
        ) {
          try {
            await s3Client.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: object.Key })
            )
            logger.info(
              { key: object.Key },
              `Deleted old ${label} file from S3`
            )
            deletedCount++
          } catch (deleteError) {
            logger.error(
              { key: object.Key, error: deleteError.message },
              `Failed to delete old ${label} file`
            )
          }
        }
      }

      continuationToken = listResponse.IsTruncated
        ? listResponse.NextContinuationToken
        : undefined
    } while (continuationToken)
  } catch (error) {
    logger.error(
      { prefix, error: error.message },
      `Failed to list ${label} files for cleanup`
    )
    return 0
  }

  logger.info(
    { prefix, deletedCount },
    `Completed cleanup of old ${label} files`
  )
  return deletedCount
}

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

    // Delete the review JSON file directly using its known flat key
    const reviewKey = `${prefix}${reviewId}.json`
    await s3Client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: reviewKey })
    )

    logger.info(
      { reviewId, reviewKey, createdAt: review.createdAt },
      'Deleted old review'
    )

    return true
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
 * @param {number} maxAgeInDays - Maximum age of reviews to keep (default 5 days)
 * @returns {Promise<number>} Number of reviews deleted
 */
export async function deleteOldReviews(
  s3Client,
  bucket,
  prefix,
  getRecentReviewsFn,
  maxAgeInDays = 5
) {
  try {
    logger.info(
      { maxAgeInDays },
      'Checking if review cleanup is needed (by age)'
    )

    // Get all reviews (fetch up to 1000 to check all old ones)
    const { reviews } = await getRecentReviewsFn({ limit: 1000 })

    // Calculate cutoff date (reviews older than this will be deleted).
    // Truncate to midnight (UTC) so that a review created exactly N days ago
    // (at any time of day) is treated as AT the boundary and therefore kept.
    // Without truncation, sub-millisecond drift between new Date() calls in
    // the implementation and the test helper causes a boundary review's
    // timestamp to fall fractionally before the cutoff, triggering deletion.
    const cutoffDate = buildCutoffDate(maxAgeInDays)
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

/**
 * Delete positions files older than a specified age by listing the S3 prefix directly.
 * Handles orphaned files whose parent review has already been deleted.
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {number} maxAgeInDays - Maximum age of files to keep
 * @returns {Promise<number>} Number of files deleted
 */
export async function deleteOldPositionsFiles(s3Client, bucket, maxAgeInDays) {
  const cutoffDate = buildCutoffDate(maxAgeInDays)
  return deleteOrphanedFilesInPrefix(
    s3Client,
    bucket,
    'positions/',
    cutoffDate.getTime(),
    'positions'
  )
}

/**
 * Delete content-uploads files older than a specified age by listing the S3 prefix directly.
 * Handles orphaned files whose parent review has already been deleted.
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {number} maxAgeInDays - Maximum age of files to keep
 * @returns {Promise<number>} Number of files deleted
 */
export async function deleteOldContentUploads(s3Client, bucket, maxAgeInDays) {
  const cutoffDate = buildCutoffDate(maxAgeInDays)
  return deleteOrphanedFilesInPrefix(
    s3Client,
    bucket,
    'content-uploads/',
    cutoffDate.getTime(),
    'content-uploads'
  )
}
