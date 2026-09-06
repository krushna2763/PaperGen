import { createRequire } from 'module';
import { textCleaner } from './text-cleaner.js';
import { ocrService, countMeaningfulChars } from './ocr.js';

const require = createRequire(import.meta.url);
const pdfModule = require('pdf-parse');

/**
 * PDF Parser Document Module
 * Extracts text and metadata from PDF buffers using PDFParse
 */
export const pdfParser = {
  /**
   * Parse a PDF buffer and return structured extracted text & metadata
   * @param {Buffer} pdfBuffer - Raw PDF buffer
   * @param {Object} _options - Reserved for optional parser settings (currently unused)
   * @returns {Promise<Object>} Structured extraction result
   */
  async parseBuffer(pdfBuffer, _options = {}) {
    if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
      const error = new Error('Invalid PDF buffer provided for extraction.');
      error.status = 400;
      throw error;
    }

    if (pdfBuffer.length === 0) {
      const error = new Error('Cannot parse an empty PDF file.');
      error.status = 400;
      throw error;
    }

    // Verify PDF header signature (%PDF-)
    const pdfHeader = pdfBuffer.slice(0, 5).toString('ascii');
    if (!pdfHeader.startsWith('%PDF-')) {
      const error = new Error('The provided file does not appear to be a valid PDF format.');
      error.status = 400;
      throw error;
    }

    let parser = null;
    try {
      // PDFParse expects Uint8Array binary data
      const uint8Data = new Uint8Array(pdfBuffer);
      
      const PDFParseClass = pdfModule.PDFParse || pdfModule;
      if (typeof PDFParseClass !== 'function') {
        throw new Error('PDF parser engine initialization failed.');
      }

      parser = new PDFParseClass(uint8Data);

      // Extract text and page data
      const textResult = await parser.getText();
      const rawText = textResult?.text || '';
      const cleanedText = textCleaner.clean(rawText);
      const pageCount = textResult?.total || (textResult?.pages ? textResult.pages.length : 1);

      // Per-page cleaned text aligned to PDF page numbers (1..pageCount)
      const parsedPages = textResult?.pages || [];
      const rawTextByPage = new Map();
      parsedPages.forEach((p, idx) => {
        const num = Number.isInteger(p?.num) ? p.num : idx + 1;
        rawTextByPage.set(num, String(p?.text || ''));
      });
      const perPageCleaned = [];
      for (let n = 1; n <= pageCount; n++) {
        perPageCleaned.push(textCleaner.clean(rawTextByPage.get(n) ?? ''));
      }

      // OCR fallback: pages whose embedded text is not meaningful are rendered
      // to images and recognized with free, local Tesseract. Normal text PDFs
      // skip OCR entirely and keep the exact legacy text assembly below.
      const ocrResult = await ocrService.ocrPdfPages(pdfBuffer, perPageCleaned);
      const extractionMethod = ocrResult.method; // 'pdf-text' | 'ocr'

      let finalText;
      let pages;
      let extractionStatus;
      const ocr = extractionMethod === 'ocr'
        ? {
            pages: ocrResult.ocrPageCount,
            pagesSucceeded: ocrResult.ocrPagesSucceeded,
            pagesErrored: ocrResult.ocrPagesErrored,
            charsExtracted: ocrResult.charsExtracted,
            dpi: ocrResult.dpi,
          }
        : undefined;

      if (extractionMethod === 'pdf-text') {
        // Unchanged pre-OCR behaviour: whole-document clean + per-page texts.
        finalText = cleanedText;
        pages = perPageCleaned.map((text, i) => ({ pageNumber: i + 1, text }));
      } else {
        // Reassemble page text in strict PDF page order. OCR replaces only the
        // pages that lacked text; every other page keeps its pdf-parse text.
        finalText = textCleaner.clean(ocrResult.texts.join('\n\n'));
        pages = ocrResult.texts.map((text, i) => ({
          pageNumber: i + 1,
          text,
          source: ocrResult.sources[i],
        }));
      }

      const characterCount = finalText.length;
      const meaningfulChars = countMeaningfulChars(finalText);

      if (extractionMethod === 'pdf-text') {
        extractionStatus = meaningfulChars > 0 ? 'TEXT_FOUND' : 'NO_TEXT';
      } else if (meaningfulChars > 0) {
        extractionStatus = 'OCR_USED';
      } else if (ocrResult.ocrPagesErrored > 0) {
        extractionStatus = 'OCR_FAILED';
      } else {
        extractionStatus = 'NO_TEXT';
      }

      if (extractionMethod === 'ocr') {
        console.log(
          `[PDF Parser] OCR fallback used: ${ocr.pages} page(s) OCR'd, ${ocr.pagesSucceeded} OK, ` +
          `${ocr.pagesErrored} error(s), ${ocr.charsExtracted} chars extracted → status ${extractionStatus}`
        );
      }

      // Extract PDF info metadata if available
      let infoData = null;
      try {
        if (typeof parser.getInfo === 'function') {
          const info = await parser.getInfo();
          infoData = {
            formatVersion: info?.info?.PDFFormatVersion || '1.4',
            title: info?.info?.Title || null,
            author: info?.info?.Author || null
          };
        }
      } catch {
        // Non-critical info retrieval failure
      }

      const warnings = ocrResult.warnings.length > 0 ? ocrResult.warnings : undefined;

      return {
        text: finalText,
        pages: pages.length > 0 ? pages : [{ pageNumber: 1, text: finalText }],
        pageCount,
        characterCount,
        extractionStatus,
        extractionMethod,
        pdfInfo: infoData,
        ...(ocr ? { ocr } : {}),
        ...(warnings ? { warnings } : {}),
      };
    } catch (err) {
      // Errors that already carry a friendly status (e.g. OCR_UNAVAILABLE when
      // Tesseract is missing) pass through untouched so the clear message
      // reaches the client without a stack trace.
      if (err && (err.status || err.code === 'OCR_UNAVAILABLE')) throw err;
      console.error('[PDF Parser] Parsing error:', err.message);
      const error = new Error(`Failed to parse PDF document: ${err.message}`);
      error.status = 422;
      throw error;
    } finally {
      if (parser && typeof parser.destroy === 'function') {
        try {
          await parser.destroy();
        } catch {
          // Ignore destroy errors
        }
      }
    }
  }
};

export default pdfParser;
