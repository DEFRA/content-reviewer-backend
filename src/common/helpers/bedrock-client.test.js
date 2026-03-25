import { describe, it, expect, vi, beforeEach } from 'vitest'

const BEDROCK_MODEL_NAME = 'claude-3-5-sonnet'
const INFERENCE_PROFILE_ARN =
  'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet'
const GUARDRAIL_ARN = 'arn:aws:bedrock:us-east-1::guardrail/test-guardrail'
const GUARDRAIL_VERSION = '1'
const AWS_REGION = 'us-east-1'
const MAX_TOKENS = 4096
const TEMPERATURE = 0.7
const TOP_P = 0.9
const INPUT_TOKENS = 10
const OUTPUT_TOKENS = 20
const TOTAL_TOKENS = 30
const REVIEW_INPUT_TOKENS = 50
const REVIEW_OUTPUT_TOKENS = 100
const REVIEW_TOTAL_TOKENS = 150
const HTTP_STATUS_500 = 500
const SAMPLE_USER_MESSAGE = 'Review this content'

const CONFIG_KEYS = {
  BEDROCK_ENABLED: 'bedrock.enabled',
  MODEL_NAME: 'bedrock.modelName',
  INFERENCE_ARN: 'bedrock.inferenceProfileArn',
  GUARDRAIL_ARN: 'bedrock.guardrailArn',
  GUARDRAIL_VERSION: 'bedrock.guardrailVersion',
  AWS_REGION: 'aws.region',
  MAX_TOKENS: 'bedrock.maxTokens',
  TEMPERATURE: 'bedrock.temperature',
  TOP_P: 'bedrock.topP'
}

const { MOCK_SEND } = vi.hoisted(() => ({ MOCK_SEND: vi.fn() }))

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(function () {
    return { send: MOCK_SEND }
  }),
  ConverseCommand: vi.fn(function (input) {
    return input
  })
}))

vi.mock('../../config.js', () => {
  const configValues = {
    'bedrock.enabled': true,
    'bedrock.modelName': 'claude-3-5-sonnet',
    'bedrock.inferenceProfileArn':
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet',
    'bedrock.guardrailArn':
      'arn:aws:bedrock:us-east-1::guardrail/test-guardrail',
    'bedrock.guardrailVersion': '1',
    'aws.region': 'us-east-1',
    'bedrock.maxTokens': 4096,
    'bedrock.temperature': 0.7,
    'bedrock.topP': 0.9
  }
  return { config: { get: vi.fn((key) => configValues[key] ?? null) } }
})

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

import { bedrockClient } from './bedrock-client.js'

beforeEach(() => {
  vi.clearAllMocks()
  MOCK_SEND.mockReset()
})

// ============ INITIALIZATION ============

describe('bedrockClient initialization', () => {
  it('exports a singleton bedrockClient', () => {
    expect(bedrockClient).toBeDefined()
  })

  it('is enabled when bedrock.enabled is true', () => {
    expect(bedrockClient.enabled).toBe(true)
  })

  it('sets modelName from config', () => {
    expect(bedrockClient.modelName).toBe(BEDROCK_MODEL_NAME)
  })

  it('sets inferenceProfileArn from config', () => {
    expect(bedrockClient.inferenceProfileArn).toBe(INFERENCE_PROFILE_ARN)
  })

  it('sets guardrailArn from config', () => {
    expect(bedrockClient.guardrailArn).toBe(GUARDRAIL_ARN)
  })

  it('sets guardrailVersion from config', () => {
    expect(bedrockClient.guardrailVersion).toBe(GUARDRAIL_VERSION)
  })

  it('sets region from config', () => {
    expect(bedrockClient.region).toBe(AWS_REGION)
  })

  it('sets maxTokens from config', () => {
    expect(bedrockClient.maxTokens).toBe(MAX_TOKENS)
  })

  it('sets temperature from config', () => {
    expect(bedrockClient.temperature).toBe(TEMPERATURE)
  })

  it('sets topP from config', () => {
    expect(bedrockClient.topP).toBe(TOP_P)
  })
})

// ============ sendMessage ============

