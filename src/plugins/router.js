import { health } from '../routes/health.js'
import { uploadRoutes } from '../routes/upload.js'
import { reviewRoutes } from '../routes/review.js'
import { results } from '../routes/results.js'
import { sqsWorkerStatus } from '../routes/sqs-worker-status.js'

const router = {
  plugin: {
    name: 'router',
    register: async (server, _options) => {
      server.route([health, sqsWorkerStatus])
      await server.register([uploadRoutes, reviewRoutes, results])
    }
  }
}

export { router }
