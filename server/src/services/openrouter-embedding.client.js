/**
 * openrouter-embedding.client.js
 *
 * OpenAI-compatible /embeddings client for OpenRouter, used for ALL question/
 * syllabus/retrieval embeddings when EMBEDDING_PROVIDER=openrouter.
 *
 *   POST {OPENROUTER_BASE_URL}/embeddings
 *   { model: "nvidia/llama-nemotron-embed-vl-1b-v2:free", input: ["...", ...] }
 *   → { data: [{ embedding: [...] }, ...] }
 *
 * Mirrors the guarantees of the Gemini embedding leg:
 *   - key rotation across OPENROUTER_API_KEYS (round-robin cursor)
 *   - in-memory embedding cache (same cache, model name is part of the key)
 *   - perf counters via bumpAi('embeddingRequests' / 'embeddingInputs')
 *   - bounded: 60 s timeout per attempt, every key tried once
 *   - the model is NEVER swapped at runtime (Qdrant dimension stability)
 *
 * nvidia/llama-nemotron-embed-vl-1b-v2 outputs 2048-d vectors (vs 3072-d for
 * gemini-embedding-001). The Qdrant collection dimension is DETECTED from the
 * first vector (ensureCollection), but an existing 3072-d collection will
 * refuse 2048-d points — re-index or point QDRANT_COLLECTION at a fresh name.
 */
import { env } from '../config/env.js';
import { embeddingCache } from './embedding-cache.js';
import { bumpAi } from './perf-context.js';

const TIMEOUT_MS = 60000;
// Free-tier embeddings have tight rate limits and NO fallback provider (vector
// dimensions must stay stable), so transient failures get a small bounded
// backoff per key before rotating: ≤ 3 attempts × N keys, always time-boxed.
const RETRY_DELAYS_MS = [1500, 5000];

/** True for transient conditions worth retrying on the next key. */
function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

class OpenRouterEmbeddingClient {
  constructor() {
    this.cursor = 0;
    // Instance property so tests can shorten the waits (prod uses the const).
    this.retryDelays = RETRY_DELAYS_MS;
  }

  get keys() {
    return env.OPENROUTER_API_KEYS.filter(Boolean);
  }

  get available() {
    return this.keys.length > 0 && !!env.OPENROUTER_EMBEDDING_MODEL && !!env.OPENROUTER_BASE_URL;
  }

  /**
   * Embed an array of texts in one API call (OpenAI-compatible batch).
   * Single texts are routed through here with a one-element array so caching,
   * counters and failover live in exactly one place.
   *
   * @param {string[]} texts - non-empty strings
   * @returns {Promise<number[][]>} vectors in input order
   */
  async embedBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const model = env.OPENROUTER_EMBEDDING_MODEL;
    const keys = this.keys;
    if (keys.length === 0) {
      throw new Error('[OpenRouter Embeddings] No OPENROUTER_API_KEY configured.');
    }

    // Cache first — deterministic models make repeated texts free.
    const vectors = new Array(texts.length);
    const misses = [];
    texts.forEach((text, i) => {
      const cached = embeddingCache.get(text, model);
      if (cached) vectors[i] = cached;
      else misses.push(i);
    });
    if (misses.length === 0) return vectors;

    const baseUrl = String(env.OPENROUTER_BASE_URL || '').replace(/\/+$/, '');

    const failures = [];
    for (let n = 0; n < keys.length; n++) {
      const idx = (this.cursor + n) % keys.length;

      for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
        if (attempt > 0) {
          const delay = this.retryDelays[Math.min(attempt - 1, this.retryDelays.length - 1)];
          await new Promise((r) => setTimeout(r, delay));
        }
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

        let res;
        try {
          res = await fetch(`${baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${keys[idx]}`,
              'HTTP-Referer': 'https://papergen.local',
              'X-Title': 'PaperGen AI',
            },
            body: JSON.stringify({
              model,
              input: misses.map((i) => texts[i]),
            }),
            signal: ac.signal,
          });
        } catch (err) {
          clearTimeout(timer);
          failures.push(`key#${idx + 1}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
          continue; // network / timeout → retry, then next key
        }
        clearTimeout(timer);

        if (isRetryableStatus(res.status)) {
          failures.push(`key#${idx + 1}: HTTP ${res.status}`);
          continue; // rate-limit / server error → retry, then next key
        }

        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = j?.error?.message || j?.message || `HTTP ${res.status}`;
          if (res.status === 401 || res.status === 403) {
            failures.push(`key#${idx + 1}: ${msg}`);
            break; // bad key → skip straight to the next key
          }
          // 400/404/422 are request- or model-shaped — identical on every key.
          throw new Error(`[OpenRouter Embeddings] rejected the request: ${msg}`);
        }

        const rows = Array.isArray(j?.data) ? j.data : null;
        if (!rows || rows.length !== misses.length) {
          throw new Error(
            `[OpenRouter Embeddings] expected ${misses.length} vector(s), got ${rows ? rows.length : 'none'}.`
          );
        }

        // Sort by index so out-of-order providers cannot scramble vector order.
        const sorted = rows.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        sorted.forEach((row, j2) => {
          const vec = row?.embedding;
          if (!Array.isArray(vec) || vec.length === 0) {
            throw new Error('[OpenRouter Embeddings] provider returned an empty vector.');
          }
          const i = misses[j2];
          vectors[i] = vec;
          embeddingCache.set(texts[i], model, vec);
        });

        bumpAi('embeddingRequests', 1);
        bumpAi('embeddingInputs', misses.length);

        this.cursor = (idx + 1) % keys.length;
        return vectors;
      }
    }

    throw new Error(
      `[OpenRouter Embeddings] all ${keys.length} key(s) failed: ${failures.join(' | ')}`
    );
  }

  /** Embed a single text. Cache check happens inside embedBatch. */
  async embedContent(text) {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }
}

export const openRouterEmbeddingClient = new OpenRouterEmbeddingClient();
export default openRouterEmbeddingClient;
