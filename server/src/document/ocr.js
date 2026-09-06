/**
 * OCR Module — free, local Tesseract fallback for scanned / image-only PDFs.
 *
 * Used ONLY when pdf-parse finds a page without enough embedded text:
 *
 *   PDF page ──render (pdf.js, ~200 DPI)──▶ page image ──Tesseract──▶ text
 *
 * The produced text is cleaned with the EXISTING text-cleaner and returned in
 * PDF page order, so the existing question extractor / embedding / Qdrant
 * pipeline is untouched. OCR is a FALLBACK: normal text PDFs never reach the
 * OCR path (no heavy renderer is even loaded for them).
 *
 * Page text sufficiency
 *   - A page is considered text-based when it has at least
 *     MIN_MEANINGFUL_CHARS_PER_PAGE letters/digits after cleaning.
 *     Headers, footers and page-number noise stay far below that bar, while a
 *     normal exam-paper page is typically 150+ characters.
 *   - Mixed PDFs (some text pages, some scanned pages) are supported: only the
 *     deficient pages are rendered and OCR'd; their text replaces the (empty)
 *     pdf-parse text for that page. Everything is reassembled in page order.
 *
 * Security
 *   - The Tesseract executable path comes ONLY from server config
 *     (env.TESSERACT_PATH, or a PATH lookup). No user input reaches argv.
 *   - child_process.spawn is used WITHOUT a shell and with a fixed argument
 *     list, so no arbitrary shell commands / arguments can be injected.
 *   - No temp files are created: page images are streamed to Tesseract over
 *     stdin and discarded immediately after each page.
 *
 * Errors
 *   - Missing/unusable Tesseract binary -> clear, non-technical error
 *     (OCR_UNAVAILABLE, status 500). No stack traces reach the client.
 *   - A failure on ONE page is logged and reported; remaining pages continue.
 */

import { spawn } from 'node:child_process';
import { env } from '../config/env.js';
import { textCleaner } from './text-cleaner.js';

// A cleaned page counts as "has real text" when it carries at least this many
// letters/digits. Obvious extraction artifacts (bars, whitespace, noise glyphs)
// contribute almost nothing to this count.
const MIN_MEANINGFUL_CHARS_PER_PAGE = 60;

// Render resolution for OCR (clamped; exam papers scan well at ~200-300 DPI).
const DEFAULT_OCR_DPI = 200;
const MIN_OCR_DPI = 120;
const MAX_OCR_DPI = 400;

// A single page rarely takes more than a couple of seconds; bound it anyway so
// a hung tesseract process can never stall the pipeline indefinitely.
const TESSERACT_TIMEOUT_MS = 120_000;

export const OCR_NOT_INSTALLED_MESSAGE =
  'OCR is required for this scanned PDF, but Tesseract OCR is not installed or configured. ' +
  'Install Tesseract OCR on the server or set TESSERACT_PATH in server/.env (see the README "OCR Support" section).';

/**
 * Count letters/digits in a string (the "meaningful" text measure).
 * Whitespace, punctuation, control chars and other artifacts are ignored.
 * @param {string|null|undefined} text
 * @returns {number}
 */
export function countMeaningfulChars(text) {
  if (!text) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      count++;
    }
  }
  return count;
}

/**
 * Does a (cleaned) page text carry enough real content that OCR is not needed?
 * @param {string|null|undefined} cleanedText
 * @param {number} [minChars] - override threshold (used by tests to force OCR)
 * @returns {boolean}
 */
export function hasSufficientText(cleanedText, minChars = MIN_MEANINGFUL_CHARS_PER_PAGE) {
  return countMeaningfulChars(cleanedText) >= minChars;
}

/**
 * Resolve the Tesseract binary: env.TESSERACT_PATH when set, otherwise the
 * plain command name so the OS PATH lookup applies.
 * @returns {string}
 */
function resolveTesseractBinary() {
  return env.TESSERACT_PATH || 'tesseract';
}

