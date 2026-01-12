import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * Mock AI Service for Development/Testing
 * Returns simulated content review results without calling AWS Bedrock
 */
class MockAIService {
  constructor() {
    logger.info('Mock AI Service initialized (for development/testing)')
  }

  /**
   * Mock content review - returns simulated AI review results
   * @param {string} content - Content to review
   * @param {string} filename - Filename for context
   * @returns {Promise<Object>} Mock review result
   */
  async reviewContent(content, filename = 'document.txt') {
    logger.info(
      { filename, contentLength: content.length },
      'Starting mock AI content review'
    )

    // Simulate AI processing time
    await this.delay(1000)

    // Analyze content characteristics
    const wordCount = content.split(/\s+/).length
    const sentenceCount = content.split(/[.!?]+/).length
    const paragraphCount = content.split(/\n\n+/).length
    const hasHeadings = /^#{1,6}\s/.test(content) || /^[A-Z][^.!?]*$/m.test(content)
    const hasBulletPoints = /^[-*•]\s/m.test(content)
    const hasNumberedList = /^\d+\.\s/m.test(content)

    // Generate mock issues based on content analysis
    const issues = this.generateMockIssues(content, wordCount)
    const suggestions = this.generateMockSuggestions(content, wordCount)

    // Calculate scores
    const clarityScore = this.calculateClarityScore(content, wordCount, sentenceCount)
    const complianceScore = this.calculateComplianceScore(content, issues)
    const overallScore = Math.round((clarityScore + complianceScore) / 2)

    // Format result to match Bedrock AI service structure
    const overallStatus = this.determineOverallStatusFromScore(overallScore)
    const strengths = this.generateStrengths(content, hasHeadings, hasBulletPoints)
    const summary = this.generateSummary(overallScore, issues.length)

    const result = {
      filename,
      status: 'completed',
      reviewText: this.formatFullReviewText(summary, issues, suggestions, strengths, {
        wordCount,
        sentenceCount,
        readingLevel: this.determineReadingLevel(wordCount, sentenceCount)
      }),
      sections: {
        overallAssessment: summary,
        contentQuality: `Overall Score: ${overallScore}/100. Clarity: ${clarityScore}/100, Compliance: ${complianceScore}/100`,
        plainEnglishReview: `Reading level: ${this.determineReadingLevel(wordCount, sentenceCount)}. Average ${Math.round(wordCount / sentenceCount)} words per sentence.`,
        styleGuideCompliance: complianceScore >= 80 ? 'Compliant with GOV.UK style guide' : 'Some improvements needed for GOV.UK compliance',
        govspeakReview: hasHeadings || hasBulletPoints ? 'Good use of formatting elements' : 'Consider adding headings and bullet points',
        accessibilityReview: 'Ensure all images have alt text and links are descriptive',
        passiveVoiceReview: issues.some(i => i.category === 'style') ? 'Passive voice detected - prefer active voice' : 'Good use of active voice',
        summaryOfFindings: `${issues.length} issue(s) found, ${suggestions.length} suggestion(s) provided`,
        exampleImprovements: suggestions.slice(0, 3).map(s => `${s.title}: ${s.description}`).join('\n\n')
      },
      metrics: {
        wordCount,
        totalIssues: issues.length,
        wordsToAvoidCount: issues.filter(i => i.category === 'clarity').length,
        passiveSentencesCount: issues.filter(i => i.category === 'style').length,
        overallScore
      },
      overallStatus,
      aiMetadata: {
        model: 'mock-ai-v1.0',
        inferenceProfile: 'development-mock',
        inputTokens: Math.round(content.length / 4),
        outputTokens: 500,
        stopReason: 'end_turn'
      },
      processedAt: new Date().toISOString()
    }

    logger.info(
      { filename, overallScore, issuesCount: issues.length },
      'Mock AI review completed'
    )

    return result
  }

  /**
   * Generate mock issues based on content analysis
   */
  generateMockIssues(content, wordCount) {
    const issues = []

    // Check for long sentences
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0)
    const longSentences = sentences.filter(s => s.split(/\s+/).length > 25)
    if (longSentences.length > 0) {
      issues.push({
        severity: 'medium',
        category: 'clarity',
        title: 'Long sentences detected',
        description: `Found ${longSentences.length} sentence(s) with more than 25 words. Consider breaking them into shorter sentences.`,
        location: 'Multiple locations',
        suggestion: 'Break long sentences into shorter ones for better readability.'
      })
    }

