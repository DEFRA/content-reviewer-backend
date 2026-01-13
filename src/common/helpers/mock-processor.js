/**
 * Mock processor - simulates SQS worker when in MOCK mode
 * Processes files from temp-uploads and generates mock reviews
 */

import { promises as fs } from 'fs'
import path from 'path'
import { createLogger } from './logging/logger.js'
import { pdfService } from './pdf-service.js'
import { wordService } from './word-service.js'
import { bedrockClient } from './bedrock-client.js'
import { resultsStorage } from './results-storage.js'

const logger = createLogger()

class MockProcessor {
  constructor() {
    this.isRunning = false
    this.pollInterval = 2000 // Check every 2 seconds
    this.pollTimer = null
    this.queueDir = path.join(process.cwd(), 'temp-queue')
    this.uploadsDir = path.join(process.cwd(), 'temp-uploads')
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Mock processor already running')
      return
    }

    this.isRunning = true
    logger.info('Starting mock processor for background job processing')

    // Ensure directories exist
    await fs.mkdir(this.queueDir, { recursive: true })
    await fs.mkdir(this.uploadsDir, { recursive: true })

    // Start polling
    this.poll()
  }

  stop() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    this.isRunning = false
    logger.info('Mock processor stopped')
  }

  async poll() {
    if (!this.isRunning) return

    try {
      await this.processQueuedJobs()
    } catch (error) {
      logger.error({ error: error.message }, 'Error processing queued jobs')
    }

    // Schedule next poll
    this.pollTimer = setTimeout(() => this.poll(), this.pollInterval)
  }

  async processQueuedJobs() {
    try {
      // Read queue directory
      const files = await fs.readdir(this.queueDir)
      const jobFiles = files.filter((f) => f.endsWith('.json'))

      if (jobFiles.length === 0) {
        return
      }

      logger.info(`Found ${jobFiles.length} queued job(s) to process`)

      // Process each job
      for (const jobFile of jobFiles) {
        try {
          await this.processJob(jobFile)
        } catch (error) {
          logger.error(
            { jobFile, error: error.message },
            'Failed to process job'
          )
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
  }

  async processJob(jobFile) {
    const jobPath = path.join(this.queueDir, jobFile)

    try {
      // Read job data
      const jobData = JSON.parse(await fs.readFile(jobPath, 'utf-8'))
      const { uploadId, filename } = jobData

      logger.info({ uploadId, filename }, 'Processing job')

      // Read file from temp-uploads/{uploadId}/{filename}
      const filePath = path.join(this.uploadsDir, uploadId, filename)
      const fileBuffer = await fs.readFile(filePath)

      // Extract text based on file type
      let extractedText = ''
      const contentType = jobData.contentType || ''

      if (contentType === 'application/pdf' || filename.endsWith('.pdf')) {
        extractedText = await pdfService.extractText(fileBuffer)
      } else if (
        contentType.includes('word') ||
        filename.endsWith('.doc') ||
        filename.endsWith('.docx')
      ) {
        extractedText = await wordService.extractText(fileBuffer)
      } else {
        throw new Error(`Unsupported file type: ${contentType}`)
      }

      logger.info(
        { uploadId, textLength: extractedText.length },
        'Text extracted from document'
      )

      // Get AI review from Bedrock (or mock)
      const review = await bedrockClient.reviewContent(extractedText)

      logger.info({ uploadId }, 'AI review completed')

      // Store result
      await resultsStorage.storeResult(uploadId, {
        status: 'completed',
        result: {
          filename,
          contentType,
          review,
          extractedTextLength: extractedText.length,
          processedAt: new Date().toISOString(),
          mock: process.env.MOCK_BEDROCK === 'true'
        },
        completedAt: new Date().toISOString()
      })

      logger.info({ uploadId }, 'Result stored successfully')

      // Delete job file
      await fs.unlink(jobPath)
      logger.info({ uploadId }, 'Job completed and removed from queue')
    } catch (error) {
      logger.error(
        { jobFile, error: error.message, stack: error.stack },
        'Job processing failed'
      )

      // Store error result
      try {
        const jobData = JSON.parse(await fs.readFile(jobPath, 'utf-8'))
        await resultsStorage.storeResult(jobData.uploadId, {
          status: 'failed',
          result: {
            error: {
              message: error.message,
              stack: error.stack
            }
          },
          failedAt: new Date().toISOString()
        })

        // Delete job file
        await fs.unlink(jobPath)
      } catch (storeError) {
        logger.error(
          { error: storeError.message },
          'Failed to store error result'
        )
      }
    }
  }
}

// Export singleton instance
export const mockProcessor = new MockProcessor()
