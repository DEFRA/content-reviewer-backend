import { describe, test, expect, vi, beforeEach } from 'vitest'
import { MongoClient } from 'mongodb'
import { LockManager } from 'mongo-locks'
import { mongoDb } from './mongodb.js'

const mockCreateIndex = vi.fn().mockResolvedValue(undefined)
const mockCollection = vi.fn().mockReturnValue({ createIndex: mockCreateIndex })
const mockDb = { collection: mockCollection }
const mockClient = {
  db: vi.fn().mockReturnValue(mockDb),
  close: vi.fn().mockResolvedValue(undefined)
}

vi.mock('mongodb', () => ({
  MongoClient: { connect: vi.fn() }
}))

vi.mock('mongo-locks', () => ({
  // Must use a regular function (not arrow) because the source calls new LockManager(...)
  LockManager: vi.fn().mockImplementation(function () {
    return {}
  })
}))

const mockServer = {
  logger: { info: vi.fn(), error: vi.fn() },
  decorate: vi.fn(),
  events: { on: vi.fn() }
}

const mockOptions = {
  mongoUrl: 'mongodb://localhost:27017/',
  databaseName: 'test-db',
  mongoOptions: { retryWrites: true }
}

function resetMocks() {
  vi.clearAllMocks()
  vi.mocked(MongoClient.connect).mockResolvedValue(mockClient)
  mockClient.close.mockResolvedValue(undefined)
}

async function runRegister() {
  await mongoDb.plugin.register(mockServer, mockOptions)
}

// ─── plugin shape ────────────────────────────────────────────────────────────

describe('#mongoDb plugin – shape', () => {
  test('Should export mongoDb with a plugin object', () => {
    expect(mongoDb).toBeDefined()
    expect(mongoDb.plugin).toBeDefined()
  })

  test('Should have name "mongodb"', () => {
    expect(mongoDb.plugin.name).toBe('mongodb')
  })

  test('Should have version "1.0.0"', () => {
    expect(mongoDb.plugin.version).toBe('1.0.0')
  })

  test('Should expose a register function', () => {
    expect(typeof mongoDb.plugin.register).toBe('function')
  })
})

// ─── register: connection ────────────────────────────────────────────────────

describe('#mongoDb plugin – register: connection', () => {
  beforeEach(resetMocks)

  test('Should connect to MongoDB using provided URL and options', async () => {
    await runRegister()

    expect(MongoClient.connect).toHaveBeenCalledWith(
      'mongodb://localhost:27017/',
      { retryWrites: true }
    )
  })

  test('Should obtain the named database from the client', async () => {
    await runRegister()

    expect(mockClient.db).toHaveBeenCalledWith('test-db')
  })

  test('Should construct LockManager with the mongo-locks collection', async () => {
    await runRegister()

    expect(LockManager).toHaveBeenCalledWith(
      expect.objectContaining({ createIndex: expect.any(Function) })
    )
  })

  test('Should log setup and connected messages', async () => {
    await runRegister()

    expect(mockServer.logger.info).toHaveBeenCalledWith('Setting up MongoDb')
    expect(mockServer.logger.info).toHaveBeenCalledWith(
      'MongoDb connected to test-db'
    )
  })
})

// ─── register: indexes ───────────────────────────────────────────────────────

describe('#mongoDb plugin – register: indexes', () => {
  beforeEach(resetMocks)

  test('Should create index on mongo-locks collection', async () => {
    await runRegister()

    expect(mockCollection).toHaveBeenCalledWith('mongo-locks')
    expect(mockCreateIndex).toHaveBeenCalledWith({ id: 1 })
  })

  test('Should create unique tokenHash index on refresh_tokens collection', async () => {
    await runRegister()

    expect(mockCollection).toHaveBeenCalledWith('refresh_tokens')
    expect(mockCreateIndex).toHaveBeenCalledWith(
      { tokenHash: 1 },
      { unique: true }
    )
  })

  test('Should create userId index on refresh_tokens collection', async () => {
    await runRegister()

    expect(mockCreateIndex).toHaveBeenCalledWith({ userId: 1 })
  })

  test('Should create TTL index on refresh_tokens.expiresAt', async () => {
    await runRegister()

    expect(mockCreateIndex).toHaveBeenCalledWith(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 }
    )
  })
})

// ─── register: server decorations ───────────────────────────────────────────

describe('#mongoDb plugin – register: server decorations', () => {
  beforeEach(resetMocks)

  test('Should decorate server with mongoClient', async () => {
    await runRegister()

    expect(mockServer.decorate).toHaveBeenCalledWith(
      'server',
      'mongoClient',
      mockClient
    )
  })

  test('Should decorate server with db', async () => {
    await runRegister()

    expect(mockServer.decorate).toHaveBeenCalledWith('server', 'db', mockDb)
  })

  test('Should decorate server with locker', async () => {
    await runRegister()

    expect(mockServer.decorate).toHaveBeenCalledWith(
      'server',
      'locker',
      expect.any(Object)
    )
  })

  test('Should decorate request with a db accessor function', async () => {
    await runRegister()

    expect(mockServer.decorate).toHaveBeenCalledWith(
      'request',
      'db',
      expect.any(Function),
      { apply: true }
    )
  })

  test('Request db accessor should return the database', async () => {
    await runRegister()

    const [, , dbFn] = vi
      .mocked(mockServer.decorate)
      .mock.calls.find(([scope, name]) => scope === 'request' && name === 'db')

    expect(dbFn()).toBe(mockDb)
  })

  test('Should decorate request with a locker accessor function', async () => {
    await runRegister()

    expect(mockServer.decorate).toHaveBeenCalledWith(
      'request',
      'locker',
      expect.any(Function),
      { apply: true }
    )
  })

  test('Request locker accessor should return the locker', async () => {
    await runRegister()

    const [, , lockerFn] = vi
      .mocked(mockServer.decorate)
      .mock.calls.find(
        ([scope, name]) => scope === 'request' && name === 'locker'
      )

    expect(lockerFn()).toBeDefined()
  })

  test('Should register a stop event handler', async () => {
    await runRegister()

    expect(mockServer.events.on).toHaveBeenCalledWith(
      'stop',
      expect.any(Function)
    )
  })
})

// ─── stop event handler ──────────────────────────────────────────────────────

describe('#mongoDb plugin – stop event handler', () => {
  beforeEach(resetMocks)

  async function getStopHandler() {
    await runRegister()

    return vi
      .mocked(mockServer.events.on)
      .mock.calls.find(([event]) => event === 'stop')?.[1]
  }

  test('Should close the client when stop fires', async () => {
    const stopHandler = await getStopHandler()

    await stopHandler()

    expect(mockServer.logger.info).toHaveBeenCalledWith('Closing Mongo client')
    expect(mockClient.close).toHaveBeenCalledWith(true)
  })

  test('Should log error when client.close throws', async () => {
    const closeError = new Error('close failed')
    mockClient.close.mockRejectedValue(closeError)

    const stopHandler = await getStopHandler()

    await stopHandler()

    expect(mockServer.logger.error).toHaveBeenCalledWith(
      closeError,
      'failed to close mongo client'
    )
  })
})
