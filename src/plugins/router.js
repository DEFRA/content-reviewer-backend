import { health } from '../routes/health.js'
import { example } from '../routes/example.js'
import { uploadRoutes } from '../routes/upload.js'
import { sqsWorkerStatus } from '../routes/sqs-worker-status.js'
import { statusRoutes } from '../routes/status.js'
import { rulesRoutes } from '../routes/rules.js'
import { reviewHistoryRoutes } from '../routes/review-history.js'

const router = {
  plugin: {
    name: 'router',
    register: async (server, _options) => {
      server.route([health, sqsWorkerStatus].concat(example))
      await server.register([
        uploadRoutes,
        statusRoutes,
        rulesRoutes,
        reviewHistoryRoutes
      ])
    }
  }
}

export { router }
