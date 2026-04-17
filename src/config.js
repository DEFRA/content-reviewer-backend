import convict from 'convict'
import convictFormatWithValidator from 'convict-format-with-validator'

import { convictValidateMongoUri } from './common/helpers/convict/validate-mongo-uri.js'

convict.addFormat(convictValidateMongoUri)
convict.addFormats(convictFormatWithValidator)

const isProduction = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test'
const cdpEnvironment = process.env.ENVIRONMENT || 'local'

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
      default: ['https://content-reviewer-frontend.dev.cdp-int.defra.cloud'],
      env: 'CORS_ORIGIN'
    },
    credentials: {
      doc: 'CORS credentials',
      format: Boolean,
      default: true,
      env: 'CORS_CREDENTIALS'
    }
  },
  upload: {
    allowedMimeTypes: {
      doc: 'Allowed MIME types for file uploads',
      format: Array,
      default: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ],
      env: 'UPLOAD_ALLOWED_MIME_TYPES'
    },
    maxFileSize: {
      doc: 'Maximum file size in bytes (10MB default)',
      format: Number,
      default: 10 * 1024 * 1024,
      env: 'UPLOAD_MAX_FILE_SIZE'
    }
  },
  cdpUploader: {
    url: {
      doc: 'cdp-uploader service URL for file uploads',
      format: String,
      default: 'https://cdp-uploader.dev.cdp-int.defra.cloud',
      env: 'CDP_UPLOADER_URL'
    },
    pollTimeoutMs: {
      doc: 'cdp-uploader polling timeout in milliseconds',
      format: Number,
      default: 60000,
      env: 'CDP_POLL_TIMEOUT_MS'
    },
    pollIntervalMs: {
      doc: 'cdp-uploader poll interval in milliseconds',
      format: Number,
      default: 1500,
      env: 'CDP_POLL_INTERVAL_MS'
    }
  },
  s3: {
    bucket: {
      doc: 'S3 bucket for uploads, results, and prompts',
      format: String,
      default: 'dev-service-optimisation-c63f2',
      env: 'S3_BUCKET'
    },
    promptKey: {
      doc: 'S3 key for system prompt file',
      format: String,
      default: 'prompts/system-prompt.md',
      env: 'S3_PROMPT_KEY'
    },
    s3Path: {
      doc: 'S3 path for the storage',
      format: String,
      default: 'reviews',
      env: 'S3_PATH'
    },
    rawS3Path: {
      doc: 'S3 path for the raw file storage',
      format: String,
      default: 'content-uploads',
      env: 'RAW_S3_PATH'
    }
  },
  aws: {
    accountId: {
      doc: 'AWS Account ID',
      format: String,
      default: '332499610595',
      env: 'AWS_ACCOUNT_ID'
    },
    region: {
      doc: 'AWS region (global)',
      format: String,
      default: 'eu-west-2',
      env: 'AWS_REGION'
    },
    endpoint: {
      doc: 'AWS endpoint URL (for LocalStack or local development). Leave unset for production AWS.',
      format: String,
      nullable: true,
      default: null,
      env: 'AWS_ENDPOINT'
    }
  },
  sqs: {
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
      doc: 'Message visibility timeout in seconds. Must exceed the Bedrock client timeout (360s) plus processing overhead — set to 900s (15 min) so a large 100k-char document cannot become visible again mid-processing.',
      format: Number,
      default: 900,
      env: 'SQS_VISIBILITY_TIMEOUT'
    },
    maxConcurrentRequests: {
      doc: 'Maximum concurrent Bedrock API requests. Each 100k-char review uses ~25-30k input tokens; running too many concurrently exhausts the tokens-per-minute quota. Keep at 2 unless the Bedrock quota has been increased.',
      format: Number,
      default: 2,
      env: 'SQS_MAX_CONCURRENT_REQUESTS'
    },
    maxReceiveCount: {
      doc: 'Maximum number of times a message may be received before being dead-lettered (application-level guard). Should match the SQS queue RedrivePolicy maxReceiveCount.',
      format: Number,
      default: 3,
      env: 'SQS_MAX_RECEIVE_COUNT'
    }
  },
  bedrock: {
    enabled: {
      doc: 'Enable AWS Bedrock AI integration',
      format: Boolean,
      default: true,
      env: 'ENABLE_BEDROCK'
    },
    inferenceProfileArn: {
      doc: 'CDP Bedrock inference profile ARN',
      format: String,
      default:
        'arn:aws:bedrock:eu-west-2:332499610595:application-inference-profile/wrmld9jrycya',
      env: 'BEDROCK_INFERENCE_PROFILE_ARN'
    },
    guardrailArn: {
      doc: 'CDP Bedrock guardrail ARN (HIGH level with PII Detect)',
      format: String,
      default: 'arn:aws:bedrock:eu-west-2:332499610595:guardrail/th34diy2ti2t',
      env: 'BEDROCK_GUARDRAIL_ARN'
    },
    guardrailVersion: {
      doc: 'Bedrock guardrail version',
      format: String,
      default: '1',
      env: 'BEDROCK_GUARDRAIL_VERSION'
    },
    modelName: {
      doc: 'Bedrock model name (for reference)',
      format: String,
      default: 'anthropic.claude-3-7-sonnet-20250219-v1:0',
      env: 'BEDROCK_MODEL_NAME'
    },
    maxTokens: {
      doc: 'Maximum output tokens in AI response. The structured response (scores + 5-15 position-based improvements) is ~3-4k tokens. Setting this to 100k was reserving unused token quota and inflating TPM usage. 8192 provides ample headroom.',
      format: Number,
      default: 8192,
      env: 'BEDROCK_MAX_TOKENS'
    },
    temperature: {
      doc: 'AI temperature (0.0-1.0, lower is more focused)',
      format: Number,
      default: 0.1,
      env: 'BEDROCK_TEMPERATURE'
    },
    topP: {
      doc: 'Top-P nucleus sampling (0.0-1.0, lower is more deterministic)',
      format: Number,
      default: 0.3,
      env: 'BEDROCK_TOP_P'
    }
  },
  mockMode: {
    s3Upload: {
      doc: 'Mock S3 uploads for local dev without AWS',
      format: Boolean,
      default: false,
      env: 'MOCK_S3_UPLOAD'
    },
    skipSqsWorker: {
      doc: 'Skip starting SQS worker',
      format: Boolean,
      default: false,
      env: 'SKIP_SQS_WORKER'
    }
  },
  cleanup: {
    enabled: {
      doc: 'Enable automatic cleanup of old reviews',
      format: Boolean,
      default: true,
      env: 'CLEANUP_ENABLED'
    },
    intervalHours: {
      doc: 'Interval in hours between cleanup runs',
      format: Number,
      default: 1,
      env: 'CLEANUP_INTERVAL_HOURS'
    },
    retentionDays: {
      doc: 'Number of days to retain reviews before deletion',
      format: Number,
      default: 5,
      env: 'CLEANUP_RETENTION_DAYS'
    }
  },
  contentReview: {
    maxCharLength: {
      doc: 'Maximum character length for content review (set in cdp-app-config)',
      format: Number,
      default: 100000,
      env: 'CONTENT_REVIEW_MAX_CHAR_LEN'
    }
  }
})

config.validate({ allowed: 'strict' })

export { config }
