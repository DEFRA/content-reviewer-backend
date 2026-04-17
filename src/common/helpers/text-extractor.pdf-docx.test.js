import { describe, test, expect, vi, beforeEach } from 'vitest'
import mammoth from 'mammoth'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { textExtractor } from './text-extractor.js'

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  }))
}))

// Mock pdfjs-dist so no real Worker or file I/O is needed.
// GlobalWorkerOptions must be a mutable object so the module-level
// pdfjsLib.GlobalWorkerOptions.workerSrc = ... assignment succeeds.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn()
}))

vi.mock('mammoth', () => ({
  default: { convertToMarkdown: vi.fn() }
}))

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Build a pdfjs text item with the baseline position encoded in transform.
 * transform = [scaleX, skewY, skewX, scaleY, tx, ty]
 * Indices 4 (tx) and 5 (ty) are what rectsOverlap reads.
 */
function makeTextItem(str, tx, ty) {
  return { str, transform: [1, 0, 0, 1, tx, ty] }
}

/** Build a URI link annotation. */
function makeLinkAnnotation(url, rect) {
  return { subtype: 'Link', url, rect }
}

/** Build a mock pdfjs page. */
function makeMockPage(items, annotations = []) {
  return {
    getTextContent: vi.fn().mockResolvedValue({ items }),
    getAnnotations: vi.fn().mockResolvedValue(annotations),
    cleanup: vi.fn()
  }
}

/** Build a mock pdfjs document from an array of pages. */
function makeMockDoc(pages) {
  return {
    numPages: pages.length,
    getPage: vi.fn().mockImplementation((i) => Promise.resolve(pages[i - 1])),
    cleanup: vi.fn().mockResolvedValue(undefined)
  }
}

/** Wire getDocument mock to resolve with the given doc. */
function mockPdfDoc(doc) {
  vi.mocked(pdfjsLib.getDocument).mockReturnValue({
    promise: Promise.resolve(doc)
  })
}

const FAKE_BUFFER = Buffer.from('fake-pdf-bytes')
const PDF_MIME = 'application/pdf'
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// ─── tests ─────────────────────────────────────────────────────────────────

