# S3 Event Notification Setup Guide

## Overview

This guide explains how to configure AWS S3 to automatically send event notifications to SQS when files are uploaded to the bucket `dev-service-optimisation-c63f2`.

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     Event-Driven Architecture                    │
└─────────────────────────────────────────────────────────────────┘

1. File Upload to S3
   ↓
2. S3 Event Notification (s3:ObjectCreated:*)
   ↓
3. SQS Queue receives event message automatically
   ↓
4. SQS Worker polls and processes messages
   ↓
5. AI Content Review Processing
```

## Prerequisites

- AWS S3 Bucket: `dev-service-optimisation-c63f2`
- AWS SQS Queue: `content_review_status`
- Queue URL: `https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status`
- Queue ARN: `arn:aws:sqs:eu-west-2:332499610595:content_review_status`
- AWS Region: `eu-west-2`
- AWS Account ID: `332499610595`

## Implementation Steps

### Step 1: Update SQS Queue Policy

The SQS queue needs permission to receive messages from S3.

**Run the setup script:**

```bash
# PowerShell
.\setup-s3-event-notification.ps1
```

**Or manually configure:**

```bash
aws sqs set-queue-attributes \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status \
  --attributes file://sqs-queue-policy.json
```

### Step 2: Configure S3 Event Notification

Configure S3 to send notifications to SQS when objects are created.

**Run the setup script:**

```bash
# PowerShell
.\setup-s3-event-notification.ps1
```

**Or manually configure:**

```bash
aws s3api put-bucket-notification-configuration \
  --bucket dev-service-optimisation-c63f2 \
  --notification-configuration file://s3-notification-config.json
```

### Step 3: Verify Configuration

**Check SQS Queue Policy:**

```bash
aws sqs get-queue-attributes \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status \
  --attribute-names Policy
```

**Check S3 Event Notification:**

```bash
aws s3api get-bucket-notification-configuration \
  --bucket dev-service-optimisation-c63f2
```

### Step 4: Test the Integration

**Upload a test file:**

```bash
# PowerShell
.\test-s3-event-trigger.ps1
```

**Or manually:**

```bash
echo "Test file" > test-event-trigger.txt
aws s3 cp test-event-trigger.txt s3://dev-service-optimisation-c63f2/content-uploads/test-event-trigger.txt
```

**Check SQS for messages:**

```bash
aws sqs receive-message \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status \
  --max-number-of-messages 1
```

## Event Message Format

When S3 sends an event to SQS, the message format is:

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
          "key": "content-uploads/file-name.pdf",
          "size": 12345,
          "eTag": "d41d8cd98f00b204e9800998ecf8427e",
          "sequencer": "0055AED6DCD90281E5"
        }
      }
    }
  ]
}
```

## Code Changes Required

### Update SQS Worker to Handle S3 Events

The SQS worker needs to be updated to handle both message types:

1. **Application messages** (sent from upload route)
2. **S3 event notifications** (sent automatically by S3)

See `src/common/helpers/sqs-worker.js` for the updated implementation.

### Optional: Remove Manual SQS Call

You can optionally remove the manual SQS message sending from the upload route since S3 will handle it automatically. However, keeping it as a backup is recommended for redundancy.

## Environment-Specific Configuration

### Development Environment

- Bucket: `dev-service-optimisation-c63f2`
- Queue: `content_review_status_dev`

### Test Environment

- Bucket: `test-service-optimisation-bucket`
- Queue: `content_review_status_test`

### Performance Test Environment

- Bucket: `perf-test-service-optimisation-bucket`
- Queue: `content_review_status_perf_test`

### Production Environment

- Bucket: `prod-service-optimisation-bucket`
- Queue: `content_review_status_prod`

## Troubleshooting

### No messages received in SQS after upload

1. **Check SQS Queue Policy:**

   ```bash
   aws sqs get-queue-attributes \
     --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status \
     --attribute-names Policy
   ```

2. **Check S3 Event Configuration:**

   ```bash
   aws s3api get-bucket-notification-configuration \
     --bucket dev-service-optimisation-c63f2
   ```

3. **Verify S3 bucket permissions:**
   - Ensure the bucket is not blocking event notifications
   - Check bucket policies

4. **Check CloudTrail for errors:**
   ```bash
   aws cloudtrail lookup-events \
     --lookup-attributes AttributeKey=ResourceName,AttributeValue=dev-service-optimisation-c63f2
   ```

### Duplicate messages

If you keep both the application-level SQS call AND S3 event notifications, you'll receive duplicate messages. Solutions:

- Remove manual SQS call from upload route
- Add deduplication logic in the worker
- Use message deduplication ID

### Permission denied errors

Ensure:

- SQS queue policy allows S3 to send messages
- IAM role/user has permissions to configure S3 notifications
- S3 bucket has permissions to send to SQS

## Security Best Practices

1. **Least Privilege:** Only grant necessary permissions
2. **Queue Policy:** Restrict to specific S3 bucket ARN
3. **Encryption:** Enable SQS encryption at rest
4. **VPC Endpoints:** Use VPC endpoints for S3 and SQS in production
5. **Monitoring:** Enable CloudWatch alarms for queue metrics

## Monitoring and Alerts

**CloudWatch Metrics to Monitor:**

- `ApproximateNumberOfMessagesVisible` - Messages waiting to be processed
- `ApproximateAgeOfOldestMessage` - Backlog indicator
- `NumberOfMessagesSent` - S3 event notification rate
- `NumberOfMessagesReceived` - Worker consumption rate

**Recommended Alarms:**

```bash
# Alert if messages are not being processed
aws cloudwatch put-metric-alarm \
  --alarm-name content-review-queue-backlog \
  --alarm-description "Alert when SQS queue has too many messages" \
  --metric-name ApproximateNumberOfMessagesVisible \
  --namespace AWS/SQS \
  --statistic Average \
  --period 300 \
  --evaluation-periods 2 \
  --threshold 100 \
  --comparison-operator GreaterThanThreshold
```

## Rollback Plan

If you need to disable S3 event notifications:

```bash
# Remove S3 event notification
aws s3api put-bucket-notification-configuration \
  --bucket dev-service-optimisation-c63f2 \
  --notification-configuration '{}'

# The upload route will still work with manual SQS calls
```

## References

- [AWS S3 Event Notifications Documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/NotificationHowTo.html)
- [AWS SQS Queue Policies](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-basic-examples-of-sqs-policies.html)
- [S3 Event Message Structure](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html)

## Support

For issues or questions:

1. Check CloudWatch Logs for worker errors
2. Review SQS dead-letter queue (if configured)
3. Contact AWS Support for infrastructure issues
