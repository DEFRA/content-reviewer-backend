# S3 to SQS Integration Architecture

## Overview

This document describes the complete S3 → SQS → Worker integration architecture for the Content Review Tool, including both automatic S3 event notifications and application-level message sending.

## Architecture Modes

### Mode 1: Automatic S3 Event Notifications (Recommended)

```
┌──────────────┐
│   Frontend   │
│  (Upload UI) │
└──────┬───────┘
       │ HTTP POST
       ▼
┌─────────────────────────────┐
│    Backend Upload API       │
│  (src/routes/upload.js)     │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│  S3 Uploader                │
│  Uploads file to S3         │
└──────┬──────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│  AWS S3 Bucket               │
│  dev-service-optimisation-   │
│  c63f2/content-uploads/      │
└──────┬───────────────────────┘
       │ Automatic Event
       │ (s3:ObjectCreated:*)
       ▼
┌──────────────────────────────┐
│  AWS SQS Queue               │
│  content_review_status       │
└──────┬───────────────────────┘
       │ Polling
       ▼
┌──────────────────────────────┐
│  SQS Worker                  │
│  (sqs-worker.js)             │
│  • Polls queue               │
│  • Processes messages        │
│  • Calls AI review           │
└──────────────────────────────┘
```

**Advantages:**

- ✅ Fully event-driven architecture
- ✅ No tight coupling between upload and queue
- ✅ Works even if backend upload route fails after S3 upload
- ✅ Can trigger processing for files uploaded via AWS Console/CLI
- ✅ Better separation of concerns
- ✅ More resilient to failures

**Configuration Required:**

1. SQS queue policy allowing S3 to send messages
2. S3 bucket event notification configuration
3. Updated SQS worker to handle S3 event format

### Mode 2: Application-Level SQS Messages

```
┌──────────────┐
│   Frontend   │
└──────┬───────┘
       │ HTTP POST
       ▼
┌─────────────────────────────┐
│    Backend Upload API       │
│  1. Upload to S3            │
│  2. Send message to SQS ←───┤ Manual call
└──────┬──────────────────────┘
       │
       ├─→ S3 Upload
       └─→ SQS Message (manual)
           │
           ▼
        ┌──────────────────────────────┐
        │  SQS Worker                  │
        └──────────────────────────────┘
```

**Advantages:**

- ✅ Simple to implement
- ✅ Works without AWS infrastructure changes
- ✅ Can include additional metadata in message
- ✅ Immediate feedback if SQS is down

**Disadvantages:**

- ❌ Tight coupling between upload and queue
- ❌ If upload route fails after S3 upload, no message sent
- ❌ Can't process files uploaded outside the application

### Mode 3: Hybrid (Both Modes) - Current Implementation

The system can run with both modes enabled:

- S3 event notifications send automatic messages
- Upload route also sends application messages

**Deduplication Strategy:**

1. Use uploadId as deduplication key
2. Check if message was already processed
3. Process only once, ignore duplicates

## Message Formats

### S3 Event Notification Message

```json
{
  "Records": [
    {
      "eventVersion": "2.1",
      "eventSource": "aws:s3",
      "awsRegion": "eu-west-2",
      "eventTime": "2026-01-08T12:00:00.000Z",
      "eventName": "ObjectCreated:Put",
      "s3": {
        "s3SchemaVersion": "1.0",
        "configurationId": "content-review-upload-event",
        "bucket": {
          "name": "dev-service-optimisation-c63f2",
          "arn": "arn:aws:s3:::dev-service-optimisation-c63f2"
        },
        "object": {
          "key": "content-uploads/abc123-file.pdf",
          "size": 12345,
          "eTag": "d41d8cd98f00b204e9800998ecf8427e",
          "sequencer": "0055AED6DCD90281E5"
        }
      }
    }
  ]
}
```

### Application Message Format

