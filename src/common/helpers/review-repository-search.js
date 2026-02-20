import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * Search for a review across multiple days
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} prefix - Reviews prefix
 * @param {string} reviewId - Review ID
 * @returns {Promise<Object|null>} Review or null if not found
 */
export async function searchReview(s3Client, bucket, prefix, reviewId) {
  try {
    const SEARCH_DAYS_BACK = 7
    for (let daysAgo = 0; daysAgo < SEARCH_DAYS_BACK; daysAgo++) {
      const review = await searchReviewForDay(
        s3Client,
        bucket,
        prefix,
        reviewId,
        daysAgo
      )
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
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} prefix - Reviews prefix
 * @param {string} reviewId - Review ID
 * @param {number} daysAgo - Number of days back to search
 * @returns {Promise<Object|null>} Review or null if not found
 */
export async function searchReviewForDay(
  s3Client,
  bucket,
  prefix,
  reviewId,
  daysAgo
) {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const searchPrefix = `${prefix}${year}/${month}/${day}/`

  const listCommand = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: searchPrefix,
    MaxKeys: 1000
  })

  const listResponse = await s3Client.send(listCommand)

  if (!listResponse.Contents) {
    return null
  }

  const matchingKey = listResponse.Contents.find((obj) =>
    obj.Key.includes(reviewId)
  )

  if (!matchingKey) {
    return null
  }

  return fetchReviewByKey(s3Client, bucket, matchingKey.Key)
}

/**
 * Fetch a review by its S3 key
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} key - S3 key
 * @returns {Promise<Object>} Review object
 */
export async function fetchReviewByKey(s3Client, bucket, key) {
  const getCommand = new GetObjectCommand({
    Bucket: bucket,
    Key: key
  })

  const response = await s3Client.send(getCommand)
  const body = await response.Body.transformToString()
  return JSON.parse(body)
}
