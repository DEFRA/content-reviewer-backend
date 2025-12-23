import { health } from '../routes/health.js'
import { example } from '../routes/example.js'
import { chat } from '../routes/chat.js'

const router = {
  plugin: {
    name: 'router',
    register: (server, _options) => {
      server.route([health].concat(example).concat(chat))
    }
  }
}

export { router }
