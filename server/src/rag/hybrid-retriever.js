/**
 * hybrid-retriever.js — DENSE + BM25 → RRF → RERANK → COMPRESS (PARTS 9/11/12/15-18).
 *
 * Pipeline per retrieval task:
 *   dense (Qdrant, topK) ─┐
 *                         ├→ RRF fusion → candidate pool → rerank → SAFETY GATE
 *   BM25 (topK) ──────────┘                                              ↓
 *                                                       parent restore → compression
 *                                                                              ↓
 *                                                          final grounded context
 *
 * Metadata safety (PART 18): EVERY final chunk must satisfy
 * class=requested, subject=requested, unit=requested, sourceType=syllabus_notes.
 * A chunk that fails ANY of these is REMOVED — never silently accepted.
 *
 * Trace (PART 17): every stage is recorded for debugging/evaluation. Traces go
 * to server-side logs/artifacts only — never to students.
 */

import { env } from '../config/env.js';
import { canonicalScopeKey, qdrantStore } from './qdrant.js';
import { bm25Search } from './bm25-index.js';
import { rerank } from './reranker.js';
import { compressContext } from './context-compressor.js';

/**
 * Reciprocal Rank Fusion over the two retrieval legs.
 * Each doc gets score = Σ 1/(k + rank) per list it appears in.
 */
