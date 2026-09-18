import { createHash } from 'crypto';
import { pdfParser as _pdfParser } from '../document/pdf-parser.js';
import { chunkNotes as _chunkNotes } from '../document/notes-chunker.js';
import { embeddingService as _embeddingService } from '../rag/embeddings.js';
import { qdrantStore } from '../rag/qdrant.js';
import { checkTopicCoverage } from '../rag/topic-coverage.js';
import { ingestNotes } from '../ingestion/ingestion.service.js';


/**
 * Knowledge-base (syllabus corpus) controller.
 *
 * Notes belong to a (class, subject, unit) — NOT to a paper. Unit 1 notes are
 * uploaded once and reused by every future paper covering Unit 1. The unit tag
 * is an explicit parameter and is never auto-detected from the file.
 */

/** POST /api/kb/notes  (multipart: file + class + subject + unit) */
export const uploadNotes = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded. Provide a PDF under the field "file".' });
    }
    const cls = String(req.body.class ?? '').trim();
    const subject = String(req.body.subject ?? '').trim();
    const unit = String(req.body.unit ?? '').trim();
    if (!cls) return res.status(400).json({ success: false, message: '"class" is required.' });
    if (!subject) return res.status(400).json({ success: false, message: '"subject" is required.' });
    if (!unit) {
      return res.status(400).json({
        success: false,
        message: '"unit" is required — notes are tagged to an explicit unit, never auto-detected from the file.',
      });
    }

    // Source reuse: identical file already indexed FOR THIS class+subject+unit
    // is not re-ingested. The same PDF under a different subject/unit is a new
    // filing and IS ingested (embeddings come from cache, so it is cheap).
    const sourceHash = createHash('sha256').update(req.file.buffer).digest('hex');
    const existing = await qdrantStore.findSyllabusByHash(sourceHash, { class: cls, subject, unit });
    if (existing.indexed) {
      console.log(`[KB Controller] Notes already indexed (hash ${sourceHash.slice(0, 12)}…) — skipping.`);
      return res.status(200).json({
        success: true,
        message: 'These notes are already indexed — ingestion skipped.',
        data: {
          reused: true,
          unit: existing.unit,
          chunkCount: existing.chunkCount,
          sourceHash,
          documentId: sourceHash,
        },
      });
    }

    // ENGINE SWITCH (PART 26): DOCUMENT_INGESTION_ENGINE=legacy (default) keeps
    // the exact current behavior; =docling routes through the isolated Docling
    // worker + semantic parent/child chunker with safe legacy fallback (PART 27)
    // and content-hash conversion caching (PART 28). Both engines end in the
    // same syllabus-corpus upsert contract (PART 8: notes are NEVER reference
    // papers, whatever engine ran).
    const result = await ingestNotes(req.file.buffer, {
      class: cls,
      subject,
      unit,
      sourceHash,
      filename: req.file.originalname,
    });

    console.log(`[KB Controller] Indexed ${result.indexedCount} note chunk(s) for Class ${cls} / ${subject} / unit ${unit} (engine=${result.engine}).`);
    return res.status(200).json({
      success: true,
      message: `Indexed ${result.chunkCount} note chunk(s) for unit "${unit}" (engine=${result.engine}).`,
      data: {
        ...result,
        sourceHash: result.sourceHash || sourceHash,
        documentId: result.sourceHash || sourceHash,
        ingestionEngine: result.engine,
        fallbackReason: result.fallbackReason ?? null,
      },
    });
  } catch (error) {
    console.error('[KB Controller] Notes upload error:', error);
    next(error);
  }
};


/**
 * GET /api/kb/documents?class=&subject=  ->  note documents for the scope.
 *
 * Mode B "Select from Knowledge Base": the ingested notes files (grouped from
 * the ONE syllabus corpus by sourceHash), each with title, class, subject,
 * units and chunk counts. A read-time view — no document store, no duplication.
 */
export const listDocuments = async (req, res, next) => {
  try {
    const cls = String(req.query.class ?? '').trim();
    const subject = String(req.query.subject ?? '').trim();
    if (!cls || !subject) {
      return res.status(400).json({ success: false, message: '"class" and "subject" query params are required.' });
    }
    const documents = await qdrantStore.listSyllabusDocuments({ class: cls, subject });
    return res.status(200).json({ success: true, data: documents });
  } catch (error) {
    console.error('[KB Controller] listDocuments error:', error);
    next(error);
  }
};

