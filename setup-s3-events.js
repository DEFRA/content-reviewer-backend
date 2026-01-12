#!/usr/bin/env node

import { S3Client, PutBucketNotificationConfigurationCommand } from '@aws-sdk/client-s3'

const s3Client = new S3Client({
  endpoint: 'http://localhost:4566',
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test'
  },
  forcePathStyle: true
})

async function setupS3Events() {
  console.log('Configuring S3 event notifications...')
  
  const params = {
    Bucket: 'dev-service-optimisation-c63f2',
    NotificationConfiguration: {
      QueueConfigurations: [
        {
          QueueArn: 'arn:aws:sqs:us-east-1:000000000000:content_review_status',
          Events: ['s3:ObjectCreated:*'],
          Filter: {
            Key: {
              FilterRules: [
                {
                  Name: 'prefix',
                  Value: 'content-uploads/'
                }
              ]
            }
          }
        }
      ]
    }
  }

  try {
    const command = new PutBucketNotificationConfigurationCommand(params)
    await s3Client.send(command)
    console.log('✅ S3 event notifications configured successfully!')
    console.log('   Bucket: dev-service-optimisation-c63f2')
    console.log('   Queue: content_review_status')
    console.log('   Trigger: s3:ObjectCreated:* in content-uploads/')
  } catch (error) {
    console.error('❌ Failed to configure S3 events:', error.message)
    process.exit(1)
  }
}

setupS3Events()
