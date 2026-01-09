import { MongoClient } from 'mongodb'
import { config } from '../../config.js'
import { createLogger } from './logging/logger.js'

const logger = createLogger()

class MongoDB {
  constructor() {
    this.client = null
    this.db = null
  }

  async connect() {
    if (this.client && this.db) {
      return this.db
    }

    try {
      const mongoUrl = config.get('mongo.mongoUrl')
      const databaseName = config.get('mongo.databaseName')
      const mongoOptions = {
        retryWrites: config.get('mongo.mongoOptions.retryWrites'),
        readPreference: config.get('mongo.mongoOptions.readPreference')
      }

      logger.info({ mongoUrl, databaseName }, 'Connecting to MongoDB')

      this.client = await MongoClient.connect(mongoUrl, mongoOptions)
      this.db = this.client.db(databaseName)

      logger.info('MongoDB connected successfully')

      return this.db
    } catch (error) {
      logger.error({ error }, 'Failed to connect to MongoDB')
      throw error
    }
  }

  async getDb() {
    if (!this.db) {
      await this.connect()
    }
    return this.db
  }

  async close() {
    if (this.client) {
      await this.client.close()
      this.client = null
      this.db = null
      logger.info('MongoDB connection closed')
    }
  }
}

export const mongodb = new MongoDB()

// Export for Hapi plugin compatibility
export const mongoDb = {
  plugin: {
    name: 'mongodb',
    version: '1.0.0',
    register: async function (server, options) {
      server.logger.info('Setting up MongoDb')

      const client = await MongoClient.connect(options.mongoUrl, {
        ...options.mongoOptions
      })

      const databaseName = options.databaseName
      const db = client.db(databaseName)

      await createIndexes(db)

      server.logger.info(`MongoDb connected to ${databaseName}`)

      server.decorate('server', 'mongoClient', client)
      server.decorate('server', 'db', db)
      server.decorate('request', 'db', () => db, { apply: true })

      server.events.on('stop', async () => {
        server.logger.info('Closing Mongo client')
        try {
          await client.close(true)
        } catch (e) {
          server.logger.error(e, 'failed to close mongo client')
        }
      })
    }
  }
}

async function createIndexes(db) {
  // Create indexes for review status collection
  await db.collection('review_statuses').createIndex({ uploadId: 1 }, { unique: true })
  await db.collection('review_statuses').createIndex({ userId: 1 })
  await db.collection('review_statuses').createIndex({ status: 1 })
  await db.collection('review_statuses').createIndex({ createdAt: -1 })
}