describe('bedrockClient.sendMessage', () => {
  const SAMPLE_RESPONSE_TEXT = 'This content is well written.'

  function buildBedrockResponse(overrides = {}) {
    return {
      output: {
        message: {
          content: [{ text: SAMPLE_RESPONSE_TEXT }]
        }
      },
      usage: {
        inputTokens: INPUT_TOKENS,
        outputTokens: OUTPUT_TOKENS,
        totalTokens: TOTAL_TOKENS
      },
      trace: { guardrail: { action: 'NONE', assessments: [] } },
      stopReason: 'end_turn',
      ...overrides
    }
  }

  it('returns success response with content', async () => {
    MOCK_SEND.mockResolvedValueOnce(buildBedrockResponse())

    const result = await bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)

    expect(result.success).toBe(true)
    expect(result.content).toBe(SAMPLE_RESPONSE_TEXT)
  })

  it('includes usage stats in response', async () => {
    MOCK_SEND.mockResolvedValueOnce(buildBedrockResponse())

    const result = await bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)

    expect(result.usage.inputTokens).toBe(INPUT_TOKENS)
    expect(result.usage.outputTokens).toBe(OUTPUT_TOKENS)
    expect(result.usage.totalTokens).toBe(TOTAL_TOKENS)
  })

  it('includes stopReason in response', async () => {
    MOCK_SEND.mockResolvedValueOnce(buildBedrockResponse())

    const result = await bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)

    expect(result.stopReason).toBe('end_turn')
  })

  it('returns blocked response when guardrail action is BLOCKED', async () => {
    MOCK_SEND.mockResolvedValueOnce(
      buildBedrockResponse({
        trace: {
          guardrail: {
            action: 'BLOCKED',
            assessments: [{ reason: 'unsafe content' }]
          }
        }
      })
    )

    const result = await bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)

    expect(result.success).toBe(false)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('guardrail')
  })

  it('passes conversation history as part of messages', async () => {
    MOCK_SEND.mockResolvedValueOnce(buildBedrockResponse())
    const history = [{ role: 'user', content: [{ text: 'previous message' }] }]

    await bedrockClient.sendMessage(SAMPLE_USER_MESSAGE, history)

    const sentCommand = MOCK_SEND.mock.calls[0][0]
    expect(sentCommand.messages).toHaveLength(2)
  })

  it('handles response with missing output gracefully', async () => {
    MOCK_SEND.mockResolvedValueOnce({
      output: {},
      usage: {},
      trace: {},
      stopReason: 'end_turn'
    })

    const result = await bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)

    expect(result.success).toBe(true)
    expect(result.content).toBe('')
  })
})

// ============ sendMessage - AWS error handling ============

describe('bedrockClient.sendMessage - AWS credential errors', () => {
  beforeEach(() => {
    vi.spyOn(bedrockClient, '_sleep').mockResolvedValue(undefined)
  })

  it('handles CredentialsProviderError by throwing friendly message', async () => {
    const credError = new Error('No credentials')
    credError.name = 'CredentialsProviderError'
    MOCK_SEND.mockRejectedValue(credError)

    await expect(
      bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)
    ).rejects.toThrow('AWS credentials not found')
  })

  it('handles AccessDeniedException by throwing friendly message', async () => {
    const accessError = new Error('Denied')
    accessError.name = 'AccessDeniedException'
    MOCK_SEND.mockRejectedValue(accessError)

    await expect(
      bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)
    ).rejects.toThrow('Access denied to Bedrock')
  })

  it('handles ResourceNotFoundException by throwing friendly message', async () => {
    const notFoundError = new Error('Not found')
    notFoundError.name = 'ResourceNotFoundException'
    MOCK_SEND.mockRejectedValue(notFoundError)

    await expect(
      bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)
    ).rejects.toThrow('Bedrock resource not found')
  })

  it('handles ThrottlingException by throwing friendly message after retries', async () => {
    const throttleError = new Error('Too many tokens')
    throttleError.name = 'ThrottlingException'
    MOCK_SEND.mockRejectedValue(throttleError)

    await expect(
      bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)
    ).rejects.toThrow('token quota exceeded')
  })

  it('handles ValidationException by throwing friendly message', async () => {
    const validationError = new Error('Invalid input')
    validationError.name = 'ValidationException'
    MOCK_SEND.mockRejectedValue(validationError)

    await expect(
      bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)
    ).rejects.toThrow('Bedrock validation error')
  })
})

