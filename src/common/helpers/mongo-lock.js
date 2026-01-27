/**
 * UNUSED FILE - COMMENTED OUT FOR TESTING
 * MongoDB lock utilities - only needed when MongoDB is enabled
 * MongoDB is currently disabled (mongo.enabled = false in config)
 * No references found outside of MongoDB-related files
 * Safe to delete after testing period.
 * Commented out on: 2024
 */

/*
async function acquireLock(locker, resource, logger) {
  const lock = await locker.lock(resource)
  if (!lock) {
    if (logger) {
      logger.error(`Failed to acquire lock for ${resource}`)
    }
    return null
  }
  return lock
}

async function requireLock(locker, resource) {
  const lock = await locker.lock(resource)
  if (!lock) {
    throw new Error(`Failed to acquire lock for ${resource}`)
  }
  return lock
}

export { acquireLock, requireLock }
*/
