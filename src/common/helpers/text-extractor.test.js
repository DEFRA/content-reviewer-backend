import { describe, test, expect, vi, beforeEach } from 'vitest'
import { textExtractor } from './text-extractor.js'

// Mock logger to avoid noise in tests
vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  }))
}))

// Reusable text constants to avoid duplication
const HELLO_WORLD = 'Hello World'

// Test constants
const TEST_CONSTANTS = {
  MIME_TYPES: {
    PDF: 'application/pdf',
    DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    DOC: 'application/msword',
    TXT: 'text/plain',
    UNSUPPORTED: 'application/json'
  },
  FILE_NAMES: {
    PDF: 'test.pdf',
    DOCX: 'test.docx',
    DOC: 'test.doc',
    TXT: 'test.txt'
  },
  TEXT: {
    SIMPLE: HELLO_WORLD,
    CLEANED_WHITESPACE: HELLO_WORLD,
    WITH_WHITESPACE: '  Hello   World  ',
    MULTILINE: 'Line 1\nLine 2\nLine 3',
    WINDOWS_NEWLINES: 'Line 1\r\nLine 2\r\nLine 3',
    EXCESSIVE_NEWLINES: 'Paragraph 1\n\n\n\n\nParagraph 2',
    EXCESSIVE_SPACES: 'Hello     World',
    EMPTY: '',
    LONG: 'A'.repeat(1000),
    PARAGRAPHS: 'Para 1\n\nPara 2\n\nPara 3'
  },
  NUMBERS: {
    ZERO: 0,
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FOUR: 4,
    FIVE: 5,
    SIX: 6,
    TEN: 10,
    THIRTEEN: 13,
    TWENTY_THREE: 23,
    PREVIEW_LENGTH: 500,
    LONG_TEXT: 600,
    PREVIEW_WITH_ELLIPSIS: 503
  }
}

describe('TextExtractor - Text Extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('extractText method', () => {
    test('Should extract text from plain text buffer', async () => {
      const mockText = TEST_CONSTANTS.TEXT.SIMPLE
      const buffer = Buffer.from(mockText, 'utf-8')

      const result = await textExtractor.extractText(
        buffer,
        TEST_CONSTANTS.MIME_TYPES.TXT,
        TEST_CONSTANTS.FILE_NAMES.TXT
      )

      expect(result).toBe(mockText)
    })

    test('Should throw error for legacy DOC format', async () => {
      const buffer = Buffer.from('mock doc content')

      await expect(
        textExtractor.extractText(
          buffer,
          TEST_CONSTANTS.MIME_TYPES.DOC,
          TEST_CONSTANTS.FILE_NAMES.DOC
        )
      ).rejects.toThrow('Legacy .doc format is not supported')
    })

    test('Should throw error for unsupported MIME type', async () => {
      const buffer = Buffer.from('mock content')

      await expect(
        textExtractor.extractText(buffer, TEST_CONSTANTS.MIME_TYPES.UNSUPPORTED)
      ).rejects.toThrow('Unsupported file type')
    })

    test('Should throw error when no text content extracted', async () => {
      const buffer = Buffer.from('   ', 'utf-8')

      await expect(
        textExtractor.extractText(buffer, TEST_CONSTANTS.MIME_TYPES.TXT)
      ).rejects.toThrow('No text content could be extracted')
    })

    test('Should clean extracted text from plain text', async () => {
      const mockText = TEST_CONSTANTS.TEXT.WITH_WHITESPACE
      const buffer = Buffer.from(mockText, 'utf-8')

      const result = await textExtractor.extractText(
        buffer,
        TEST_CONSTANTS.MIME_TYPES.TXT
      )

      expect(result).toBe(TEST_CONSTANTS.TEXT.CLEANED_WHITESPACE)
    })
  })
})

describe('TextExtractor - Text Cleaning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('cleanText method', () => {
    test('Should return empty string for null input', () => {
      const result = textExtractor.cleanText(null)
      expect(result).toBe('')
    })

    test('Should return empty string for undefined input', () => {
      const result = textExtractor.cleanText(undefined)
      expect(result).toBe('')
    })

    test('Should normalize Windows line endings', () => {
      const result = textExtractor.cleanText(
        TEST_CONSTANTS.TEXT.WINDOWS_NEWLINES
      )
      expect(result).toBe('Line 1\nLine 2\nLine 3')
    })

    test('Should reduce excessive newlines', () => {
      const result = textExtractor.cleanText(
        TEST_CONSTANTS.TEXT.EXCESSIVE_NEWLINES
      )
      expect(result).toBe('Paragraph 1\n\nParagraph 2')
    })

    test('Should normalize spaces', () => {
      const result = textExtractor.cleanText(
        TEST_CONSTANTS.TEXT.EXCESSIVE_SPACES
      )
      expect(result).toBe('Hello World')
    })

    test('Should trim whitespace', () => {
      const result = textExtractor.cleanText(
        TEST_CONSTANTS.TEXT.WITH_WHITESPACE
      )
      expect(result).toBe(TEST_CONSTANTS.TEXT.CLEANED_WHITESPACE)
    })

    test('Should handle text with multiple whitespace issues', () => {
      const dirtyText = '  Hello     World\r\n\r\n\r\n\r\nNext Line  '
      const result = textExtractor.cleanText(dirtyText)
      expect(result).toBe('Hello World\n\nNext Line')
    })
  })
})