describe('bedrockClient.sendMessage - AWS service errors', () => {
  beforeEach(() => {
    vi.spyOn(bedrockClient, '_sleep').mockResolvedValue(undefined)
  })

  it('handles ServiceUnavailableException by throwing friendly message after retries', async () => {
    const serviceError = new Error('Service down')
    serviceError.name = 'ServiceUnavailableException'
    MOCK_SEND.mockRejectedValue(serviceError)

    await expect(
      bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)
    ).rejects.toThrow('temporarily unavailable')
  })

  it('handles TimeoutError by throwing friendly message after retries', async () => {
    const timeoutError = new Error('Request timed out')
    timeoutError.name = 'TimeoutError'
    MOCK_SEND.mockRejectedValue(timeoutError)

    await expect(
      bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)
    ).rejects.toThrow('timed out')
  })

  it('handles ETIMEDOUT code by throwing friendly message after retries', async () => {
    const etimedoutError = new Error('Connection timed out')
    etimedoutError.code = 'ETIMEDOUT'
    MOCK_SEND.mockRejectedValue(etimedoutError)

    await expect(
      bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)
    ).rejects.toThrow('timed out')
  })

  it('handles unknown errors with generic message', async () => {
    const unknownError = new Error('Unexpected failure')
    unknownError.name = 'UnknownError'
    MOCK_SEND.mockRejectedValue(unknownError)

    await expect(
      bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)
    ).rejects.toThrow('Bedrock API error')
  })

  it('throws when client is disabled', async () => {
    const disabledClient = Object.create(bedrockClient)
    disabledClient.enabled = false

    await expect(
      disabledClient.sendMessage(SAMPLE_USER_MESSAGE)
    ).rejects.toThrow('Bedrock AI is not enabled')
  })
})

// ============ reviewContent ============

describe('bedrockClient.reviewContent', () => {
  const SAMPLE_CONTENT = 'This is content to review for GOV.UK compliance.'
  const SAMPLE_REVIEW_TEXT = 'The content meets GOV.UK standards.'

  function buildBedrockResponse(text = SAMPLE_REVIEW_TEXT) {
    return {
      output: { message: { content: [{ text }] } },
      usage: {
        inputTokens: REVIEW_INPUT_TOKENS,
        outputTokens: REVIEW_OUTPUT_TOKENS,
        totalTokens: REVIEW_TOTAL_TOKENS
      },
      trace: { guardrail: { action: 'NONE', assessments: [] } },
      stopReason: 'end_turn'
    }
  }

  it('returns success result with review text', async () => {
    MOCK_SEND.mockResolvedValueOnce(buildBedrockResponse())

    const result = await bedrockClient.reviewContent(SAMPLE_CONTENT)

    expect(result.success).toBe(true)
    expect(result.review).toBe(SAMPLE_REVIEW_TEXT)
  })

  it('includes usage stats in the result', async () => {
    MOCK_SEND.mockResolvedValueOnce(buildBedrockResponse())

    const result = await bedrockClient.reviewContent(SAMPLE_CONTENT)

    expect(result.usage).toBeDefined()
    expect(result.usage.totalTokens).toBe(REVIEW_TOTAL_TOKENS)
  })

  it('uses provided contentType in the result', async () => {
    MOCK_SEND.mockResolvedValueOnce(buildBedrockResponse())

    const result = await bedrockClient.reviewContent(SAMPLE_CONTENT, 'web_page')

    expect(result.contentType).toBe('web_page')
  })

  it('defaults contentType to "general" when not provided', async () => {
    MOCK_SEND.mockResolvedValueOnce(buildBedrockResponse())

    const result = await bedrockClient.reviewContent(SAMPLE_CONTENT)

    expect(result.contentType).toBe('general')
  })

  it('returns failure when guardrail blocks content', async () => {
    MOCK_SEND.mockResolvedValueOnce({
      output: { message: { content: [{ text: '' }] } },
      usage: {},
      trace: { guardrail: { action: 'BLOCKED', assessments: [] } },
      stopReason: 'guardrail_intervened'
    })

    const result = await bedrockClient.reviewContent(SAMPLE_CONTENT)

    expect(result.success).toBe(false)
    expect(result.error).toContain('guardrail')
  })

  it('rethrows errors from sendMessage', async () => {
    const error = new Error('Bedrock API error: internal server error')
    MOCK_SEND.mockRejectedValueOnce(error)

    await expect(bedrockClient.reviewContent(SAMPLE_CONTENT)).rejects.toThrow()
  })
})

