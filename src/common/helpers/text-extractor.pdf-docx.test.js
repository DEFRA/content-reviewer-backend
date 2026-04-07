import { describe, test, expect } from 'vitest'
import { textExtractor } from './text-extractor.js'

describe('text-extractor.pdf-docx', () => {
  test('textExtractor should be defined', () => {
    expect(textExtractor).toBeDefined()
  })
})
