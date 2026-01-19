import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} from '@aws-sdk/client-s3'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * S3 Results Storage Service
 * Stores and retrieves Bedrock review results in S3
 */
export class ResultsStorage {
  constructor() {
    // Check if we should use mock mode
    const awsEndpoint = config.get('aws.endpoint')
    this.mockMode =
      process.env.MOCK_S3_UPLOAD === 'true' ||
      (!awsEndpoint && process.env.NODE_ENV === 'development')

    if (this.mockMode) {
      logger.info('ResultsStorage running in MOCK mode')
      this.s3Client = null
      this.mockResults = new Map() // In-memory storage for mock mode
    } else {
      const s3Config = {
        region: config.get('aws.region')
      }

      if (awsEndpoint) {
        s3Config.endpoint = awsEndpoint
        s3Config.forcePathStyle = true
      }

      this.s3Client = new S3Client(s3Config)
    }

    this.bucket = config.get('s3.bucket')
    this.resultsPrefix = config.get('results.s3Path') || 'content-results'
  }

  /**
   * Store review result in S3
   * @param {string} jobId - Job/Upload ID
   * @param {Object} result - Review result object
   * @returns {Promise<Object>} Storage result
   */
  async storeResult(jobId, result) {
    const key = `${this.resultsPrefix}/${jobId}.json`

    try {
      const resultData = {
        jobId,
        status: 'completed',
        result,
        completedAt: new Date().toISOString(),
        version: '1.0'
      }

      // Mock mode - store in memory
      if (this.mockMode) {
        logger.info(
          { jobId, resultSize: JSON.stringify(result).length },
          'MOCK: Storing result'
        )
        this.mockResults.set(jobId, resultData)
        return {
          success: true,
          bucket: this.bucket,
          key,
          location: `s3://${this.bucket}/${key}`,
          mock: true
        }
      }

      // Real S3 storage
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(resultData, null, 2),
        ContentType: 'application/json',
        Metadata: {
          jobId,
          storedAt: new Date().toISOString()
        }
      })

      await this.s3Client.send(command)

      logger.info(
        { jobId, bucket: this.bucket, key },
        'Stored review result in S3'
      )

      return {
        success: true,
        bucket: this.bucket,
        key,
        location: `s3://${this.bucket}/${key}`
      }
    } catch (error) {
      logger.error(
        { jobId, error: error.message, stack: error.stack },
        'Failed to store result in S3'
      )
      throw new Error(`Failed to store result: ${error.message}`)
    }
  }

  /**
   * Retrieve review result from S3
   * @param {string} jobId - Job/Upload ID
   * @returns {Promise<Object|null>} Review result or null if not found
   */
  async getResult(jobId) {
    const key = `${this.resultsPrefix}/${jobId}.json`

    try {
      // Mock mode - retrieve from memory
      if (this.mockMode) {
        logger.info({ jobId }, 'MOCK: Retrieving result')
        const result = this.mockResults.get(jobId)
        if (!result) {
          logger.info({ jobId }, 'MOCK: Result not found')
          return null
        }
        return result
      }

      // Real S3 retrieval
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      })

      const response = await this.s3Client.send(command)
      const bodyString = await response.Body.transformToString()
      const result = JSON.parse(bodyString)

      logger.info(
        { jobId, bucket: this.bucket, key },
        'Retrieved result from S3'
      )

      return result
    } catch (error) {
      // Handle NoSuchKey error (result not found)
      if (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey') {
        logger.debug({ jobId }, 'Result not found in S3')
        return null
      }

      logger.error(
        { jobId, error: error.message, stack: error.stack },
        'Failed to retrieve result from S3'
      )
      throw new Error(`Failed to retrieve result: ${error.message}`)
    }
  }

  /**
   * Store error result
   * @param {string} jobId - Job/Upload ID
   * @param {Error} error - Error object
   * @returns {Promise<Object>} Storage result
   */
  async storeError(jobId, error) {
    const errorResult = {
      jobId,
      status: 'failed',
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack
      },
      failedAt: new Date().toISOString()
    }

    return this.storeResult(jobId, errorResult)
  }

  /**
   * Check if result exists
   * @param {string} jobId - Job/Upload ID
   * @returns {Promise<boolean>} True if result exists
   */
  async hasResult(jobId) {
    try {
      const result = await this.getResult(jobId)
      return result !== null
    } catch (error) {
      logger.error(
        { jobId, error: error.message },
        'Error checking result existence'
      )
      return false
    }
  }
}

// Export singleton instance
export const resultsStorage = new ResultsStorage()