describe('TextExtractor - Text Preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getPreview method', () => {
    test('Should return full text when shorter than max length', () => {
      const result = textExtractor.getPreview(TEST_CONSTANTS.TEXT.SIMPLE)
      expect(result).toBe(TEST_CONSTANTS.TEXT.SIMPLE)
    })

    test('Should truncate text when longer than max length', () => {
      const result = textExtractor.getPreview(
        TEST_CONSTANTS.TEXT.LONG,
        TEST_CONSTANTS.NUMBERS.TEN
      )
      expect(result).toBe('AAAAAAAAAA...')
      expect(result.length).toBe(TEST_CONSTANTS.NUMBERS.THIRTEEN)
    })

    test('Should use default max length of 500', () => {
      const longText = 'A'.repeat(TEST_CONSTANTS.NUMBERS.LONG_TEXT)
      const result = textExtractor.getPreview(longText)
      expect(result.length).toBe(TEST_CONSTANTS.NUMBERS.PREVIEW_WITH_ELLIPSIS)
      expect(result).toBe(
        'A'.repeat(TEST_CONSTANTS.NUMBERS.PREVIEW_LENGTH) + '...'
      )
    })

    test('Should handle null input', () => {
      const result = textExtractor.getPreview(null)
      expect(result).toBe(null)
    })

    test('Should handle empty string', () => {
      const result = textExtractor.getPreview(TEST_CONSTANTS.TEXT.EMPTY)
      expect(result).toBe(TEST_CONSTANTS.TEXT.EMPTY)
    })
  })
})

describe('TextExtractor - Word Counting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('countWords method', () => {
    test('Should count words correctly', () => {
      const result = textExtractor.countWords(TEST_CONSTANTS.TEXT.SIMPLE)
      expect(result).toBe(TEST_CONSTANTS.NUMBERS.TWO)
    })

    test('Should return zero for empty string', () => {
      const result = textExtractor.countWords(TEST_CONSTANTS.TEXT.EMPTY)
      expect(result).toBe(TEST_CONSTANTS.NUMBERS.ZERO)
    })

    test('Should return zero for null input', () => {
      const result = textExtractor.countWords(null)
      expect(result).toBe(TEST_CONSTANTS.NUMBERS.ZERO)
    })

    test('Should handle text with multiple spaces', () => {
      const result = textExtractor.countWords(
        TEST_CONSTANTS.TEXT.EXCESSIVE_SPACES
      )
      expect(result).toBe(TEST_CONSTANTS.NUMBERS.TWO)
    })

    test('Should handle text with newlines', () => {
      const result = textExtractor.countWords(TEST_CONSTANTS.TEXT.MULTILINE)
      expect(result).toBe(TEST_CONSTANTS.NUMBERS.SIX)
    })

    test('Should trim and count correctly', () => {
      const result = textExtractor.countWords(
        TEST_CONSTANTS.TEXT.WITH_WHITESPACE
      )
      expect(result).toBe(TEST_CONSTANTS.NUMBERS.TWO)
    })
  })
})

describe('TextExtractor - Statistics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getStatistics method', () => {
    test('Should return statistics for text', () => {
      const text = 'Hello World\nSecond Line'
      const result = textExtractor.getStatistics(text)

      expect(result).toEqual({
        characters: TEST_CONSTANTS.NUMBERS.TWENTY_THREE,
        words: TEST_CONSTANTS.NUMBERS.FOUR,
        lines: TEST_CONSTANTS.NUMBERS.TWO,
        paragraphs: TEST_CONSTANTS.NUMBERS.ONE
      })
    })

    test('Should return zero statistics for null input', () => {
      const result = textExtractor.getStatistics(null)

      expect(result).toEqual({
        characters: TEST_CONSTANTS.NUMBERS.ZERO,
        words: TEST_CONSTANTS.NUMBERS.ZERO,
        lines: TEST_CONSTANTS.NUMBERS.ZERO,
        paragraphs: TEST_CONSTANTS.NUMBERS.ZERO
      })
    })

    test('Should return zero statistics for empty string', () => {
      const result = textExtractor.getStatistics(TEST_CONSTANTS.TEXT.EMPTY)

      expect(result).toEqual({
        characters: TEST_CONSTANTS.NUMBERS.ZERO,
        words: TEST_CONSTANTS.NUMBERS.ZERO,
        lines: TEST_CONSTANTS.NUMBERS.ZERO,
        paragraphs: TEST_CONSTANTS.NUMBERS.ZERO
      })
    })

    test('Should count multiple paragraphs', () => {
      const result = textExtractor.getStatistics(TEST_CONSTANTS.TEXT.PARAGRAPHS)

      expect(result.paragraphs).toBe(TEST_CONSTANTS.NUMBERS.THREE)
      expect(result.lines).toBe(TEST_CONSTANTS.NUMBERS.FIVE)
    })

    test('Should handle single line text', () => {
      const result = textExtractor.getStatistics(TEST_CONSTANTS.TEXT.SIMPLE)

      expect(result.lines).toBe(TEST_CONSTANTS.NUMBERS.ONE)
      expect(result.paragraphs).toBe(TEST_CONSTANTS.NUMBERS.ONE)
    })
  })
})

describe('TextExtractor - Singleton and Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('singleton instance', () => {
    test('Should export textExtractor singleton', () => {
      expect(textExtractor).toBeDefined()
      expect(textExtractor.cleanText).toBeTypeOf('function')
    })

    test('Should be able to use singleton instance', () => {
      const result = textExtractor.cleanText(
        TEST_CONSTANTS.TEXT.WITH_WHITESPACE
      )
      expect(result).toBe(TEST_CONSTANTS.TEXT.CLEANED_WHITESPACE)
    })
  })
})
