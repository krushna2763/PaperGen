/**
 * bm25-index.js — BM25 KEYWORD RETRIEVAL over the syllabus corpus (PART 10).
 *
 * Purpose: exact/important terminology recall (names, objects, places) that a
 * dense embedding can dilute. BM25 is a COMPLEMENT to dense retrieval, never a
 * replacement (PART 10).
 *
 * The index is built by scrolling the Qdrant syllabus payloads for one scope
 * (class/subject[/unit]) — so BM25 and dense search see EXACTLY the same
 * chunks and every BM25 hit keeps its full metadata for filtering (PART 10).
 *
 * Parents are indexed too (marked chunkType:'parent') for parent-context
 * restore, but candidate SEARCH only returns children by default (PART 5:
 * child retrieves, parent restores context).
 *
 * Caching (PART 28): the tokenized index is cached in memory per scope key and
 * mirrored to server/data/bm25-cache.json; the cache key embeds the sorted
 * sourceHash list, so any re-ingestion invalidates it naturally.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalScopeKey, qdrantStore } from './qdrant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = () => process.env.BM25_CACHE_FILE
  || path.join(__dirname, '..', '..', 'data', 'bm25-cache.json');

const K1 = 1.5;
const B = 0.75;

// Small academic-English stopword list — retrieval quality, not linguistics.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'from',
  'by', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this',
  'that', 'these', 'those', 'as', 'not', 'no', 'but', 'if', 'then', 'so',
  'what', 'which', 'who', 'whom', 'whose', 'why', 'how', 'when', 'where',
  'did', 'does', 'do', 'can', 'could', 'will', 'would', 'should', 'may',
  'might', 'he', 'she', 'they', 'we', 'you', 'i', 'his', 'her', 'their',
  'there', 'here', 'about', 'into', 'over', 'under', 'after', 'before',
]);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function scopeKeyOf({ class: cls, subject, unit } = {}) {
  return [canonicalScopeKey(cls), canonicalScopeKey(subject), unit != null ? String(unit) : ''].join('::');
}

function buildIndexFromDocs(docs) {
  // docs: [{ payload }]
  const df = new Map();
  const entries = docs.map((d) => {
    const p = d.payload || {};
    const tokens = tokenize(`${p.text || ''} ${p.chapter || ''} ${p.section || ''}`);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
    return { payload: p, tokens, tf, length: tokens.length || 1 };
  });
  const totalLen = entries.reduce((a, e) => a + e.length, 0);
  return {
    docs: entries,
    df: Object.fromEntries(df),
    N: entries.length,
    avgdl: entries.length > 0 ? totalLen / entries.length : 0,
  };
}

function scoreIndex(index, queryTokens) {
  if (!index || index.N === 0) return [];
  const results = [];
  for (const doc of index.docs) {
    let score = 0;
    const seen = new Set();
    for (const term of queryTokens) {
      if (seen.has(term)) continue;
      seen.add(term);
      const tf = doc.tf instanceof Map ? (doc.tf.get(term) || 0) : 0;
      if (tf === 0) continue;
      const n = index.df[term] || 0;
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.length / index.avgdl))));
    }
    if (score > 0) results.push({ score: Math.round(score * 10000) / 10000, payload: doc.payload });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/** In-memory per-scope index cache + on-disk mirror. */
const memCache = new Map();

