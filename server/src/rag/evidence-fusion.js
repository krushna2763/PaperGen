/**
 * evidence-fusion.js — Phase 8: Hybrid Evidence Fusion layer.
 *
 * Combines Qdrant vector hits (the existing hit shapes from
 * retriever.search() and hybridSearch().final — both UNCHANGED) with Phase 7
 * graph nodes/relationships into ONE unified, scored, provenance-preserving
 * evidence list consumed by the hybrid-graph retriever and, through it, the
 * generation pipeline.
 *
 * Source-of-truth rule (Phase 8 §9/§13): Qdrant source text is the academic
 * authority. Vector chunks get a higher scoring weight than graph items, and a
 * graph relationship whose supporting source sentence merely restates an
 * already-present vector chunk is deduplicated AWAY in favor of the source
 * text itself — a graph edge never wins purely by existing.
 *
 * Scope rule (Phase 8 §10/§11): wrong class / subject / unit HARD-DROPS an
 * evidence item (never silently accepted). A MISSING scope field is never
 * treated as wrong — legacy dense-mode hits (Phase 7 known bug) and gaps in
 * real data must not silently empty a unit's evidence.
 */

import { canonicalScopeKey } from './qdrant.js';

/** Deterministic, configurable scoring weights (Phase 8 §8). */
export const DEFAULT_WEIGHTS = Object.freeze({
  vector: 0.5,      // vector similarity / source authority
  graph: 0.1,       // graph node/relationship confidence
  concept: 0.15,    // concept match vs the resolved target
  topic: 0.15,      // topic match vs the resolved target
  provenance: 0.1,  // how complete the provenance is
});

const EVIDENCE_TYPES = Object.freeze(['VECTOR_CHUNK', 'GRAPH_NODE', 'GRAPH_RELATIONSHIP']);

