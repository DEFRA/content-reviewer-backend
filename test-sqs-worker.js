#!/usr/bin/env node

/**
 * Script to test SQS worker status
 * Usage: node test-sqs-worker.js
 */

import http from 'http'
import { config } from './src/config.js'

const backendUrl = config.get('host')
const backendPort = config.get('port')

function checkWorkerStatus() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: backendUrl,
      port: backendPort,
      path: '/api/sqs-worker/status',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    }

    const req = http.request(options, (res) => {
      let data = ''

      res.on('data', (chunk) => {
        data += chunk
      })

      res.on('end', () => {
        try {
          const response = JSON.parse(data)
          resolve({ statusCode: res.statusCode, data: response })
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error.message}`))
        }
      })
    })

    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`))
    })

    req.end()
  })
}

async function main() {
  console.log('🔍 Testing SQS Worker Status...\n')
  console.log(
    `Connecting to: http://${backendUrl}:${backendPort}/api/sqs-worker/status\n`
  )

  try {
    const result = await checkWorkerStatus()

    console.log('✅ Response Status:', result.statusCode)
    console.log('\n📊 Worker Status:')
    console.log(JSON.stringify(result.data, null, 2))

    const workerData = result.data.data

    console.log('\n📋 Summary:')
    console.log(
      `  • Worker Running: ${workerData.running ? '✅ YES' : '❌ NO'}`
    )
    console.log(
      `  • Expected to Run: ${workerData.expectedToRun ? '✅ YES' : '❌ NO'}`
    )
    console.log(`  • Queue URL: ${workerData.queueUrl}`)
    console.log(`  • Region: ${workerData.region}`)
    console.log(
      `  • Mock Mode: ${workerData.environment.mockMode ? '⚠️  YES' : '✅ NO'}`
    )
    console.log(
      `  • Worker Skipped: ${workerData.environment.skipWorker ? '⚠️  YES' : '✅ NO'}`
    )
    console.log(`  • AWS Endpoint: ${workerData.environment.awsEndpoint}`)

    if (workerData.running && workerData.expectedToRun) {
      console.log('\n✅ SQS Worker is running and healthy!')
    } else if (!workerData.expectedToRun) {
      console.log(
        '\n⚠️  SQS Worker is not expected to run (MOCK mode or SKIP_SQS_WORKER=true)'
      )
    } else {
      console.log('\n❌ SQS Worker is not running (check logs for errors)')
    }
  } catch (error) {
    console.error('❌ Error:', error.message)
    console.error('\nMake sure the backend server is running:')
    console.error('  npm run dev')
    process.exit(1)
  }
}

main()
