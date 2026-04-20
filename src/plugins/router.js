import { health } from '../routes/health.js'
import { reviewRoutes } from '../routes/review.js'
import { uploadRoutes } from '../routes/upload.js'
import { results } from '../routes/results.js'
import { sqsWorkerStatus } from '../routes/sqs-worker-status.js'
import { resultEnvelope } from '../routes/result-envelope.js'
import { adminRoutes } from '../routes/admin.js'

const router = {
  plugin: {
    name: 'router',
    register: async (server, _options) => {
      server.route([health, sqsWorkerStatus])
      await server.register([
        reviewRoutes,
        uploadRoutes,
        results,
        resultEnvelope,
        adminRoutes
      ])
    }
  }
}

export { router }
