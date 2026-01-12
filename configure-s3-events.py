#!/usr/bin/env python3
"""
Configure S3 event notifications in LocalStack to trigger SQS
"""
import boto3
import json

# LocalStack configuration
LOCALSTACK_ENDPOINT = 'http://localhost:4566'
BUCKET_NAME = 'dev-service-optimisation-c63f2'
QUEUE_NAME = 'content_review_status'
AWS_REGION = 'eu-west-2'

# Create boto3 clients
s3_client = boto3.client(
    's3',
    endpoint_url=LOCALSTACK_ENDPOINT,
    aws_access_key_id='test',
    aws_secret_access_key='test',
    region_name=AWS_REGION
)

sqs_client = boto3.client(
    'sqs',
    endpoint_url=LOCALSTACK_ENDPOINT,
    aws_access_key_id='test',
    aws_secret_access_key='test',
    region_name=AWS_REGION
)

try:
    # Get the SQS queue ARN
    print(f"Getting queue URL for: {QUEUE_NAME}")
    queue_url_response = sqs_client.get_queue_url(QueueName=QUEUE_NAME)
    queue_url = queue_url_response['QueueUrl']
    print(f"Queue URL: {queue_url}")
    
    # Get queue attributes to get ARN
    queue_attrs = sqs_client.get_queue_attributes(
        QueueUrl=queue_url,
        AttributeNames=['QueueArn']
    )
    queue_arn = queue_attrs['Attributes']['QueueArn']
    print(f"Queue ARN: {queue_arn}")
    
    # Configure S3 bucket notification
    notification_configuration = {
        'QueueConfigurations': [
            {
                'Id': 'ContentUploadNotification',
                'QueueArn': queue_arn,
                'Events': ['s3:ObjectCreated:*'],
                'Filter': {
                    'Key': {
                        'FilterRules': [
                            {
                                'Name': 'prefix',
                                'Value': 'content-uploads/'
                            }
                        ]
                    }
                }
            }
        ]
    }
    
    print(f"\nConfiguring S3 bucket notification for: {BUCKET_NAME}")
    print(f"Configuration: {json.dumps(notification_configuration, indent=2)}")
    
    s3_client.put_bucket_notification_configuration(
        Bucket=BUCKET_NAME,
        NotificationConfiguration=notification_configuration
    )
    
    print("\n✅ S3 event notification configured successfully!")
    print(f"   Bucket: {BUCKET_NAME}")
    print(f"   Queue: {QUEUE_NAME}")
    print(f"   Trigger: s3:ObjectCreated:* in content-uploads/")
    
    # Verify the configuration
    print("\nVerifying configuration...")
    current_config = s3_client.get_bucket_notification_configuration(Bucket=BUCKET_NAME)
    print(f"Current configuration: {json.dumps(current_config, indent=2, default=str)}")
    
except Exception as e:
    print(f"\n❌ Error configuring S3 events: {str(e)}")
    import traceback
    traceback.print_exc()
    exit(1)
