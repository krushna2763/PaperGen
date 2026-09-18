import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env.js';
import { embeddingCache } from './embedding-cache.js';
import { bumpAi } from './perf-context.js';
import { openRouterEmbeddingClient } from './openrouter-embedding.client.js';

/**
 * Centralized Gemini client with TWO bounded failover layers:
 *
 *   1. KEY failover   — the existing 8-key pool (unchanged behavior)
 *   2. MODEL failover — LLM-only: when every key fails on the primary model
 *                       with a TEMPORARY error (503/429/500/timeout/network),
 *                       the next model in GEMINI_FALLBACK_MODELS is tried.
 *
 * Order of attempts (models outer, keys inner):
 *   MODEL 1 → Key 1..Key N  (rotate immediately on temporary failure)
 *   MODEL 2 → Key 1..Key N  (after one short bounded delay)
 *   ...stop on first success.
 *
 * Hard bounds: models × keys attempts, max, and every call races a 90 s
 * timeout. The Gemini SDK's own retries stay disabled (maxRetries: 0) — all
 * retry/failover decisions live here.
 *
 * Request-scoped errors abort immediately: 400 invalid request and 404
 * unknown model fail identically on every key, so there is no pointless
 * 8-key storm. 401/403 auth errors are KEY-scoped — one dead key in the pool
 * rotates to the next key; only when EVERY key reports auth do we fail fast
 * with a clear authentication error (and skip model fallback, since a bad
 * key fails the same on every model).
 */

const DEFAULT_TIMEOUT_MS = 90000;   // per-call timeout (unchanged from before)
const MODEL_SWITCH_DELAY_MS = 1200; // short bounded pause before trying the next model (never minutes)

/**
 * Turn image asset records into Gemini inlineData parts. Accepts either a
 * bare base64/data-URI string or the asset-record shape this codebase uses
 * everywhere (blueprint imageAssets, asset-associator output): `dataUri`,
 * with `data`/`base64` kept only for back-compat callers. An asset with no
 * pixel data is dropped rather than sent as an empty inlineData part — never
 * fabricate image bytes that were not actually extracted.
 * @param {Array<string|Object>} images
 * @returns {Array<{ inlineData: { mimeType: string, data: string } }>}
 */
export function buildImageParts(images) {
  return (Array.isArray(images) ? images : []).map((img) => {
    const raw = typeof img === 'string' ? img : (img.dataUri || img.data || img.base64 || '');
    const data = String(raw || '').replace(/^data:image\/[a-z]+;base64,/, '');
    const mimeType = (typeof img === 'object' && img.mimeType) || 'image/png';
    return { inlineData: { mimeType, data } };
  }).filter((part) => Boolean(part.inlineData.data));
}

/**
 * Classify a Gemini SDK error into a category + whether it is eligible for
 * key/model failover.
 * @param {Error} error
 * @returns {{ category: string, temporary: boolean, status: number }}
 */
export function classifyGeminiError(error) {
  const status = Number(error?.status) || Number(error?.response?.status) || 0;
  const lower = String(error?.message || '').toLowerCase();

  if (status === 400) return { category: 'invalid_request', temporary: false, status };
  if (status === 401 || status === 403) return { category: 'auth', temporary: false, status };
  if (status === 404 || /(is not found|not found for api|model .* not found)/i.test(lower)) {
    return { category: 'model_not_found', temporary: false, status: status || 404 };
  }
  if (status === 408) return { category: 'timeout', temporary: true, status };
  if (status === 429) return { category: 'rate_limit', temporary: true, status };
  if (status === 500) return { category: 'server_error', temporary: true, status };
  if (status === 503) return { category: 'overload', temporary: true, status };
  if (/timed out|timeout|deadline exceeded|aborted/i.test(lower)) return { category: 'timeout', temporary: true, status };
  if (/fetch failed|network|econnreset|econnrefused|socket hang up|enotfound|unreachable|und_err/i.test(lower)) {
    return { category: 'network', temporary: true, status };
  }
  if (/429|quota|rate limit|resource exhausted|too many requests/i.test(lower)) return { category: 'rate_limit', temporary: true, status };
  if (/503|overloaded|overload|unavailable|high demand|service busy/i.test(lower)) return { category: 'overload', temporary: true, status };
  if (/api ?key|invalid key|permission|unauthorized|forbidden|401|403/i.test(lower)) return { category: 'auth', temporary: false, status };
  // Unclassifiable: stay conservative and bounded — fail over, the loops are
  // capped and each attempt is fast or timeout-limited anyway.
  return { category: 'unknown', temporary: true, status };
}

