/**
 * context-compressor.js — CONTEXT COMPRESSION (PARTS 15/16).
 *
 * Takes the reranked top 3–5 chunks and produces a compact grounding context:
 *   - sentence-level selection: keeps sentences that carry query-relevant
 *     FACTS, drops filler — but never rewrites or invents anything;
 *   - every block retains its source metadata (chunkId, unit, page, heading);
 *   - parent-context restore (PART 5): when a retrieved child's PARENT is
 *     available and small, parent sentences are preferred so the generator
 *     sees the section's full framing instead of an isolated fragment;
 *   - hard token budget (PART 16, configurable RETRIEVAL_CONTEXT_BUDGET_TOKENS).
 */

import { env } from '../config/env.js';
import { splitSentences, countTokens } from '../chunking/semantic-chunker.js';
import { tokenize } from './bm25-index.js';

/**
 * Compress reranked chunks into a grounded context.
 * @param {string} query - content-oriented retrieval query (PART 13)
 * @param {Array<{payload, scores?}>} chunks - reranked final chunks
 * @param {Object} [opts] - { budgetTokens, parentTexts: Map<parentChunkId, string> }
 * @returns {{ blocks: Array, tokensUsed: number, droppedChunks: number }}
 */
export function compressContext(query, chunks, opts = {}) {
  const budget = opts.budgetTokens ?? env.RETRIEVAL_CONTEXT_BUDGET_TOKENS;
  const parentTexts = opts.parentTexts instanceof Map ? opts.parentTexts : new Map();
  const qTerms = new Set(tokenize(query));

  const blocks = [];
  let tokensUsed = 0;
  let droppedChunks = 0;

  for (const c of chunks || []) {
    const p = c.payload || {};
    const childText = String(p.text || '').trim();
    if (!childText) continue;

    // PART 5 — parent restore: prefer the parent's fuller framing when it is
    // available and does not blow the budget on its own.
    let source = childText;
    let usedParent = false;
    const parentText = p.parentChunkId ? parentTexts.get(p.parentChunkId) : null;
    if (parentText && countTokens(parentText) <= Math.max(120, budget / 3)) {
      source = parentText;
      usedParent = true;
    }

    const sentences = splitSentences(source);
    if (sentences.length === 0) continue;

    // Score sentences by query-term coverage (content relevance, no invention).
    const scored = sentences.map((s, i) => {
      const st = tokenize(s);
      let hits = 0;
      for (const t of new Set(st)) if (qTerms.has(t)) hits++;
      // Mild positional prior: earlier sentences often define the topic.
      const pos = 1 - i / Math.max(1, sentences.length);
      return { s, score: hits + pos * 0.5, tokens: countTokens(s), hits };
    });

    // Greedy pick in ORIGINAL order, honoring the per-chunk fair share.
    const fairShare = Math.max(60, Math.floor(budget / Math.max(1, chunks.length)));
    const chosen = [];
    let used = 0;
    // Always keep the first sentence (topic anchor) — compression must never
    // strip a chunk down to nothing and hallucinate the rest of the framing.
    if (scored.length > 0) {
      chosen.push(scored[0]);
      used += scored[0].tokens;
    }
    for (let i = 1; i < scored.length; i++) {
      if (used >= fairShare) break;
      if (used + scored[i].tokens > fairShare) continue;
      // Sentences with zero query overlap are only filler when later ones
      // still carry hits — keep a coherent 2-sentence floor otherwise.
      if (scored[i].hits === 0 && chosen.length >= 2 && i > 0 && scored.some((x) => x.hits > 0)) continue;
      chosen.push(scored[i]);
      used += scored[i].tokens;
    }
    // Restore original document order for readability.
    chosen.sort((a, b) => sentences.indexOf(a.s) - sentences.indexOf(b.s));
    const text = chosen.map((x) => x.s).join(' ');

    const blockTokens = countTokens(text);
    if (tokensUsed + blockTokens > budget && blocks.length > 0) {
      droppedChunks += 1;
      continue; // budget exhausted — later (lower-ranked) chunks drop first
    }

    tokensUsed += blockTokens;
    blocks.push({
      chunkId: p.chunkId ?? null,
      parentChunkId: p.parentChunkId ?? null,
      usedParent,
      unit: p.unit ?? null,
      class: p.class ?? null,
      subject: p.subject ?? null,
      sourceType: p.sourceType ?? null,
      headingPath: p.headingPath ?? [],
      sourcePage: p.sourcePage ?? p.pageNumber ?? null,
      text,
      tokens: blockTokens,
    });
  }

  return { blocks, tokensUsed, droppedChunks };
}

export default { compressContext };
