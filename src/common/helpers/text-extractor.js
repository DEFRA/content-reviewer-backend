import { createLogger } from './logging/logger.js'
import { textNormaliser } from './text-normaliser.js'
import { extractPdfWithLinks } from './pdf-text-extractor.js'
import { extractDocxText } from './docx-text-extractor.js'

const logger = createLogger()

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PDF_MIME = 'application/pdf'
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const LEGACY_DOC_MIME = 'application/msword'
const TEXT_PLAIN_MIME = 'text/plain'

// Default character count for text previews.
const DEFAULT_PREVIEW_LENGTH = 500

// ─────────────────────────────────────────────────────────────────────────────
// TextExtractor class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract structured plain text (with Markdown hyperlinks) from
 * PDF, DOCX and plain-text files.
 *
 * Hyperlink handling:
 *   • PDF  — pdfjs-dist annotation layer; links become [anchor](url)
 *   • DOCX — mammoth convertToMarkdown(); links already [anchor](url)
 *   • TXT  — raw text, no hyperlink extraction needed
 *
 * The output is passed to textNormaliser.normalise() which explicitly
 * preserves [anchor](url) tokens verbatim so URLs are never mangled.
 */
class TextExtractor {
  /**
   * Extract text (with embedded Markdown hyperlinks) from a file buffer.
   *
   * @param {Buffer} buffer   - File content
   * @param {string} mimeType - MIME type of the file
   * @param {string} [fileName='unknown']
   * @returns {Promise<string>} Normalised text with links as [anchor](url)
   */
  async extractText(buffer, mimeType, fileName = 'unknown') {
    logger.info({ fileName, mimeType }, 'Extracting text from file')

    try {
      const text = this.cleanText(
        await this.dispatchExtraction(buffer, mimeType)
      )

      logger.info(
        { extractedLength: text.length, fileName },
        'Text extraction completed'
      )

      if (!text || text.trim().length === 0) {
        throw new Error('No text content could be extracted from the file')
      }

      return text
    } catch (error) {
      logger.error(
        { error: error.message, mimeType, fileName },
        'Text extraction failed'
      )
      throw new Error(`Failed to extract text: ${error.message}`)
    }
  }

  /**
   * Dispatch to the right extractor based on MIME type.
   * @private
   */
  async dispatchExtraction(buffer, mimeType) {
    switch (mimeType) {
      case PDF_MIME:
        return this.extractFromPDF(buffer)
      case DOCX_MIME:
        return this.extractFromDocx(buffer)
      case LEGACY_DOC_MIME:
        throw new Error(
          'Legacy .doc format is not supported. Please use .docx format.'
        )
      case TEXT_PLAIN_MIME:
        return buffer.toString('utf-8')
      default:
        throw new Error(`Unsupported file type: ${mimeType}`)
    }
  }

  /**
   * Extract text from a PDF buffer.
   *
   * Delegates to pdf-text-extractor; returns block-structured output that the
   * normaliser flattens into Markdown-with-links.
   *
   * @param {Buffer} buffer
   * @returns {Promise<string>}
   */
  async extractFromPDF(buffer) {
    try {
      const text = await extractPdfWithLinks(buffer)
      logger.info(
        { extractedLength: text.length },
        'PDF text + hyperlinks extracted via pdfjs-dist'
      )
      return text
    } catch (error) {
      logger.error({ error: error.message }, 'PDF extraction failed')
      throw new Error(`Failed to extract text from PDF: ${error.message}`)
    }
  }

  /**
   * Extract text from a DOCX buffer. Delegates to docx-text-extractor.
   *
   * @param {Buffer} buffer
   * @returns {Promise<string>}
   */
  async extractFromDocx(buffer) {
    return extractDocxText(buffer)
  }

  /**
   * Normalise raw extracted text through the full TextNormaliser pipeline.
   *
   * TextNormaliser preserves [anchor](url) tokens verbatim — URLs are never
   * altered by whitespace collapse, dash substitution or quote substitution.
   *
   * @param {string} text
   * @returns {string}
   */
  cleanText(text) {
    if (!text) {
      return ''
    }
    return textNormaliser.normalise(text).normalisedText
  }

  /**
   * Get text preview (first N characters).
   * @param {string} text
   * @param {number} [maxLength=500]
   * @returns {string}
   */
  getPreview(text, maxLength = DEFAULT_PREVIEW_LENGTH) {
    if (!text || text.length <= maxLength) {
      return text
    }
    return `${text.substring(0, maxLength)}...`
  }

  /**
   * Count words in text.
   * @param {string} text
   * @returns {number}
   */
  countWords(text) {
    if (!text) {
      return 0
    }
    return text.trim().split(/\s+/).filter(Boolean).length
  }

  /**
   * Get text statistics.
   * @param {string} text
   * @returns {{ characters: number, words: number, lines: number, paragraphs: number }}
   */
  getStatistics(text) {
    if (!text) {
      return { characters: 0, words: 0, lines: 0, paragraphs: 0 }
    }
    return {
      characters: text.length,
      words: this.countWords(text),
      lines: text.split('\n').length,
      paragraphs: text.split(/\n\n+/).filter(Boolean).length
    }
  }
}

export const textExtractor = new TextExtractor()