export class GeminiFailoverClient {
  /**
   * @param {Object} [opts] - test seam: inject keys / starting rotation index
   */
  constructor(opts = {}) {
    // Never fabricate a key slot: with the whole Gemini pool removed (e.g. a
    // deploy that only uses OpenRouter), keys stays EMPTY and availability
    // checks report "not configured" instead of attempting a bogus call.
    this.keys = opts.keys && opts.keys.length > 0
      ? opts.keys
      : env.GEMINI_API_KEYS.length > 0
        ? env.GEMINI_API_KEYS
        : (env.GEMINI_API_KEY ? [env.GEMINI_API_KEY] : []);
    this.currentKeyIndex = opts.startKeyIndex ?? 0;
    console.log(`[Gemini Client] Initialized with ${this.keys.length} API key(s) in the failover pool.`);
  }

  /**
   * Execute an operation with bounded key + model failover.
   *
   * @param {Function} operation - Async callback receiving (genAIClient, keyIndex, modelName)
   * @param {Object} [opts] - { models?: string[], timeoutMs?: number, modelSwitchDelayMs?: number }
   * @returns {Promise<any>}
   */
  async executeWithFailover(operation, opts = {}) {
    if (!this.keys || this.keys.length === 0) {
      throw new Error('No Gemini API keys configured in environment.');
    }

    const models = Array.isArray(opts.models) && opts.models.length > 0 ? opts.models : [env.GEMINI_MODEL];
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const modelSwitchDelayMs = opts.modelSwitchDelayMs ?? MODEL_SWITCH_DELAY_MS;
    const aiKey = opts.aiKey;               // 'geminiRequests' | 'embeddingRequests'
    const embeddingInputs = opts.embeddingInputs ?? 0; // texts embedded per attempt
    const startedAt = Date.now();

    const failures = []; // every failed attempt (bounded: models × keys)
    const permanent = []; // request-level failures (abort-worthy: 400/404)
    let attemptNumber = 0;

    for (let m = 0; m < models.length; m++) {
      const modelName = models[m];
      let sawPermanent = null;
      let authOnModel = 0; // keys that failed with 401/403 on THIS model

      for (let k = 0; k < this.keys.length; k++) {
        const keyIndex = (this.currentKeyIndex + k) % this.keys.length;
        const genAI = new GoogleGenerativeAI(this.keys[keyIndex]);
        const label = `Gemini request (${modelName}, Key #${keyIndex + 1})`;
        attemptNumber++;

        try {
          const result = await withTimeout(operation(genAI, keyIndex, modelName), timeoutMs, label);
          console.log(`[Gemini] model=${modelName} keyIndex=${keyIndex} success elapsedMs=${Date.now() - startedAt}`);
          if (attemptNumber > 1) bumpAi('failoverAttempts');
          if (aiKey) bumpAi(aiKey);
          if (embeddingInputs > 0) bumpAi('embeddingInputs', embeddingInputs);
          // Advance the persistent rotation cursor so the next call starts on a
          // different key (spreads load across the pool over time).
          this.currentKeyIndex = (keyIndex + 1) % this.keys.length;
          return result;
        } catch (error) {
          if (attemptNumber > 1) bumpAi('failoverAttempts');
          const cls = classifyGeminiError(error);
          failures.push({ model: modelName, keyIndex, category: cls.category, status: cls.status, message: error.message });
          console.warn(`[Gemini] model=${modelName} keyIndex=${keyIndex} failed status=${cls.status || 'n/a'} category=${cls.category}: ${error.message}`);

          if (cls.category === 'invalid_request' || cls.category === 'model_not_found') {
            // 400/404 — the same request fails identically on every key and
            // model; fail immediately instead of a pointless retry storm.
            sawPermanent = { category: cls.category, status: cls.status, message: error.message };
            permanent.push({ model: modelName, keyIndex, category: cls.category, status: cls.status, message: error.message });
            break;
          }
          if (cls.category === 'auth') {
            // 401/403 are KEY-scoped, not request-scoped: one dead key in the
            // pool (e.g. deleted service account) must rotate to the next key
            // instead of failing the whole request. Only when EVERY key on the
            // model reports auth do we report it clearly (see below).
            authOnModel++;
            console.log(`[Gemini] auth failure on keyIndex=${keyIndex} → rotating key`);
            continue;
          }
          // temporary failure → rotate key immediately (inner loop continues)
          console.log(`[Gemini] temporary failure → rotating key`);
        }
      }

      if (sawPermanent) {
        throw buildAggregateError(models, this.keys.length, failures, permanent, startedAt, true);
      }

      if (authOnModel === this.keys.length) {
        // Every key on this model failed with 401/403 → clear auth error.
        // Do NOT try fallback models: a dead/banned key fails identically on
        // every model, so model fallback would only add a pointless storm.
        const perm = { category: 'auth', status: failures[0]?.status || 401, message: failures[0]?.message || 'API key rejected' };
        permanent.push(perm);
        throw buildAggregateError(models, this.keys.length, failures, permanent, startedAt, true);
      }

      console.warn(`[Gemini] model=${modelName} exhausted after ${this.keys.length} key(s)`);

      if (m < models.length - 1) {
        const next = models[m + 1];
        console.log(`[Gemini] switching to fallback model "${next}" in ${modelSwitchDelayMs}ms`);
        await sleep(modelSwitchDelayMs);
      }
    }

    throw buildAggregateError(models, this.keys.length, failures, permanent, startedAt, false);
  }

