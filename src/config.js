import convict from 'convict'
import convictFormatWithValidator from 'convict-format-with-validator'

import { convictValidateMongoUri } from './common/helpers/convict/validate-mongo-uri.js'

convict.addFormat(convictValidateMongoUri)
convict.addFormats(convictFormatWithValidator)

const isProduction = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test'

const config = convict({
  serviceVersion: {
    doc: 'The service version, this variable is injected into your docker container in CDP environments',
    format: String,
    nullable: true,
    default: null,
    env: 'SERVICE_VERSION'
  },
  host: {
    doc: 'The IP address to bind',
    format: 'ipaddress',
    default: '0.0.0.0',
    env: 'HOST'
  },
  port: {
    doc: 'The port to bind',
    format: 'port',
    default: 3001,
    env: 'PORT'
  },
  serviceName: {
    doc: 'Api Service Name',
    format: String,
    default: 'content-reviewer-backend'
  },
  cdpEnvironment: {
    doc: 'The CDP environment the app is running in. With the addition of "local" for local development',
    format: [
      'local',
      'infra-dev',
      'management',
      'dev',
      'test',
      'perf-test',
      'ext-test',
      'prod'
    ],
    default: 'local',
    env: 'ENVIRONMENT'
  },
  log: {
    isEnabled: {
      doc: 'Is logging enabled',
      format: Boolean,
      default: !isTest,
      env: 'LOG_ENABLED'
    },
    level: {
      doc: 'Logging level',
      format: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
      default: 'info',
      env: 'LOG_LEVEL'
    },
    format: {
      doc: 'Format to output logs in',
      format: ['ecs', 'pino-pretty'],
      default: isProduction ? 'ecs' : 'pino-pretty',
      env: 'LOG_FORMAT'
    },
    redact: {
      doc: 'Log paths to redact',
      format: Array,
      default: isProduction
        ? ['req.headers.authorization', 'req.headers.cookie', 'res.headers']
        : ['req', 'res', 'responseTime']
    }
  },
  mongo: {
    enabled: {
      doc: 'Enable MongoDB connection',
      format: Boolean,
      default: false,
      env: 'MONGO_ENABLED'
    },
    mongoUrl: {
      doc: 'URI for mongodb',
      format: String,
      default: 'mongodb://127.0.0.1:27017/',
      env: 'MONGO_URI'
    },
    databaseName: {
      doc: 'database for mongodb',
      format: String,
      default: 'content-reviewer-backend',
      env: 'MONGO_DATABASE'
    },
    mongoOptions: {
      retryWrites: {
        doc: 'Enable Mongo write retries, overrides mongo URI when set.',
        format: Boolean,
        default: null,
        nullable: true,
        env: 'MONGO_RETRY_WRITES'
      },
      readPreference: {
        doc: 'Mongo read preference, overrides mongo URI when set.',
        format: [
          'primary',
          'primaryPreferred',
          'secondary',
          'secondaryPreferred',
          'nearest'
        ],
        default: null,
        nullable: true,
        env: 'MONGO_READ_PREFERENCE'
      }
    }
  },
  httpProxy: {
    doc: 'HTTP Proxy URL',
    format: String,
    nullable: true,
    default: null,
    env: 'HTTP_PROXY'
  },
  isMetricsEnabled: {
    doc: 'Enable metrics reporting',
    format: Boolean,
    default: isProduction,
    env: 'ENABLE_METRICS'
  },
  tracing: {
    header: {
      doc: 'CDP tracing header name',
      format: String,
      default: 'x-cdp-request-id',
      env: 'TRACING_HEADER'
    }
  },
  cors: {
    origin: {
      doc: 'CORS allowed origins',
      format: Array,
      default: ['http://localhost:3000'],
      env: 'CORS_ORIGIN'
    },
    credentials: {
      doc: 'CORS credentials',
      format: Boolean,
      default: true,
      env: 'CORS_CREDENTIALS'
    }
  },
  s3: {
    endpoint: {
      doc: 'S3 endpoint URL (for LocalStack)',
      format: String,
      default: null,
      nullable: true,
      env: 'S3_ENDPOINT'
    },
    region: {
      doc: 'AWS region for S3',
      format: String,
      default: 'eu-west-2',
      env: 'S3_REGION'
    },
    bucket: {
      doc: 'S3 bucket for general storage',
      format: String,
      default: 'dev-service-optimisation-c63f2',
      env: 'S3_BUCKET'
    },
    rulesPath: {
      doc: 'S3 path for rules repository',
      format: String,
      default: 'rules',
      env: 'S3_RULES_PATH'
    }
  },
  upload: {
    s3Bucket: {
      doc: 'S3 bucket for uploaded files',
      format: String,
      default: 'dev-service-optimisation-c63f2',
      env: 'UPLOAD_S3_BUCKET'
    },
    s3Path: {
      doc: 'S3 path prefix for uploaded files',
      format: String,
      default: 'content-uploads',
      env: 'UPLOAD_S3_PATH'
    },
    maxFileSize: {
      doc: 'Maximum file size in bytes (10MB default)',
      format: Number,
      default: 10 * 1024 * 1024,
      env: 'UPLOAD_MAX_FILE_SIZE'
    },
    allowedMimeTypes: {
      doc: 'Allowed MIME types for uploads',
      format: Array,
      default: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ],
      env: 'UPLOAD_ALLOWED_MIME_TYPES'
    },
    region: {
      doc: 'AWS region for S3',
      format: String,
      default: 'eu-west-2',
      env: 'AWS_REGION'
    }
  },
  s3EventTriggerEnabled: {
    doc: 'Enable S3 automatic event notifications to SQS (recommended). Set to false to use manual SQS calls from upload route.',
    format: Boolean,
    default: false,
    env: 'S3_EVENT_TRIGGER_ENABLED'
  },
  sqs: {
    endpoint: {
      doc: 'SQS endpoint URL (for LocalStack)',
      format: String,
      default: null,
      nullable: true,
      env: 'SQS_ENDPOINT'
    },
    queueUrl: {
      doc: 'SQS queue URL for content review',
      format: String,
      default:
        'https://sqs.eu-west-2.amazonaws.com/332499610595/content_review_status',
      env: 'SQS_QUEUE_URL'
    },
    queueName: {
      doc: 'SQS queue name',
      format: String,
      default: 'content_review_status',
      env: 'SQS_QUEUE_NAME'
    },
    region: {
      doc: 'AWS region for SQS',
      format: String,
      default: 'eu-west-2',
      env: 'SQS_REGION'
    },
    maxMessages: {
      doc: 'Maximum number of messages to receive at once',
      format: Number,
      default: 10,
      env: 'SQS_MAX_MESSAGES'
    },
    waitTimeSeconds: {
      doc: 'Long polling wait time in seconds',
      format: Number,
      default: 20,
      env: 'SQS_WAIT_TIME_SECONDS'
    },
    visibilityTimeout: {
      doc: 'Message visibility timeout in seconds',
      format: Number,
      default: 300,
      env: 'SQS_VISIBILITY_TIMEOUT'
    }
  },
  bedrock: {
    useMockAI: {
      doc: 'Use mock AI service instead of real AWS Bedrock (for development/testing)',
      format: Boolean,
      default: false,
      env: 'USE_MOCK_AI'
    },
    endpoint: {
      doc: 'Bedrock endpoint URL (for LocalStack/testing)',
      format: String,
      default: null,
      nullable: true,
      env: 'BEDROCK_ENDPOINT'
    },
    region: {
      doc: 'AWS region for Bedrock AI',
      format: String,
      default: 'eu-west-2',
      env: 'BEDROCK_REGION'
    },
    inferenceProfileArn: {
      doc: 'Bedrock inference profile ARN with guardrails',
      format: String,
      default:
        'arn:aws:bedrock:eu-west-2:332499610595:application-inference-profile/wrmld9jrycya',
      env: 'BEDROCK_INFERENCE_PROFILE_ARN'
    },
    maxTokens: {
      doc: 'Maximum tokens for AI response',
      format: Number,
      default: 8000,
      env: 'BEDROCK_MAX_TOKENS'
    },
    temperature: {
      doc: 'Temperature for AI response (0.0-1.0)',
      format: Number,
      default: 0.3,
      env: 'BEDROCK_TEMPERATURE'
    }
  },
  aws: {
    accountId: {
      doc: 'AWS Account ID',
      format: String,
      default: '332499610595',
      env: 'AWS_ACCOUNT_ID'
    }
  }
})

config.validate({ allowed: 'strict' })

export { config }
