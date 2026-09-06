import { createHash } from 'crypto';
import { pdfParser } from '../document/pdf-parser.js';
import { chunkNotes } from '../document/notes-chunker.js';
import { embeddingService } from '../rag/embeddings.js';
import { qdrantStore } from '../rag/qdrant.js';

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
        data: { reused: true, unit: existing.unit, chunkCount: existing.chunkCount, sourceHash },
      });
    }

    const parsed = await pdfParser.parseBuffer(req.file.buffer);
    const chunks = chunkNotes(parsed.text);
    if (chunks.length === 0) {
      return res.status(422).json({ success: false, message: 'No readable text found in the notes file.' });
    }

    const embedded = await embeddingService.embedQuestions(chunks.map((c) => ({ text: c.text })));
    const withVectors = chunks.map((c, i) => ({ ...c, embedding: embedded.questions[i].embedding }));

    const result = await qdrantStore.upsertSyllabusChunks(withVectors, { class: cls, subject, unit, sourceHash });

    console.log(`[KB Controller] Indexed ${result.indexedCount} note chunk(s) for Class ${cls} / ${subject} / unit ${unit}.`);
    return res.status(200).json({
      success: true,
      message: `Indexed ${result.indexedCount} note chunk(s) for unit "${unit}".`,
      data: { ...result, extractionMethod: parsed.extractionMethod },
    });
  } catch (error) {
    console.error('[KB Controller] Notes upload error:', error);
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

export default { uploadNotes, listUnits };