  /**
   * Embed a single text with key failover ONLY — the embedding model is never
   * swapped (vector dimension stability + Qdrant collection integrity).
   * Served from the in-memory cache when possible (zero API calls).
   *
   * Provider dispatch: EMBEDDING_PROVIDER routes the embedding leg to OpenRouter
   * (nvidia/llama-nemotron-embed-vl-1b-v2:free, 2048-d) or legacy Gemini. The
   * rest of the app only ever calls embedContent/embedBatch — provider details
   * stay behind this seam, so caller and test mocks are unaffected.
   */
  async embedContent(text) {
    if (env.EMBEDDING_PROVIDER === 'openrouter') {
      return openRouterEmbeddingClient.embedContent(text);
    }
    const model = env.EMBEDDING_MODEL;
    const cached = embeddingCache.get(text, model);
    if (cached) return cached;

    const vector = await this.executeWithFailover(async (genAI, keyIndex, modelName) => {
      const modelObj = genAI.getGenerativeModel({ model: modelName });
      // maxRetries: 0 — the SDK's internal backoff on 429/5xx would stall for
      // minutes; we want fast failures so the multi-key failover pool rotates
      const response = await modelObj.embedContent(text, { maxRetries: 0 });
      return response.embedding.values;
    }, { models: [model], aiKey: 'embeddingRequests', embeddingInputs: 1 });

    embeddingCache.set(text, model, vector);
    return vector;
  }

  /**
   * TRUE multi-input batch embedding: ONE batchEmbedContents API call for up
   * to `chunkSize` texts (the embedding API supports up to 100 inputs per
   * request). Key failover applies; the model is never swapped. Each input is
   * cache-checked first, so repeated texts add no API calls.
   *
   * Provider dispatch: under EMBEDDING_PROVIDER=openrouter the whole list goes
   * to openRouterEmbeddingClient in ONE /embeddings call (it has no ~100/call
   * cap; chunkSize is ignored). `opts` stays accepted so callers are unchanged.
   *
   * @param {string[]} texts - Non-empty list of texts
   * @param {Object} [opts] - { chunkSize?: number }
   * @returns {Promise<number[][]>} vectors in input order
   */
  async embedBatch(texts, opts = {}) {
    if (env.EMBEDDING_PROVIDER === 'openrouter') {
      return openRouterEmbeddingClient.embedBatch(texts);
    }
    const chunkSize = opts.chunkSize ?? 100;
    const model = env.EMBEDDING_MODEL;
    const vectors = [];
    const misses = []; // indexes needing an API call

    texts.forEach((text, i) => {
      const cached = embeddingCache.get(text, model);
      if (cached) vectors[i] = cached;
      else misses.push(i);
    });

    for (let start = 0; start < misses.length; start += chunkSize) {
      const chunkIdx = misses.slice(start, start + chunkSize);
      const chunkTexts = chunkIdx.map((i) => texts[i]);

      const chunkVectors = await this.executeWithFailover(async (genAI, keyIndex, modelName) => {
        const modelObj = genAI.getGenerativeModel({ model: modelName });
        const response = await modelObj.batchEmbedContents(
          { requests: chunkTexts.map((t) => ({ content: { role: 'user', parts: [{ text: t }] } })) },
          { maxRetries: 0 }
        );
        return (response.embeddings || []).map((e) => e.values);
      }, { models: [model], aiKey: 'embeddingRequests', embeddingInputs: chunkTexts.length });

      chunkVectors.forEach((v, j) => {
        const i = chunkIdx[j];
        vectors[i] = v;
        if (Array.isArray(v) && v.length > 0) embeddingCache.set(texts[i], model, v);
      });
    }

    return vectors;
  }