    // Check for passive voice (simple detection)
    const passiveVoiceMatches = content.match(/\b(is|are|was|were|been|being)\s+\w+ed\b/gi)
    if (passiveVoiceMatches && passiveVoiceMatches.length > 3) {
      issues.push({
        severity: 'low',
        category: 'style',
        title: 'Passive voice usage',
        description: 'Document contains passive voice constructions. GOV.UK style prefers active voice.',
        location: 'Multiple locations',
        suggestion: 'Convert passive voice to active voice where possible. Example: "The form was completed" → "Complete the form"'
      })
    }

    // Check for jargon
    const jargonWords = ['utilize', 'leverage', 'facilitate', 'implement', 'synergy']
    const foundJargon = jargonWords.filter(word => 
      content.toLowerCase().includes(word)
    )
    if (foundJargon.length > 0) {
      issues.push({
        severity: 'medium',
        category: 'clarity',
        title: 'Potential jargon detected',
        description: `Found terms that may be jargon: ${foundJargon.join(', ')}`,
        location: 'Multiple locations',
        suggestion: 'Replace jargon with simpler, more common words that users will understand.'
      })
    }

    // Check document length
    if (wordCount < 50) {
      issues.push({
        severity: 'low',
        category: 'content',
        title: 'Very short content',
        description: 'Content appears very brief. Ensure all necessary information is included.',
        location: 'Overall document',
        suggestion: 'Consider if additional detail or context would help users.'
      })
    }

