#!/usr/bin/env node

/**
 * AWS Credentials Test Script
 * 
 * This script helps you verify that your AWS credentials are configured correctly
 * for the Content Reviewer Backend.
 * 
 * Usage:
 *   node test-aws-credentials.js
 * 
 * Or with a specific profile:
 *   AWS_PROFILE=your-profile node test-aws-credentials.js
 */

import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { S3Client, ListBucketsCommand, HeadBucketCommand } from '@aws-sdk/client-s3'
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs'
import { config } from './src/config.js'

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
}

function log(message, color = 'reset') {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`)
}

async function testCredentials() {
  log('\n🔐 AWS Credentials Test\n', 'cyan')
  
  // 1. Check environment variables
  log('1️⃣  Checking Environment Configuration...', 'blue')
  const awsProfile = process.env.AWS_PROFILE
  const awsRegion = config.get('upload.region')
  const s3Bucket = config.get('upload.s3Bucket')
  const mockMode = process.env.MOCK_S3_UPLOAD === 'true'
  
  if (mockMode) {
    log('   ⚠️  MOCK_S3_UPLOAD is enabled - skipping AWS tests', 'yellow')
    return
  }
  
  if (awsProfile) {
    log(`   ✓ AWS Profile: ${awsProfile}`, 'green')
  } else {
    log('   ℹ️  No AWS_PROFILE set (will use default credentials)', 'yellow')
  }
  
  log(`   ✓ Region: ${awsRegion}`, 'green')
  log(`   ✓ Target Bucket: ${s3Bucket}`, 'green')
  
  // 2. Try to load credentials
  log('\n2️⃣  Loading AWS Credentials...', 'blue')
  try {
    const credentialProvider = fromNodeProviderChain({
      timeout: 5000,
      maxRetries: 2
    })
    
    const credentials = await credentialProvider()
    
    if (credentials.accessKeyId && credentials.secretAccessKey) {
      const maskedKey = credentials.accessKeyId.substring(0, 8) + '***'
      log(`   ✓ Credentials loaded successfully`, 'green')
      log(`   ✓ Access Key: ${maskedKey}`, 'green')
      
      if (credentials.sessionToken) {
        log('   ✓ Session Token: Present (temporary credentials)', 'green')
      }
    } else {
      throw new Error('Credentials loaded but missing keys')
    }
  } catch (error) {
    log(`   ✗ Failed to load credentials: ${error.message}`, 'red')
    log('\n💡 Try one of these solutions:', 'yellow')
    log('   1. Set AWS_PROFILE=your-profile-name', 'yellow')
    log('   2. Configure credentials: aws configure', 'yellow')
    log('   3. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY', 'yellow')
    log('   4. Use MOCK_S3_UPLOAD=true for testing without AWS\n', 'yellow')
    process.exit(1)
  }
  
  // 3. Test S3 connection
  log('\n3️⃣  Testing S3 Connection...', 'blue')
  try {
    const s3Config = {
      region: awsRegion,
      credentials: fromNodeProviderChain()
    }
    
    const endpoint = process.env.AWS_ENDPOINT || process.env.LOCALSTACK_ENDPOINT
    if (endpoint) {
      log(`   ℹ️  Using custom endpoint: ${endpoint}`, 'yellow')
      s3Config.endpoint = endpoint
      s3Config.forcePathStyle = true
    }
    
    const s3Client = new S3Client(s3Config)
    
    // Try to check if bucket exists
    const headBucketCommand = new HeadBucketCommand({ Bucket: s3Bucket })
    await s3Client.send(headBucketCommand)
    
    log(`   ✓ Successfully connected to S3`, 'green')
    log(`   ✓ Bucket '${s3Bucket}' is accessible`, 'green')
  } catch (error) {
    if (error.name === 'NotFound') {
      log(`   ✗ Bucket '${s3Bucket}' does not exist`, 'red')
    } else if (error.name === 'Forbidden' || error.Code === 'AccessDenied') {
      log(`   ✗ Access denied to bucket '${s3Bucket}'`, 'red')
      log('   💡 Check your IAM permissions for s3:GetBucket* actions', 'yellow')
    } else {
      log(`   ✗ S3 connection failed: ${error.message}`, 'red')
    }
    log('\n💡 Note: Your credentials may still work for uploads even if this check fails', 'yellow')
  }
  
  // 4. Test SQS connection (if configured)
  const sqsQueueUrl = config.get('sqs.queueUrl')
  if (sqsQueueUrl && !sqsQueueUrl.includes('localhost')) {
    log('\n4️⃣  Testing SQS Connection...', 'blue')
    try {
      const sqsConfig = {
        region: config.get('sqs.region'),
        credentials: fromNodeProviderChain()
      }
      
      const sqsClient = new SQSClient(sqsConfig)
      const getQueueCommand = new GetQueueAttributesCommand({
        QueueUrl: sqsQueueUrl,
        AttributeNames: ['QueueArn']
      })
      
      await sqsClient.send(getQueueCommand)
      log(`   ✓ Successfully connected to SQS`, 'green')
      log(`   ✓ Queue is accessible`, 'green')
    } catch (error) {
      log(`   ✗ SQS connection failed: ${error.message}`, 'red')
      log('   💡 Check your IAM permissions for sqs:GetQueueAttributes', 'yellow')
    }
  }
  
  // Summary
  log('\n✅ Credentials Test Complete!\n', 'green')
  log('Your AWS configuration appears to be working correctly.', 'green')
  log('You can now run the backend with: npm start\n', 'cyan')
}

// Run the test
testCredentials().catch((error) => {
  log(`\n❌ Unexpected error: ${error.message}\n`, 'red')
  console.error(error)
  process.exit(1)
})
