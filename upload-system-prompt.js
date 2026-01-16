/**
 * Upload System Prompt to S3
 *
 * This script uploads the default GOV.UK system prompt to S3
 * The SQS worker will fetch it from S3 when processing reviews
 */

import 'dotenv/config'
import { promptManager } from './src/common/helpers/prompt-manager.js'
import { createLogger } from './src/common/helpers/logging/logger.js'

const logger = createLogger()

async function uploadSystemPrompt() {
  try {
    logger.info('Starting system prompt upload to S3...')

    // Upload the embedded default prompt to S3
    await promptManager.uploadPrompt()

    logger.info('✅ System prompt uploaded successfully to S3')
    logger.info(
      'The SQS worker will now fetch this prompt when processing reviews'
    )

    process.exit(0)
  } catch (error) {
    logger.error(
      { error: error.message },
      '❌ Failed to upload system prompt to S3'
    )
    logger.error('Make sure AWS credentials are configured properly')
    process.exit(1)
  }
}

uploadSystemPrompt()
