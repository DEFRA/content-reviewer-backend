import { afterAll, beforeAll } from 'vitest'
import { setup, teardown } from 'vitest-mongodb'

beforeAll(async () => {
  // Skip MongoDB setup if MongoDB is disabled
  if (process.env.MONGO_ENABLED === 'false') {
    console.log('MongoDB is disabled, skipping MongoDB setup')
    return
  }

  // Setup mongo mock
  try {
    await setup({
      binary: {
        version: 'latest'
      },
      serverOptions: {},
      autoStart: false
    })
    process.env.MONGO_URI = globalThis.__MONGO_URI__
    process.env.MONGO_ENABLED = 'true'
  } catch (error) {
    console.warn('MongoDB Memory Server failed to start:', error.message)
    process.env.MONGO_ENABLED = 'false'
  }
}, 60000)

afterAll(async () => {
  if (process.env.MONGO_ENABLED !== 'false') {
    await teardown()
  }
})
