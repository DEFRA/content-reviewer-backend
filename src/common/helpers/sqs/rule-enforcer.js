import { createLogger } from '../logging/logger.js'

const logger = createLogger()

function isAtSentenceStart(text, matchStart) {
  if (matchStart === 0) {
    return true
  }
  let i = matchStart - 1
  while (i >= 0 && text[i] === ' ') {
    i--
  }
  if (i < 0) {
    return true
  }
  return /[.!?\n\r]/.test(text[i])
}

function isWelshGovernment(text, matchStart) {
  const prefix = 'Welsh '
  if (matchStart < prefix.length) {
    return false
  }
  return text.slice(matchStart - prefix.length, matchStart) === prefix
}

function isAlreadyFlagged(improvements, word) {
  const lowerWord = word.toLowerCase()
  return improvements.some((imp) =>
    imp.current?.toLowerCase().includes(lowerWord)
  )
}

function extractContainingSentence(text, matchStart, matchEnd) {
  let sStart = matchStart
  while (sStart > 0 && !/[.!?\n\r]/.test(text[sStart - 1])) {
    sStart--
  }
  while (sStart < matchStart && /\s/.test(text[sStart])) {
    sStart++
  }

  let sEnd = matchEnd
  while (sEnd < text.length && text[sEnd] !== '\n' && text[sEnd] !== '\r') {
    const ch = text[sEnd]
    sEnd++
    if (/[.!?]/.test(ch)) {
      break
    }
  }

  return { start: sStart, end: sEnd }
}

function removePleaseFromSentence(sentence) {
  if (/^please\b/i.test(sentence)) {
    const rest = sentence.replace(/^please,?\s+/i, '')
    return rest.charAt(0).toUpperCase() + rest.slice(1)
  }
  return sentence
    .replace(/\bplease\b/i, '')
    .replaceAll(/\s{2,}/g, ' ')
    .trim()
}

function getNextRef(improvements) {
  return improvements.reduce((max, imp) => Math.max(max, imp.ref ?? 0), 0) + 1
}

function findFirstGovernmentMatch(text) {
  const regex = /\bGovernment\b/g
  let match
  while ((match = regex.exec(text)) !== null) {
    if (
      !isAtSentenceStart(text, match.index) &&
      !isWelshGovernment(text, match.index)
    ) {
      return match
    }
  }
  return null
}

function injectPleaseImprovement(improvements, issues, canonicalText, ref) {
  if (isAlreadyFlagged(improvements, 'please')) {
    return ref
  }
  const match = /\bplease\b/gi.exec(canonicalText)
  if (!match) {
    return ref
  }
  const sentence = extractContainingSentence(
    canonicalText,
    match.index,
    match.index + match[0].length
  )
  const sentenceText = canonicalText.slice(sentence.start, sentence.end)
  const suggested = removePleaseFromSentence(sentenceText)
  if (!suggested || suggested === sentenceText) {
    return ref
  }
  improvements.push({
    severity: 'medium',
    category: 'Plain English',
    issue: "Use of 'please' — GOV.UK style is direct and instructional",
    why: "GOV.UK style avoids 'please' in favour of direct, instructional language. It is not rude to be direct.",
    current: sentenceText,
    suggested,
    ref,
    start: sentence.start,
    end: sentence.end
  })
  issues.push({
    start: sentence.start,
    end: sentence.end,
    type: 'plain-english',
    text: sentenceText,
    ref
  })
  logger.info(
    { matchStart: match.index },
    "[rule-enforcer] Injected 'please' improvement"
  )
  return ref + 1
}

function injectGovernmentImprovement(improvements, issues, canonicalText, ref) {
  if (isAlreadyFlagged(improvements, 'Government')) {
    return
  }
  const match = findFirstGovernmentMatch(canonicalText)
  if (!match) {
    return
  }
  const start = match.index
  const end = match.index + match[0].length
  improvements.push({
    severity: 'medium',
    category: 'GOV.UK Style Compliance',
    issue: "Incorrect capitalisation of 'government' — sentence case required",
    why: "GOV.UK style guide requires sentence case. 'Government' should only be capitalised at the start of a sentence or as part of 'Welsh Government'.",
    current: match[0],
    suggested: 'government',
    ref,
    start,
    end
  })
  issues.push({
    start,
    end,
    type: 'govuk-style',
    text: match[0],
    ref
  })
  logger.info(
    { matchStart: start },
    "[rule-enforcer] Injected 'Government' improvement"
  )
}

/**
 * Post-process parsed review to inject improvements for issues the LLM missed.
 * Enforces:
 *   - Use of "please" (GOV.UK style requires direct language)
 *   - Mid-sentence capitalisation of "Government" (sentence case required)
 *
 * Only the first unflagged occurrence of each pattern is injected, consistent
 * with the LLM's consolidation behaviour.
 */
export function enforceMandatoryRules(parsedReview, canonicalText) {
  if (!canonicalText) {
    return parsedReview
  }

  const improvements = [...(parsedReview.improvements ?? [])]
  const issues = [...(parsedReview.reviewedContent?.issues ?? [])]
  let ref = getNextRef(improvements)

  ref = injectPleaseImprovement(improvements, issues, canonicalText, ref)
  injectGovernmentImprovement(improvements, issues, canonicalText, ref)

  if (improvements.length === (parsedReview.improvements ?? []).length) {
    return parsedReview
  }

  return {
    ...parsedReview,
    improvements,
    reviewedContent: { ...parsedReview.reviewedContent, issues }
  }
}
