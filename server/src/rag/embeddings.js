import { geminiClient } from '../services/gemini-client.service.js';
import { env } from '../config/env.js';

/**
 * Embeddings Module (RAG Layer)
 * Converts structured question objects into semantic embedding vectors via the
 * configured embedding provider (EMBEDDING_PROVIDER: openrouter | gemini).
 *
 * Philosophy: ONE QUESTION = ONE CHUNK = ONE EMBEDDING VECTOR = ONE FUTURE QDRANT POINT
 */
export const embeddingService = {
  /**
   * Generate an embedding vector for a single question text
   * @param {string|Object} questionInput - Question text or question object with .text property
   * @returns {Promise<{ text: string, vector: Array<number>, dimension: number }>}
   */
  async embedQuestion(questionInput) {
    const text = typeof questionInput === 'string' ? questionInput : questionInput?.text;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      const error = new Error('Question text cannot be empty or null for embedding generation.');
      error.status = 400;
      throw error;
    }

    try {
      const trimmedText = text.trim();
      const vector = await geminiClient.embedContent(trimmedText);

      if (!vector || !Array.isArray(vector) || vector.length === 0) {
        throw new Error('Embedding provider returned an empty or invalid vector.');
      }

      return {
        text: trimmedText,
        vector,
        dimension: vector.length
      };
    } catch (err) {
      console.error('[Embedding Service] Single question embedding failed:', err.message);
      const error = new Error(`Failed to generate embedding for question: ${err.message}`);
      error.status = err.status || 500;
      throw error;
    }
  },

  /**
   * Batch embed an array of structured question objects with TRUE multi-input
   * batching (ONE provider API call), preserving all metadata.
   * Each input is served from the in-memory embedding cache when available.
   *
   * @param {Array<Object>} questions - Array of question objects
   * @param {Object} [options={}] - { chunkSize } (Gemini legacy path ~100/call;
   *   ignored on the OpenRouter path, which takes the whole list in one call)
   * @returns {Promise<{ questions: Array<Object>, count: number, vectorDimension: number, embeddingModel: string }>}
   */
  async embedQuestions(questions, options = {}) {
    if (!questions || !Array.isArray(questions)) {
      const error = new Error('Invalid input: "questions" must be an array of question objects.');
      error.status = 400;
      throw error;
    }

    if (questions.length === 0) {
      return {
        questions: [],
        count: 0,
        vectorDimension: 0,
        embeddingModel: env.EMBEDDING_MODEL
      };
    }

    // Generated multi-part questions carry `fullText` (passage + stem +
    // sub-parts) so the vector captures the whole question, not a bare stem.
    const texts = questions.map((q) => (q.fullText || q.text || '').trim());
    const emptyIdx = texts.findIndex((t) => !t);
    if (emptyIdx !== -1) {
      const q = questions[emptyIdx];
      throw new Error(`Question at index ${emptyIdx + 1} (${q.questionNumber || 'Unknown'}) has empty text.`);
    }

    const t0 = Date.now();
    console.log(`[Embedding Service] Batch embedding ${questions.length} question(s) (model: ${env.EMBEDDING_MODEL})`);

    const vectors = await geminiClient.embedBatch(texts, { chunkSize: options.chunkSize });

    let detectedDimension = 0;
    const embeddedQuestions = questions.map((q, i) => {
      const vector = vectors[i];
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error(`Failed to obtain vector for question ${q.questionNumber || i + 1}.`);
      }
      if (!detectedDimension) detectedDimension = vector.length;
      return { ...q, embedding: vector };
    });

    console.log(`[Embedding Service] Embedded ${embeddedQuestions.length} question(s) → ${detectedDimension}-d in ${Date.now() - t0}ms`);

    return {
      questions: embeddedQuestions,
      count: embeddedQuestions.length,
      vectorDimension: detectedDimension,
      embeddingModel: env.EMBEDDING_MODEL
    };
  }
};

export default embeddingService;