/** GET /api/kb/units?class=&subject=  ->  [{ id, label, chunkCount }] for units WITH notes */
export const listUnits = async (req, res, next) => {
  try {
    const cls = String(req.query.class ?? '').trim();
    const subject = String(req.query.subject ?? '').trim();
    if (!cls || !subject) {
      return res.status(400).json({ success: false, message: '"class" and "subject" query params are required.' });
    }
    const units = await qdrantStore.listUnitsWithNotes({ class: cls, subject });
    return res.status(200).json({ success: true, data: units });
  } catch (error) {
    console.error('[KB Controller] listUnits error:', error);
    next(error);
  }
};

/**
 * GET /api/kb/topics?class=&subject=&unit=  ->  [{ topic, chunkCount }]
 *
 * Mode B topic anchoring: the chapters detected in ONE unit's notes (heading
 * detection over the syllabus chunks, grouped like listUnitsWithNotes).
 * Suggestions only — the client renders them as combobox options; the teacher
 * can always type a topic of their own (checked via /kb/topics/coverage).
 */
export const listTopics = async (req, res, next) => {
  try {
    const cls = String(req.query.class ?? '').trim();
    const subject = String(req.query.subject ?? '').trim();
    const unit = String(req.query.unit ?? '').trim();
    if (!cls || !subject || !unit) {
      return res.status(400).json({ success: false, message: '"class", "subject" and "unit" query params are required.' });
    }
    const topics = await qdrantStore.listTopicsWithNotes({ class: cls, subject, unit });
    return res.status(200).json({ success: true, data: topics });
  } catch (error) {
    console.error('[KB Controller] listTopics error:', error);
    next(error);
  }
};

/**
 * GET /api/kb/topics/coverage?class=&subject=&unit=&topic=  ->
 *   { matched, chunkCount, topScore, unit }
 *
 * Coverage check for a TYPED topic (free text in the combobox): embeds it and
 * searches that unit's syllabus corpus — reusing the ONE shared coverage
 * mechanism (rag/topic-coverage.js), also used for server-side warnings.
 * An unmatched topic is a warning to surface inline, NEVER a block.
 */
export const topicCoverage = async (req, res, next) => {
  try {
    const cls = String(req.query.class ?? '').trim();
    const subject = String(req.query.subject ?? '').trim();
    const unit = String(req.query.unit ?? '').trim();
    const topic = String(req.query.topic ?? '').trim();
    if (!cls || !subject || !unit || !topic) {
      return res.status(400).json({ success: false, message: '"class", "subject", "unit" and "topic" query params are required.' });
    }
    const coverage = await checkTopicCoverage({ topic, class: cls, subject, unit });
    return res.status(200).json({ success: true, data: coverage });
  } catch (error) {
    console.error('[KB Controller] topicCoverage error:', error);
    next(error);
  }
};

/**
 * GET /api/kb/notes/images?class=&subject=&unit=&sourceHash=&topic=&search=&imageType=&page=&limit=
 *
 * Mode B Image Based questions: discovers image-bearing topics and extracted
 * picture assets from the notes explicitly selected for the paper.
 */
export const listNotesImages = async (req, res, next) => {
  try {
    const { getNotesImagesAndTopics } = await import('../services/notes-image.service.js');
    const sourceHash = String(req.query.sourceHash || req.query.sourceHashes || '').trim();
    if (!sourceHash) {
      // Source isolation: No notes selected for this paper -> strictly NO images or topics
      return res.status(200).json({
        success: true,
        data: { topics: [], images: [], totalImages: 0, page: 1, totalPages: 0 },
      });
    }
    const result = await getNotesImagesAndTopics({
      class: req.query.class,
      subject: req.query.subject,
      unit: req.query.unit,
      sourceHash,
      topic: req.query.topic,
      search: req.query.search,
      imageType: req.query.imageType,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('[KB Controller] listNotesImages error:', error);
    next(error);
  }
};

export default { uploadNotes, listDocuments, listUnits, listTopics, topicCoverage, listNotesImages };