    return issues
  }

  /**
   * Generate mock suggestions
   */
  generateMockSuggestions(content, wordCount) {
    const suggestions = []

    // Always provide some general suggestions
    suggestions.push({
      type: 'improvement',
      priority: 'medium',
      title: 'Add clear headings',
      description: 'Use descriptive headings to help users scan the content.',
      example: 'Break content into sections with H2 headings like "What you need to do" or "Who can apply"'
    })

    suggestions.push({
      type: 'improvement',
      priority: 'medium',
      title: 'Use bullet points',
      description: 'Present lists of items as bullet points for better readability.',
      example: 'Convert comma-separated lists into bullet points'
    })

    if (wordCount > 300) {
      suggestions.push({
        type: 'improvement',
        priority: 'high',
        title: 'Add summary or introduction',
        description: 'For longer content, add a brief summary at the start.',
        example: 'Start with 1-2 sentences explaining what the page is about'
      })
    }

    suggestions.push({
      type: 'compliance',
      priority: 'low',
      title: 'Check accessibility',
      description: 'Ensure all images have alt text and links are descriptive.',
      example: 'Avoid "click here" - use descriptive link text instead'
    })

    return suggestions
  }

  /**
   * Generate strengths
   */
  generateStrengths(content, hasHeadings, hasBulletPoints) {
    const strengths = []

    if (hasHeadings) {
      strengths.push('Content uses headings to structure information')
    }

    if (hasBulletPoints) {
      strengths.push('Uses bullet points to present lists clearly')
    }

    if (content.length > 100) {
      strengths.push('Content provides detailed information')
    }

    // Check for action words
    const actionWords = ['can', 'will', 'must', 'should', 'need to', 'apply', 'contact']
    const hasActionWords = actionWords.some(word => 
      content.toLowerCase().includes(word)
    )
    if (hasActionWords) {
      strengths.push('Uses clear action words to guide users')
    }

    if (strengths.length === 0) {
      strengths.push('Content submitted for review')
    }

    return strengths
  }

  /**
   * Calculate various scores
   */
  calculateClarityScore(content, wordCount, sentenceCount) {
    const avgWordsPerSentence = wordCount / sentenceCount
    let score = 80

    // Penalize very long or very short average sentence length
    if (avgWordsPerSentence > 25) score -= 15
    else if (avgWordsPerSentence > 20) score -= 10
    else if (avgWordsPerSentence < 8) score -= 5

    return Math.max(60, Math.min(100, score))
  }

  calculateComplianceScore(content, issues) {
    const highSeverityIssues = issues.filter(i => i.severity === 'high').length
    const mediumSeverityIssues = issues.filter(i => i.severity === 'medium').length

    let score = 90
    score -= highSeverityIssues * 20
    score -= mediumSeverityIssues * 10

    return Math.max(50, Math.min(100, score))
  }

  calculateReadabilityScore(wordCount, sentenceCount) {
    const avgWordsPerSentence = wordCount / sentenceCount
    
    // Ideal: 15-20 words per sentence
    if (avgWordsPerSentence >= 15 && avgWordsPerSentence <= 20) return 95
    if (avgWordsPerSentence >= 12 && avgWordsPerSentence <= 23) return 85
    if (avgWordsPerSentence >= 10 && avgWordsPerSentence <= 25) return 75
    
    return 65
  }

  calculateStructureScore(hasHeadings, hasBulletPoints, paragraphCount) {
    let score = 70

    if (hasHeadings) score += 15
    if (hasBulletPoints) score += 10
    if (paragraphCount > 2) score += 5

    return Math.min(100, score)
  }

  determineReadingLevel(wordCount, sentenceCount) {
    const avgWordsPerSentence = wordCount / sentenceCount

    if (avgWordsPerSentence < 12) return 'Easy (Primary school)'
    if (avgWordsPerSentence < 17) return 'Medium (Secondary school)'
    if (avgWordsPerSentence < 22) return 'Moderate (College level)'
    return 'Complex (University level)'
  }

  generateSummary(overallScore, issuesCount) {
    if (overallScore >= 90 && issuesCount === 0) {
      return 'Excellent! This content meets GOV.UK standards with no significant issues. The writing is clear, concise, and user-friendly.'
    }
    
    if (overallScore >= 80) {
      return `Good content overall. ${issuesCount > 0 ? `${issuesCount} area(s) identified for improvement.` : 'Minor refinements suggested.'} The content is mostly clear and follows GOV.UK guidelines.`
    }
    
    if (overallScore >= 70) {
      return `Acceptable content with room for improvement. Address the ${issuesCount} identified issue(s) to better align with GOV.UK standards.`
    }
    
    return `Content needs revision. ${issuesCount} issue(s) identified. Review the suggestions to improve clarity and compliance with GOV.UK standards.`
  }

  /**
   * Determine overall status from score (matching Bedrock format)
   */
  determineOverallStatusFromScore(score) {
    if (score >= 90) return 'pass'
    if (score >= 75) return 'pass_with_recommendations'
    if (score >= 60) return 'needs_improvement'
    return 'fail'
  }

  /**
   * Format full review text (matching Bedrock output)
   */
  formatFullReviewText(summary, issues, suggestions, strengths, analysis) {
    let text = `# Mock AI Content Review\n\n`
    text += `## Overall Assessment\n${summary}\n\n`
    
    if (strengths.length > 0) {
      text += `## Strengths\n`
      strengths.forEach(s => text += `- ${s}\n`)
      text += `\n`
    }
    
    if (issues.length > 0) {
      text += `## Issues Found (${issues.length})\n`
      issues.forEach((issue, i) => {
        text += `\n### ${i + 1}. ${issue.title} (${issue.severity})\n`
        text += `**Category:** ${issue.category}\n`
        text += `**Description:** ${issue.description}\n`
        text += `**Suggestion:** ${issue.suggestion}\n`
      })
      text += `\n`
    }
    
    if (suggestions.length > 0) {
      text += `## Suggestions for Improvement\n`
      suggestions.forEach((sug, i) => {
        text += `\n### ${i + 1}. ${sug.title}\n`
        text += `**Priority:** ${sug.priority}\n`
        text += `**Description:** ${sug.description}\n`
        if (sug.example) {
          text += `**Example:** ${sug.example}\n`
        }
      })
      text += `\n`
    }
    
    text += `## Document Statistics\n`
    text += `- Word Count: ${analysis.wordCount}\n`
    text += `- Sentence Count: ${analysis.sentenceCount}\n`
    text += `- Reading Level: ${analysis.readingLevel}\n`
    
    return text
  }

  /**
   * Simulate processing delay
   */
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

export const mockAIService = new MockAIService()
export { MockAIService }
