/**
 * hybrid-graph-retriever.js — Phase 8: Hybrid Vector + Knowledge Graph retrieval.
 *
 * Orchestrates the EXISTING vector legs with the EXISTING Phase 7 graph
 * retriever:
 *   - mode 'legacy' | 'vector' → retriever.search() dense-only (no graph)
 *   - mode 'hybrid'            → hybridSearch() dense + BM25 (no graph)
 *   - mode 'hybrid_graph'      → hybridSearch() + retrieveGraphEvidence(), then
 *                                evidence-fusion.js fuses both into one scored,
 *                                provenance-backed evidence list.
 *
 * Design rules enforced here:
 *   - Qdrant source text is the academic authority (Phase 8 §9): fusion weights
 *     and the dedup rule keep a graph edge below strong source text.
 *   - Unit/class/subject isolation is exact-scope filtering (Phase 8 §11).
 *   - Never fabricate graph evidence (Phase 8 §25/§27): an empty or failed
 *     graph is reported via graphUnavailable/graphFailed and we degrade to
 *     vector evidence; both failing throws RETRIEVAL_FAILURE.
 *   - Do NOT invent concepts (Phase 8 §5): concept/topic pass through only when
 *     the caller has them; an uncertain target keeps uncertainty.
 *   - Legacy-metadata adapter (Phase 8 §28): retriever.search() drops the unit
 *     field from hits. Inside THIS layer only, missing scope metadata on a hit
 *     is stamped back from the requested scope. Isolated here; retriever.js is
 *     untouched.
 */

import { retriever } from './retriever.js';
import { hybridSearch } from './hybrid-retriever.js';
import { canonicalScopeKey } from './qdrant.js';
import { retrieveGraphEvidence } from '../graph/graph-retriever.js';
import { fuseEvidence, DEFAULT_WEIGHTS } from './evidence-fusion.js';
import { geminiClient } from '../services/gemini-client.service.js';

const SUPPORTED_MODES = new Set(['legacy', 'vector', 'hybrid', 'hybrid_graph']);

/**
 * Concept-target resolution (Phase 8 §5). Deterministic and non-fabricating:
 * returns a concept ONLY when the caller already knows one (direct `concept`,
 * or a slot/items-intent concept). Uncertain → null; graph retrieval then
 * falls back to topic-level / unit-level scope.
 */
export function resolveConceptTarget({ concept, intent, slot, item } = {}) {
  const direct = String(concept ?? '').trim();
  if (direct) return direct;
  const fromIntent = String(intent?.concept ?? '').trim();
  if (fromIntent) return fromIntent;
  const fromItem = String(item?.concept ?? item?.topicAnchor ?? '').trim();
  if (fromItem) return fromItem;
  const fromSlot = String(slot?.concept ?? slot?.topicAnchor ?? '').trim();
  if (fromSlot) return fromSlot;
  return null;
}

/** Isolated metadata adapter (Phase 8 §28) — restores dropped scope fields on hits. */
export function restoreScopeMetadata(hits, { class: cls, subject, unit } = {}) {
  const clsKey = canonicalScopeKey(cls);
  const subjKey = canonicalScopeKey(subject);
  const unitValue = unit != null && String(unit).trim() !== '' ? String(unit) : null;
  return (hits || []).map((h) => {
    const out = { ...h };
    if (out.unit == null || String(out.unit).trim() === '') out.unit = unitValue;
    if (out.class == null || String(out.class).trim() === '') out.class = clsKey;
    if (out.subject == null || String(out.subject).trim() === '') out.subject = subjKey;
    if (out.sourceDocumentId == null && out.hash) out.sourceDocumentId = out.hash;
    return out;
  });
}

