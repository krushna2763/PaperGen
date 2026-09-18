/**
 * graph-retriever.js — Phase 7 Knowledge Graph foundation: FOUNDATION
 * retrieval only. Exact concept/topic lookup plus bounded-depth traversal
 * (parent/child, related concepts), scoped by class/subject/unit/confidence.
 *
 * Explicitly NOT Phase 8: no Qdrant fusion, no RRF, no ranking against
 * dense/BM25 retrieval, no generation-prompt integration. This just answers
 * "what does the graph know near X" for a given scope.
 */
import { graphStore } from './graph-store.js';

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * @param {Object} args
 * @param {string} args.class
 * @param {string} args.subject
 * @param {string|null} [args.unit]
 * @param {string} [args.topic] - exact topic-node lookup
 * @param {string} [args.concept] - exact concept/term canonicalName (or alias) lookup
 * @param {number} [args.maxDepth=2] - bounded 0-5; foundation default is 1-2 hops
 * @param {number} [args.limit=20] - max nodes returned
 * @param {number} [args.minConfidence]
 * @returns {Promise<{nodes: object[], relationships: object[], provenance: object[], confidence: number}>}
 */
export async function retrieveGraphEvidence({ class: cls, subject, unit, topic, concept, maxDepth = 2, limit = 20, minConfidence } = {}) {
  const startNodes = [];

  if (concept) {
    const n = graphStore.findNodeByCanonicalName({ class: cls, subject, unit, canonicalName: concept });
    if (n) startNodes.push(n);
  } else if (topic) {
    // "topic" is a per-node tag (schema §2) as well as its own TOPIC-type
    // hierarchy node — matching on the tag finds every concept/term filed
    // under it even when no separate TOPIC node was built for this scope yet.
    const needle = String(topic).toLowerCase();
    startNodes.push(...graphStore.findNodes({ class: cls, subject, unit }).filter((n) => n.type === 'TOPIC' ? n.canonicalName.toLowerCase() === needle : String(n.topic ?? '').toLowerCase() === needle));
  } else if (unit) {
    startNodes.push(...graphStore.findNodes({ class: cls, subject, unit, type: 'UNIT' }));
  }

  if (startNodes.length === 0) {
    return { nodes: [], relationships: [], provenance: [], confidence: 0 };
  }

  const nodeById = new Map();
  const relById = new Map();
  for (const start of startNodes) {
    const sub = graphStore.getSubgraph(start.id, { maxDepth, minConfidence });
    for (const n of sub.nodes) if (!nodeById.has(n.id)) nodeById.set(n.id, n);
    for (const r of sub.relationships) if (!relById.has(r.id)) relById.set(r.id, r);
  }

  let resultNodes = [...nodeById.values()];
  if (minConfidence != null) resultNodes = resultNodes.filter((n) => n.confidence >= minConfidence);
  resultNodes = resultNodes.slice(0, limit);
  const keptIds = new Set(resultNodes.map((n) => n.id));
  const resultRels = [...relById.values()].filter((r) => keptIds.has(r.source) && keptIds.has(r.target));

  const provenanceByKey = new Map();
  for (const item of [...resultNodes, ...resultRels]) {
    const p = item.provenance;
    if (!p) continue;
    const key = `${p.sourceDocumentId}::${p.chunkId}`;
    if (!provenanceByKey.has(key)) provenanceByKey.set(key, p);
  }

  return {
    nodes: resultNodes,
    relationships: resultRels,
    provenance: [...provenanceByKey.values()],
    confidence: average([...resultNodes, ...resultRels].map((x) => x.confidence)),
  };
}

export default { retrieveGraphEvidence };
