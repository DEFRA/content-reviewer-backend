import { sqsWorker } from '../common/helpers/sqs-worker.js'
import { config } from '../config.js'

/**
 * GET /api/sqs-worker/status
 * Check the status of the SQS worker
 */
const sqsWorkerStatus = {
  method: 'GET',
  path: '/api/sqs-worker/status',
  handler: (_request, h) => {
    const status = sqsWorker.getStatus()

    // Check if worker should be running based on environment
    const skipWorker =
      process.env.MOCK_S3_UPLOAD === 'true' ||
      process.env.SKIP_SQS_WORKER === 'true'

    return h
      .response({
        status: 'success',
        data: {
          ...status,
          expectedToRun: !skipWorker,
          environment: {
            mockMode: process.env.MOCK_S3_UPLOAD === 'true',
            skipWorker: process.env.SKIP_SQS_WORKER === 'true',
            awsEndpoint: config.get('aws.endpoint') || 'default'
          }
        }
      })
      .code(200)
  }
}

export { sqsWorkerStatus }
