import { health } from '../routes/health.js'
import { example } from '../routes/example.js'
import { uploadRoutes } from '../routes/upload.js'
import { sqsWorkerStatus } from '../routes/sqs-worker-status.js'

const router = {
  plugin: {
    name: 'router',
    register: async (server, _options) => {
      server.route([health, sqsWorkerStatus].concat(example))
      await server.register([uploadRoutes])
    }
  }
}

export { router }
