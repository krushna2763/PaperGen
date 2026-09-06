import { env } from '../config/env.js';

export const getHealth = (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'AI-Powered Agentic RAG Question Generator Backend is operational',
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
    config: {
      port: env.PORT,
      qdrantConfigured: Boolean(env.QDRANT_URL && env.QDRANT_API_KEY),
      geminiConfigured: Boolean(env.GEMINI_API_KEYS.length > 0),
      geminiFailoverPoolSize: env.GEMINI_API_KEYS.length,
      embeddingModel: env.EMBEDDING_MODEL,
      llmModel: env.GEMINI_MODEL,
      llmFallbackModels: env.GEMINI_FALLBACK_MODELS,
      cloudinaryConfigured: Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET),
      retrievalTopK: env.RETRIEVAL_TOP_K,
      similarityThreshold: env.SIMILARITY_THRESHOLD,
      maxRetries: env.MAX_RETRIES
    }
  });
};
