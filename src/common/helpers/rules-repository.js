import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command
} from '@aws-sdk/client-s3'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const logger = createLogger()

/**
 * Rules Repository Manager
 * Manages content review rules in S3 bucket
 */
class RulesRepository {
  constructor() {
    const s3Config = {
      region: config.get('s3.region')
    }

    // Add endpoint for LocalStack if configured
    const awsEndpoint =
      process.env.AWS_ENDPOINT || process.env.LOCALSTACK_ENDPOINT
    if (awsEndpoint) {
      s3Config.endpoint = awsEndpoint
      s3Config.forcePathStyle = true
    }

    this.s3Client = new S3Client(s3Config)
    this.bucket = config.get('upload.s3Bucket')
    this.rulesPrefix = 'rules/' // Rules stored under rules/ prefix
  }

  /**
   * Upload rules file to S3
   * @param {string} ruleFileName - Name of the rule file
   * @param {string} localFilePath - Local path to the rule file
   * @returns {Promise<Object>} Upload result
   */
  async uploadRules(ruleFileName, localFilePath) {
    try {
      const fileContent = readFileSync(localFilePath, 'utf8')
      const s3Key = `${this.rulesPrefix}${ruleFileName}`

      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: fileContent,
        ContentType: 'text/markdown',
        Metadata: {
          uploadedAt: new Date().toISOString(),
          version: '1.0'
        }
      })

      await this.s3Client.send(command)

      logger.info(
        {
          bucket: this.bucket,
          key: s3Key,
          size: fileContent.length
        },
        'Rules file uploaded to S3'
      )

      return {
        success: true,
        bucket: this.bucket,
        key: s3Key,
        size: fileContent.length,
        location: `s3://${this.bucket}/${s3Key}`
      }
    } catch (error) {
      logger.error(
        {
          error: error.message,
          ruleFileName,
          localFilePath
        },
        'Failed to upload rules to S3'
      )
      throw error
    }
  }

  /**
   * Download rules from S3
   * @param {string} ruleFileName - Name of the rule file (or full key)
   * @returns {Promise<string>} Rules content as string
   */
  async getRules(ruleFileName) {
    try {
      // If ruleFileName doesn't include prefix, add it
      const s3Key = ruleFileName.startsWith(this.rulesPrefix)
        ? ruleFileName
        : `${this.rulesPrefix}${ruleFileName}`

      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: s3Key
      })

      const response = await this.s3Client.send(command)
      const rulesContent = await this.streamToString(response.Body)

      logger.info(
        {
          bucket: this.bucket,
          key: s3Key,
          size: rulesContent.length
        },
        'Rules retrieved from S3'
      )

      return rulesContent
    } catch (error) {
      logger.error(
        {
          error: error.message,
          ruleFileName
        },
        'Failed to retrieve rules from S3'
      )
      throw error
    }
  }

  /**
   * Get default GOV.UK content QA rules
   * @returns {Promise<string>} Rules content
   */
  async getDefaultRules() {
    return await this.getRules('govuk-content-qa-rules.md')
  }

  /**
   * List all available rules in S3
   * @returns {Promise<Array>} List of rule files
   */
  async listRules() {
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.rulesPrefix
      })

      const response = await this.s3Client.send(command)
      const rules = (response.Contents || []).map((item) => ({
        key: item.Key,
        name: item.Key.replace(this.rulesPrefix, ''),
        size: item.Size,
        lastModified: item.LastModified
      }))

      logger.info(
        {
          bucket: this.bucket,
          count: rules.length
        },
        'Listed rules from S3'
      )

      return rules
    } catch (error) {
      logger.error(
        {
          error: error.message
        },
        'Failed to list rules from S3'
      )
      throw error
    }
  }

  /**
   * Initialize rules repository by uploading default rules
   * Call this during server startup or manually
   * @returns {Promise<Object>} Upload result
   */
  async initializeDefaultRules() {
    try {
      const rulesDir = join(__dirname, '../../..', 'rules')
      const defaultRulesPath = join(rulesDir, 'govuk-content-qa-rules.md')

      logger.info('Initializing default rules in S3...')

      const result = await this.uploadRules(
        'govuk-content-qa-rules.md',
        defaultRulesPath
      )

      logger.info('Default rules initialized successfully')

      return result
    } catch (error) {
      logger.error(
        {
          error: error.message
        },
        'Failed to initialize default rules'
      )
      throw error
    }
  }

  /**
   * Build system prompt for Bedrock AI from rules
   * @param {string} rulesContent - Content of the rules file
   * @returns {string} Formatted system prompt
   */
  buildSystemPrompt(rulesContent) {
    return `${rulesContent}

---

## IMPORTANT INSTRUCTIONS

You are reviewing content that has been uploaded for GOV.UK compliance checking.

1. Read the entire document carefully
2. Apply all the rules defined above
3. Follow the REQUIRED OUTPUT STRUCTURE exactly
4. For each issue found, specify whether it's "Automated" or "Human judgement required"
5. Provide specific examples and locations
6. Do not rewrite content unless explicitly requested
7. Be thorough but concise

Begin your review below:
`
  }

  /**
   * Helper to convert stream to string
   * @param {Stream} stream - Readable stream
   * @returns {Promise<string>} String content
   */
  async streamToString(stream) {
    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
}

// Create singleton instance
export const rulesRepository = new RulesRepository()

// Export class for testing
export { RulesRepository }
