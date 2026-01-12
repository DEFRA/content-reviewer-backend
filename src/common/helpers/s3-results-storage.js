import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand
} from '@aws-sdk/client-s3'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * S3 Results Storage Service
 * Manages persistent storage of review results in S3
 */
class S3ResultsStorage {
  constructor() {
    const s3Config = {
      region: config.get('upload.region')
    }

    // Add endpoint for LocalStack if configured
    const awsEndpoint =
      process.env.AWS_ENDPOINT || process.env.LOCALSTACK_ENDPOINT
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true // Required for LocalStack
    }

    this.s3Client = new S3Client(s3Config)
    this.bucket = config.get('upload.s3Bucket')
    this.resultsPrefix = 'results' // Store results in /results folder
    this.maxHistoryCount = parseInt(process.env.MAX_REVIEW_HISTORY) || 100
    this.enabled = process.env.ENABLE_S3_RESULTS_STORAGE !== 'false' // Enabled by default

    if (this.enabled) {
      logger.info(
        {
          bucket: this.bucket,
          resultsPrefix: this.resultsPrefix,
          maxHistoryCount: this.maxHistoryCount
        },
        'S3 Results Storage initialized'
      )
    } else {
      logger.warn('S3 Results Storage is DISABLED')
    }
  }

  /**
   * Save review result to S3
   * @param {string} uploadId - Upload ID
   * @param {Object} reviewResult - Complete review result object
   * @param {Object} metadata - Additional metadata (filename, status, etc.)
   * @returns {Promise<Object>} S3 location info
   */
  async saveResult(uploadId, reviewResult, metadata = {}) {
    if (!this.enabled) {
      logger.debug({ uploadId }, 'S3 Results Storage disabled - skipping save')
      return null
    }

    try {
      const key = `${this.resultsPrefix}/${uploadId}.json`

      // Create complete result object with metadata
      const completeResult = {
        uploadId,
        filename: metadata.filename || 'unknown',
        status: metadata.status || 'completed',
        createdAt: metadata.createdAt || new Date().toISOString(),
        completedAt: metadata.completedAt || new Date().toISOString(),
        reviewResult,
        savedAt: new Date().toISOString()
      }

      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(completeResult, null, 2),
        ContentType: 'application/json',
        Metadata: {
          uploadId,
          filename: metadata.filename || 'unknown',
          completedAt: metadata.completedAt || new Date().toISOString()
        }
      })

      await this.s3Client.send(command)

      const location = `s3://${this.bucket}/${key}`
      logger.info({ uploadId, location }, 'Review result saved to S3')

      // Trigger cleanup of old results (async, don't wait)
      this.cleanupOldResults().catch((error) => {
        logger.warn(
          { error: error.message },
          'Failed to cleanup old results (non-critical)'
        )
      })

      return {
        bucket: this.bucket,
        key,
        location
      }
    } catch (error) {
      logger.error(
        { uploadId, error: error.message },
        'Failed to save result to S3'
      )
      throw error
    }
  }

  /**
   * Get review result from S3
   * @param {string} uploadId - Upload ID
   * @returns {Promise<Object>} Review result object
   */
  async getResult(uploadId) {
    if (!this.enabled) {
      logger.debug({ uploadId }, 'S3 Results Storage disabled - cannot fetch')
      return null
    }

    try {
      const key = `${this.resultsPrefix}/${uploadId}.json`

      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      })

      const response = await this.s3Client.send(command)
      const bodyString = await response.Body.transformToString()
      const result = JSON.parse(bodyString)

      logger.debug({ uploadId }, 'Retrieved review result from S3')
      return result
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        logger.debug({ uploadId }, 'Review result not found in S3')
        return null
      }
      logger.error(
        { uploadId, error: error.message },
        'Failed to get result from S3'
      )
      throw error
    }
  }

  /**
   * List all review results from S3 (most recent first)
   * @param {number} limit - Max number of results to return
   * @returns {Promise<Array>} Array of review summaries
   */
  async listResults(limit = 100) {
    if (!this.enabled) {
      logger.debug('S3 Results Storage disabled - cannot list')
      return []
    }

    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: `${this.resultsPrefix}/`,
        MaxKeys: Math.min(limit, 1000) // AWS max is 1000
      })

      const response = await this.s3Client.send(command)
      const objects = response.Contents || []

      // Sort by last modified (newest first)
      const sortedObjects = objects.sort(
        (a, b) => b.LastModified - a.LastModified
      )

      // Extract uploadIds and metadata
      const results = sortedObjects.slice(0, limit).map((obj) => ({
        uploadId: obj.Key.replace(`${this.resultsPrefix}/`, '').replace(
          '.json',
          ''
        ),
        key: obj.Key,
        lastModified: obj.LastModified,
        size: obj.Size
      }))

      logger.debug({ count: results.length }, 'Listed review results from S3')
      return results
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to list results from S3')
      throw error
    }
  }

  /**
   * Load recent results into memory
   * @param {number} limit - Max number of results to load
   * @returns {Promise<Array>} Array of full review result objects
   */
  async loadRecentResults(limit = 100) {
    if (!this.enabled) {
      logger.debug('S3 Results Storage disabled - cannot load')
      return []
    }

    try {
      const resultsList = await this.listResults(limit)

      // Load full results in parallel (but limit concurrency)
      const batchSize = 10
      const loadedResults = []

      for (let i = 0; i < resultsList.length; i += batchSize) {
        const batch = resultsList.slice(i, i + batchSize)
        const batchResults = await Promise.all(
          batch.map(async (item) => {
            try {
              return await this.getResult(item.uploadId)
            } catch (error) {
              logger.warn(
                { uploadId: item.uploadId, error: error.message },
                'Failed to load result - skipping'
              )
              return null
            }
          })
        )
        loadedResults.push(...batchResults.filter((r) => r !== null))
      }

      logger.info(
        { count: loadedResults.length },
        'Loaded recent results from S3'
      )
      return loadedResults
    } catch (error) {
      logger.error(
        { error: error.message },
        'Failed to load recent results from S3'
      )
      return []
    }
  }

  /**
   * Clean up old results, keeping only the most recent N results
   * @returns {Promise<number>} Number of results deleted
   */
  async cleanupOldResults() {
    if (!this.enabled) {
      return 0
    }

    try {
      const allResults = await this.listResults(1000) // Get up to 1000 results

      if (allResults.length <= this.maxHistoryCount) {
        logger.debug(
          { current: allResults.length, max: this.maxHistoryCount },
          'No cleanup needed - under max history limit'
        )
        return 0
      }

      // Delete results beyond the max limit
      const resultsToDelete = allResults.slice(this.maxHistoryCount)

      logger.info(
        {
          total: allResults.length,
          toDelete: resultsToDelete.length,
          keeping: this.maxHistoryCount
        },
        'Cleaning up old review results from S3'
      )

      let deleteCount = 0
      for (const result of resultsToDelete) {
        try {
          const command = new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: result.key
          })
          await this.s3Client.send(command)
          deleteCount++
        } catch (error) {
          logger.warn(
            { key: result.key, error: error.message },
            'Failed to delete old result'
          )
        }
      }

      logger.info(
        { deletedCount: deleteCount },
        'Cleanup completed - old results deleted'
      )
      return deleteCount
    } catch (error) {
      logger.error(
        { error: error.message },
        'Failed to cleanup old results from S3'
      )
      return 0
    }
  }

  /**
   * Check if S3 Results Storage is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled
  }
}

// Export singleton instance
export const s3ResultsStorage = new S3ResultsStorage()
export { S3ResultsStorage }