describe('TextExtractor – PDF extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('extractFromPDF – no link annotations (fast path)', () => {
    test('Should join text items as plain text when no annotations exist', async () => {
      const page = makeMockPage([
        makeTextItem('Hello', 10, 20),
        makeTextItem(' World', 50, 20)
      ])
      mockPdfDoc(makeMockDoc([page]))

      const result = await textExtractor.extractFromPDF(FAKE_BUFFER)

      expect(result).toContain('Hello World')
    })

    test('Should call page.cleanup after processing', async () => {
      const page = makeMockPage([makeTextItem('text', 10, 20)])
      mockPdfDoc(makeMockDoc([page]))

      await textExtractor.extractFromPDF(FAKE_BUFFER)

      expect(page.cleanup).toHaveBeenCalled()
    })

    test('Should call doc.cleanup after all pages processed', async () => {
      const page = makeMockPage([makeTextItem('text', 10, 20)])
      const doc = makeMockDoc([page])
      mockPdfDoc(doc)

      await textExtractor.extractFromPDF(FAKE_BUFFER)

      expect(doc.cleanup).toHaveBeenCalled()
    })

    test('Should join multiple pages with double newline', async () => {
      const page1 = makeMockPage([makeTextItem('Page one', 10, 20)])
      const page2 = makeMockPage([makeTextItem('Page two', 10, 20)])
      mockPdfDoc(makeMockDoc([page1, page2]))

      const result = await textExtractor.extractFromPDF(FAKE_BUFFER)

      expect(result).toContain('Page one')
      expect(result).toContain('Page two')
      expect(result).toContain('\n\n')
    })
  })

  describe('extractFromPDF – link annotations path', () => {
    test('Should render linked text as Markdown [anchor](url)', async () => {
      // Item inside the annotation rect → link anchor
      // rect [5,15,50,30]: tx=10 (5≤10≤50) ty=20 (15≤20≤30) → overlap
      const page = makeMockPage(
        [
          makeTextItem('Click here', 10, 20),
          makeTextItem(' for info', 60, 20) // tx=60 > rx2=50 → outside
        ],
        [makeLinkAnnotation('https://example.com', [5, 15, 50, 30])]
      )
      mockPdfDoc(makeMockDoc([page]))

      const result = await textExtractor.extractFromPDF(FAKE_BUFFER)

      expect(result).toContain('[Click here](https://example.com)')
      expect(result).toContain(' for info')
    })

    test('Should group consecutive items inside the same annotation', async () => {
      const page = makeMockPage(
        [
          makeTextItem('Go', 10, 20),
          makeTextItem(' here', 20, 20) // both inside [5,15,50,30]
        ],
        [makeLinkAnnotation('https://example.com', [5, 15, 50, 30])]
      )
      mockPdfDoc(makeMockDoc([page]))

      const result = await textExtractor.extractFromPDF(FAKE_BUFFER)

      expect(result).toContain('[Go here](https://example.com)')
    })

    test('Should not render link when anchor text is whitespace only', async () => {
      // Whitespace-only anchor: flush skips the push when anchorText.trim() === ''
      const page = makeMockPage(
        [makeTextItem('   ', 10, 20)], // inside rect but only spaces
        [makeLinkAnnotation('https://example.com', [5, 15, 50, 30])]
      )
      mockPdfDoc(makeMockDoc([page]))

      const result = await textExtractor.extractFromPDF(FAKE_BUFFER)

      expect(result).not.toContain('[')
      expect(result).not.toContain('](')
    })

    test('Should ignore annotations that are not Link subtype', async () => {
      const page = makeMockPage(
        [makeTextItem('text', 10, 20)],
        [
          {
            subtype: 'Highlight',
            url: 'https://example.com',
            rect: [5, 15, 50, 30]
          }
        ]
      )
      mockPdfDoc(makeMockDoc([page]))

      const result = await textExtractor.extractFromPDF(FAKE_BUFFER)

      expect(result).not.toContain('](')
    })

    test('Should ignore Link annotations whose URL does not start with http', async () => {
      const page = makeMockPage(
        [makeTextItem('link', 10, 20)],
        [makeLinkAnnotation('ftp://example.com', [5, 15, 50, 30])]
      )
      mockPdfDoc(makeMockDoc([page]))

      const result = await textExtractor.extractFromPDF(FAKE_BUFFER)

      expect(result).not.toContain('](')
    })

    test('Should handle item outside all annotation rects as plain text', async () => {
      const page = makeMockPage(
        [makeTextItem('outside', 100, 100)], // outside rect [5,15,50,30]
        [makeLinkAnnotation('https://example.com', [5, 15, 50, 30])]
      )
      mockPdfDoc(makeMockDoc([page]))

      const result = await textExtractor.extractFromPDF(FAKE_BUFFER)

      expect(result).toContain('outside')
      expect(result).not.toContain('](')
    })
  })

  describe('extractFromPDF – error path', () => {
    test('Should throw wrapped error when pdfjs fails', async () => {
      vi.mocked(pdfjsLib.getDocument).mockReturnValue({
        promise: Promise.reject(new Error('pdfjs boom'))
      })

      await expect(textExtractor.extractFromPDF(FAKE_BUFFER)).rejects.toThrow(
        'Failed to extract text from PDF: pdfjs boom'
      )
    })
  })

  describe('extractText – PDF mime type routes through extractFromPDF', () => {
    test('Should return normalised text for PDF mime type', async () => {
      const page = makeMockPage([makeTextItem('Hello World', 10, 20)])
      mockPdfDoc(makeMockDoc([page]))

      const result = await textExtractor.extractText(
        FAKE_BUFFER,
        PDF_MIME,
        'test.pdf'
      )

      expect(result).toContain('Hello World')
    })

    test('Should wrap extractFromPDF error in extractText error', async () => {
      vi.mocked(pdfjsLib.getDocument).mockReturnValue({
        promise: Promise.reject(new Error('pdf parse error'))
      })

      await expect(
        textExtractor.extractText(FAKE_BUFFER, PDF_MIME, 'test.pdf')
      ).rejects.toThrow(
        'Failed to extract text: Failed to extract text from PDF'
      )
    })
  })
})

describe('TextExtractor – DOCX extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('extractFromDocx – success paths', () => {
    test('Should return extracted markdown text when no warnings', async () => {
      vi.mocked(mammoth.convertToMarkdown).mockResolvedValue({
        value: 'Some extracted text',
        messages: []
      })

      const result = await textExtractor.extractFromDocx(FAKE_BUFFER)

      expect(result).toBe('Some extracted text')
    })

    test('Should still return text when mammoth emits warnings', async () => {
      vi.mocked(mammoth.convertToMarkdown).mockResolvedValue({
        value: 'Extracted with warnings',
        messages: [{ type: 'warning', message: 'unrecognised element' }]
      })

      const result = await textExtractor.extractFromDocx(FAKE_BUFFER)

      expect(result).toBe('Extracted with warnings')
    })
  })

  describe('extractFromDocx – error path', () => {
    test('Should throw wrapped error when mammoth fails', async () => {
      vi.mocked(mammoth.convertToMarkdown).mockRejectedValue(
        new Error('mammoth boom')
      )

      await expect(textExtractor.extractFromDocx(FAKE_BUFFER)).rejects.toThrow(
        'Failed to extract text from DOCX: mammoth boom'
      )
    })
  })

  describe('extractText – DOCX mime type routes through extractFromDocx', () => {
    test('Should return normalised text for DOCX mime type', async () => {
      vi.mocked(mammoth.convertToMarkdown).mockResolvedValue({
        value: 'Document content here',
        messages: []
      })

      const result = await textExtractor.extractText(
        FAKE_BUFFER,
        DOCX_MIME,
        'test.docx'
      )

      expect(result).toContain('Document content')
    })

    test('Should wrap extractFromDocx error in extractText error', async () => {
      vi.mocked(mammoth.convertToMarkdown).mockRejectedValue(
        new Error('docx parse error')
      )

      await expect(
        textExtractor.extractText(FAKE_BUFFER, DOCX_MIME, 'test.docx')
      ).rejects.toThrow(
        'Failed to extract text: Failed to extract text from DOCX'
      )
    })
  })
})
