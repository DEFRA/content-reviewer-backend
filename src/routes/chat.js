/**
 * LEGACY FILE - COMMENTED OUT FOR TESTING
 * This file contains old synchronous review endpoints that have been replaced by async architecture in review.js
 * - chatController (/api/chat) - was already unused
 * - reviewController (/api/review) - replaced by /api/review/text in review.js (async via SQS)
 * The frontend now uses the async endpoints which don't have timeout issues
 * Safe to delete after confirming application works without it
 * Commented out on: 2026-01-27
 */