  /**
   * RAW Gemini generation — key + model failover only. This is the Gemini leg
   * of the multi-provider chain (services/ai/); the AI router's geminiProvider
   * calls this directly so `generateContent()` can delegate to the router
   * without recursing back into itself.
   */
  async generateRaw(prompt, generationConfig = {}) {
    const models = [env.GEMINI_MODEL, ...env.GEMINI_FALLBACK_MODELS];
    const imageParts = buildImageParts(generationConfig.images);

    const contentPayload = imageParts.length > 0 ? [prompt, ...imageParts] : prompt;

    return this.executeWithFailover(async (genAI, keyIndex, modelName) => {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: generationConfig.temperature,
          maxOutputTokens: generationConfig.maxOutputTokens,
          responseMimeType: generationConfig.responseMimeType,
          ...(generationConfig.responseSchema ? { responseSchema: generationConfig.responseSchema } : {}),
        },
      });
      const response = await model.generateContent(contentPayload, { maxRetries: 0 });
      return response.response.text();
    }, { models, aiKey: 'geminiRequests' });
  }

  /**
   * The app's LLM entry point (all agents call this). Routes through the
   * multi-provider chain Token Harbor → xKiro → Groq → OpenRouter
   * (services/ai/ai-router.service.js); FREE-only + fallback rules live there.
   * Signature is unchanged so every existing caller and test mock still works.
   * NOTE: Gemini is NOT in this chain (and never used for vision). This method
   * only forwards to the router — it makes no Gemini API calls itself.
   */
  async generateContent(prompt, generationConfig = {}) {
    const { aiRouter } = await import('./ai/ai-router.service.js');
    return aiRouter.generate({
      prompt,
      temperature: generationConfig.temperature,
      maxTokens: generationConfig.maxOutputTokens,
      responseFormat: generationConfig.responseMimeType === 'application/json' ? 'json' : 'text',
      responseSchema: generationConfig.responseSchema,
      ...(Array.isArray(generationConfig.images) && generationConfig.images.length > 0 ? { images: generationConfig.images } : {}),
    });
  }
}

/**
 * Build the final aggregated error. The user-facing message never contains
 * keys, credentials or raw secrets; diagnostics live on error.details for
 * server-side debugging only.
 */
function buildAggregateError(models, keyCount, failures, permanent, startedAt, hasPermanent) {
  const elapsedMs = Date.now() - startedAt;
  const categories = [...new Set(failures.map(f => f.category))];
  const perm = permanent[0];

  const error = new Error(
    hasPermanent
      ? `Gemini request rejected (${perm?.category || 'invalid_request'}): ${perm?.message || 'invalid request'}`
      : 'Gemini service is temporarily unavailable after trying the configured models. Please try again shortly.'
  );
  error.status = hasPermanent
    ? perm?.status && perm.status >= 400 && perm.status < 500 ? perm.status : 400
    : 503;
  error.code = 'GEMINI_FAILOVER_EXHAUSTED';
  error.details = {
    modelsAttempted: models,
    keysAttempted: keyCount,
    totalAttempts: failures.length,
    failureCategories: categories,
    finalError: perm?.message || failures[failures.length - 1]?.message || null,
    elapsedMs,
  };
  return error;
}

export const geminiClient = new GeminiFailoverClient();
export default geminiClient;

/**
 * Race a promise against a timeout.
 * @param {Promise<any>} promise
 * @param {number} ms - Timeout in milliseconds
 * @param {string} label - For the error message
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}