export function rrfFuse(denseHits, bm25Hits, { k = env.RETRIEVAL_RRF_K, pool = env.RETRIEVAL_FUSION_POOL } = {}) {
  const byKey = new Map(); // key: chunkId || hash || normalized text
  const keyOf = (payload) => {
    if (payload?.chunkId) return `id:${payload.chunkId}`;
    if (payload?.hash) return `hash:${payload.hash}`;
    return 'txt:' + String(payload?.text || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
  };

  const addLeg = (hits, leg) => {
    (hits || []).forEach((h, i) => {
      const key = keyOf(h.payload || {});
      const entry = byKey.get(key) || {
        payload: h.payload || {},
        rrfScore: 0,
        denseScore: null,
        bm25Score: null,
        denseRank: null,
        bm25Rank: null,
      };
      entry.rrfScore += 1 / (k + i + 1);
      if (leg === 'dense') {
        entry.denseScore = h.score ?? entry.denseScore;
        entry.denseRank = i + 1;
      } else {
        entry.bm25Score = h.score ?? entry.bm25Score;
        entry.bm25Rank = i + 1;
      }
      // Prefer the richest payload representation when both legs agree.
      if (leg === 'bm25' && !entry.payload?.chunkId && h.payload?.chunkId) entry.payload = h.payload;
      byKey.set(key, entry);
    });
  };

  addLeg(denseHits, 'dense');
  addLeg(bm25Hits, 'bm25');

  return [...byKey.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, Math.max(1, pool))
    .map((e) => ({ ...e, rrfScore: Math.round(e.rrfScore * 100000) / 100000 }));
}

/**
 * PART 18 — metadata safety gate. Returns only chunks whose payload EXACTLY
 * matches the requested scope + syllabus_notes source type.
 */
export function validateChunkMetadata(candidates, { class: cls, subject, unit } = {}) {
  const wantCls = canonicalScopeKey(cls);
  const wantSub = canonicalScopeKey(subject);
  const wantUnit = unit != null && String(unit).trim() !== '' ? String(unit) : null;
  const rejected = [];
  const ok = (candidates || []).filter((c) => {
    const p = c.payload || {};
    const problems = [];
    if (canonicalScopeKey(p.class) !== wantCls) problems.push(`class=${p.class ?? '∅'}≠${wantCls}`);
    if (canonicalScopeKey(p.subject) !== wantSub) problems.push(`subject=${p.subject ?? '∅'}≠${wantSub}`);
    if (wantUnit && String(p.unit ?? '') !== wantUnit) problems.push(`unit=${p.unit ?? '∅'}≠${wantUnit}`);
    if (p.corpus !== 'syllabus') problems.push(`corpus=${p.corpus ?? '∅'}`);
    if (p.sourceType != null && p.sourceType !== 'syllabus_notes') problems.push(`sourceType=${p.sourceType}`);
    if (problems.length > 0) {
      rejected.push({ chunkId: p.chunkId ?? null, reasons: problems });
      return false;
    }
    return true;
  });
  return { ok, rejected };
}

/** Normalize a fused/reranked entry into the hit shape downstream consumes. */
function toHit(entry, scoreKey) {
  const p = entry.payload || {};
  return {
    score: entry[scoreKey] ?? entry.rrfScore ?? 0,
    text: p.text || '',
    chunkId: p.chunkId ?? null,
    parentChunkId: p.parentChunkId ?? null,
    chunkType: p.chunkType ?? null,
    unit: p.unit ?? null,
    class: p.class ?? null,
    subject: p.subject ?? null,
    sourceType: p.sourceType ?? null,
    headingPath: p.headingPath ?? [],
    section: p.section ?? null,
    sourcePage: p.sourcePage ?? p.pageNumber ?? null,
    pageNumber: p.sourcePage ?? p.pageNumber ?? null,
    hash: p.hash ?? null,
  };
}

/**
 * Hybrid search for ONE retrieval task.
 * @param {Object} args
 *   { query (content query, PART 13), vector (query embedding), filter
 *     { class, subject, unit }, topK (final chunks) }
 * @returns {Promise<Object>} { final, dense, bm25, fused, reranked, rejectedMeta, compressed, trace }
 */
export async function hybridSearch(args) {
  const { query, vector, filter = {}, topK = env.RETRIEVAL_CONTEXT_CHUNKS } = args;
  const cls = canonicalScopeKey(filter.class);
  const subject = canonicalScopeKey(filter.subject);
  if (!cls || !subject) throw new Error('[Hybrid] class and subject are mandatory.');
  const legTopK = args.legTopK ?? env.RETRIEVAL_HYBRID_TOP_K;
  const t0 = Date.now();

  // ── Two legs, concurrent ───────────────────────────────────────────────────
  const [denseHits, bm25Hits] = await Promise.all([
    vector && vector.length > 0
      ? qdrantStore.searchVectors({
          vector,
          topK: legTopK,
          filter: { class: cls, subject, unit: filter.unit, corpus: 'syllabus' },
        })
      : Promise.resolve([]),
    bm25Search(query, { class: cls, subject, unit: filter.unit }, { topK: legTopK }),
  ]);

  // ── RRF fusion → candidate pool ────────────────────────────────────────────
  const fused = rrfFuse(denseHits, bm25Hits);

  // ── Rerank (query↔chunk relevance ONLY — PART 12) ─────────────────────────
  const reranked = rerank(query, fused, { topK: Math.max(topK, env.RETRIEVAL_CONTEXT_CHUNKS) });

  // ── Safety gate (PART 18) — strict, never silent ──────────────────────────
  const { ok: safeChunks, rejected: rejectedMeta } = validateChunkMetadata(reranked, {
    class: cls,
    subject,
    unit: filter.unit,
  });

  // ── Parent-context restore (PART 5): pull parent payloads for final chunks ─
  const parentTexts = new Map();
  const wantedParents = [...new Set(safeChunks.map((c) => c.payload?.parentChunkId).filter(Boolean))];
  if (wantedParents.length > 0) {
    const all = await qdrantStore.scrollSyllabusPayloads({ class: cls, subject, unit: filter.unit });
    for (const row of all) {
      const p = row.payload || {};
      if (p.chunkType === 'parent' && wantedParents.includes(p.chunkId)) {
        parentTexts.set(p.chunkId, String(p.text || ''));
      }
    }
  }

  // ── Context compression (PARTS 15/16) ──────────────────────────────────────
  const finalChunks = safeChunks.slice(0, Math.max(1, topK));
  const compressed = compressContext(query, finalChunks, { parentTexts });

  const trace = {
    query,
    filter: { class: cls, subject, unit: filter.unit ?? null },
    denseCandidates: denseHits.map((h) => ({ score: h.score, chunkId: h.payload?.chunkId ?? null, unit: h.payload?.unit ?? null, text: String(h.payload?.text || '').slice(0, 120) })),
    bm25Candidates: bm25Hits.map((h) => ({ score: h.score, chunkId: h.payload?.chunkId ?? null, unit: h.payload?.unit ?? null, text: String(h.payload?.text || '').slice(0, 120) })),
    fusedCandidates: fused.map((f) => ({ rrfScore: f.rrfScore, chunkId: f.payload?.chunkId ?? null, denseRank: f.denseRank, bm25Rank: f.bm25Rank })),
    rerankedCandidates: reranked.map((r) => ({ rerankScore: r.rerankScore, signals: r.signals, chunkId: r.payload?.chunkId ?? null })),
    rejectedMeta,
    finalChunks: compressed.blocks.map((b) => ({ chunkId: b.chunkId, usedParent: b.usedParent, unit: b.unit, sourcePage: b.sourcePage, tokens: b.tokens, text: b.text.slice(0, 160) })),
    sourceTypes: [...new Set(finalChunks.map((c) => c.payload?.sourceType).filter(Boolean))],
    units: [...new Set(finalChunks.map((c) => c.payload?.unit).filter(Boolean))],
    scores: finalChunks.map((c) => ({ chunkId: c.payload?.chunkId ?? null, rerankScore: c.rerankScore, denseScore: c.denseScore, bm25Score: c.bm25Score, rrfScore: c.rrfScore })),
    elapsedMs: Date.now() - t0,
  };

  return {
    // `final` keeps the legacy hit shape so downstream consumers (grounding,
    // generation prompts) work unchanged.
    final: finalChunks.map((c) => toHit(c, 'rerankScore')),
    dense: denseHits,
    bm25: bm25Hits,
    fused,
    reranked,
    rejectedMeta,
    compressed,
    trace,
  };
}

export default { hybridSearch, rrfFuse, validateChunkMetadata };

