/**
 * Shared Agent Utilities
 * Small deterministic helpers used across the agent layer.
 */

/**
 * Robustly parse a JSON object out of LLM text output.
 * Handles markdown code fences and stray prose around the JSON block.
 * @param {string} text - Raw LLM response text
 * @returns {Object|null} Parsed object or null if none found
 */
export function parseJsonObject(text) {
  if (!text || typeof text !== 'string') return null;

  let cleaned = text.trim();
  // Strip markdown code fences (```json ... ```)
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall through to balanced-block extraction
  }

  // Find the first balanced {...} block even if surrounded by prose
  const start = cleaned.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * Cosine similarity between two equal-length numeric vectors.
 * @param {Array<number>} a
 * @param {Array<number>} b
 * @returns {number} 0..1 (0 on invalid input)
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Round a number to a fixed number of decimal places.
 * @param {number} value
 * @param {number} [decimals=4]
 * @returns {number}
 */
export function roundTo(value, decimals = 4) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Normalize question text for deterministic exact-duplicate detection.
 * Lowercases, collapses all whitespace, and trims.
 * @param {string} text
 * @returns {string}
 */
export function normalizeQuestionText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Run async tasks with a fixed concurrency limit (rate-limit safe).
 * @param {Array<T>} items
 * @param {number} limit - Max concurrent workers
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<R>>} Results in input order
 */
export async function runWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), Math.max(1, items.length));
  const runners = Array.from({ length: safeLimit }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

export default { parseJsonObject, cosineSimilarity, roundTo, normalizeQuestionText, runWithConcurrencyLimit };