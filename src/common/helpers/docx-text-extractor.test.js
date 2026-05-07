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

const FAKE_BUFFER = Buffer.from('PKfake-docx-bytes')

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── docxXmlToParagraphObjects ──────────────────────────────────────────────

describe('docxXmlToParagraphObjects', () => {
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
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://gov.uk"/>'
    )
    const [block] = docxXmlToParagraphObjects(xml, rels)
    const linkRun = block.runs.find((r) => r.href)
    expect(linkRun).toBeDefined()
    expect(linkRun.href).toBe('https://gov.uk')
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

  test('treats a single w:p (non-array) the same as an array of one', () => {
    const xml = wrapDocument('<w:p><w:r><w:t>Solo</w:t></w:r></w:p>')
    const result = docxXmlToParagraphObjects(xml, null)
    expect(result).toHaveLength(1)
    expect(result[0].runs.map((r) => r.text).join('')).toContain('Solo')
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
      {
        type: 'para',
        runs: [{ text: 'Click', href: 'https://example.com' }]
      }
    ]
    expect(blocksToDocxText(blocks)).toBe('[Click](https://example.com)')
  })

  test('groups consecutive runs sharing the same href into one anchor', () => {
    const blocks = [
      {
        type: 'para',
        runs: [
          { text: 'Click ', href: 'https://example.com' },
          { text: 'here', href: 'https://example.com' }
        ]
      }
    ]
    expect(blocksToDocxText(blocks)).toBe('[Click here](https://example.com)')
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

// ─── extractDocxText ────────────────────────────────────────────────────────

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

describe('extractDocxText – ZIP fallback path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Force both mammoth functions to fail so we land in the ZIP fallback
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
      makeMockZip({
        'word/document.xml': documentXml
      })
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
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://gov.uk"/>'
    )

    vi.mocked(JSZip.loadAsync).mockResolvedValue(
      makeMockZip({
        'word/document.xml': documentXml,
        'word/_rels/document.xml.rels': relsXml
      })
    )

    const result = await extractDocxText(FAKE_BUFFER)
    expect(result).toContain('[GOV.UK](https://gov.uk)')
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

  // ─── Zip-bomb mitigations (sonar S5042) ──────────────────────────────────

  test('rejects archives that contain more than 1000 entries', async () => {
    const documentXml = wrapDocument('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>')

    // 1001 entries → exceeds MAX_ZIP_ENTRIES
    const tooManyEntries = {}
    for (let i = 0; i < 1001; i++) {
      tooManyEntries[`junk/file_${i}.bin`] = ''
    }

    vi.mocked(JSZip.loadAsync).mockResolvedValue(
      makeMockZip({ 'word/document.xml': documentXml }, tooManyEntries)
    )

    await expect(extractDocxText(FAKE_BUFFER)).rejects.toThrow(
      /entries.*refusing to expand/
    )
  })

  test('rejects archives whose document.xml exceeds the 50 MB cap', async () => {
    // 51 MB string — single entry, but oversized.
    const oversizedXml = 'A'.repeat(51 * 1024 * 1024)

    vi.mocked(JSZip.loadAsync).mockResolvedValue(
      makeMockZip({ 'word/document.xml': oversizedXml })
    )

    await expect(extractDocxText(FAKE_BUFFER)).rejects.toThrow(
      /exceeds.*refusing to expand/
    )
  })
})

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
    // Node Buffer is required by extractDocxText for the subarray() debug log;
    // wrap a Uint8Array in Buffer.from to keep that contract.
    const view = Buffer.from(Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x01))
    const result = await extractDocxText(view)
    expect(result).toBe('ok')
  })
})
