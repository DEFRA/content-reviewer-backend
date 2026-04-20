import { config } from '../../config.js'
import { createServer } from '../../server.js'
import { promptManager } from './prompt-manager.js'

async function startServer() {
  const server = await createServer()
  await server.start()

  server.logger.info('Server started successfully')
  server.logger.info(
    `Access your backend on http://localhost:${config.get('port')}`
  )

  // Always push the embedded DEFAULT_SYSTEM_PROMPT to S3 on startup so that
  // every deployment automatically uses the latest prompt from code.
  // A stale S3 object is overwritten; the in-memory cache is cleared so the
  // first review after startup reads the freshly uploaded version.
  promptManager.uploadPrompt().catch((error) => {
    server.logger.error(
      { error: error.message },
      'Failed to seed system prompt to S3 on startup — reviews will fall back to the embedded default'
    )
  })

  return server
}

export { startServer }
