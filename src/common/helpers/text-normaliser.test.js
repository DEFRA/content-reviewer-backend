import { describe } from 'vitest'
import { testNormaliseEdgeCases } from './text-normaliser.edge-cases.test.js'
import { testControlChars } from './text-normaliser.control-chars.test.js'
import { testUnicodeAndLigatures } from './text-normaliser.unicode-ligatures.test.js'
import { testQuotesAndDashes } from './text-normaliser.quotes-dashes.test.js'
import { testWhitespaceAndLines } from './text-normaliser.whitespace-lines.test.js'
import { testPageNumbers } from './text-normaliser.page-numbers.test.js'
import { testUrlProtection } from './text-normaliser.url-protection.test.js'
import { testStructuralPreservation } from './text-normaliser.structural.test.js'
import { testBuildSourceMap } from './text-normaliser.source-map.test.js'
import { testRealWorldScenarios } from './text-normaliser.real-world.test.js'

describe('TextNormaliser', () => {
  testNormaliseEdgeCases()
  testControlChars()
  testUnicodeAndLigatures()
  testQuotesAndDashes()
  testWhitespaceAndLines()
  testPageNumbers()
  testUrlProtection()
  testStructuralPreservation()
  testBuildSourceMap()
  testRealWorldScenarios()
})
