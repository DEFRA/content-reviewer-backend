import { health } from '../routes/health.js'
import { example } from '../routes/example.js'
import { uploadRoutes } from '../routes/upload.js'
import { textReviewRoutes } from '../routes/text-review.js'
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
        textReviewRoutes,
        statusRoutes,
        rulesRoutes,
        reviewHistoryRoutes
      ])
    }
  }
}

export { router }
