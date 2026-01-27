/**
 * EXAMPLE CODE - COMMENTED OUT FOR TESTING
 * MongoDB query helpers for example routes
 * Only used by routes/example.js (which is also commented out)
 * MongoDB is currently disabled (mongo.enabled = false in config)
 * Safe to delete after confirming not needed for project
 * Commented out on: 2024
 */

/*
function findAllExampleData(db) {
  const cursor = db
    .collection('example-data')
    .find({}, { projection: { _id: 0 } })

  return cursor.toArray()
}

function findExampleData(db, id) {
  return db
    .collection('example-data')
    .findOne({ exampleId: id }, { projection: { _id: 0 } })
}

export { findAllExampleData, findExampleData }
*/
