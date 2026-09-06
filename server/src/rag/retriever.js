import { qdrantStore } from './qdrant.js';
import { env } from '../config/env.js';

/**
 * Semantic Retriever (RAG Layer)
 *
 * Thin wrapper around the Qdrant store that turns raw vector-search hits
 * into readable academic-context objects for the agent layer.
 *
 * RULE 4: RAG retrieves context. RAG does NOT directly generate questions.
 */
export const retriever = {
  /**
   * Semantic search over indexed question points.
   * @param {Object} opts - { vector, filter: { corpus, unit, class, subject, sourceDocumentId }, topK }
   * @returns {Promise<Array<Object>>} Normalized hits without vector arrays
   */
  async search({ vector, filter = {}, topK = env.RETRIEVAL_TOP_K }) {
    if (!vector || !Array.isArray(vector) || vector.length === 0) {
      const error = new Error('A non-empty vector is required for retrieval.');
      error.status = 400;
      throw error;
    }

    const hits = await qdrantStore.searchVectors({ vector, filter, topK });

    return hits.map(hit => ({
      score: hit.score,
      questionNumber: hit.payload.questionNumber ?? null,
      parentQuestionNumber: hit.payload.parentQuestionNumber ?? null,
      section: hit.payload.section ?? null,
      type: hit.payload.type ?? null,
      text: hit.payload.text ?? '',
      marks: hit.payload.marks ?? null,
      sourceDocumentId: hit.payload.sourceDocumentId ?? null,
      pageNumber: hit.payload.pageNumber ?? null,
      class: hit.payload.class ?? null,
      subject: hit.payload.subject ?? null,
    }));
  },
};

export default retriever;