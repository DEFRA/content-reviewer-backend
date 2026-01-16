import { promptManager } from './src/common/helpers/prompt-manager.js'
import { createLogger } from './src/common/helpers/logging/logger.js'

const logger = createLogger()

/**
 * Upload embedded system prompt to S3
 * Uses the DEFAULT_SYSTEM_PROMPT from prompt-manager.js
 */
async function uploadPrompt() {
  try {
    logger.info('Uploading embedded system prompt to S3')

    // Upload the embedded prompt (will use DEFAULT_SYSTEM_PROMPT)
    await promptManager.uploadPrompt()

    logger.info('✅ System prompt uploaded successfully to S3')
    console.log('\n✅ SUCCESS: System prompt uploaded to S3')
    console.log(
      '   Using embedded DEFAULT_SYSTEM_PROMPT from prompt-manager.js'
    )

    process.exit(0)
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to upload system prompt')
    console.error('\n❌ ERROR: Failed to upload system prompt')
    console.error(`   ${error.message}`)
    process.exit(1)
  }
}

// Run the upload
uploadPrompt()
