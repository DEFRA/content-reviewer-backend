# S3 Event Notification - Quick Reference

## 🚀 Quick Setup (3 Steps)

```powershell
# 1. Configure S3 → SQS event notifications
.\setup-s3-event-notification.ps1

# 2. Test the integration
.\test-s3-event-trigger.ps1

# 3. Start the SQS worker
npm run sqs:worker
```

## 📋 Files Created

- `S3_EVENT_NOTIFICATION_SETUP.md` - Detailed setup guide
- `S3_SQS_INTEGRATION_ARCHITECTURE.md` - Architecture documentation
- `sqs-queue-policy.json` - SQS queue policy configuration
- `s3-notification-config.json` - S3 event notification configuration
- `setup-s3-event-notification.ps1` - Automated setup script
- `test-s3-event-trigger.ps1` - Test script

## 🔧 Configuration

### SQS Queue

- **Name:** `content_review_status`
- **URL:** `https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status`
- **ARN:** `arn:aws:sqs:eu-west-2:332499610595:content_review_status`

### S3 Bucket

- **Name:** `dev-service-optimisation-c63f2`
- **Event Type:** `s3:ObjectCreated:*`
- **Filter:** `content-uploads/`

## 📊 How It Works

```
File Upload → S3 Bucket → Automatic Event → SQS Queue → Worker → AI Review
```

### Before (Application-Level)

```javascript
// Upload route manually sends SQS message
await s3Uploader.uploadFile(file)
await sqsClient.sendMessage(metadata) // Manual
```

### After (Event-Driven)

```javascript
// S3 automatically sends event to SQS
await s3Uploader.uploadFile(file)
// No manual SQS call needed - S3 handles it!
```

## ✅ Verification Commands

```bash
# Check SQS queue policy
aws sqs get-queue-attributes \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status \
  --attribute-names Policy

# Check S3 event configuration
aws s3api get-bucket-notification-configuration \
  --bucket dev-service-optimisation-c63f2

# Check for messages in queue
aws sqs receive-message \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status \
  --max-number-of-messages 1
```

## 🧪 Testing

```bash
# Upload test file
echo "Test" > test.txt
aws s3 cp test.txt s3://dev-service-optimisation-c63f2/content-uploads/test.txt

# Wait 5 seconds, then check SQS
aws sqs receive-message \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status
```

## 📝 Code Changes

### Updated: `src/common/helpers/sqs-worker.js`

- ✅ Now handles both S3 event messages and application messages
- ✅ Automatically detects message format
- ✅ Normalizes data for processing

### Optional: `src/routes/upload.js`

- ⚠️ Can remove manual SQS call (lines 87-120)
- 💡 Or keep as backup for redundancy

## 🎯 Benefits

✅ **Event-Driven:** No manual queue management  
✅ **Resilient:** Works even if upload route fails  
✅ **Scalable:** Can process files uploaded anywhere  
✅ **Decoupled:** S3 and SQS are independent  
✅ **FIFO:** Messages processed in order

## ⚙️ Environment-Specific

| Environment   | Bucket                                  | Queue                             |
| ------------- | --------------------------------------- | --------------------------------- |
| **Dev**       | `dev-service-optimisation-c63f2`        | `content_review_status_dev`       |
| **Test**      | `test-service-optimisation-bucket`      | `content_review_status_test`      |
| **Perf-Test** | `perf-test-service-optimisation-bucket` | `content_review_status_perf_test` |
| **Prod**      | `prod-service-optimisation-bucket`      | `content_review_status_prod`      |

## 🚨 Troubleshooting

### No messages after upload?

```bash
# Check S3 notification config
aws s3api get-bucket-notification-configuration --bucket dev-service-optimisation-c63f2
```

### Permission errors?

```bash
# Verify SQS queue policy
aws sqs get-queue-attributes --queue-url <url> --attribute-names Policy
```

### Duplicate messages?

- Remove manual SQS call from `src/routes/upload.js`
- Or implement deduplication in worker

## 📚 Documentation

- **Full Setup Guide:** `S3_EVENT_NOTIFICATION_SETUP.md`
- **Architecture Details:** `S3_SQS_INTEGRATION_ARCHITECTURE.md`
- **SQS Worker Code:** `src/common/helpers/sqs-worker.js`
- **Upload Route:** `src/routes/upload.js`

## 🔄 Rollback

```bash
# Disable S3 events (application messages still work)
aws s3api put-bucket-notification-configuration \
  --bucket dev-service-optimisation-c63f2 \
  --notification-configuration '{}'
```

## 📞 Support

- **AWS Issues:** Check CloudWatch Logs
- **Code Issues:** See `sqs-worker.js` comments
- **Setup Issues:** Re-run `setup-s3-event-notification.ps1`
