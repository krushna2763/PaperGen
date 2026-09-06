/**
 * perf-context.js
 *
 * Lightweight per-request performance instrumentation using AsyncLocalStorage.
 * Every AI call made inside a request (via the centralized Gemini client or
 * the embedding service) increments counters in the request's own stats
 * object, and stage timings are accumulated by the orchestrator's `timed()`.
 *
 * This avoids threading a stats object through every agent signature while
 * keeping concurrent requests isolated. Counters are surfaced in
 * `meta.timing` / `meta.ai` of the generation response (never secrets).
 */
import { AsyncLocalStorage } from 'async_hooks';

const storage = new AsyncLocalStorage();

/** Default (empty) stats shape. */
export function emptyStats() {
  return {
    timing: {},        // stage -> ms (accumulated, may repeat across rounds)
    ai: {
      geminiRequests: 0,     // generateContent attempts (LLM)
      embeddingRequests: 0,  // embedContent / batchEmbedContents calls
      embeddingInputs: 0,    // texts embedded (a batch of N counts N)
      validationRequests: 0, // batch semantic validation calls
      cacheHits: 0,
      cacheMisses: 0,
      failoverAttempts: 0,   // extra key/model attempts beyond the first
      regenerationRounds: 0,
    },
  };
}

/** Run a function inside a fresh stats context. */
export function runWithStats(fn) {
  return storage.run(emptyStats(), fn);
}

/** Get the current request's stats (or a fresh object outside a request). */
export function getStats() {
  return storage.getStore() ?? emptyStats();
}

/** Accumulate a stage timing (ms) into the current stats. */
export function addTiming(stage, ms) {
  const stats = getStats();
  if (!stats || !stats.timing) return;
  stats.timing[stage] = (stats.timing[stage] ?? 0) + ms;
}

/** Increment one of the ai counters. */
export function bumpAi(key, n = 1) {
  const stats = getStats();
  if (!stats || !stats.ai) return;
  stats.ai[key] = (stats.ai[key] ?? 0) + n;
}

export default { runWithStats, getStats, addTiming, bumpAi, emptyStats };