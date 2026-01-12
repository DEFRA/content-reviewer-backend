import { SQSClient, PurgeQueueCommand } from '@aws-sdk/client-sqs'

const sqsClient = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test'
  }
})

const queueUrl = 'http://localhost:4566/000000000000/content-review-queue'

console.log('Purging SQS queue:', queueUrl)

try {
  const command = new PurgeQueueCommand({
    QueueUrl: queueUrl
  })
  
  await sqsClient.send(command)
  console.log('✓ Queue purged successfully - all old messages removed')
} catch (error) {
  console.error('Error purging queue:', error.message)
  process.exit(1)
}
