import { describe, test, expect, vi, beforeEach } from 'vitest'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import {
  extractDocxText,
  docxXmlToParagraphObjects,
  blocksToDocxText
} from './docx-text-extractor.js'

vi.mock('./logging/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  }))
}))

vi.mock('mammoth', () => ({
  default: {
    convertToMarkdown: vi.fn(),
    extractRawText: vi.fn()
  }
}))

vi.mock('jszip', () => ({
  default: { loadAsync: vi.fn() }
}))

// ─── Test constants ─────────────────────────────────────────────────────────

const FAKE_BUFFER = Buffer.from('PKfake-docx-bytes')
const EXAMPLE_URL = 'https://example.com'
const GOV_UK_URL = 'https://gov.uk'

// Limits in production code (mirrored here so test thresholds stay in sync).
const MAX_INPUT_BUFFER_BYTES = 50 * 1024 * 1024
const MAX_EXTRACTED_XML_BYTES = 50 * 1024 * 1024
const MAX_ZIP_ENTRIES = 1000

// Boundary values that trigger the corresponding guard.
const OVERSIZED_BUFFER_BYTES = MAX_INPUT_BUFFER_BYTES + 1
const OVERSIZED_XML_BYTES = MAX_EXTRACTED_XML_BYTES + 1
const OVER_ENTRY_LIMIT = MAX_ZIP_ENTRIES + 1

// First five bytes of a real ZIP local-file-header (PK\3\4 plus a version byte).
const ZIP_MAGIC_BYTES = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x01)

// ─── XML helpers ────────────────────────────────────────────────────────────

const wrapDocument = (innerXml) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
   <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
               xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
     <w:body>${innerXml}</w:body>
   </w:document>`

const wrapRels = (innerXml) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
   <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${innerXml}</Relationships>`

// Build a JSZip-like mock backed by a path → string map.
// Exposes both `file(path)` (for content lookups) and `files` (for entry-count
// checks) so tests can exercise the zip-bomb mitigations.
function makeMockZip(files, extraEntries = {}) {
  return {
    files: { ...files, ...extraEntries },
    file: vi.fn((path) => {
      if (!(path in files)) {
        return null
      }
      return { async: vi.fn().mockResolvedValue(files[path]) }
    })
  }
}

// ─── docxXmlToParagraphObjects — structural classification ─────────────────

describe('docxXmlToParagraphObjects — structural classification', () => {
  test('returns an empty array when the body cannot be located', () => {
    const xml = '<?xml version="1.0"?><foo/>'
    const result = docxXmlToParagraphObjects(xml, null)
    expect(result).toEqual([])
  })

  test('extracts a simple paragraph with a single run', () => {
    const xml = wrapDocument('<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>')
    const result = docxXmlToParagraphObjects(xml, null)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('para')
    expect(result[0].runs.map((r) => r.text).join('')).toContain('Hello world')
  })

  test('detects heading paragraphs by w:pStyle = HeadingX', () => {
    const xml = wrapDocument(
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>'
    )
    const result = docxXmlToParagraphObjects(xml, null)
    expect(result[0].type).toBe('heading')
  })

  test('detects list paragraphs by w:numPr presence', () => {
    const xml = wrapDocument(
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Item</w:t></w:r></w:p>'
    )
    const result = docxXmlToParagraphObjects(xml, null)
    expect(result[0].type).toBe('list')
  })

  test('treats a single w:p (non-array) the same as an array of one', () => {
    const xml = wrapDocument('<w:p><w:r><w:t>Solo</w:t></w:r></w:p>')
    const result = docxXmlToParagraphObjects(xml, null)
    expect(result).toHaveLength(1)
    expect(result[0].runs.map((r) => r.text).join('')).toContain('Solo')
  })
})

// ─── docxXmlToParagraphObjects — content extraction ────────────────────────

describe('docxXmlToParagraphObjects — content extraction', () => {
  test('captures bold and italic from w:rPr', () => {
    const xml = wrapDocument(
      '<w:p><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>Strong</w:t></w:r></w:p>'
    )
    const [block] = docxXmlToParagraphObjects(xml, null)
    expect(block.runs[0].bold).toBe(true)
    expect(block.runs[0].italic).toBe(true)
  })

  test('hyperlinks resolve through the rels map to a target URL', () => {
    const xml = wrapDocument(`
      <w:p>
        <w:hyperlink r:id="rId1">
          <w:r><w:t>GOV.UK</w:t></w:r>
        </w:hyperlink>
      </w:p>
    `)
    const rels = wrapRels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${GOV_UK_URL}"/>`
    )
    const [block] = docxXmlToParagraphObjects(xml, rels)
    const linkRun = block.runs.find((r) => r.href)
    expect(linkRun).toBeDefined()
    expect(linkRun.href).toBe(GOV_UK_URL)
    expect(linkRun.text).toContain('GOV.UK')
  })

  test('drops drawing / picture artefact runs', () => {
    const xml = wrapDocument(`
      <w:p>
        <w:r><w:t>Real text</w:t></w:r>
        <w:r><w:drawing><pic:pic/></w:drawing></w:r>
      </w:p>
    `)
    const [block] = docxXmlToParagraphObjects(xml, null)
    const allText = block.runs.map((r) => r.text).join('')
    expect(allText).toContain('Real text')
    expect(allText).not.toContain('<pic:pic')
  })

  test('drops paragraphs whose runs collapse to empty', () => {
    const xml = wrapDocument('<w:p><w:r><w:drawing/></w:r></w:p>')
    expect(docxXmlToParagraphObjects(xml, null)).toEqual([])
  })

  test('falls back to empty rels when relsXml fails to parse', () => {
    const xml = wrapDocument('<w:p><w:r><w:t>X</w:t></w:r></w:p>')
    const result = docxXmlToParagraphObjects(xml, '<<not-valid-xml')
    expect(result).toHaveLength(1)
    expect(result[0].runs[0].href ?? null).toBeNull()
  })
})

