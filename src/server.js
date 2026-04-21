import Hapi from '@hapi/hapi'

import { secureContext } from '@defra/hapi-secure-context'

import { config } from './config.js'
import { router } from './plugins/router.js'
import { requestLogger } from './common/helpers/logging/request-logger.js'
import { mongoDb } from './common/helpers/mongodb.js'
import { failAction } from './common/helpers/fail-action.js'
import { pulse } from './common/helpers/pulse.js'
import { requestTracing } from './common/helpers/request-tracing.js'
import { setupProxy } from './common/helpers/proxy/setup-proxy.js'
import { sqsWorker } from './common/helpers/sqs-worker.js'
import { cleanupScheduler } from './common/helpers/cleanup-scheduler.js'

// ── Security constants ────────────────────────────────────────────────────────
// Content-Security-Policy for a pure REST API — no scripts, styles or frames
// served by this service, so every directive is locked to 'none'.
const CSP_HEADER_VALUE =
  "default-src 'none'; frame-ancestors 'none'; form-action 'none'"

// Per-IP rate-limiting (in-memory, single-instance guard).
// NOTE: In a multi-instance deployment each pod enforces this independently;
// a shared Redis store would give a global limit, but this still protects
// against single-client bursts hitting one pod.
const rateLimitStore = new Map()

function getRateLimitEntry(ip, windowMs) {
  const now = Date.now()
  const entry = rateLimitStore.get(ip) ?? {
    count: 0,
    resetAt: now + windowMs
  }
  if (now > entry.resetAt) {
    entry.count = 0
    entry.resetAt = now + windowMs
  }
  return entry
}

async function createServer() {
  setupProxy()
  const server = Hapi.server({
    host: config.get('host'),
    port: config.get('port'),
    routes: {
      validate: {
        options: {
          abortEarly: false
        },
        failAction
      },
      cors: {
        origin: config.get('cors.origin'),
        credentials: config.get('cors.credentials')
      },
      security: {
        hsts: {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: false
        },
        xss: 'enabled',
        noSniff: true,
        xframe: true
      },
      timeout: {
        socket: 90000, // 90 seconds - must be less than nginx timeout
        server: 85000 // 85 seconds - allow time for response before socket closes
      }
    },
    router: {
      stripTrailingSlash: true
    }
  })

  // Hapi Plugins:
  // requestLogger  - automatically logs incoming requests
  // requestTracing - trace header logging and propagation
  // secureContext  - loads CA certificates from environment config
  // pulse          - provides shutdown handlers
  // mongoDb        - sets up mongo connection pool and attaches to `server` and `request` objects
  // router         - routes used in the app
  const plugins = [requestLogger, requestTracing, secureContext, pulse, router]

  // Only register MongoDB if enabled in config
  const mongoConfig = config.get('mongo')
  if (mongoConfig.enabled !== false) {
    plugins.splice(4, 0, {
      plugin: mongoDb,
      options: mongoConfig
    })
  }

  await server.register(plugins)

  // ── Rate limiting (Principle 8: Plan for security flaws) ───────────────────
  // Reject requests from IPs that exceed the configured window limit.
  // Health-check path is excluded to avoid false positives from load balancers.
  const rateLimitEnabled = config.get('rateLimit.enabled')
  const rateLimitWindowMs = config.get('rateLimit.windowMs')
  const rateLimitMaxRequests = config.get('rateLimit.maxRequests')

  if (rateLimitEnabled) {
    server.ext('onRequest', (request, h) => {
      if (request.path === '/health') {
        return h.continue
      }
      const ip = request.info.remoteAddress
      const entry = getRateLimitEntry(ip, rateLimitWindowMs)
      entry.count++
      rateLimitStore.set(ip, entry)
      if (entry.count > rateLimitMaxRequests) {
        server.logger.warn(
          { ip, count: entry.count, limit: rateLimitMaxRequests },
          'Rate limit exceeded'
        )
        return h
          .response({ error: 'Too many requests, please try again later.' })
          .code(429)
          .takeover()
      }
      return h.continue
    })
  }

  // ── Additional security response headers (Principle 8) ────────────────────
  // Attach CSP, Referrer-Policy and Permissions-Policy to every response,
  // including error responses that go through Boom.
  server.ext('onPreResponse', (request, h) => {
    const { response } = request
    const headers = {
      'Content-Security-Policy': CSP_HEADER_VALUE,
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=()'
    }

    if (response.isBoom) {
      Object.assign(response.output.headers, headers)
    } else {
      for (const [name, value] of Object.entries(headers)) {
        response.header(name, value)
      }
    }
    return h.continue
  })

  const skipWorker = config.get('mockMode.skipSqsWorker')

  if (skipWorker) {
    server.logger.info('SQS worker not started (SKIP_SQS_WORKER=true)')
  } else {
    server.logger.info('Starting SQS worker for content review queue')
    sqsWorker.start().catch((error) => {
      server.logger.error(
        { error: error.message },
        'Failed to start SQS worker - will continue without it'
      )
    })

    // Stop worker on server stop
    server.events.on('stop', () => {
      server.logger.info('Stopping SQS worker')
      sqsWorker.stop()
    })
  }

  // Start cleanup scheduler for automatic deletion of old reviews
  server.logger.info('Starting cleanup scheduler for old review deletion')
  cleanupScheduler.start()

  // Stop cleanup scheduler on server stop
  server.events.on('stop', () => {
    server.logger.info('Stopping cleanup scheduler')
    cleanupScheduler.stop()
  })

  return server
}

export { createServer }
