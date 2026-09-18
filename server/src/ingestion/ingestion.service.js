/**
 * ingestion.service.js — document ingestion with an ENGINE SWITCH (PARTS 26-28).
 *
 *   DOCUMENT_INGESTION_ENGINE=legacy  (default) → existing pdf-parser path.
 *   DOCUMENT_INGESTION_ENGINE=docling          → Docling worker + semantic
 *                                                parent/child chunker.
 *
 * GUARANTEES:
 *   - FALLBACK (PART 27): any Docling failure falls back to the legacy parser
 *     per document — the upload is never lost, generation never crashes, and
 *     the response records ingestionEngine='legacy-fallback' + the reason.
 *   - CACHING (PART 28): Docling conversion is cached by content SHA-256 on
 *     disk (server/data/docling-cache/); the same file is never re-converted.
 *   - CORPUS SEPARATION (PART 8): whatever the engine, notes chunks are always
 *     indexed into the SYLLABUS corpus with sourceType='syllabus_notes'.
 *     Reference papers never enter this path.
 *
 * Both engines end in the SAME embedding + Qdrant upsert contract, so
 * retrieval, grounding and generation are engine-agnostic.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'crypto';
import { env } from '../config/env.js';
import { pdfParser } from '../document/pdf-parser.js';
import { chunkNotes } from '../document/notes-chunker.js';
import { chunkStructuredDocument } from '../chunking/semantic-chunker.js';
import { embeddingService } from '../rag/embeddings.js';
import { qdrantStore } from '../rag/qdrant.js';
import { doclingHealth, doclingConvert } from './docling-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = () => process.env.DOCLING_CACHE_DIR
  || path.join(__dirname, '..', '..', 'data', 'docling-cache');

/** Load a cached structured document for this content hash (PART 28). */
function loadCachedDoc(sourceHash) {
  try {
    const f = path.join(CACHE_DIR(), `${sourceHash}.json`);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { /* corrupt cache → reconvert */ }
  return null;
}

function saveCachedDoc(sourceHash, doc) {
  try {
    fs.mkdirSync(CACHE_DIR(), { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR(), `${sourceHash}.json`), JSON.stringify(doc), 'utf8');
  } catch { /* cache write is best-effort */ }
}

/**
 * Read a cached Docling structured document by content hash (READ-ONLY).
 *
 * Used by the semantic image-grounding layer to find OPTIONAL notes-image
 * evidence through metadata association: the notes file's own conversion
 * (already cached by PART 28) carries its picture elements with page/bbox
 * metadata. No conversion is triggered here — a cache miss simply returns
 * null (notes images stay unsupported evidence, never a hard requirement).
 *
 * @param {string} sourceHash - the notes file's content SHA-256
 * @returns {Object|null} the StructuredDocument, or null when not cached
 */
export function loadStructuredDocByHash(sourceHash) {
  if (!sourceHash) return null;
  return loadCachedDoc(sourceHash);
}

/**
 * Convert a document through Docling WITH the PART-28 disk cache applied.
 *
 * The shared cache contract ("the same file is never re-converted") was
 * previously only enforced on the notes-ingestion path; the reference-paper
 * analyze path called doclingConvert directly, so every analyze re-converted
 * the same bytes and a cold worker could exceed DOCLING_TIMEOUT_MS. Both
 * callers now share this helper: cache HIT → no conversion, MISS → convert
 * once and persist. Cache failures stay best-effort (reconvert on next call).
 *
 * @param {Buffer} buffer - the PDF bytes (cache key = sha256 of the bytes)
 * @param {Object} [opts] - { filename, documentIdPrefix }
 * @returns {Promise<{ document: Object, meta: Object|null, sourceHash: string, cached: boolean }>} the structured document (from cache or freshly converted)
 */
export async function convertWithCache(buffer, { filename = 'upload.pdf', documentIdPrefix = 'doc' } = {}) {
  const sourceHash = createHash('sha256').update(buffer).digest('hex');
  const cached = loadCachedDoc(sourceHash);
  if (cached) {
    console.log(`[Ingestion] Docling cache HIT for hash ${sourceHash.slice(0, 12)}… (PART 28)`);
    return { document: cached, meta: null, sourceHash, cached: true };
  }
  await doclingHealth(); // worker must be up; failure propagates to the caller's fallback
  const out = await doclingConvert(buffer, { filename, documentId: `${documentIdPrefix}_${sourceHash.slice(0, 16)}` });
  saveCachedDoc(sourceHash, out.document);
  return { document: out.document, meta: out.meta, sourceHash, cached: false };
}

/**
 * Ingest notes for one (class, subject, unit) scope.
 * @param {Buffer} buffer
 * @param {Object} scope - { class, subject, unit, sourceHash, filename }
 * @returns {Promise<Object>} { engine, parentCount, childCount, chunkCount, … }
 */
export async function ingestNotes(buffer, scope = {}) {
  const cls = scope.class;
  const subject = scope.subject;
  const unit = scope.unit;
  const sourceHash = scope.sourceHash || createHash('sha256').update(buffer).digest('hex');
  const filename = scope.filename || 'upload.pdf';
  const engine = env.DOCUMENT_INGESTION_ENGINE === 'docling' ? 'docling' : 'legacy';

  // ── DOCLING PATH (feature-flagged; falls back per document on failure) ────
  if (engine === 'docling') {
    try {
      // Shared PART-28 cache contract (convertWithCache): cache HIT → no
      // conversion; MISS → convert once and persist. The scope's sourceHash
      // (when provided) is the SAME sha256-of-bytes key the helper computes.
      const converted = await convertWithCache(buffer, { filename, documentIdPrefix: 'doc' });
      const doc = converted.document;
      const conversionMeta = converted.meta;
      // converted.sourceHash is always sha256-of-bytes (the cache key); when a
      // scope-provided sourceHash exists it is the same value by construction
      // and the outer binding keeps prior behavior for the Qdrant upsert.

      const { parents, children } = chunkStructuredDocument(doc, { class: cls, subject, unit });
      if (children.length === 0) {
        throw new Error('docling produced no chunkable content');
      }

      // Embed children (retrieval units) AND parents (kept searchable so the
      // payloads stay complete; retrieval itself is child-first).
      const all = [...parents, ...children];
      const embedded = await embeddingService.embedQuestions(all.map((c) => ({ text: c.text })));
      const withVectors = all.map((c, i) => ({ ...c, embedding: embedded.questions[i].embedding }));

      const result = await qdrantStore.upsertSyllabusChunksV2(withVectors, {
        class: cls, subject, unit, sourceHash,
        sourceFilename: filename,
      });
      console.log(`[Ingestion] docling engine: ${result.indexedCount} chunk(s) for unit "${unit}" (conversion ${conversionMeta?.elapsedMs ?? 'cached'}ms)`);
      return {
        engine: 'docling',
        parentCount: result.parentCount,
        childCount: result.childCount,
        chunkCount: result.indexedCount,
        indexedCount: result.indexedCount,
        unit,
        sourceHash,
        doclingVersion: doc.doclingVersion,
        pageCount: doc.pageCount,
        elementCount: (doc.elements || []).length,
      };
    } catch (err) {
      // PART 27 — safe fallback. The upload is NOT lost.
      console.error(`[Ingestion] Docling failed (${err.message}) — falling back to legacy parser for this document.`);
      const legacy = await ingestLegacy(buffer, { cls, subject, unit, sourceHash, filename });
      return {
        ...legacy,
        engine: 'legacy-fallback',
        fallbackReason: `${err?.name || 'Error'}: ${err?.message || err}`,
      };
    }
  }

  // ── LEGACY PATH (default, unchanged behavior) ──────────────────────────────
  return ingestLegacy(buffer, { cls, subject, unit, sourceHash, filename });
}

/** The existing ingestion path — unchanged behavior, shared by the fallback. */
async function ingestLegacy(buffer, { cls, subject, unit, sourceHash, filename = 'upload.pdf' }) {
  const parsed = await pdfParser.parseBuffer(buffer);
  const chunks = chunkNotes(parsed.text);
  if (chunks.length === 0) {
    const error = new Error('No readable text found in the notes file.');
    error.status = 422;
    throw error;
  }
  const embedded = await embeddingService.embedQuestions(chunks.map((c) => ({ text: c.text })));
  const withVectors = chunks.map((c, i) => ({ ...c, embedding: embedded.questions[i].embedding }));
  const result = await qdrantStore.upsertSyllabusChunks(withVectors, {
    class: cls, subject, unit, sourceHash,
    sourceFilename: filename,
  });
  console.log(`[Ingestion] legacy engine: ${result.indexedCount} chunk(s) for unit "${unit}"`);
  return {
    engine: 'legacy',
    parentCount: 0,
    childCount: result.indexedCount,
    chunkCount: result.indexedCount,
    indexedCount: result.indexedCount,
    unit,
    sourceHash,
    extractionMethod: parsed.extractionMethod,
  };
}

export default { ingestNotes };

