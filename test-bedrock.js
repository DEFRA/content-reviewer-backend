#!/usr/bin/env node
/**
 * Test script for AWS Bedrock integration
 * Run with: node test-bedrock.js
 */

import 'dotenv/config'
import { BedrockClient } from './src/common/helpers/bedrock-client.js'
import { buildChatPrompt } from './src/common/helpers/gov-uk-review-prompt.js'
import { createLogger } from './src/common/helpers/logging/logger.js'

const logger = createLogger()

async function testBedrock() {
  console.log('🧪 Testing AWS Bedrock Integration...\n')

  try {
    // Check if Bedrock is enabled
    if (!BedrockClient.isEnabled()) {
      console.log('❌ Bedrock is disabled')
      console.log('   Set ENABLE_BEDROCK=true in .env to enable\n')
      return
    }

    // Check if in mock mode
    if (BedrockClient.isMockMode()) {
      console.log('⚠️  Bedrock is in MOCK mode')
      console.log('   Set MOCK_BEDROCK=false to use real AWS Bedrock\n')
      return
    }

    console.log('✅ Bedrock is enabled and configured\n')

    // Initialize client
    console.log('📡 Initializing Bedrock client...')
    const client = new BedrockClient()

    // Test with a simple prompt
    console.log('💬 Sending test message to Bedrock...\n')
    const testMessage =
      'Review this sentence: The dog was walked by the man yesterday.'
    console.log(`   Input: "${testMessage}"\n`)

    const prompt = buildChatPrompt(testMessage)
    const response = await client.invokeModel(prompt)

    console.log('✅ Response received!\n')
    console.log('📄 AI Response:')
    console.log('─'.repeat(80))
    console.log(response.content)
    console.log('─'.repeat(80))
    console.log('\n📊 Token Usage:')
    console.log(`   Input tokens:  ${response.usage?.input_tokens || 'N/A'}`)
    console.log(`   Output tokens: ${response.usage?.output_tokens || 'N/A'}`)
    console.log(
      `   Total tokens:  ${(response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)}\n`
    )

    console.log('✅ Bedrock test successful!\n')
  } catch (error) {
    console.error('❌ Bedrock test failed:\n')
    console.error(`   Error: ${error.message}\n`)

    if (error.message.includes('credentials')) {
      console.log('💡 Tip: Make sure your AWS credentials are configured:')
      console.log('   export AWS_ACCESS_KEY_ID=your_key_id')
      console.log('   export AWS_SECRET_ACCESS_KEY=your_secret_key\n')
    }

    if (error.message.includes('AccessDeniedException')) {
      console.log('💡 Tip: Make sure you have Bedrock permissions:')
      console.log('   1. Go to AWS Console → Bedrock → Model access')
      console.log('   2. Request access to Claude 3 models')
      console.log(
        '   3. Ensure your IAM user/role has bedrock:InvokeModel permission\n'
      )
    }

    if (error.message.includes('ValidationException')) {
      console.log('💡 Tip: Check your model ID in .env:')
      console.log(
        '   BEDROCK_MODEL_ID=anthropic.claude-3-sonnet-20240229-v1:0\n'
      )
    }

    logger.error('Bedrock test failed', { error: error.message })
    process.exit(1)
  }
}

// Run the test
testBedrock().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
