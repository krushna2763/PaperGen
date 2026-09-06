import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from server directory or root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config(); // fallback to current working dir .env

export const env = {
  PORT: process.env.PORT || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  CORS_ORIGIN: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:5173', 'http://localhost:3000'],
  
  // OCR (free local Tesseract fallback for scanned PDFs)
  // Absolute path to the tesseract executable, or leave empty to resolve via PATH.
  TESSERACT_PATH: (process.env.TESSERACT_PATH || '').trim(),
  TESSERACT_LANG: (process.env.TESSERACT_LANG || 'eng').trim() || 'eng',
  // PDF page render resolution for OCR (clamped to 120-400 inside the OCR module)
  PDF_OCR_DPI: parseInt(process.env.PDF_OCR_DPI || '200', 10),

  // Storage (Cloudinary)
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',

  // Qdrant Vector DB
  // SECURITY: default is the local instance. The previous default hardcoded a
  // real Qdrant Cloud cluster URL, which leaked via git history — the cluster's
  // credentials MUST be rotated; removing it here does not un-leak it.
  QDRANT_URL: process.env.QDRANT_URL || 'http://localhost:6333',
  QDRANT_API_KEY: process.env.QDRANT_API_KEY || '',
  QDRANT_COLLECTION: process.env.QDRANT_COLLECTION || 'exam_papers',

  // Google Gemini LLM & Embedding Config (with Failover pool)
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.LLM_API_KEY || '',
  GEMINI_API_KEY_BACKUP: process.env.GEMINI_API_KEY_BACKUP || '',
  GEMINI_API_KEY_BACKUP_2: process.env.GEMINI_API_KEY_BACKUP_2 || '',
  GEMINI_API_KEY_BACKUP_3: process.env.GEMINI_API_KEY_BACKUP_3 || '',
  GEMINI_API_KEYS: [
    process.env.GEMINI_API_KEY || process.env.LLM_API_KEY,
    process.env.GEMINI_API_KEY_BACKUP,
    process.env.GEMINI_API_KEY_BACKUP_2,
    process.env.GEMINI_API_KEY_BACKUP_3,
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY_6,
    process.env.GEMINI_API_KEY_7,
    process.env.GEMINI_API_KEY_8
  ].filter(key => Boolean(key && key.trim() !== '')),
  GEMINI_MODEL: process.env.GEMINI_MODEL || process.env.LLM_MODEL || 'gemini-1.5-flash',
  // Comma-separated LLM fallback models, tried in order AFTER every key in the
  // pool fails on the primary model. LLM-only (generateContent); embeddings are
  // deliberately excluded so vector dimensions stay stable.
  GEMINI_FALLBACK_MODELS: (process.env.GEMINI_FALLBACK_MODELS || process.env.LLM_FALLBACK_MODELS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'gemini-embedding-001',

  // Agent Tuning
  SIMILARITY_THRESHOLD: parseFloat(process.env.SIMILARITY_THRESHOLD || '0.85'),
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3', 10),

  // Controlled concurrency for parallel AI evaluation (rate-limit safe)
  AI_EVAL_CONCURRENCY: parseInt(process.env.AI_EVAL_CONCURRENCY || '3', 10),

  // Security hardening
  // Rate limiting tiers (requests per minute). The tight tier covers every
  // route that triggers paid Gemini calls (generate/analyze/notes ingest/embed);
  // the loose tier is a read/abuse backstop for everything else.
  RATE_LIMIT_AI_PER_MINUTE: parseInt(process.env.RATE_LIMIT_AI_PER_MINUTE || '6', 10),
  RATE_LIMIT_DEFAULT_PER_MINUTE: parseInt(process.env.RATE_LIMIT_DEFAULT_PER_MINUTE || '120', 10),
  // SSRF guard (see storage.service.js assertStorageFileUrl): fileUrl downloads
  // are restricted to Cloudinary delivery. With CLOUDINARY_CLOUD_NAME set, the
  // URL must also target that cloud's path, so unknown tenants are rejected.
  // Empty cloud name => fileUrl downloads are disabled entirely (fail closed).
  CLOUDINARY_HOST: process.env.CLOUDINARY_HOST || 'res.cloudinary.com',

  // Retrieval
  RETRIEVAL_TOP_K: parseInt(process.env.RETRIEVAL_TOP_K || '10', 10)
};