// ============ _extractErrorDetails ============

describe('bedrockClient._extractErrorDetails', () => {
  it('extracts basic error properties', () => {
    const error = new Error('test error')
    error.name = 'TestError'
    error.code = 'TEST_CODE'

    const details = bedrockClient._extractErrorDetails(error)

    expect(details.name).toBe('TestError')
    expect(details.message).toBe('test error')
    expect(details.code).toBe('TEST_CODE')
  })

  it('extracts AWS metadata fields', () => {
    const error = new Error('aws error')
    error.$metadata = { httpStatusCode: HTTP_STATUS_500, requestId: 'req-123' }
    error.$fault = 'server'
    error.$service = 'bedrock'

    const details = bedrockClient._extractErrorDetails(error)

    expect(details.statusCode).toBe(HTTP_STATUS_500)
    expect(details.requestId).toBe('req-123')
    expect(details.$fault).toBe('server')
    expect(details.$service).toBe('bedrock')
  })

  it('handles non-serializable errors gracefully', () => {
    const error = new Error('circular')
    const circular = {}
    circular.self = circular
    error.circular = circular

    // Override JSON.stringify to force serialization failure for this object
    const originalStringify = JSON.stringify
    vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw new Error('circular structure')
    })

    const details = bedrockClient._extractErrorDetails(error)

    expect(details.serializationError).toBeDefined()
    JSON.stringify = originalStringify
  })
})

// ============ _buildMessages ============

describe('bedrockClient._buildMessages', () => {
  it('appends user message to empty history', () => {
    const messages = bedrockClient._buildMessages('hello', [])

    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content[0].text).toBe('hello')
  })

  it('appends user message after existing history', () => {
    const history = [{ role: 'assistant', content: [{ text: 'previous' }] }]
    const messages = bedrockClient._buildMessages('follow-up', history)

    expect(messages).toHaveLength(2)
    expect(messages[1].content[0].text).toBe('follow-up')
  })
})

// ============ _buildGuardrailConfig ============

describe('bedrockClient._buildGuardrailConfig', () => {
  it('returns config with guardrailIdentifier', () => {
    const config = bedrockClient._buildGuardrailConfig()

    expect(config.guardrailIdentifier).toBe(GUARDRAIL_ARN)
  })

  it('returns config with guardrailVersion', () => {
    const config = bedrockClient._buildGuardrailConfig()

    expect(config.guardrailVersion).toBe(GUARDRAIL_VERSION)
  })

  it('enables trace in guardrail config', () => {
    const config = bedrockClient._buildGuardrailConfig()

    expect(config.trace).toBe('enabled')
  })
})

// ============ _buildInferenceConfig ============

describe('bedrockClient._buildInferenceConfig', () => {
  it('returns config with maxTokens', () => {
    const config = bedrockClient._buildInferenceConfig()

    expect(config.maxTokens).toBe(MAX_TOKENS)
  })

  it('returns config with temperature', () => {
    const config = bedrockClient._buildInferenceConfig()

    expect(config.temperature).toBe(TEMPERATURE)
  })

  it('returns config with topP', () => {
    const config = bedrockClient._buildInferenceConfig()

    expect(config.topP).toBe(TOP_P)
  })
})

// ============ _isRetryableError ============

