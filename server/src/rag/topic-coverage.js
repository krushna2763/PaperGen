/**
 * topic-coverage.js — the ONE coverage-check mechanism (task §2).
 *
 * Answers "does the indexed syllabus corpus contain material for this topic?"
 * by reusing the existing retrieval stack: one embedding via the shared Gemini
 * client, one filtered Qdrant search via the existing retriever. Used by:
 *   - GET /api/kb/topics/coverage  (inline combobox feedback in the client)
 *   - attachTopicCoverage() in manual-blueprint.js (blocking-free warnings)
 *
 * An unmatched topic is a WARNING, never a block — the teacher may know
 * something the notes do not cover.
 */
import { geminiClient } from '../services/gemini-client.service.js';
import { retriever } from './retriever.js';

/**
 * @param {Object} args
 * @param {string} args.topic - free-text topic
 * @param {string} args.class
 * @param {string} args.subject
 * @param {string} [args.unit] - when given, the search is restricted to that
 *   unit's notes; when absent, the whole class+subject syllabus corpus.
 * @param {number} [args.minScore] - score floor for a "matched" verdict.
 * @returns {Promise<{ matched: boolean, chunkCount: number, topScore: number|null, unit: string|null }>}
 */
export async function checkTopicCoverage({ topic, class: cls, subject, unit = null, minScore = 0.45 }) {
  const text = String(topic ?? '').trim();
  if (!text) {
    return { matched: false, chunkCount: 0, topScore: null, unit: unit ?? null };
  }

  const vector = await geminiClient.embedContent(`Class ${cls} ${subject}: ${text}`);
  const filter = {
    corpus: 'syllabus',
    class: String(cls ?? ''),
    subject: String(subject ?? ''),
    ...(unit != null && String(unit).trim() !== '' ? { unit: String(unit) } : {}),
  };
  const hits = await retriever.search({ vector, topK: 8, filter });

  const scored = hits.filter((h) => Number.isFinite(Number(h.score)));
  const topScore = scored.length > 0 ? Math.max(...scored.map((h) => Number(h.score))) : null;
  const matched = scored.filter((h) => Number(h.score) >= minScore);

  return {
    matched: matched.length > 0,
    chunkCount: matched.length,
    topScore,
    unit: unit ?? null,
  };
}

export default { checkTopicCoverage };
