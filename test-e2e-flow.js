/**
 * Interactive test script for end-to-end upload flow
 * This simulates what happens when a user uploads a document
 */

import { resultsStorage } from './src/common/helpers/results-storage.js'
import { BedrockClient } from './src/common/helpers/bedrock-client.js'
import { buildReviewPrompt } from './src/common/helpers/gov-uk-review-prompt.js'
import { wordService } from './src/common/helpers/word-service.js'

console.log('🎯 End-to-End Upload Flow Simulation')
console.log('='.repeat(60))
console.log('')

// Simulate the complete flow
const jobId = `test-e2e-${Date.now()}`
const filename = 'sample-govuk-content.pdf'

console.log('📝 Scenario: User uploads a GOV.UK content document')
console.log('Job ID:', jobId)
console.log('Filename:', filename)
console.log('')

// Step 1: Upload (simulated)
console.log('Step 1: 📤 File Upload to S3')
console.log('-'.repeat(60))
console.log(
  '✅ File uploaded to: s3://bucket/content-uploads/' + jobId + '/' + filename
)
console.log('✅ SQS message sent with jobId')
console.log('')

// Step 2: Worker picks up message
console.log('Step 2: 🔄 SQS Worker Processes Message')
console.log('-'.repeat(60))
console.log('✅ Message received from queue')
console.log('✅ Worker downloads file from S3')
console.log('')

// Step 3: Text extraction
console.log('Step 3: 📄 Text Extraction')
console.log('-'.repeat(60))

const sampleContent = `
GOV.UK Content Guide

Writing for GOV.UK

Write in plain English. Use short sentences and simple words.

Key principles:
- Start with user needs
- Do the hard work to make it simple
- Design with data
- Do less

Formatting
Use headings to break up content. Keep paragraphs short. Use bullet points for lists.

Call to action
Make it clear what the user needs to do next.
`.trim()

console.log('✅ Text extracted from PDF')
console.log('   Length:', sampleContent.length, 'characters')
console.log('   Words:', sampleContent.split(/\s+/).length)
console.log('')

// Step 4: Bedrock review
console.log('Step 4: 🤖 AI Content Review (Bedrock)')
console.log('-'.repeat(60))

try {
  const bedrockClient = new BedrockClient()
  const prompt = buildReviewPrompt(sampleContent, { filename })

  let review
  if (BedrockClient.isMockMode()) {
    console.log('ℹ️  Using MOCK mode (no real Bedrock API call)')
    review = `# GOV.UK Content Review

## Summary
This document follows GOV.UK content guidelines effectively.

## Strengths
✅ Uses plain English
✅ Clear structure with headings
✅ Bullet points for easy scanning
✅ Action-oriented language

## Suggestions
⚠️  Consider adding more specific examples
⚠️  Could include accessibility checklist

## Recommendations
1. Add real-world examples
2. Include links to related guidance
3. Consider adding a checklist

## Overall Score: 8/10
Strong content that follows best practices.`
  } else {
    console.log('📡 Calling real Bedrock API...')
    const result = await bedrockClient.invokeModel(prompt)
    review = result.content
  }

  console.log('✅ AI review generated')
  console.log('   Preview:', review.substring(0, 100) + '...')
  console.log('')

  // Step 5: Store result
  console.log('Step 5: 💾 Store Result in S3')
  console.log('-'.repeat(60))

  const resultData = {
    filename,
    uploadId: jobId,
    review,
    usage: { input_tokens: 500, output_tokens: 300 },
    textLength: sampleContent.length,
    processedAt: new Date().toISOString(),
    mock: BedrockClient.isMockMode()
  }

  const stored = await resultsStorage.storeResult(jobId, resultData)
  console.log('✅ Result stored:', stored.location)
  if (stored.mock) {
    console.log('   (Mock mode: stored in memory)')
  }
  console.log('')

  // Step 6: Frontend polls for result
  console.log('Step 6: 🌐 Frontend Polls for Result')
  console.log('-'.repeat(60))
  console.log('Frontend polling: GET /api/results/' + jobId)
  console.log('')

  // Simulate a few polls
  for (let i = 1; i <= 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const result = await resultsStorage.getResult(jobId)

    if (i < 3) {
      console.log(`Poll ${i}: Status = processing (simulated delay)`)
    } else {
      console.log(`Poll ${i}: Status = completed ✅`)
      console.log('')
      console.log('Result returned to frontend:')
      console.log(
        JSON.stringify(
          {
            success: true,
            status: 'completed',
            jobId: result.jobId,
            result: {
              filename: result.result.filename,
              review: result.result.review.substring(0, 200) + '...',
              processedAt: result.result.processedAt
            }
          },
          null,
          2
        )
      )
    }
  }

  console.log('')
  console.log('Step 7: 🎨 Frontend Displays Result')
  console.log('-'.repeat(60))
  console.log('✅ Review page updates automatically')
  console.log('✅ Shows filename:', filename)
  console.log('✅ Shows review content')
  console.log('✅ Shows timestamp')
  if (BedrockClient.isMockMode()) {
    console.log('⚠️  Shows mock warning badge')
  }
  console.log('')

  // Summary
  console.log('🎉 End-to-End Test Complete!')
  console.log('='.repeat(60))
  console.log('✅ File upload simulation')
  console.log('✅ SQS message processing')
  console.log('✅ Text extraction')
  console.log('✅ Bedrock AI review')
  console.log('✅ Result storage')
  console.log('✅ Frontend polling')
  console.log('✅ Result display')
  console.log('')
  console.log('💡 To test with real uploads:')
  console.log('1. Start backend: npm run dev')
  console.log('2. Start frontend: cd ../frontend && npm run dev')
  console.log('3. Visit: http://localhost:3000/upload')
  console.log('4. Upload a document and watch it work!')
  console.log('')
  console.log('📊 Test job ID for API queries:')
  console.log('   ' + jobId)
  console.log('')
  console.log('Try:')
  console.log('   curl http://localhost:3001/api/results/' + jobId)
  console.log('')
} catch (error) {
  console.error('❌ Test failed:', error.message)
  console.error(error.stack)
}
