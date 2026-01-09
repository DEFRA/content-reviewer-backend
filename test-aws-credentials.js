#!/usr/bin/env node

/**
 * AWS Credentials Test Script
 *
 * This script tests AWS credentials and Bedrock access to help diagnose
 * why the /api/review endpoint might be failing.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand
} from '@aws-sdk/client-bedrock-runtime'

const region = 'eu-west-2'

console.log('='.repeat(80))
console.log('AWS CREDENTIALS & BEDROCK TEST')
console.log('='.repeat(80))
console.log()

// Display environment diagnostics
console.log('Environment Diagnostics:')
console.log('-'.repeat(80))
console.log('Node Environment:', process.env.NODE_ENV || 'development')
console.log('AWS Region:', region)
console.log('AWS Profile:', process.env.AWS_PROFILE || 'not set')
console.log('Has AWS_ACCESS_KEY_ID:', !!process.env.AWS_ACCESS_KEY_ID)
console.log('Has AWS_SECRET_ACCESS_KEY:', !!process.env.AWS_SECRET_ACCESS_KEY)
console.log('Has AWS_SESSION_TOKEN:', !!process.env.AWS_SESSION_TOKEN)
console.log(
  'Has AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:',
  !!process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
)
console.log()

if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
  console.log('ℹ️  No explicit credentials configured.')
  console.log('   AWS SDK will attempt to use:')
  console.log('   1. Shared credentials file (~/.aws/credentials)')
  console.log('   2. ECS container credentials (if running in ECS)')
  console.log(
    '   3. EC2 instance metadata (if running on EC2) <- CDP uses this'
  )
  console.log()
}

// Test: Test Bedrock Runtime API access
console.log('Testing Bedrock Runtime API Access...')
console.log('-'.repeat(80))

const inferenceProfileArn =
  'arn:aws:bedrock:eu-west-2:332499610595:inference-profile/eu.anthropic.claude-3-5-sonnet-20241022-v2:0'
const guardrailArn =
  'arn:aws:bedrock:eu-west-2:332499610595:guardrail/j7sbivk41lq4'
const guardrailVersion = '3'

try {
  const bedrockClient = new BedrockRuntimeClient({ region })

  const command = new ConverseCommand({
    modelId: inferenceProfileArn,
    messages: [
      {
        role: 'user',
        content: [
          { text: 'Hello, respond with just "OK" if you can read this.' }
        ]
      }
    ],
    inferenceConfig: {
      maxTokens: 10,
      temperature: 0
    },
    guardrailConfig: {
      guardrailIdentifier: guardrailArn,
      guardrailVersion: guardrailVersion,
      trace: 'enabled'
    }
  })

  console.log('Sending test message to Bedrock...')
  console.log('Inference Profile:', inferenceProfileArn)
  console.log('Guardrail:', guardrailArn)
  console.log()

  const response = await bedrockClient.send(command)

  console.log('✅ Bedrock API ACCESSIBLE')
  console.log(
    'Response:',
    response.output?.message?.content?.[0]?.text || '[no text]'
  )
  console.log('Stop Reason:', response.stopReason)
  console.log('Usage:', {
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    totalTokens: response.usage?.totalTokens
  })
  console.log()
} catch (error) {
  console.error('❌ Bedrock API NOT ACCESSIBLE')
  console.error()
  console.error('Error Details:')
  console.error('  Name:', error.name)
  console.error('  Message:', error.message)
  console.error('  Code:', error.code || error.$fault)
  console.error('  Status Code:', error.$metadata?.httpStatusCode)
  console.error('  Request ID:', error.$metadata?.requestId)
  console.error()

  if (error.name === 'CredentialsProviderError') {
    console.error('Root Cause: No AWS credentials available')
    console.error(
      'Solution: In CDP, ensure the EC2 instance has an IAM role with Bedrock permissions'
    )
  } else if (error.name === 'AccessDeniedException') {
    console.error('Root Cause: Credentials found but lack permissions')
    console.error(
      'Solution: Add bedrock:InvokeModel permission to the IAM role/user'
    )
  } else if (error.name === 'ResourceNotFoundException') {
    console.error('Root Cause: Inference profile or guardrail not found')
    console.error(
      'Solution: Verify the ARNs are correct for this region/account'
    )
  } else if (error.name === 'ThrottlingException') {
    console.error('Root Cause: Rate limit exceeded')
    console.error('Solution: Implement retry with exponential backoff')
  } else if (error.name === 'ValidationException') {
    console.error('Root Cause: Invalid request parameters')
    console.error('Solution: Check the request structure and parameters')
  }

  console.error()
  console.error('Full error object:')
  console.error(JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
  console.error()
}

console.log('='.repeat(80))
console.log('TEST COMPLETE')
console.log('='.repeat(80))
console.log()
console.log('Summary:')
console.log()
console.log('If running locally:')
console.log(
  '  - Credential errors are EXPECTED unless you have AWS credentials configured'
)
console.log(
  '  - To configure: aws configure (using AWS CLI) or set environment variables'
)
console.log()
console.log('If running in CDP:')
console.log('  - Test should PASS')
console.log('  - If it fails, check:')
console.log('    1. EC2 instance has an IAM role attached')
console.log('    2. IAM role has Bedrock permissions (bedrock:InvokeModel)')
console.log('    3. Instance metadata service (IMDS) is accessible')
console.log(
  '    4. Security groups allow access to metadata endpoint (169.254.169.254)'
)
console.log('    5. Inference profile ARN is correct for the account/region')
console.log()
console.log('Required IAM Permissions:')
console.log('  {')
console.log('    "Version": "2012-10-17",')
console.log('    "Statement": [')
console.log('      {')
console.log('        "Effect": "Allow",')
console.log('        "Action": [')
console.log('          "bedrock:InvokeModel",')
console.log('          "bedrock:InvokeModelWithResponseStream",')
console.log('          "bedrock:ApplyGuardrail"')
console.log('        ],')
console.log('        "Resource": [')
console.log('          "arn:aws:bedrock:*:*:inference-profile/*",')
console.log('          "arn:aws:bedrock:*:*:guardrail/*"')
console.log('        ]')
console.log('      }')
console.log('    ]')
console.log('  }')
console.log()
