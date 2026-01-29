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
    const skipWorker = config.get('mockMode.skipSqsWorker')

    return h
      .response({
        status: 'success',
        data: {
          ...status,
          expectedToRun: !skipWorker,
          environment: {
            mockMode: config.get('mockMode.s3Upload'),
            skipWorker,
            awsEndpoint: config.get('aws.endpoint') || 'default'
          }
        }
      })
      .code(200)
  }
}

export { sqsWorkerStatus }