```json
{
  "uploadId": "abc123-def456-ghi789",
  "filename": "document.pdf",
  "s3Bucket": "dev-service-optimisation-c63f2",
  "s3Key": "content-uploads/abc123-def456-ghi789.pdf",
  "s3Location": "https://dev-service-optimisation-c63f2.s3.eu-west-2.amazonaws.com/content-uploads/abc123-def456-ghi789.pdf",
  "contentType": "application/pdf",
  "fileSize": 12345,
  "messageType": "file_upload",
  "userId": "user@example.com",
  "sessionId": "session-123",
  "timestamp": "2026-01-08T12:00:00.000Z"
}
```

## SQS Worker Implementation

The SQS worker (`src/common/helpers/sqs-worker.js`) automatically detects and handles both message formats:

```javascript
async processMessage(message) {
  const body = JSON.parse(message.Body)

  // Detect message type
  if (body.Records && body.Records[0] && body.Records[0].s3) {
    // S3 Event Notification
    const s3Event = body.Records[0]
    const messageData = {
      messageType: 's3_event',
      s3Bucket: s3Event.s3.bucket.name,
      s3Key: s3Event.s3.object.key,
      fileSize: s3Event.s3.object.size,
      // ... normalize data
    }
    await this.processContentReview(messageData)
  } else {
    // Application Message
    await this.processContentReview(body)
  }
}
```

## Setup Instructions

### Quick Setup (Run Scripts)

```powershell
# 1. Configure S3 event notifications
.\setup-s3-event-notification.ps1

# 2. Test the configuration
.\test-s3-event-trigger.ps1

# 3. Start SQS worker
npm run sqs:worker
```

### Manual Setup

#### Step 1: Update SQS Queue Policy

```bash
aws sqs set-queue-attributes \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status \
  --attributes file://sqs-queue-policy.json
```

#### Step 2: Configure S3 Event Notification

```bash
aws s3api put-bucket-notification-configuration \
  --bucket dev-service-optimisation-c63f2 \
  --notification-configuration file://s3-notification-config.json
```

#### Step 3: Verify Configuration

```bash
# Check SQS policy
aws sqs get-queue-attributes \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status \
  --attribute-names Policy

# Check S3 notification
aws s3api get-bucket-notification-configuration \
  --bucket dev-service-optimisation-c63f2
```

## Configuration Files

### sqs-queue-policy.json

Grants S3 permission to send messages to SQS:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "s3.amazonaws.com" },
      "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:eu-west-2:332499610595:content_review_status",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "332499610595" },
        "ArnLike": {
          "aws:SourceArn": "arn:aws:s3:::dev-service-optimisation-c63f2"
        }
      }
    }
  ]
}
```

### s3-notification-config.json

Configures S3 to send events to SQS:

```json
{
  "QueueConfigurations": [
    {
      "Id": "content-review-upload-event",
      "QueueArn": "arn:aws:sqs:eu-west-2:332499610595:content_review_status",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {
        "Key": {
          "FilterRules": [{ "Name": "prefix", "Value": "content-uploads/" }]
        }
      }
    }
  ]
}
```

## Environment-Specific Configuration

### Development

- Bucket: `dev-service-optimisation-c63f2`
- Queue: `content_review_status_dev`
- Queue URL: `https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status_dev`

### Test

- Bucket: `test-service-optimisation-bucket`
- Queue: `content_review_status_test`
- Queue URL: `https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status_test`

### Performance Test

- Bucket: `perf-test-service-optimisation-bucket`
- Queue: `content_review_status_perf_test`
- Queue URL: `https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status_perf_test`

### Production

- Bucket: `prod-service-optimisation-bucket`
- Queue: `content_review_status_prod`
- Queue URL: `https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status_prod`

## Testing

### Test S3 Event Notification

```powershell
# Run test script
.\test-s3-event-trigger.ps1
```

### Manual Testing

```bash
# 1. Upload a test file
echo "Test content" > test.txt
aws s3 cp test.txt s3://dev-service-optimisation-c63f2/content-uploads/test.txt

# 2. Wait 5 seconds for event propagation

# 3. Check SQS for message
aws sqs receive-message \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status \
  --max-number-of-messages 1
