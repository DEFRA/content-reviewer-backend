import { afterAll, beforeAll } from 'vitest'
import { setup, teardown } from 'vitest-mongodb'

beforeAll(async () => {
  // Setup mongo mock
  await setup({
    binary: {
      version: 'latest'
    },
    serverOptions: {},
    autoStart: false
  })
  process.env.MONGO_URI = globalThis.__MONGO_URI__
  process.env.MONGO_ENABLED = 'true' // Enable MongoDB for tests
}, 60000)

afterAll(async () => {
  await teardown()
})