describe('bedrockClient._isRetryableError', () => {
  it('returns true for ThrottlingException', () => {
    const error = new Error('throttled')
    error.name = 'ThrottlingException'
    expect(bedrockClient._isRetryableError(error)).toBe(true)
  })

  it('returns true for ServiceUnavailableException', () => {
    const error = new Error('unavailable')
    error.name = 'ServiceUnavailableException'
    expect(bedrockClient._isRetryableError(error)).toBe(true)
  })

  it('returns true for TimeoutError', () => {
    const error = new Error('timeout')
    error.name = 'TimeoutError'
    expect(bedrockClient._isRetryableError(error)).toBe(true)
  })

  it('returns true for ETIMEDOUT code', () => {
    const error = new Error('timed out')
    error.code = 'ETIMEDOUT'
    expect(bedrockClient._isRetryableError(error)).toBe(true)
  })

  it('returns true for ECONNRESET code', () => {
    const error = new Error('connection reset')
    error.code = 'ECONNRESET'
    expect(bedrockClient._isRetryableError(error)).toBe(true)
  })

  it('returns false for non-retryable errors', () => {
    const error = new Error('auth failed')
    error.name = 'AccessDeniedException'
    expect(bedrockClient._isRetryableError(error)).toBe(false)
  })

  it('returns false for ValidationException', () => {
    const error = new Error('invalid input')
    error.name = 'ValidationException'
    expect(bedrockClient._isRetryableError(error)).toBe(false)
  })
})

// ============ _sleep ============

describe('bedrockClient._sleep', () => {
  it('resolves after the given delay', async () => {
    await expect(bedrockClient._sleep(0)).resolves.toBeUndefined()
  })
})

// ============ sendMessage - retry behaviour ============

describe('bedrockClient.sendMessage - retry on retryable errors', () => {
  const SAMPLE_RESPONSE_TEXT = 'Content looks good.'

  function buildBedrockResponse() {
    return {
      output: { message: { content: [{ text: SAMPLE_RESPONSE_TEXT }] } },
      usage: {
        inputTokens: INPUT_TOKENS,
        outputTokens: OUTPUT_TOKENS,
        totalTokens: TOTAL_TOKENS
      },
      trace: { guardrail: { action: 'NONE', assessments: [] } },
      stopReason: 'end_turn'
    }
  }

  beforeEach(() => {
    vi.spyOn(bedrockClient, '_sleep').mockResolvedValue(undefined)
  })

  it('retries and succeeds after a ThrottlingException on first attempt', async () => {
    const throttleError = new Error('throttled')
    throttleError.name = 'ThrottlingException'
    MOCK_SEND.mockRejectedValueOnce(throttleError)
    MOCK_SEND.mockResolvedValueOnce(buildBedrockResponse())

    const result = await bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)

    expect(result.success).toBe(true)
    expect(result.content).toBe(SAMPLE_RESPONSE_TEXT)
    expect(bedrockClient._sleep).toHaveBeenCalledOnce()
  })

  it('retries and succeeds after a ServiceUnavailableException', async () => {
    const serviceError = new Error('unavailable')
    serviceError.name = 'ServiceUnavailableException'
    MOCK_SEND.mockRejectedValueOnce(serviceError)
    MOCK_SEND.mockResolvedValueOnce(buildBedrockResponse())

    const result = await bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)

    expect(result.success).toBe(true)
    expect(bedrockClient._sleep).toHaveBeenCalledOnce()
  })

  it('throws after exhausting all retries on repeated ThrottlingException', async () => {
    const throttleError = new Error('throttled')
    throttleError.name = 'ThrottlingException'
    MOCK_SEND.mockRejectedValue(throttleError)

    await expect(
      bedrockClient.sendMessage(SAMPLE_USER_MESSAGE)
    ).rejects.toThrow('token quota exceeded')
  })

  it('includes system prompt in command input when provided', async () => {
    MOCK_SEND.mockResolvedValueOnce(buildBedrockResponse())

    await bedrockClient.sendMessage(
      SAMPLE_USER_MESSAGE,
      [],
      'You are a helpful assistant.'
    )

    const sentCommand = MOCK_SEND.mock.calls[0][0]
    expect(sentCommand.system).toEqual([
      { text: 'You are a helpful assistant.' }
    ])
  })

  it('omits system field from command when systemPrompt is null', async () => {
    MOCK_SEND.mockResolvedValueOnce(buildBedrockResponse())

    await bedrockClient.sendMessage(SAMPLE_USER_MESSAGE, [], null)

    const sentCommand = MOCK_SEND.mock.calls[0][0]
    expect(sentCommand.system).toBeUndefined()
  })
})
