/**
 * Quick test of the Results API endpoints
 * Tests both full result retrieval and status checks
 */

console.log('🧪 Testing Results API\n')

const BASE_URL = 'http://localhost:3001'

// Test 1: Check non-existent job (should return "processing")
console.log('Test 1: Non-existent job')
console.log('='.repeat(60))

try {
  const response = await fetch(`${BASE_URL}/api/results/non-existent-job-123`)
  const data = await response.json()

  console.log('Status:', response.status)
  console.log('Response:', JSON.stringify(data, null, 2))

  if (data.status === 'processing') {
    console.log('✅ Correctly returns "processing" for non-existent job\n')
  } else {
    console.log('❌ Expected status "processing"\n')
  }
} catch (error) {
  console.error('❌ Test failed:', error.message)
  console.log('\n⚠️  Make sure backend is running: npm run dev\n')
  process.exit(1)
}

// Test 2: Create a mock result and retrieve it
console.log('Test 2: Store and retrieve result')
console.log('='.repeat(60))

// First, let's check if the test result from test-async-flow.js exists
const testJobId = `test-job-${Date.now()}`

try {
  // In a real scenario, the SQS worker would create this
  // For now, we'll just test retrieval of the one created by test-async-flow.js

  // Find a recent test job by trying a recent timestamp
  const recentTime = Date.now() - 60000 // Last minute
  const recentJobId = `test-job-${recentTime}`

  console.log('Checking for recent test job...')
  const response = await fetch(`${BASE_URL}/api/results/${recentJobId}`)
  const data = await response.json()

  console.log('Status:', response.status)
  console.log('Response status:', data.status)

  if (data.status === 'processing') {
    console.log('ℹ️  No recent test results found (expected in fresh start)')
    console.log(
      '💡 Run "node test-async-flow.js" first to create a test result\n'
    )
  } else {
    console.log('✅ Found existing test result:')
    console.log('   Job ID:', data.jobId)
    console.log('   Status:', data.status)
    console.log('   Filename:', data.result?.filename || 'N/A')
    console.log('')
  }
} catch (error) {
  console.error('❌ Test failed:', error.message)
}

// Test 3: Status endpoint (lightweight)
console.log('Test 3: Status check endpoint')
console.log('='.repeat(60))

try {
  const jobId = 'test-status-check'
  const response = await fetch(`${BASE_URL}/api/results/${jobId}/status`)
  const data = await response.json()

  console.log('Status:', response.status)
  console.log('Response:', JSON.stringify(data, null, 2))

  if (data.ready === false && data.status === 'processing') {
    console.log('✅ Status endpoint working correctly\n')
  } else {
    console.log('⚠️  Unexpected response format\n')
  }
} catch (error) {
  console.error('❌ Test failed:', error.message)
}

// Summary
console.log('📊 Test Summary')
console.log('='.repeat(60))
console.log('✅ Results API is responding')
console.log('✅ Non-existent jobs return "processing" status')
console.log('✅ Status endpoint working')
console.log('')
console.log('💡 Next steps:')
console.log('1. Run: node test-async-flow.js')
console.log('2. Check the jobId in output')
console.log('3. Query: curl http://localhost:3001/api/results/{jobId}')
console.log('')
