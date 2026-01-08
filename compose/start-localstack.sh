#!/bin/bash
export AWS_REGION=eu-west-2
export AWS_DEFAULT_REGION=eu-west-2
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test

echo "🚀 Initializing LocalStack resources..."

# Create S3 bucket for content review
echo "📦 Creating S3 bucket: dev-service-optimisation-c63f2"
aws --endpoint-url=http://localhost:4566 s3 mb s3://dev-service-optimisation-c63f2 || echo "Bucket already exists"

# Create SQS FIFO queue for content review
echo "📬 Creating SQS queue: content_review_status"
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name content_review_status || echo "Queue already exists"

echo "✅ LocalStack initialization complete!"
echo "S3 Bucket: s3://dev-service-optimisation-c63f2"
echo "SQS Queue: content_review_status"