/**
 * Hybrid retrieval entry point.
 * @param {Object} args
 * @param {string} args.class
 * @param {string} args.subject
 * @param {string|null} [args.unit]
 * @param {string} [args.topic]
 * @param {string} [args.concept]
 * @param {string} args.query - content-oriented retrieval query
 * @param {string} [args.questionType]
 * @param {number} [args.limit] - max combined evidence items
 * @param {Array<number>} [args.vector] - precomputed query embedding (skip re-embedding)
 * @param {Object} [args.filter] - extra Qdrant filter (corpus/sourceDocumentId/sourceHash/sourceType)
 * @param {string} [args.mode='hybrid'] - legacy|vector|hybrid|hybrid_graph (Phase 8 §14)
 * @param {Object} [args.weights] - scoring weights override for fuseEvidence
 * @param {number} [args.maxDepth=2] - bounded graph traversal depth
 * @param {number} [args.minConfidence]
 * @param {number} [args.graphLimit=20]
 * @param {number} [args.vectorTopK]
 * @param {number} [args.legTopK]
 * @param {Object} [args.deps] - injectable seams (embed/denseSearch/hybridSearch/graphSearch) for tests
 * @returns {Promise<{ target, vectorEvidence, graphEvidence, combinedEvidence, provenance, scores, diagnostics, compressed }>}
 */