async function buildScopeIndex(scope) {
  const key = scopeKeyOf(scope);
  const rows = await qdrantStore.scrollSyllabusPayloads(scope);
  const docHashes = [...new Set(rows.map((r) => r.payload?.sourceHash).filter(Boolean))].sort();
  const cacheKey = `${key}|${docHashes.join(',')}`;

  // 1) memory cache
  const mem = memCache.get(key);
  if (mem && mem.cacheKey === cacheKey) return mem;

  // 2) disk cache (PART 28 — avoid re-tokenizing unchanged scopes)
  try {
    if (fs.existsSync(CACHE_FILE())) {
      const disk = JSON.parse(fs.readFileSync(CACHE_FILE(), 'utf8'));
      const hit = Array.isArray(disk) ? disk.find((e) => e.cacheKey === cacheKey) : null;
      if (hit) {
        const revived = reviveIndex(hit);
        memCache.set(key, revived);
        return revived;
      }
    }
  } catch { /* corrupt cache → rebuild */ }

  const index = buildIndexFromDocs(rows);
  index.cacheKey = cacheKey;
  index.scopeKey = key;
  memCache.set(key, index);

  // Mirror to disk (best effort — never fatal).
  try {
    let all = [];
    if (fs.existsSync(CACHE_FILE())) {
      all = JSON.parse(fs.readFileSync(CACHE_FILE(), 'utf8'));
      if (!Array.isArray(all)) all = [];
    }
    const others = all.filter((e) => !e.scopeKey || e.scopeKey !== key);
    others.push({
      scopeKey: key,
      cacheKey,
      // Persist the FULL scoring state (PART 28 fix): `tf` per doc and `length`
      // are required by scoreIndex — a payload-only mirror crashes on load.
      docs: index.docs.map((d) => ({ payload: d.payload, tf: Object.fromEntries(d.tf), length: d.length })),
      df: index.df,
      N: index.N,
      avgdl: index.avgdl,
    });
    fs.mkdirSync(path.dirname(CACHE_FILE()), { recursive: true });
    fs.writeFileSync(CACHE_FILE(), JSON.stringify(others), 'utf8');
  } catch { /* cache write is best-effort */ }

  return index;
}

/**
 * Rehydrate a disk-cached index into the in-memory shape scoreIndex expects:
 * `tf` must be a Map per doc, `length` a number. Any doc missing them (e.g. a
 * cache written by the payload-only mirror bug) is recomputed from its payload.
 */
function reviveIndex(hit) {
  hit.docs = (hit.docs || []).map((d) => {
    if (d.tf instanceof Map && typeof d.length === 'number') return d;
    const tokens = tokenize(`${d.payload?.text || ''} ${d.payload?.chapter || ''} ${d.payload?.section || ''}`);
    if (!(d.tf instanceof Map)) {
      const tf = new Map();
      const obj = typeof d.tf === 'object' && d.tf != null ? d.tf : {};
      for (const [t, n] of Object.entries(obj)) tf.set(t, n);
      if (tf.size === 0) for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      d.tf = tf;
    }
    if (typeof d.length !== 'number') d.length = tokens.length || 1;
    return d;
  });
  return hit;
}

/** Test hook — drop all cached indexes. */
export function resetBm25Cache() {
  memCache.clear();
  try { fs.rmSync(CACHE_FILE(), { force: true }); } catch { /* ignore */ }
}

/** Test hook — drop ONLY the in-memory cache (simulates a process restart
 *  while keeping the on-disk mirror, i.e. the disk-load code path). */
export function dropBm25MemCache() {
  memCache.clear();
}

/**
 * BM25 search over the syllabus corpus for one scope.
 * @param {string} query
 * @param {Object} filter - { class, subject, unit?, includeParents? } (scope mandatory)
 * @param {Object} [opts] - { topK }
 * @returns {Promise<Array<{ score, payload }>>}
 */
export async function bm25Search(query, filter = {}, opts = {}) {
  const cls = canonicalScopeKey(filter.class);
  const subject = canonicalScopeKey(filter.subject);
  if (!cls || !subject) {
    throw new Error('[BM25] class and subject are mandatory — never search across scopes.');
  }
  const index = await buildScopeIndex({ class: cls, subject, unit: filter.unit });
  const qTokens = tokenize(query);
  const hits = scoreIndex(index, qTokens);
  const topK = Math.max(1, opts.topK || 10);
  return hits
    .filter((h) => (filter.includeParents === true ? true : h.payload?.chunkType !== 'parent'))
    .slice(0, topK);
}

export default { bm25Search, tokenize, resetBm25Cache, dropBm25MemCache };

