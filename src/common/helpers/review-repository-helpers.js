import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * Preserve immutable fields from a review
 * @param {Object} review - Review object
 * @returns {Object} Preserved immutable fields
 */
export function preserveImmutableFields(review) {
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
export function sanitizeAdditionalData(
  additionalData,
  reviewId,
  preservedFields
) {
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
export function restoreImmutableFields(review, preservedFields, reviewId) {
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
export function updateProcessingTimestamps(review, status, now) {
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
