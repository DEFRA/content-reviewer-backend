import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * Fetch a single review from S3
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {Object} obj - S3 object metadata
 * @returns {Promise<Object|null>} Review object or null if failed
 */
async function fetchSingleReview(s3Client, bucket, obj) {
  try {
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: obj.Key
    })
    const reviewResponse = await s3Client.send(getCommand)
    const body = await reviewResponse.Body.transformToString()
    const review = JSON.parse(body)
    // Add S3 LastModified to the review object for accurate sorting/display
    review.lastModified = obj.LastModified?.toISOString()
    return review
  } catch (error) {
    logger.warn({ key: obj.Key, error: error.message }, 'Failed to load review')
    return null
  }
}

/**
 * Sort reviews by last modified timestamp
 * @param {Array} reviews - Array of reviews
 * @returns {Array} Sorted reviews (most recent first)
 */
function sortReviewsByLastModified(reviews) {
  return reviews.sort((a, b) => {
    const aTime = new Date(
      a.lastModified || a.updatedAt || a.createdAt
    ).getTime()
    const bTime = new Date(
      b.lastModified || b.updatedAt || b.createdAt
    ).getTime()
    return bTime - aTime // Most recent first
  })
}

/**
 * Get recent reviews (paginated)
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} prefix - Reviews prefix
 * @param {Object} options - Query options
 * @param {number} options.limit - Maximum number of reviews to return
 * @param {string} options.continuationToken - Token for pagination
 * @returns {Promise<Object>} Reviews and pagination info
 */
export async function getRecentReviews(
  s3Client,
  bucket,
  prefix,
  { limit = 20, continuationToken = null } = {}
) {
  try {
    // Fetch enough objects to ensure we can properly sort and limit
    // System maintains max 100 reviews, so always fetch all 100 to ensure accurate sorting
    const fetchLimit = 100

    const listCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: fetchLimit,
      ContinuationToken: continuationToken || undefined
    })

    const response = await s3Client.send(listCommand)

    if (!response.Contents || response.Contents.length === 0) {
      return {
        reviews: [],
        hasMore: false,
        nextToken: null
      }
    }

    // Sort ALL S3 objects by LastModified (most recent first)
    const sortedContents = response.Contents.slice().sort((a, b) => {
      return (
        new Date(b.LastModified).getTime() - new Date(a.LastModified).getTime()
      )
    })

    // Fetch the actual review data for the most recent objects
    const reviewPromises = sortedContents
      .slice(0, limit)
      .map((obj) => fetchSingleReview(s3Client, bucket, obj))

    const reviews = (await Promise.all(reviewPromises)).filter(
      (r) => r !== null
    )

    // Sort reviews by lastModified for most accurate ordering
    sortReviewsByLastModified(reviews)

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
 * Get total count of reviews
 * @param {Object} s3Client - S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} prefix - Reviews prefix
 * @returns {Promise<number>} Total number of reviews
 */
export async function getReviewCount(s3Client, bucket, prefix) {
  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix
    })

    let count = 0
    let continuationToken = null

    do {
      listCommand.input.ContinuationToken = continuationToken
      const response = await s3Client.send(listCommand)
      count += response.KeyCount || 0
      continuationToken = response.NextContinuationToken
    } while (continuationToken)

    return count
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get review count')
    throw error
  }
}