/**
 * Run tesseract with a fixed argv list, feeding an image buffer on stdin and
 * collecting stdout. Never uses a shell; never takes user-controlled args.
 * @param {string[]} args
 * @param {Buffer} input - image bytes (PNG) written to stdin
 * @param {number} timeoutMs
 * @returns {Promise<string>} tesseract stdout (the recognized text)
 */
function runTesseract(args, input, timeoutMs = TESSERACT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const binary = resolveTesseractBinary();
    let child;
    try {
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(wrapSpawnError(err));
      return;
    }

    let settled = false;
    const stdoutChunks = [];
    const stderrChunks = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error(`Tesseract timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (err) => settle(() => reject(wrapSpawnError(err))));
    child.on('close', (code) => {
      settle(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdoutChunks).toString('utf8'));
        } else {
          const tail = Buffer.concat(stderrChunks).toString('utf8').split('\n').filter(Boolean).slice(-3).join(' | ');
          reject(new Error(`Tesseract exited with code ${code}${tail ? `: ${tail}` : ''}.`));
        }
      });
    });

    // EPIPE is expected when the process dies before reading all of stdin.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function wrapSpawnError(err) {
  if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
    const error = new Error(OCR_NOT_INSTALLED_MESSAGE);
    error.status = 500;
    error.code = 'OCR_UNAVAILABLE';
    return error;
  }
  return err;
}

/**
 * Verify Tesseract is installed & runnable, returning its version for logs.
 * Throws the friendly OCR_UNAVAILABLE error otherwise.
 * @returns {Promise<string>} version line, e.g. "tesseract 5.5.0"
 */
async function verifyTesseract() {
  const stdout = await runTesseract(['--version'], Buffer.alloc(0), 30_000);
  const firstLine = String(stdout || '').split('\n')[0].trim() || 'unknown version';
  return firstLine;
}

/**
 * OCR a PDF that pdf-parse found text-deficient.
 *
 * @param {Buffer} pdfBuffer - Raw PDF bytes
 * @param {Array<string>} pageTexts - Cleaned pdf-parse text per page (index 0 = page 1).
 *   Pages with sufficient text are kept untouched; deficient pages are OCR'd.
 * @param {Object} [options] - { minChars?, dpi? } (both optional; used by tests)
 * @returns {Promise<{
 *   method: 'pdf-text'|'ocr',
 *   texts: string[],          // per-page text in PDF page order (index 0 = page 1)
 *   sources: ('pdf-text'|'ocr')[],
 *   ocrPageCount: number,     // pages that went through OCR
 *   ocrPagesSucceeded: number,
 *   ocrPagesErrored: number,
 *   charsExtracted: number,   // meaningful chars gained from OCR pages
 *   warnings: string[]
 * }>}
 */
export const ocrService = {
  async ocrPdfPages(pdfBuffer, pageTexts = [], options = {}) {
    const minChars = Number.isFinite(options.minChars) ? Math.max(0, options.minChars) : MIN_MEANINGFUL_CHARS_PER_PAGE;
    const dpi = clampInt(options.dpi ?? env.PDF_OCR_DPI ?? DEFAULT_OCR_DPI, MIN_OCR_DPI, MAX_OCR_DPI);
    const warnings = [];

    // ── Decide which pages genuinely need OCR ───────────────────────────────
    const needOcr = pageTexts.map((text) => !hasSufficientText(text, minChars));
    if (needOcr.every((needed) => !needed)) {
      // Normal text PDF: nothing to do — never load the renderer, never OCR.
      return {
        method: 'pdf-text',
        texts: pageTexts.slice(),
        sources: pageTexts.map(() => 'pdf-text'),
        ocrPageCount: 0,
        ocrPagesSucceeded: 0,
        ocrPagesErrored: 0,
        charsExtracted: 0,
        dpi,
        warnings,
      };
    }

    // ── Render deficient pages and OCR them sequentially (bounded memory) ───
    // pdf-to-img / pdf.js is lazy-loaded here so text PDFs never pay for it.
    const { pdf } = await import('pdf-to-img');

    const dataUrl = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
    const document = await pdf(dataUrl, { scale: dpi / 72 });

    try {
      // The renderer reports the authoritative page count. Re-align per-page
      // state: pages pdf-parse never texted are treated as scanned by default.
      const pageCount = document.length;
      const texts = new Array(pageCount);
      const sources = new Array(pageCount);
      const needsOcr = new Array(pageCount);
      for (let i = 0; i < pageCount; i++) {
        const parsed = pageTexts[i] ?? '';
        texts[i] = parsed;
        sources[i] = 'pdf-text'; // becomes 'ocr' only after OCR succeeds below
        needsOcr[i] = !hasSufficientText(parsed, minChars);
      }

      const ocrPages = needsOcr
        .map((needed, i) => (needed ? i + 1 : 0))
        .filter((n) => n > 0);

      if (ocrPages.length === 0) {
        return {
          method: 'pdf-text',
          texts,
          sources,
          ocrPageCount: 0,
          ocrPagesSucceeded: 0,
          ocrPagesErrored: 0,
          charsExtracted: 0,
          dpi,
          warnings,
        };
      }

      console.log(`[OCR] Starting OCR for ${ocrPages.length} page(s) at ${dpi} DPI...`);
      let version = '';
      try {
        version = await verifyTesseract();
        console.log(`[OCR] Tesseract ready: ${version}`);
      } catch (err) {
        console.error(`[OCR] ${err.message}`);
        throw err; // friendly OCR_UNAVAILABLE — no fake success, no partial claim
      }

      let succeeded = 0;
      let errored = 0;
      let charsExtracted = 0;

      for (const pageNumber of ocrPages) {
        console.log(`[OCR] Processing page ${pageNumber}/${pageCount}...`);
        try {
          const image = await document.getPage(pageNumber);
          const rawText = await runTesseract(['stdin', 'stdout', '-l', safeLang(env.TESSERACT_LANG), '--psm', '3'], image);
          const cleaned = textCleaner.clean(rawText);
          const meaningful = countMeaningfulChars(cleaned);

          if (meaningful > 0) {
            texts[pageNumber - 1] = cleaned;
            sources[pageNumber - 1] = 'ocr';
            charsExtracted += meaningful;
            succeeded++;
            console.log(`[OCR] Page ${pageNumber}/${pageCount}: extracted ${meaningful} meaningful character(s).`);
          } else {
            // OCR ran but produced nothing usable (blank / unreadable page).
            warnings.push(`Page ${pageNumber} produced no usable text via OCR.`);
            console.warn(`[OCR] Page ${pageNumber}/${pageCount}: OCR returned no usable text.`);
          }
        } catch (err) {
          errored++;
          warnings.push(`Page ${pageNumber} could not be OCR'd: ${err.message}`);
          console.warn(`[OCR] Page ${pageNumber}/${pageCount} failed: ${err.message}`);
        }
      }

      console.log(
        `[OCR] OCR completed: ${succeeded}/${ocrPages.length} page(s) OK, ${errored} error(s), ${charsExtracted} meaningful character(s) extracted.`
      );

      return {
        method: 'ocr',
        texts,
        sources,
        ocrPageCount: ocrPages.length,
        ocrPagesSucceeded: succeeded,
        ocrPagesErrored: errored,
        charsExtracted,
        dpi,
        warnings,
      };
    } finally {
      try {
        await document.destroy();
      } catch {
        // Best-effort resource release
      }
    }
  },
};

function safeLang(lang) {
  // Tesseract language tags are simple tokens like "eng", "eng+hin". Server
  // config only, but validate so a stray env value can never reach argv oddly.
  return /^[A-Za-z0-9_+-]{1,32}$/.test(String(lang || 'eng')) ? String(lang) : 'eng';
}

function clampInt(value, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export default ocrService;