function normalizeForComparision(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** High-level same-sentence overlap for the dedup rule (Phase 8 §13). */
function nearSame(a, b) {
  const na = normalizeForComparision(a);
  const nb = normalizeForComparision(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 12 && nb.length >= 12) {
    return na.includes(nb) || nb.includes(na);
  }
  return false;
}

/**
 * Case-insensitive same-scope comparison for one VALUE (class/subject).
 * Uses the SAME canonicalization as rag/qdrant.js so "Oops" === "oops".
 */
function scopeEquals(a, b) {
  const ka = canonicalScopeKey(a);
  const kb = canonicalScopeKey(b);
  if (ka == null || kb == null) return null; // missing on either side → unknown
  return ka === kb;
}

/**
 * Provenance-completeness of an evidence item (0..1). Full provenance:
 * sourceDocumentId + sourceHash + chunkId + pageNumber + sourceText.
 */
function provenanceConfidenceOf(ev) {
  const p = ev.provenance || {};
  let present = 0;
  const checks = [p.sourceDocumentId, p.sourceHash, p.chunkId, p.pageNumber, p.sourceText];
  for (const c of checks) if (c != null && String(c).trim() !== '') present += 1;
  return checks.length > 0 ? present / checks.length : 0;
}

/** Escapes regex meta characters without a backslash-heavy regex literal. */
function escapeRegex(s) {
  const META = new Set('.*+?^${}()|[]\\'.split(''));
  return String(s).split('').map((c) => (META.has(c) ? `\\${c}` : c)).join('');
}

/**
 * Concept-match component. The target's concept must exist AND the evidence
 * must genuinely mention it (word-boundary, case-insensitive). Never
 * fabricates: absent target concept or absent evidence concept → 0.
 */
function conceptMatchOf(ev, target) {
  const concept = String(target?.concept ?? '').trim();
  if (!concept) return 0;
  const needle = concept.toLowerCase();
  const haystack = normalizeForComparision(String(ev.concept || ev.text || ''));
  if (!haystack) return 0;
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(needle)}([^a-z0-9]|$)`);
  return re.test(haystack) || haystack.includes(needle) ? 1 : 0;
}

/** Topic-match component. Case-insensitive; absent topic on either side → 0. */
function topicMatchOf(ev, target) {
  const want = String(target?.topic ?? '').trim().toLowerCase();
  const got = String(ev.topic ?? '').trim().toLowerCase();
  if (!want || !got) return 0;
  return got === want || got.includes(want) ? 1 : 0;
}

/** Normalize a vector hit (retriever.search() or hybridSearch().final shape). */
export function toEvidence(item, type, opts = {}) {
  if (!item || typeof item !== 'object') return null;
  const nodesById = opts.nodesById instanceof Map ? opts.nodesById : new Map();

  const base = {
    id: item.id || item.chunkId || `ev-${Math.random().toString(16).slice(2)}`,
    type,
    text: String(item.text || item.canonicalName || item.sourceText || '').trim(),
    concept: null,
    relation: null,
    score: Number(item.score ?? item.confidence ?? 0) || 0,
    sourceDocumentId: item.sourceDocumentId ?? item.hash ?? null,
    sourceHash: item.hash ?? item.sourceHash ?? null,
    chunkId: item.chunkId ?? null,
    pageNumber: item.pageNumber ?? item.sourcePage ?? null,
    section: item.section ?? null,
    unit: item.unit ?? null,
    topic: item.topic ?? null,
    class: item.class ?? null,
    subject: item.subject ?? null,
    provenance: null,
    contentFidelity: null,
  };

  if (type === 'VECTOR_CHUNK') {
    base.concept = item.concept ?? null;
    base.provenance = {
      sourceDocumentId: item.sourceDocumentId ?? item.hash ?? null,
      sourceDocumentName: item.sourceDocumentName ?? null,
      sourceHash: item.hash ?? item.sourceHash ?? null,
      chunkId: item.chunkId ?? null,
      pageNumber: item.pageNumber ?? item.sourcePage ?? null,
      section: item.section ?? null,
      sourceText: base.text,
    };
  } else {
    // GRAPH_NODE / GRAPH_RELATIONSHIP — keep the graph's own provenance.
    base.concept = item.canonicalName ?? null;
    base.relation = item.relation ?? null;
    base.score = Number(item.confidence ?? 0) || 0;
    if (item.provenance && typeof item.provenance === 'object') {
      const p = item.provenance;
      base.sourceDocumentId = p.sourceDocumentId ?? null;
      base.sourceHash = p.sourceHash ?? null;
      base.chunkId = p.chunkId ?? null;
      base.pageNumber = p.pageNumber ?? null;
      base.section = p.section ?? null;
      base.provenance = {
        sourceDocumentId: p.sourceDocumentId ?? null,
        sourceDocumentName: p.sourceDocumentName ?? null,
        sourceHash: p.sourceHash ?? null,
        chunkId: p.chunkId ?? null,
        pageNumber: p.pageNumber ?? null,
        section: p.section ?? null,
        sourceText: p.sourceText ?? null,
      };
    }
    if (type === 'GRAPH_RELATIONSHIP') {
      const src = nodesById.get(item.source);
      const tgt = nodesById.get(item.target);
      const a = src?.canonicalName ?? String(item.source ?? '').slice(0, 24);
      const b = tgt?.canonicalName ?? String(item.target ?? '').slice(0, 24);
      base.text = `${a} --${item.relation}--> ${b}`;
      base.concept = src?.canonicalName ?? null;
    }
  }

  return base;
}

/** Build the per-evidence contentFidelity record (Phase 8 §10). */
function contentFidelityOf(ev, target) {
  return {
    classMatch: target?.class != null && ev.class != null ? (scopeEquals(ev.class, target.class) === true) : null,
    subjectMatch: target?.subject != null && ev.subject != null ? (scopeEquals(ev.subject, target.subject) === true) : null,
    unitMatch: target?.unit != null && ev.unit != null ? String(ev.unit) === String(target.unit) : null,
    topicMatch: target?.topic != null ? topicMatchOf(ev, target) === 1 : null,
    conceptMatch: target?.concept != null ? conceptMatchOf(ev, target) === 1 : null,
  };
}

/**
 * Hard scope gate (Phase 8 §10/§11): wrong class/subject/unit drops the item.
 * Missing fields pass (never treated as wrong — legacy metadata gaps).
 * @returns {{ keep: boolean, reason: string|null }}
 */
function scopeGate(ev, target) {
  if (ev.class != null && target?.class != null) {
    const ok = scopeEquals(ev.class, target.class);
    if (ok === false) return { keep: false, reason: `class=${ev.class}≠${target.class}` };
  }
  if (ev.subject != null && target?.subject != null) {
    const ok = scopeEquals(ev.subject, target.subject);
    if (ok === false) return { keep: false, reason: `subject=${ev.subject}≠${target.subject}` };
  }
  if (ev.unit != null && target?.unit != null) {
    if (String(ev.unit) !== String(target.unit)) return { keep: false, reason: `unit=${ev.unit}≠${target.unit}` };
  }
  return { keep: true, reason: null };
}

function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0));
}

function round(v) {
  return Math.round(Number(v) * 100000) / 100000;
}

/**
 * Deterministic transparent scoring (Phase 8 §8):
 *   finalScore = vectorScore*vectorWeight + graphScore*graphWeight
 *              + conceptMatch*conceptWeight + topicMatch*topicWeight
 *              + provenanceConfidence*provenanceWeight
 */
export function scoreEvidence(ev, { weights = DEFAULT_WEIGHTS, target } = {}) {
  const vectorScore = ev.type === 'VECTOR_CHUNK' ? clamp01(Number(ev.score) || 0) : 0;
  const graphScore = ev.type !== 'VECTOR_CHUNK' ? clamp01(Number(ev.score) || 0) : 0;
  const concept = conceptMatchOf(ev, target);
  const topic = topicMatchOf(ev, target);
  const prov = provenanceConfidenceOf(ev);
  const final =
    vectorScore * weights.vector
    + graphScore * weights.graph
    + concept * weights.concept
    + topic * weights.topic
    + prov * weights.provenance;
  return {
    final: round(final),
    components: {
      vectorScore: round(vectorScore),
      graphScore: round(graphScore),
      conceptMatch: round(concept),
      topicMatch: round(topic),
      provenanceConfidence: round(prov),
    },
  };
}

/**
 * Fuse vector hits + graph nodes + graph relationships into one unified,
 * scored, provenance-preserving, deduplicated evidence list.
 * @param {Object} args - { vectorHits, graphNodes, graphRelationships, target }
 * @param {Object} [opts] - { weights, limit, dropWrongScope=true }
 * @returns {{ vectorEvidence, graphEvidence, combinedEvidence, provenance, scores, diagnostics }}
 */
export function fuseEvidence(args = {}, opts = {}) {
  const { vectorHits = [], graphNodes = [], graphRelationships = [], target = {} } = args;
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) >= 0 ? Math.floor(Number(opts.limit)) : null;
  const dropWrongScope = opts.dropWrongScope !== false;

  const nodesById = new Map();
  for (const n of Array.isArray(graphNodes) ? graphNodes : []) {
    if (n?.id) nodesById.set(n.id, n);
  }

  const diagnostics = {
    droppedWrongScope: 0,
    droppedWrongScopeReasons: [],
    dedupedCount: 0,
    vectorInput: Array.isArray(vectorHits) ? vectorHits.length : 0,
    graphNodeInput: Array.isArray(graphNodes) ? graphNodes.length : 0,
    graphRelationshipInput: Array.isArray(graphRelationships) ? graphRelationships.length : 0,
  };

  const vectorEvidence = [];
  const graphEvidence = [];
  const scores = {};

  const push = (ev, bucket) => {
    if (!ev) return;
    ev.contentFidelity = contentFidelityOf(ev, target);
    if (dropWrongScope) {
      const gate = scopeGate(ev, target);
      if (!gate.keep) {
        diagnostics.droppedWrongScope += 1;
        if (diagnostics.droppedWrongScopeReasons.length < 12) diagnostics.droppedWrongScopeReasons.push(`${ev.type}:${gate.reason}`);
        return;
      }
    }
    const { final, components } = scoreEvidence(ev, { weights, target });
    ev.score = final;
    scores[ev.id] = final;
    ev.scoreComponents = components;
    bucket.push(ev);
  };

  // 1. Vector chunks are the academic authority — always first.
  for (const hit of vectorHits) push(toEvidence(hit, 'VECTOR_CHUNK'), vectorEvidence);
  // 2. Graph nodes.
  for (const n of graphNodes) push(toEvidence(n, 'GRAPH_NODE', { nodesById }), graphEvidence);
  // 3. Graph relationships (deduped against already-present vector text).
  const vectorTexts = vectorEvidence.map((e) => normalizeForComparision(e.text));
  const relSeen = new Set(); // normalized relationship text seen among graph items
  for (const r of graphRelationships) {
    const ev = toEvidence(r, 'GRAPH_RELATIONSHIP', { nodesById });
    if (!ev) continue;
    const relText = normalizeForComparision(ev.provenance?.sourceText || ev.text);
    const restatesVector = relText && vectorTexts.some((vt) => nearSame(relText, vt));
    const duplicateRel = relText && relSeen.has(relText);
    if (restatesVector || duplicateRel) {
      diagnostics.dedupedCount += 1;
      continue;
    }
    if (relText) relSeen.add(relText);
    push(ev, graphEvidence);
  }

  const combinedEvidence = [...vectorEvidence, ...graphEvidence].sort((a, b) => b.score - a.score);

  // Unique provenance rows (sourceDocumentId::chunkId), as graph-retriever does.
  const provenanceByKey = new Map();
  for (const ev of combinedEvidence) {
    const p = ev.provenance;
    if (!p?.sourceDocumentId && !p?.sourceHash) continue;
    const key = `${p.sourceDocumentId ?? ''}::${p.chunkId ?? ''}`;
    if (!provenanceByKey.has(key)) provenanceByKey.set(key, p);
  }

  if (limit != null && limit > 0 && combinedEvidence.length > limit) {
    combinedEvidence.length = limit;
  }

  diagnostics.vectorEvidence = vectorEvidence.length;
  diagnostics.graphEvidence = graphEvidence.length;
  diagnostics.combinedEvidence = combinedEvidence.length;

  return {
    vectorEvidence,
    graphEvidence,
    combinedEvidence,
    provenance: [...provenanceByKey.values()],
    scores,
    diagnostics,
  };
}

export default { fuseEvidence, toEvidence, scoreEvidence, DEFAULT_WEIGHTS, EVIDENCE_TYPES };