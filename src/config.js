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
  serverUrl: {
    doc: 'The public base URL of this service — used as the CDP Uploader callbackUrl so CDP Uploader can POST back when scanning is complete',
    format: String,
    default: 'http://localhost:3001',
    env: 'SERVER_URL'
  },
  serviceName: {
    doc: 'Api Service Name',
    format: String,
    default: 'content-reviewer-backend'
  },
  hapi: {
    socketTimeoutMs: {
      doc: 'Hapi TCP socket inactivity timeout in ms. Must exceed `hapi.serverTimeoutMs` so the handler error response is delivered before the socket is closed. Must also be less than the upstream nginx/load-balancer read timeout.',
      format: Number,
      default: 90_000,
      env: 'HAPI_SOCKET_TIMEOUT_MS'
    },
    serverTimeoutMs: {
      doc: 'Hapi server-side request processing timeout in ms. Hard ceiling on how long any single request handler can run. Fires 5 s before the socket timeout so a clean 503 can be returned to the client.',
      format: Number,
      default: 85_000,
      env: 'HAPI_SERVER_TIMEOUT_MS'
    }
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
        ? [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-admin-api-key"]',
            'res.headers'
          ]
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
  cdpUploader: {
    url: {
      doc: 'cdp-uploader service URL for file uploads',
      format: String,
      default: 'https://cdp-uploader.dev.cdp-int.defra.cloud',
      env: 'CDP_UPLOADER_URL'
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
    rawS3Path: {
      doc: 'S3 path for the raw file storage',
      format: String,
      default: 'content-uploads',
      env: 'RAW_S3_PATH'
    },
    requestTimeoutMs: {
      doc: 'S3 client request timeout in milliseconds. Applied to PutObject calls (text-content upload). 30 s is generous for a text payload over a VPC-internal connection; prevents silent hangs when S3 is degraded.',
      format: Number,
      default: 30000,
      env: 'S3_REQUEST_TIMEOUT_MS'
    }
  },
  aws: {
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
      doc: 'Message visibility timeout in seconds. Must exceed BEDROCK_TIMEOUT_MS (120 s). Set to 180 s (3 min) — gives Bedrock its full 2-min window plus a 60 s safety margin. On failure the processor explicitly resets this window to 180 s from failure time so the retry is always delayed by the full 3 minutes.',
      format: Number,
      default: 180,
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
    },
    heartbeatIntervalMs: {
      doc: 'How often the SQS worker extends the message visibility timeout while processing (ms). Must be smaller than `bedrock.timeoutMs` so the heartbeat fires before any plausible Bedrock timeout. 90 s gives Bedrock its full 120 s budget while still firing once as a safety net.',
      format: Number,
      default: 90_000,
      env: 'SQS_HEARTBEAT_INTERVAL_MS'
    },
    heartbeatVisibilitySeconds: {
      doc: 'How many seconds to add to the SQS message visibility window on each heartbeat tick. Same value is used to reset the visibility window on failure so a retried message always waits the full backoff from the moment of failure.',
      format: Number,
      default: 180,
      env: 'SQS_HEARTBEAT_VISIBILITY_SECONDS'
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
      doc: 'AI temperature (0.0-1.0). 0 = greedy/fully deterministic — same input always produces the same output. Required for reproducible reviews.',
      format: Number,
      default: 0,
      env: 'BEDROCK_TEMPERATURE'
    },
    topP: {
      doc: 'Top-P nucleus sampling (0.0-1.0). 1 = no nucleus filtering. Combined with temperature=0 this maximises determinism.',
      format: Number,
      default: 1,
      env: 'BEDROCK_TOP_P'
    },
    timeoutMs: {
      doc: 'Bedrock Converse request timeout in ms. With chunking, each 25k-char chunk typically responds within 30-60 s; 120 s is the hard upper limit before we surface a timeout error. Must remain less than `sqs.visibilityTimeout` (180 s) so the heartbeat fires first and the message is not redelivered during a slow call.',
      format: Number,
      default: 120_000,
      env: 'BEDROCK_TIMEOUT_MS'
    },
    chunkSizeChars: {
      doc: 'Maximum characters per Bedrock chunk. Keeps each call within the CDP shared token quota — 25,000 chars (~6,250 content tokens) + ~3,000 system prompt + ~400 overhead = ~9,650 input tokens per chunk. With maxCharLength=100,000 this produces 4 chunks processed in parallel.',
      format: Number,
      default: 25000,
      env: 'BEDROCK_CHUNK_SIZE_CHARS'
    },
    maxTokensPerMinute: {
      doc: 'Global token-per-minute cap across all concurrent Bedrock calls. CDP shared platform quota is ~50,000 TPM; default is 45,000 to leave a 10% safety margin. Chunks are processed sequentially and gated by this limit so no single user can exhaust the shared quota.',
      format: Number,
      default: 45000,
      env: 'BEDROCK_MAX_TOKENS_PER_MINUTE'
    },
    systemPromptOverheadTokens: {
      doc: 'Conservative token allowance added to each chunk estimate to account for the system prompt, user prompt wrapper, and request overhead. Used by the rate limiter before the prompt is loaded. System prompt ~3,000 + overhead ~400 + safety margin = 4,000.',
      format: Number,
      default: 4000,
      env: 'BEDROCK_SYSTEM_PROMPT_OVERHEAD_TOKENS'
    },
    throttleMaxRetries: {
      doc: 'Number of Bedrock-level retries on ThrottlingException before failing. Set to 1 so a transient quota spike retries once with a short backoff rather than immediately failing the review.',
      format: Number,
      default: 1,
      env: 'BEDROCK_THROTTLE_MAX_RETRIES'
    },
    throttleBackoffMs: {
      doc: 'Base backoff in ms before the first Bedrock retry on ThrottlingException. With exponential backoff and 1 retry this is also the fixed wait time.',
      format: Number,
      default: 5000,
      env: 'BEDROCK_THROTTLE_BACKOFF_MS'
    },
    throttleBackoffMaxMs: {
      doc: 'Maximum backoff cap in ms for Bedrock ThrottlingException retries.',
      format: Number,
      default: 15000,
      env: 'BEDROCK_THROTTLE_BACKOFF_MAX_MS'
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
      default: 24,
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
  },
  rateLimit: {
    enabled: {
      doc: 'Enable per-IP rate limiting on HTTP endpoints',
      format: Boolean,
      default: true,
      env: 'RATE_LIMIT_ENABLED'
    },
    windowMs: {
      doc: 'Rate limit sliding window in milliseconds',
      format: Number,
      default: 60000,
      env: 'RATE_LIMIT_WINDOW_MS'
    },
    maxRequests: {
      doc: 'Maximum requests per IP per window',
      format: Number,
      default: 100,
      env: 'RATE_LIMIT_MAX_REQUESTS'
    }
  },
  adminApiKey: {
    doc: 'API key required to access /admin/* endpoints. Set this secret in production — leave unset to disable auth (local/dev only).',
    format: String,
    nullable: true,
    default: null,
    sensitive: true,
    env: 'ADMIN_API_KEY'
  },
  jwt: {
    secret: {
      doc: 'HMAC-SHA256 secret used to sign/verify JWT access and refresh tokens. Must be at least 32 characters. Set JWT_SECRET in CDP platform secrets.',
      format: String,
      default: 'change-me-jwt-secret-must-be-32-chars-min',
      sensitive: true,
      env: 'JWT_SECRET'
    },
    accessTokenExpirySeconds: {
      doc: 'JWT access token lifetime in seconds (default: 3600 = 1 hour).',
      format: Number,
      default: 3600,
      env: 'JWT_ACCESS_TOKEN_EXPIRY_SECONDS'
    },
    refreshTokenExpirySeconds: {
      doc: 'JWT refresh token lifetime in seconds (default: 604800 = 7 days).',
      format: Number,
      default: 604800,
      env: 'JWT_REFRESH_TOKEN_EXPIRY_SECONDS'
    }
  }
})

config.validate({ allowed: 'strict' })

export { config }
