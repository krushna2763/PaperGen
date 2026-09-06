import { retriever } from '../rag/retriever.js';
import { env } from '../config/env.js';
import { cosineSimilarity, roundTo } from './agent-utils.js';

/**
 * Similarity / Duplicate Agent (Module 10)
 *
 * Prevents generated questions from being too similar to:
 *   A. previous-paper questions (SOURCE similarity)
 *   B. other generated questions in the same batch (PEER similarity)
 *
 * Performance: similarity NEVER calls the LLM and NEVER calls the embedding
 * API itself — it works on embeddings that were already produced in one batch
 * by the embedding stage. All comparisons are cosine similarity (local math)
 * plus Qdrant vector search (already embedded vectors).
 *
 * Semantic similarity ≠ automatic rejection: two questions can share a concept
 * and still be legitimately different. The configurable SIMILARITY_THRESHOLD
 * (default 0.85) is the first line of defense against COPY / TRIVIAL PARAPHRASE.
 */
export const similarityAgent = {
  /**
   * A. SOURCE similarity: compare a generated question (via its pre-computed
   *    embedding) against the indexed previous-paper questions on Qdrant.
   *
   * @param {Object} question - { questionId, text, ... }
   * @param {Array<number>} vector - Pre-computed embedding (from batch embed stage)
   * @param {Object} [opts] - { filter, topK }
   * @returns {Promise<{ isDuplicate: boolean, maxSimilarity: number, threshold: number, matchedQuestion: string|null }>}
   */
  async checkAgainstSource(question, vector, opts = {}) {
    const { filter = {}, topK = 5 } = opts;
    const threshold = env.SIMILARITY_THRESHOLD;

    const hits = await retriever.search({ vector, filter, topK });

    const best = hits[0] ?? null;
    const maxSimilarity = best ? roundTo(best.score) : 0;

    const isDuplicate = best !== null && best.score >= threshold;

    if (isDuplicate) {
      console.warn(`[Similarity Agent] Question "${question.questionId}" too similar to source "${best.questionNumber}" (${roundTo(best.score)} >= ${threshold}).`);
    }

    return {
      isDuplicate,
      maxSimilarity,
      threshold,
      matchedQuestion: best?.questionNumber ?? null,
    };
  },

  /**
   * B. PEER similarity — in-memory, using embeddings already attached to the
   *    question objects (entry.question.embedding). No Gemini calls.
   *
   * Semantics preserved:
   *   - First-round originals (entry.attempts === 0): pairwise within the
   *     batch; first-accepted-wins — the later question is flagged.
   *   - Regenerated entries (entry.attempts > 0): compared only against the
   *     accepted questions' vectors (acceptedVectors), never re-evaluating
   *     questions whose state has not changed.
   *
   * @param {Array<{ question: { questionId, embedding }, attempts: number }>} entries
   * @param {Object} [opts] - { acceptedVectors: Record<questionId, number[]> }
   * @returns {Map<string, { isDuplicate: boolean, maxSimilarity: number, threshold: number, matchedWith: string|null }>}
   *   Map keyed by duplicate questionId (absent entries are not duplicates)
   */
  findPeerDuplicates(entries, opts = {}) {
    const { acceptedVectors = {} } = opts;
    const threshold = env.SIMILARITY_THRESHOLD;
    const result = new Map();

    const originals = entries.filter(e => e.attempts === 0 && Array.isArray(e.question?.embedding));
    for (let i = 0; i < originals.length; i++) {
      for (let j = i + 1; j < originals.length; j++) {
        const sim = cosineSimilarity(originals[i].question.embedding, originals[j].question.embedding);
        if (sim >= threshold) {
          const dupId = originals[j].question.questionId;
          const previous = result.get(dupId);
          if (!previous || sim > previous.maxSimilarity) {
            result.set(dupId, {
              isDuplicate: true,
              maxSimilarity: roundTo(sim),
              threshold,
              matchedWith: originals[i].question.questionId,
            });
          }
        }
      }
    }

    for (const entry of entries) {
      if (entry.attempts > 0 && Array.isArray(entry.question?.embedding)) {
        const q = entry.question;
        let maxSim = 0;
        let matched = null;
        for (const [acceptedId, acceptedVector] of Object.entries(acceptedVectors)) {
          const sim = cosineSimilarity(q.embedding, acceptedVector);
          if (sim > maxSim) {
            maxSim = sim;
            matched = acceptedId;
          }
        }
        if (maxSim >= threshold) {
          result.set(q.questionId, { isDuplicate: true, maxSimilarity: roundTo(maxSim), threshold, matchedWith: matched });
        }
      }
    }

    return result;
  },
};

export default similarityAgent;