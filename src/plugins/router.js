import { health } from '../routes/health.js'
import { example } from '../routes/example.js'
import { uploadRoutes } from '../routes/upload.js'
import { reviewRoutes } from '../routes/review.js'
import { sqsWorkerStatus } from '../routes/sqs-worker-status.js'
import { chatController, reviewController } from '../routes/chat.js'

const router = {
  plugin: {
    name: 'router',
    register: async (server, _options) => {
      // Chat and review routes (legacy - kept for backward compatibility)
      server.route([
        {
          method: 'POST',
          path: '/api/chat',
          ...chatController
        },
        {
          method: 'POST',
          path: '/api/review',
          ...reviewController
        }
      ])

      // Other routes
      server.route([health, sqsWorkerStatus].concat(example))
      await server.register([uploadRoutes, reviewRoutes])
    }
  }
}

export { router }
