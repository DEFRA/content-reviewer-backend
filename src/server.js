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

  const skipWorker = config.get('mockMode.skipSqsWorker')

  if (!skipWorker) {
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
  } else {
    server.logger.info('SQS worker not started (SKIP_SQS_WORKER=true)')
  }

  return server
}

export { createServer }
