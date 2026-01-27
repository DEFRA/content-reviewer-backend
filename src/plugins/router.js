import { health } from '../routes/health.js'
import { example } from '../routes/example.js'
import { uploadRoutes } from '../routes/upload.js'
import { reviewRoutes } from '../routes/review.js'
import { results } from '../routes/results.js'
import { sqsWorkerStatus } from '../routes/sqs-worker-status.js'
import { chatController, reviewController } from '../routes/chat.js'

const router = {
  plugin: {
    name: 'router',
    register: async (server, _options) => {
      // Chat endpoint (COMMENTED OUT - NOT USED)
      // This was a legacy endpoint that is no longer used by the frontend
      // The frontend uses /api/review/text instead
      // server.route([
      //   {
      //     method: 'POST',
      //     path: '/api/chat',
      //     ...chatController
      //   }
      // ])

      // Review endpoint (ACTIVE - used by frontend)
      server.route([
        {
          method: 'POST',
          path: '/api/review',
          ...reviewController
        }
      ])

      // Other routes
      // Example routes COMMENTED OUT - require MongoDB which is disabled
      // server.route([health, sqsWorkerStatus].concat(example))
      server.route([health, sqsWorkerStatus])
      await server.register([uploadRoutes, reviewRoutes, results])
    }
  }
}

export { router }
