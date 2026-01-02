import { health } from '../routes/health.js'
import { example } from '../routes/example.js'
import { uploadRoutes } from '../routes/upload.js'

const router = {
  plugin: {
    name: 'router',
    register: async (server, _options) => {
      server.route([health].concat(example))
      await server.register([uploadRoutes])
    }
  }
}

export { router }
