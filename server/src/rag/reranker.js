/**
 * reranker.js — CANDIDATE RERANKING (PART 12).
 *
 * Judges query ↔ chunk RELEVANCE only. It never asks "does this chunk copy the
 * reference question?" — that is the similarity/novelty layer's job (PART 12).
 * Metadata filters are applied BEFORE reranking and are never relaxed here.
 *
 * WHY A LEXICAL RERANKER: the project's runtime is Node/Express without a
 * Python model server, and the task forbids Gemini-as-reranker. The reranker
 * below is a deterministic, zero-network multi-signal scorer:
 *
 *   S = w1·coverage   (IDF-weighted query-term coverage in the chunk)
 *     + w2·phrase     (exact query-bigram overlap — word-order match)
 *     + w3·heading    (query terms appearing in the chunk's heading path)
 *     + w4·fusedRank  (reciprocal of the RRF fusion rank — dense+BM25 consensus)
 *
 * It is a drop-in interface: `rerank(query, candidates, opts)` — a
 * cross-encoder service can replace the scoring function later without
 * touching callers. Weights are config, not code (PART 11: configurable).
 */

import { tokenize } from './bm25-index.js';

const WEIGHTS = {
  coverage: parseFloat(process.env.RERANK_W_COVERAGE || '0.4'),
  phrase: parseFloat(process.env.RERANK_W_PHRASE || '0.25'),
  heading: parseFloat(process.env.RERANK_W_HEADING || '0.15'),
  fusedRank: parseFloat(process.env.RERANK_W_FUSED || '0.2'),
};

function bigrams(tokens) {
  const out = new Set();
  for (let i = 0; i < tokens.length - 1; i++) out.add(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

/**
 * Rerank fused candidates.
 * @param {string} query - the CONTENT-oriented retrieval query (PART 13)
 * @param {Array<{score, payload, rrfScore?, denseRank?, bm25Rank?}>} candidates
 * @param {Object} [opts] - { topK }
 * @returns {Array<Object>} reranked candidates (each gains .rerankScore)
 */
export function rerank(query, candidates, opts = {}) {
  const qTokens = tokenize(query);
  const qBigrams = bigrams(qTokens);
  const qSet = new Set(qTokens);

  const scored = (candidates || []).map((c, idx) => {
    const text = String(c.payload?.text || '');
    const cTokens = tokenize(text);
    const cSet = new Set(cTokens);

    // 1) IDF-free coverage: fraction of distinct query terms present.
    let covered = 0;
    for (const t of qSet) if (cSet.has(t)) covered++;
    const coverage = qSet.size > 0 ? covered / qSet.size : 0;

    // 2) Phrase: fraction of query bigrams present verbatim (word-order signal).
    const cBigrams = bigrams(cTokens);
    let phraseHits = 0;
    for (const b of qBigrams) if (cBigrams.has(b)) phraseHits++;
    const phrase = qBigrams.size > 0 ? phraseHits / qBigrams.size : 0;

    // 3) Heading match: query terms in the heading path / section title.
    const headText = tokenize(`${c.payload?.section || ''} ${(c.payload?.headingPath || []).join(' ')}`);
    let headHits = 0;
    for (const t of qSet) if (headText.includes(t)) headHits++;
    const heading = qSet.size > 0 ? headHits / qSet.size : 0;

    // 4) Fusion consensus: earlier fused rank = higher signal (idx is fused order).
    const fusedRank = candidates.length > 1 ? 1 - idx / (candidates.length - 1) : 1;

    const rerankScore =
      WEIGHTS.coverage * coverage +
      WEIGHTS.phrase * phrase +
      WEIGHTS.heading * heading +
      WEIGHTS.fusedRank * fusedRank;

    return {
      ...c,
      rerankScore: Math.round(rerankScore * 10000) / 10000,
      signals: { coverage, phrase, heading, fusedRank },
    };
  });

  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  const topK = Math.max(1, opts.topK || 5);
  return scored.slice(0, topK);
}

export default { rerank };