```

### Verify Worker Processing

```bash
# Start worker
npm run sqs:worker

# In another terminal, upload a file
# Watch worker logs for processing
```

## Monitoring

### CloudWatch Metrics

Monitor these key metrics:

1. **SQS Queue Metrics:**
   - `ApproximateNumberOfMessagesVisible` - Messages waiting
   - `ApproximateAgeOfOldestMessage` - Processing lag
   - `NumberOfMessagesSent` - Event rate
   - `NumberOfMessagesReceived` - Worker consumption rate

2. **S3 Bucket Metrics:**
   - `NumberOfObjects` - Files in bucket
   - `BucketSizeBytes` - Storage used

### CloudWatch Alarms

```bash
# Alert on queue backlog
aws cloudwatch put-metric-alarm \
  --alarm-name content-review-queue-backlog \
  --metric-name ApproximateNumberOfMessagesVisible \
  --namespace AWS/SQS \
  --statistic Average \
  --period 300 \
  --evaluation-periods 2 \
  --threshold 100 \
  --comparison-operator GreaterThanThreshold
```

## Troubleshooting

### No messages in SQS after upload

**Possible causes:**

1. SQS queue policy not configured
2. S3 event notification not configured
3. S3 bucket policy blocking events
4. Wrong S3 key prefix (file not in `content-uploads/`)

**Solutions:**

```bash
# Verify SQS policy
aws sqs get-queue-attributes --queue-url <url> --attribute-names Policy

# Verify S3 notification
aws s3api get-bucket-notification-configuration --bucket <bucket>

# Check CloudTrail for errors
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=<bucket>
```

### Duplicate messages

If both S3 events AND application messages are enabled, you'll get duplicates.

**Solutions:**

1. Remove manual SQS call from upload route
2. Implement deduplication in worker
3. Use SQS FIFO queue with deduplication

### Worker not processing messages

**Check:**

1. Worker is running: `npm run sqs:worker`
2. AWS credentials configured
3. Queue URL is correct
4. Worker has SQS permissions

## Security Considerations

1. **Least Privilege:** Grant only necessary permissions
2. **Queue Policy:** Restrict to specific S3 bucket
3. **Encryption:** Enable SQS encryption at rest
4. **VPC Endpoints:** Use for production environments
5. **Access Logging:** Enable S3 and SQS logging

## Performance Optimization

1. **Batch Processing:** Process multiple messages in parallel
2. **Visibility Timeout:** Set appropriate timeout (30-60 seconds)
3. **Long Polling:** Use 20-second wait time
4. **Auto Scaling:** Scale workers based on queue depth
5. **Dead Letter Queue:** Configure for failed messages

## Migration Path

### From Application-Only to S3 Events

1. ✅ Setup S3 event notifications (this guide)
2. ✅ Update SQS worker to handle both formats
3. ✅ Test thoroughly in dev environment
4. ⚠️ Keep application messages as backup
5. 📊 Monitor for duplicates
6. 🔄 After 1 week, optionally remove application messages

### Rollback Plan

```bash
# Remove S3 event notification
aws s3api put-bucket-notification-configuration \
  --bucket dev-service-optimisation-c63f2 \
  --notification-configuration '{}'

# Application messages will continue to work
```

## Next Steps

1. ✅ Run setup script: `.\setup-s3-event-notification.ps1`
2. ✅ Test integration: `.\test-s3-event-trigger.ps1`
3. ✅ Update worker code (already done)
4. 📝 Implement AI content review logic
5. 📊 Setup monitoring and alerts
6. 🚀 Deploy to production

## References

- [AWS S3 Event Notifications](https://docs.aws.amazon.com/AmazonS3/latest/userguide/NotificationHowTo.html)
- [AWS SQS Queue Policies](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-basic-examples-of-sqs-policies.html)
- [S3 Event Message Structure](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html)

## Support Contacts

- **Infrastructure Issues:** AWS Support
- **Application Issues:** Development Team
- **Monitoring:** CloudWatch Alarms