export async function retrieveHybridEvidence(args = {}) {
  const {
    class: cls, subject, unit, topic, concept, query, limit,
    vector, filter = {}, mode = 'hybrid', weights, maxDepth = 2, minConfidence,
    graphLimit = 20, vectorTopK, legTopK, questionIntent, slot, item, verbose = true,
  } = args;
  const deps = {
    embed: async (text) => geminiClient.embedContent(text),
    denseSearch: retriever.search.bind(retriever),
    hybridSearch,
    graphSearch: retrieveGraphEvidence,
    ...(args.deps || {}),
  };

  if (!SUPPORTED_MODES.has(mode)) throw new Error(`[HybridGraph] unsupported mode '${mode}' (legacy|vector|hybrid|hybrid_graph)`);
  const clsKey = canonicalScopeKey(cls);
  const subjKey = canonicalScopeKey(subject);
  if (!clsKey || !subjKey) throw new Error('[HybridGraph] class and subject are mandatory.');
  if (!query && !vector) throw new Error('[HybridGraph] a content query (or precomputed vector) is required.');

  const t0 = Date.now();
  const resolvedConcept = resolveConceptTarget({ concept, intent: questionIntent, slot, item });
  const target = {
    class: cls ?? null,
    subject: subject ?? null,
    unit: unit != null && String(unit).trim() !== '' ? String(unit) : null,
    topic: topic != null ? String(topic) : null,
    concept: resolvedConcept,
  };
  const diagnostics = {
    mode,
    target,
    conceptResolvedFrom: concept ? 'direct' : questionIntent?.concept ? 'intent' : 'topic-or-unit',
    graphUnavailable: false,
    graphFailed: false,
    vectorFailed: false,
    vectorLeg: null,
    imageStripped: false,
    vectorElapsedMs: 0,
    graphElapsedMs: 0,
    graphConfidence: 0,
  };

  const qfilter = { corpus: filter.corpus ?? 'syllabus', class: clsKey, subject: subjKey };
  if (filter.sourceDocumentId) qfilter.sourceDocumentId = filter.sourceDocumentId;
  if (filter.sourceHash) qfilter.sourceHash = filter.sourceHash;
  if (filter.sourceType) qfilter.sourceType = filter.sourceType;
  if (target.unit) qfilter.unit = target.unit;

  // ── 1. Vector retrieval (existing legs, unchanged filters) ─────────────────
  let vectorHits = [];
  let compressed = null;
  let vectorErrorMessage = null;
  try {
    const embedStart = Date.now();
    const qv = vector && Array.isArray(vector) && vector.length > 0
      ? vector
      : await deps.embed(query);
    diagnostics.embedElapsedMs = Date.now() - embedStart;

    if (mode === 'legacy' || mode === 'vector') {
      diagnostics.vectorLeg = 'legacy-dense';
      const hits = await deps.denseSearch({ vector: qv, topK: vectorTopK, filter: qfilter });
      // Phase 8 §28: restore dropped scope metadata inside THIS layer only.
      vectorHits = restoreScopeMetadata(hits, { class: cls, subject, unit: target.unit });
    } else {
      diagnostics.vectorLeg = 'hybrid-dense+bm25';
      const out = await deps.hybridSearch({
        query,
        vector: qv,
        topK: limit ?? vectorTopK ?? undefined,
        legTopK,
        filter: { class: cls, subject, unit: target.unit },
      });
      vectorHits = out.final || [];
      compressed = out.compressed || null;
    }
  } catch (err) {
    vectorErrorMessage = String(err?.message || err);
    diagnostics.vectorFailed = true;
    diagnostics.vectorError = vectorErrorMessage.slice(0, 240);
    vectorHits = [];
    console.warn(`[HYBRID-GRAPH] vector leg failed (${diagnostics.vectorLeg || mode}): ${vectorErrorMessage.slice(0, 160)}`);
  }
  diagnostics.vectorElapsedMs = Date.now() - t0;

  // ── 2. Graph retrieval (hybrid_graph only; local + bounded) ────────────────
  let graphNodes = [];
  let graphRelationships = [];
  let graphProvenance = [];
  let graphErrorMessage = null;
  if (mode === 'hybrid_graph') {
    try {
      const graphT0 = Date.now();
      const g = await deps.graphSearch({
        class: cls,
        subject,
        unit: target.unit,
        topic: target.topic,
        concept: target.concept,
        maxDepth,
        limit: graphLimit,
        minConfidence,
      });
      diagnostics.graphElapsedMs = Date.now() - graphT0;
      graphNodes = g?.nodes || [];
      graphRelationships = g?.relationships || [];
      graphProvenance = g?.provenance || [];
      diagnostics.graphConfidence = Number(g?.confidence ?? 0) || 0;
      diagnostics.graphProvenanceRows = Array.isArray(graphProvenance) ? graphProvenance.length : 0;
      if (graphNodes.length === 0 && graphRelationships.length === 0) {
        diagnostics.graphUnavailable = true;
      }
    } catch (err) {
      graphErrorMessage = String(err?.message || err);
      diagnostics.graphFailed = true;
      diagnostics.graphError = graphErrorMessage.slice(0, 240);
      console.warn(`[HYBRID-GRAPH] graph leg failed: ${graphErrorMessage.slice(0, 160)}`);
    }
  }

  // ── 3. Evidence fusion + hard scope gate + dedup (Phase 8 §6/§8/§10) ──────
  const fused = fuseEvidence(
    {
      vectorHits,
      graphNodes,
      graphRelationships,
      target,
    },
    { limit: limit ?? null, weights }
  );
diagnostics.fusedEvidence = fused.combinedEvidence.length;
  diagnostics.filteredEvidence = fused.diagnostics.droppedWrongScope;
  diagnostics.droppedWrongScope = fused.diagnostics.droppedWrongScope;
  diagnostics.droppedWrongScopeReasons = fused.diagnostics.droppedWrongScopeReasons;
  diagnostics.dedupedCount = fused.diagnostics.dedupedCount;
  diagnostics.graphNodes = graphNodes.length;
  diagnostics.graphRelationships = graphRelationships.length;
  diagnostics.vectorRetrieved = fused.diagnostics.vectorInput;

  // ── 4. Failure semantics (Phase 8 §27) ─────────────────────────────────────
  if (fused.vectorEvidence.length === 0 && fused.graphEvidence.length === 0) {
    const err = new Error(
      '[HybridGraph] retrieval failure: no vector evidence and no graph evidence available.'
    );
    err.code = 'RETRIEVAL_FAILURE';
    err.diagnostics = diagnostics;
    throw err;
  }

  if (verbose) {
    console.log(
      `[HYBRID-GRAPH] target=${mode}:${clsKey}/${subjKey}/${target.unit ?? '∅'}/${target.topic ?? '∅'}/${target.concept ?? '∅'} ` +
      `vectorEvidence=${fused.vectorEvidence.length} graphNodes=${graphNodes.length} graphRelationships=${graphRelationships.length} ` +
      `fusedEvidence=${fused.combinedEvidence.length} filteredEvidence=${diagnostics.filteredEvidence} graphConfidence=${Number(diagnostics.graphConfidence).toFixed(3)}`
    );
  }

  return {
    target,
    vectorEvidence: fused.vectorEvidence,
    graphEvidence: fused.graphEvidence,
    combinedEvidence: fused.combinedEvidence,
    provenance: fused.provenance,
    scores: fused.scores,
    diagnostics,
    compressed,
  };
}

export default { retrieveHybridEvidence, resolveConceptTarget, restoreScopeMetadata, DEFAULT_WEIGHTS };