// ─── blocksToDocxText ───────────────────────────────────────────────────────

describe('blocksToDocxText', () => {
  test('joins paragraph blocks with double newlines', () => {
    const blocks = [
      { type: 'para', runs: [{ text: 'First' }] },
      { type: 'para', runs: [{ text: 'Second' }] }
    ]
    expect(blocksToDocxText(blocks)).toBe('First\n\nSecond')
  })

  test('prefixes list blocks with "- "', () => {
    const blocks = [{ type: 'list', runs: [{ text: 'Item one' }] }]
    expect(blocksToDocxText(blocks)).toBe('- Item one')
  })

  test('renders run with href as Markdown anchor', () => {
    const blocks = [
      { type: 'para', runs: [{ text: 'Click', href: EXAMPLE_URL }] }
    ]
    expect(blocksToDocxText(blocks)).toBe(`[Click](${EXAMPLE_URL})`)
  })

  test('groups consecutive runs sharing the same href into one anchor', () => {
    const blocks = [
      {
        type: 'para',
        runs: [
          { text: 'Click ', href: EXAMPLE_URL },
          { text: 'here', href: EXAMPLE_URL }
        ]
      }
    ]
    expect(blocksToDocxText(blocks)).toBe(`[Click here](${EXAMPLE_URL})`)
  })

  test('keeps consecutive runs with different hrefs as separate anchors', () => {
    const blocks = [
      {
        type: 'para',
        runs: [
          { text: 'A', href: 'https://a.example' },
          { text: 'B', href: 'https://b.example' }
        ]
      }
    ]
    expect(blocksToDocxText(blocks)).toBe(
      '[A](https://a.example)[B](https://b.example)'
    )
  })

  test('drops blocks whose runs collapse to whitespace', () => {
    const blocks = [
      { type: 'para', runs: [{ text: '   ' }] },
      { type: 'para', runs: [{ text: 'Real' }] }
    ]
    expect(blocksToDocxText(blocks)).toBe('Real')
  })

  test('returns empty string for an empty block list', () => {
    expect(blocksToDocxText([])).toBe('')
  })
})

// ─── extractDocxText — mammoth happy path ──────────────────────────────────

describe('extractDocxText – mammoth happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('returns mammoth markdown string when convertToMarkdown succeeds', async () => {
    vi.mocked(mammoth.convertToMarkdown).mockResolvedValue({
      value: '# Hello\n\nWorld',
      messages: []
    })

    const result = await extractDocxText(FAKE_BUFFER)
    expect(result).toBe('# Hello\n\nWorld')
  })

  test('logs when mammoth returns warning messages', async () => {
    vi.mocked(mammoth.convertToMarkdown).mockResolvedValue({
      value: 'text',
      messages: [{ message: 'minor warning' }]
    })

    const result = await extractDocxText(FAKE_BUFFER)
    expect(result).toBe('text')
  })

  test('returns empty string when mammoth value is empty', async () => {
    vi.mocked(mammoth.convertToMarkdown).mockResolvedValue({
      value: '',
      messages: []
    })

    const result = await extractDocxText(FAKE_BUFFER)
    expect(result).toBe('')
  })
})

describe('extractDocxText – mammoth fallback to extractRawText', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('falls back to extractRawText when convertToMarkdown fails', async () => {
    vi.mocked(mammoth.convertToMarkdown).mockRejectedValue(
      new Error('convertToMarkdown not supported')
    )
    vi.mocked(mammoth.extractRawText).mockResolvedValue({
      value: 'Plain text fallback',
      messages: []
    })

    const result = await extractDocxText(FAKE_BUFFER)
    expect(result).toBe('Plain text fallback')
  })
})

// ─── extractDocxText — ZIP fallback (parse paths) ──────────────────────────

