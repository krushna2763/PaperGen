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
  // ── Embedding provider ──────────────────────────────────────────────────
  // 'openrouter' = OpenAI-compatible POST /embeddings against OpenRouter
  //                (default: nvidia/llama-nemotron-embed-vl-1b-v2:free, 2048-d,
  //                uses the SAME OpenRouter key pool as the LLM leg).
  // 'gemini'     = legacy Gemini embedding API (gemini-embedding-001, 3072-d).
  // The two produce different-dimension vectors: switching providers requires
  // re-indexing (a fresh Qdrant collection) or Qdrant refuses the upserts.
  EMBEDDING_PROVIDER: (process.env.EMBEDDING_PROVIDER || 'openrouter').trim().toLowerCase(),
  OPENROUTER_EMBEDDING_MODEL: (process.env.OPENROUTER_EMBEDDING_MODEL || 'nvidia/llama-nemotron-embed-vl-1b-v2:free').trim(),
  // Legacy var name kept for the Gemini path; the EMBEDDING_MODEL getter below
  // always reports the ACTIVE provider's model so health/controller/log output
  // stays truthful.
  GEMINI_EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'gemini-embedding-001',
  get EMBEDDING_MODEL() {
    return this.EMBEDDING_PROVIDER === 'gemini'
      ? this.GEMINI_EMBEDDING_MODEL
      : this.OPENROUTER_EMBEDDING_MODEL;
  },

  // Groq — LAST-RESORT LLM fallback for generateContent only (never embeddings).
  // Used when every Gemini key + every Gemini fallback model has failed with a
  // temporary error. OpenAI-compatible chat API. Comma-separated keys.
  // NOTE: EMBEDDING_PROVIDER controls the embedding leg — see its block above.
  // ── Multi-provider AI layer (services/ai/) ────────────────────────────────
  // One `generate()` interface over Apinex → Token Harbor → xKiro → Groq →
  // OpenRouter. Order is env-configurable; keys are server-side only; when
  // AI_FREE_ONLY is true a provider whose model is not a verified FREE model
  // is skipped (never a silent paid request). Gemini is NOT in the default
  // chain — it stays registered but is only ever called if someone explicitly
  // configures keys.
  AI_PRIMARY_PROVIDER: (process.env.AI_PRIMARY_PROVIDER || 'apinex').trim().toLowerCase(),
  AI_FALLBACK_PROVIDERS: (process.env.AI_FALLBACK_PROVIDERS || 'tokenharbor,xkiro,groq,openrouter')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  AI_FREE_ONLY: !/^(0|false|no)$/i.test(process.env.AI_FREE_ONLY ?? 'true'),

  // Vision route — ordered comma list, FIRST available entry is primary and
  // the rest are failover (e.g. "apinex,tokenharbor,gemini"). A single name
  // keeps the legacy behavior.
  AI_VISION_PROVIDER: (process.env.AI_VISION_PROVIDER || 'apinex').trim().toLowerCase(),
  AI_VISION_PROVIDERS: (process.env.AI_VISION_PROVIDERS || process.env.AI_VISION_PROVIDER || 'apinex,tokenharbor')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  // Apinex — OpenAI-compatible (PRIMARY text LLM + PRIMARY vision provider;
  // verified: text + vision on free/deepseek-v4.1-flash).
  APINEX_API_KEYS: (process.env.APINEX_API_KEYS || process.env.APINEX_API_KEY || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  APINEX_MODEL: (process.env.APINEX_MODEL || 'free/deepseek-v4.1-flash').trim(),
  APINEX_VISION_MODEL: (process.env.APINEX_VISION_MODEL || 'free/deepseek-v4.1-flash').trim(),
  APINEX_BASE_URL: (process.env.APINEX_BASE_URL || 'https://api.apinex.bond/v1').trim(),

  // Token Harbor — OpenAI-compatible (FALLBACK text + vision). Text model and
  // vision model are separate ids on one endpoint.
  TOKENHARBOR_API_KEYS: (process.env.TOKENHARBOR_API_KEYS || process.env.TOKENHARBOR_API_KEY || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  TOKENHARBOR_MODEL: (process.env.TOKENHARBOR_MODEL || 'deepseek-v4.1-flash:free').trim(),
  TOKENHARBOR_VISION_MODEL: (process.env.TOKENHARBOR_VISION_MODEL || 'mimo-v2.5:free').trim(),
  TOKENHARBOR_BASE_URL: (process.env.TOKENHARBOR_BASE_URL || 'https://tokenharbor.ai/v1').trim(),

  // xKiro — OpenAI-compatible. Accepts GROQ-style single key or a comma list.
  XKIRO_API_KEYS: (process.env.XKIRO_API_KEYS || process.env.XKIRO_API_KEY || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  XKIRO_MODEL: (process.env.XKIRO_MODEL || 'qwen/qwen3.8-max:free').trim(),
  XKIRO_VISION_MODEL: (process.env.XKIRO_VISION_MODEL || process.env.XKIRO_MODEL || 'deepseek/deepseek-v4.1-flash:free').trim(),
  XKIRO_BASE_URL: (process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1').trim(),

  // OpenRouter — OpenAI-compatible.
  OPENROUTER_API_KEYS: (process.env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEY || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  OPENROUTER_MODEL: (process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra:free').trim(),
  OPENROUTER_BASE_URL: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').trim(),

  // Groq — keep the existing integration (GROQ_API_KEYS list OR GROQ_API_KEY).
  GROQ_API_KEYS: (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  GROQ_MODEL: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',

  // Agent Tuning
  SIMILARITY_THRESHOLD: parseFloat(process.env.SIMILARITY_THRESHOLD || '0.85'),
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3', 10),
  // LAYER 2 structural repair (answer-validator.js missing-required-field
  // cases only) — a SEPARATE, small, bounded budget from MAX_RETRIES. Never
  // increased to compensate for content-quality/novelty/vision failures.
  STRUCTURAL_REPAIR_MAX_ATTEMPTS: parseInt(process.env.STRUCTURAL_REPAIR_MAX_ATTEMPTS || '1', 10),

  // Controlled concurrency for parallel AI evaluation (rate-limit safe)
  AI_EVAL_CONCURRENCY: parseInt(process.env.AI_EVAL_CONCURRENCY || '3', 10),

  // Explicit output-token budget for question-GENERATION calls. Multi-candidate
  // calls (initial multi-slot batch, 3-candidate regeneration pool) emit ~3k
  // completion tokens PER candidate (stem + subParts + answers + marking
  // schemes); without an explicit cap, OpenAI-compatible providers apply their
  // own smaller default (e.g. 8192) and truncate the JSON mid-question. 16384
  // covers a 3-candidate pool with answers plus headroom. Override with
  // AI_GENERATION_MAX_OUTPUT_TOKENS if a provider rejects it.
  AI_GENERATION_MAX_OUTPUT_TOKENS: parseInt(process.env.AI_GENERATION_MAX_OUTPUT_TOKENS || '16384', 10),

  // Security hardening
  // Rate limiting tiers (requests per minute). The tight tier covers every
  // route that triggers paid Gemini calls (generate/analyze/notes ingest/embed);
  // the loose tier is a read/abuse backstop for everything else.
  RATE_LIMIT_AI_PER_MINUTE: parseInt(process.env.RATE_LIMIT_AI_PER_MINUTE || '6', 10),
  RATE_LIMIT_DEFAULT_PER_MINUTE: parseInt(process.env.RATE_LIMIT_DEFAULT_PER_MINUTE || '120', 10),
  // Rate-limit window length. Default 60s; lower it (e.g. 20000) so a client
  // that hits the ceiling recovers faster. The `*_PER_MINUTE` counts are the
  // budget PER THIS WINDOW.
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  // SSRF guard (see storage.service.js assertStorageFileUrl): fileUrl downloads
  // are restricted to Cloudinary delivery. With CLOUDINARY_CLOUD_NAME set, the
  // URL must also target that cloud's path, so unknown tenants are rejected.
  // Empty cloud name => fileUrl downloads are disabled entirely (fail closed).
  CLOUDINARY_HOST: process.env.CLOUDINARY_HOST || 'res.cloudinary.com',

  // Retrieval
  RETRIEVAL_TOP_K: parseInt(process.env.RETRIEVAL_TOP_K || '10', 10),

  MIN_EVIDENCE_COVERAGE: parseFloat(process.env.MIN_EVIDENCE_COVERAGE || '0.5'),
  MIN_EVIDENCE_TERMS: parseInt(process.env.MIN_EVIDENCE_TERMS || '2', 10),

  // ── Phase 4 — Agentic Retrieval strategy ladder ────────────────────────────
  // Maximum deterministic retrieval-strategy rungs tried per task (CONCEPT →
  // TOPIC+UNIT → UNIT FALLBACK) before accepting the best-so-far evidence.
  // Independent of MAX_RETRIES — never touches slotAttempts/generation retry
  // budget; this only bounds how many Qdrant searches ONE retrieval task may
  // issue while looking for sufficient academic evidence.
  RETRIEVAL_MAX_STRATEGY_ATTEMPTS: parseInt(process.env.RETRIEVAL_MAX_STRATEGY_ATTEMPTS || '3', 10),

  // ── Ingestion engine switch (PART 26) ──────────────────────────────────────
  // 'legacy'  = existing pdf-parser + notes-chunker path (default, unchanged).
  // 'docling' = isolated Python Docling worker → structured doc → semantic
  //             chunker. Falls back to legacy per-document on worker failure.
  DOCUMENT_INGESTION_ENGINE: (process.env.DOCUMENT_INGESTION_ENGINE || 'legacy').trim().toLowerCase(),
  DOCLING_SERVICE_URL: (process.env.DOCLING_SERVICE_URL || 'http://127.0.0.1:8100').trim(),
  DOCLING_TIMEOUT_MS: parseInt(process.env.DOCLING_TIMEOUT_MS || '180000', 10),

  // ── Retrieval mode switch (PART 26) ────────────────────────────────────────
  // 'legacy' = dense-only Qdrant retrieval (current behavior, unchanged).
  // 'hybrid' = dense + BM25 → RRF fusion → rerank → compress (new path).
  RETRIEVAL_MODE: (process.env.RETRIEVAL_MODE || 'legacy').trim().toLowerCase(),

  // ── Question planner (PHASE 9) ── opt-in planning layer ───────────────────
  // When false the pipeline is byte-identical to pre-Phase-9 behavior
  // (no plans are built, no plan blocks enter any prompt).
  // When true: retrieval → QuestionPlan (deterministic) → validate → generate.
  QUESTION_PLANNER_ENABLED: String(process.env.QUESTION_PLANNER_ENABLED || 'false').trim().toLowerCase() === 'true',

  // ── Phase 10 — Multi-candidate generation + ranking ────────────────────────
  // OFF by default: the initial generation pass stays single-candidate-per-slot,
  // byte-identical to pre-Phase-10 behavior. ON: generateNode pools 3
  // independent candidates per slot in ONE batch call and ranks them with the
  // same deterministic pre-screen candidate-selector.js already uses for
  // regeneration — never a second competing validation system. On any pool
  // failure (bad JSON, schema violation, etc.) generateNode falls back to the
  // existing single-candidate generate() call, matching this codebase's
  // fallback-on-failure convention everywhere else (docling->legacy,
  // embedding provider, model failover).
  MULTI_CANDIDATE_ENABLED: String(process.env.MULTI_CANDIDATE_ENABLED || 'false').trim().toLowerCase() === 'true',

  // ── Semantic image grounding (image → topic/concepts → notes evidence) ────
  // OFF by default: IMAGE_BASED slots behave exactly as before (byte-identical
  // pipeline). ON: ONE vision call per reference image extracts topic/concepts
  // + visual relationships; the SAME topic/concepts are matched in the notes
  // through the existing retrieval stack (hybrid/graph); notes TEXT is the
  // primary academic grounding; notes images ride along as OPTIONAL supporting
  // metadata (no image-to-image similarity, no extra vision calls). The
  // grounding object feeds the planner/generators/validators/ranking and adds
  // a deterministic image-grounding fidelity gate for IMAGE_BASED candidates.
  IMAGE_GROUNDING_ENABLED: String(process.env.IMAGE_GROUNDING_ENABLED || 'true').trim().toLowerCase() === 'true',
  // Reject a candidate whose content never engages the grounded image
  // topic/concepts (deterministic check). Validation-layer gates remain the
  // final authority; this is the cheap, always-on complement.
  IMAGE_GROUNDING_FIDELITY_ENFORCED: String(process.env.IMAGE_GROUNDING_FIDELITY_ENFORCED || 'true').trim().toLowerCase() === 'true',
  // Minimum imageGroundingConfidence for the grounding to be handed to the
  // planner/generator as REQUIRED evidence. Below it the grounding is still
  // produced (and reported honestly) but only as best-effort context.
  IMAGE_GROUNDING_MIN_CONFIDENCE: parseFloat(process.env.IMAGE_GROUNDING_MIN_CONFIDENCE || '0.25'),

  // ── Semantic chunking (PART 6) — structure boundaries take priority ───────
  CHUNK_MIN_TOKENS: parseInt(process.env.CHUNK_MIN_TOKENS || '60', 10),
  CHUNK_MAX_TOKENS: parseInt(process.env.CHUNK_MAX_TOKENS || '350', 10),
  CHUNK_OVERLAP_TOKENS: parseInt(process.env.CHUNK_OVERLAP_TOKENS || '40', 10),

  // ── Hybrid retrieval tuning (PARTS 10/11/12/15/16) ────────────────────────
  // RRF constant k (larger = flatter fusion; standard 60).
  RETRIEVAL_RRF_K: parseInt(process.env.RETRIEVAL_RRF_K || '60', 10),
  // Candidate pool size after fusion, before reranking.
  RETRIEVAL_FUSION_POOL: parseInt(process.env.RETRIEVAL_FUSION_POOL || '20', 10),
  // Final context chunks sent to Gemini after reranking (PART 16: 3–5).
  RETRIEVAL_CONTEXT_CHUNKS: parseInt(process.env.RETRIEVAL_CONTEXT_CHUNKS || '5', 10),
  // Token budget for the compressed grounding context.
  RETRIEVAL_CONTEXT_BUDGET_TOKENS: parseInt(process.env.RETRIEVAL_CONTEXT_BUDGET_TOKENS || '900', 10),
  // Per-leg retrieval depth for dense and BM25 before fusion.
  RETRIEVAL_HYBRID_TOP_K: parseInt(process.env.RETRIEVAL_HYBRID_TOP_K || '10', 10),

  // ── Question-intent retrieval (PARTS 13/14) ────────────────────────────────
  // When true (default in hybrid mode), slot/item retrieval queries are built
  // from the QUESTION INTENT (type/topic/concept/cognitive operation) instead
  // of the raw reference wording. Legacy mode always keeps the raw query.
  RETRIEVAL_INTENT_QUERIES: process.env.RETRIEVAL_INTENT_QUERIES !== 'false',

  // ── Reference-novelty gate (PARTS 15/16/17) ────────────────────────────────
  // Deterministic per-item check that the generated stem is not an exact copy,
  // near-paraphrase, or same-information-demand rephrasing of its positional
  // reference item. Mode-independent (runs regardless of RETRIEVAL_MODE — see
  // orchestrator.agent.js). Undefined unless a deployer explicitly sets these
  // — reference-novelty.agent.js's own per-QUESTION-TYPE defaults apply
  // otherwise (a short MCQ/fill-blank stem and a multi-clause LONG_ANSWER
  // essay prompt need different overlap floors; see TYPE_NOVELTY_THRESHOLDS).
  REFERENCE_NOVELTY_STEM_OVERLAP_PARAPHRASE: process.env.REFERENCE_NOVELTY_STEM_OVERLAP_PARAPHRASE != null
    ? parseFloat(process.env.REFERENCE_NOVELTY_STEM_OVERLAP_PARAPHRASE) : undefined,
  REFERENCE_NOVELTY_STEM_OVERLAP_DEMAND: process.env.REFERENCE_NOVELTY_STEM_OVERLAP_DEMAND != null
    ? parseFloat(process.env.REFERENCE_NOVELTY_STEM_OVERLAP_DEMAND) : undefined,
  // The embedding backstop (orchestrator.agent.js) compares a generated
  // sub-part's vector against its OWN reference item's vector — a different,
  // stricter concern than SIMILARITY_THRESHOLD (0.85, untouched), which
  // compares against a corpus of OTHER papers for source/peer duplication.
  // A higher bar here (only lexically-novel content ever reaches this check —
  // anything demand-matched + high-overlap already failed the lexical gate)
  // avoids rejecting a genuinely demand-shifted question purely because it
  // shares topic vocabulary with its own reference.
  REFERENCE_NOVELTY_EMBEDDING_THRESHOLD: parseFloat(process.env.REFERENCE_NOVELTY_EMBEDDING_THRESHOLD || '0.93'),
};

