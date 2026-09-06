/**
 * embedding-cache.js
 *
 * Lightweight in-memory LRU cache for embedding vectors.
 *
 *   key  = sha256(normalizedText + '|' + embeddingModel)
 *   hit  → return the cached vector (no API call)
 *   miss → compute, store, return
 *
 * Rules:
 *   - ONLY successful results are cached (failed requests are never stored).
 *   - Bounded size with LRU eviction (no unbounded growth).
 *   - Text is normalized (trimmed + whitespace-collapsed) so equivalent
 *     prompts/context share a key.
 *   - This is a process-local optimization — deliberately NO Redis.
 */
import { createHash } from 'crypto';
import { bumpAi } from './perf-context.js';

const MAX_ENTRIES = 2000;

function normalize(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

export function cacheKeyFor(text, model) {
  return createHash('sha256').update(`${normalize(text)}|${model}`).digest('hex');
}

class EmbeddingCache {
  constructor(maxEntries = MAX_ENTRIES) {
    this.max = maxEntries;
    this.map = new Map(); // insertion order = LRU order
    this.hits = 0;
    this.misses = 0;
  }

  /** Look up a vector; returns undefined on miss. */
  get(text, model) {
    const key = cacheKeyFor(text, model);
    if (this.map.has(key)) {
      const vector = this.map.get(key);
      // refresh LRU position
      this.map.delete(key);
      this.map.set(key, vector);
      this.hits++;
      bumpAi('cacheHits');
      return vector;
    }
    this.misses++;
    bumpAi('cacheMisses');
    return undefined;
  }

  /** Store a vector (only successes should call this). */
  set(text, model, vector) {
    const key = cacheKeyFor(text, model);
    this.map.delete(key); // refresh position
    this.map.set(key, vector);
    if (this.map.size > this.max) {
      // evict least-recently-used (first inserted)
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  get size() {
    return this.map.size;
  }

  /** Stats for logging — never contains vectors. */
  stats() {
    return { size: this.map.size, hits: this.hits, misses: this.misses, max: this.max };
  }
}

export const embeddingCache = new EmbeddingCache();
export default embeddingCache;