describe('extractDocxText – ZIP fallback parses XML', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(mammoth.convertToMarkdown).mockRejectedValue(
      new Error('mammoth failed')
    )
    vi.mocked(mammoth.extractRawText).mockRejectedValue(
      new Error('mammoth failed')
    )
  })

  test('parses document.xml and returns serialised Markdown when present', async () => {
    const documentXml = wrapDocument(
      '<w:p><w:r><w:t>Hello from ZIP fallback</w:t></w:r></w:p>'
    )
    vi.mocked(JSZip.loadAsync).mockResolvedValue(
      makeMockZip({ 'word/document.xml': documentXml })
    )

    const result = await extractDocxText(FAKE_BUFFER)
    expect(typeof result).toBe('string')
    expect(result).toContain('Hello from ZIP fallback')
  })

  test('resolves hyperlinks via rels XML when present', async () => {
    const documentXml = wrapDocument(`
      <w:p>
        <w:hyperlink r:id="rId1">
          <w:r><w:t>GOV.UK</w:t></w:r>
        </w:hyperlink>
      </w:p>
    `)
    const relsXml = wrapRels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${GOV_UK_URL}"/>`
    )

    vi.mocked(JSZip.loadAsync).mockResolvedValue(
      makeMockZip({
        'word/document.xml': documentXml,
        'word/_rels/document.xml.rels': relsXml
      })
    )

    const result = await extractDocxText(FAKE_BUFFER)
    expect(result).toContain(`[GOV.UK](${GOV_UK_URL})`)
  })
})

// ─── extractDocxText — ZIP fallback (error paths) ──────────────────────────

describe('extractDocxText – ZIP fallback error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(mammoth.convertToMarkdown).mockRejectedValue(
      new Error('mammoth failed')
    )
    vi.mocked(mammoth.extractRawText).mockRejectedValue(
      new Error('mammoth failed')
    )
  })

  test('throws a wrapped error when zip is missing word/document.xml', async () => {
    vi.mocked(JSZip.loadAsync).mockResolvedValue(makeMockZip({}))

    await expect(extractDocxText(FAKE_BUFFER)).rejects.toThrow(
      /Failed to extract text from DOCX/
    )
  })

  test('throws a wrapped error when JSZip itself cannot read the buffer', async () => {
    vi.mocked(JSZip.loadAsync).mockRejectedValue(new Error('bad zip'))

    await expect(extractDocxText(FAKE_BUFFER)).rejects.toThrow(
      /Failed to extract text from DOCX/
    )
  })
})

// ─── Zip-bomb mitigations (sonar S5042) ────────────────────────────────────

describe('extractDocxText – zip-bomb mitigations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(mammoth.convertToMarkdown).mockRejectedValue(
      new Error('mammoth failed')
    )
    vi.mocked(mammoth.extractRawText).mockRejectedValue(
      new Error('mammoth failed')
    )
  })

  test('rejects input buffers that exceed the cap before opening the archive', async () => {
    const oversizedBuffer = Buffer.alloc(OVERSIZED_BUFFER_BYTES)

    await expect(extractDocxText(oversizedBuffer)).rejects.toThrow(
      /buffer.*refusing to expand/
    )
    // Guard fires before loadAsync, so the zip library is never invoked.
    expect(JSZip.loadAsync).not.toHaveBeenCalled()
  })

  test('rejects archives that contain more than the entry-count limit', async () => {
    const documentXml = wrapDocument('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>')

    const tooManyEntries = {}
    for (let i = 0; i < OVER_ENTRY_LIMIT; i++) {
      tooManyEntries[`junk/file_${i}.bin`] = ''
    }

    vi.mocked(JSZip.loadAsync).mockResolvedValue(
      makeMockZip({ 'word/document.xml': documentXml }, tooManyEntries)
    )

    await expect(extractDocxText(FAKE_BUFFER)).rejects.toThrow(
      /entries.*refusing to expand/
    )
  })

  test('rejects archives whose document.xml exceeds the per-entry size cap', async () => {
    const oversizedXml = 'A'.repeat(OVERSIZED_XML_BYTES)

    vi.mocked(JSZip.loadAsync).mockResolvedValue(
      makeMockZip({ 'word/document.xml': oversizedXml })
    )

    await expect(extractDocxText(FAKE_BUFFER)).rejects.toThrow(
      /exceeds.*refusing to expand/
    )
  })
})

// ─── extractDocxText — buffer normalisation ────────────────────────────────

describe('extractDocxText – buffer normalisation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(mammoth.convertToMarkdown).mockResolvedValue({
      value: 'ok',
      messages: []
    })
  })

  test('accepts a Node Buffer', async () => {
    const result = await extractDocxText(Buffer.from('docx-bytes'))
    expect(result).toBe('ok')
  })

  test('accepts a Uint8Array (ArrayBufferView)', async () => {
    // Wrap a Uint8Array in Buffer.from so the subarray() debug log works.
    const view = Buffer.from(ZIP_MAGIC_BYTES)
    const result = await extractDocxText(view)
    expect(result).toBe('ok')
  })
})
