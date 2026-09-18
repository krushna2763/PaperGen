/**
 * graph-store.js — Phase 7 Knowledge Graph foundation: persistence.
 *
 * Copies server/src/services/paper-archive-store.js's pattern exactly: no
 * MongoDB/Neo4j/Redis/SQLite in this repo, so a generated artifact that must
 * survive a restart gets a plain JSON file (write-to-.tmp, then rename, with
 * a Windows in-place-write fallback) plus an in-memory Map mirror for fast
 * reads. Same "this deployment has no Redis" reasoning as that store.
 *
 * Node/relationship ids are deterministic (graph-schema.js's buildNodeId /
 * buildRelationshipId), so upsert is naturally idempotent — re-building the
 * same source document twice replaces the same rows instead of duplicating
 * them, exactly like stablePointId does for Qdrant syllabus points.
 *
 * Phase 7 scope: this store is NOT wired into ingestion/retrieval/generation.
 * It is populated by a separate, explicit build step (see graph-retriever.js
 * and the OOP build script) — Phase 8 decides whether/how it feeds requests.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'knowledge-graph.json');
const FILE = () => process.env.KNOWLEDGE_GRAPH_FILE || DEFAULT_FILE;

/** id -> node / id -> relationship */
let nodes = new Map();
let relationships = new Map();

function load() {
  nodes = new Map();
  relationships = new Map();
  try {
    const raw = readFileSync(FILE(), 'utf8');
    const doc = JSON.parse(raw);
    if (Array.isArray(doc?.nodes)) for (const n of doc.nodes) if (n && n.id) nodes.set(n.id, n);
    if (Array.isArray(doc?.relationships)) for (const r of doc.relationships) if (r && r.id) relationships.set(r.id, r);
  } catch {
    // missing / unreadable / bad JSON => start empty
  }
}

function persist() {
  const file = FILE();
  const json = JSON.stringify({ nodes: [...nodes.values()], relationships: [...relationships.values()] }, null, 2);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, json, 'utf8');
    try {
      renameSync(tmp, file);
    } catch {
      // Windows rename-over-existing can transiently fail (EPERM/EEXIST while
      // the target is briefly locked by an indexer/AV) — fall back in-place.
      writeFileSync(file, json, 'utf8');
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  } catch (err) {
    console.error('[Knowledge Graph] persist failed:', err.message);
  }
}

load();

function matchesFilters(node, { class: cls, subject, unit, type, minConfidence } = {}) {
  if (cls != null && String(node.class) !== String(cls)) return false;
  if (subject != null && String(node.subject).toLowerCase() !== String(subject).toLowerCase()) return false;
  if (unit != null && String(node.unit) !== String(unit)) return false;
  if (type != null && node.type !== type) return false;
  if (minConfidence != null && !(node.confidence >= minConfidence)) return false;
  return true;
}

export const graphStore = {
  /** Idempotent insert/replace of one node. */
  upsertNode(node) {
    nodes.set(node.id, structuredClone(node));
    persist();
    return structuredClone(nodes.get(node.id));
  },

  /** Idempotent insert/replace of one relationship. Both endpoints must already exist. */
  upsertRelationship(edge) {
    relationships.set(edge.id, structuredClone(edge));
    persist();
    return structuredClone(relationships.get(edge.id));
  },

  /** @returns {object|null} a copy, never the live object. */
  getNode(id) {
    const n = nodes.get(String(id ?? ''));
    return n ? structuredClone(n) : null;
  },

  /** @returns {object|null} */
  getRelationship(id) {
    const r = relationships.get(String(id ?? ''));
    return r ? structuredClone(r) : null;
  },

  /** @param {{class?, subject?, unit?, type?, minConfidence?}} filters */
  findNodes(filters = {}) {
    return [...nodes.values()].filter((n) => matchesFilters(n, filters)).map((n) => structuredClone(n));
  },

  /** @param {{class, subject, unit?, type?, canonicalName}} args */
  findNodeByCanonicalName({ class: cls, subject, unit, type, canonicalName } = {}) {
    const needle = String(canonicalName ?? '').trim().toLowerCase();
    const found = [...nodes.values()].find((n) => {
      if (!matchesFilters(n, { class: cls, subject, unit, type })) return false;
      return n.canonicalName.trim().toLowerCase() === needle || (n.aliases || []).some((a) => String(a).trim().toLowerCase() === needle);
    });
    return found ? structuredClone(found) : null;
  },

  /**
   * 1-hop neighbors of a node.
   * @param {string} nodeId
   * @param {{direction?: 'out'|'in'|'both', relation?: string, minConfidence?: number}} [options]
   * @returns {Array<{node: object, relationship: object}>}
   */
  findRelated(nodeId, options = {}) {
    const direction = options.direction || 'both';
    const out = [];
    for (const r of relationships.values()) {
      if (options.relation && r.relation !== options.relation) continue;
      if (options.minConfidence != null && !(r.confidence >= options.minConfidence)) continue;
      if ((direction === 'out' || direction === 'both') && r.source === nodeId) {
        const n = nodes.get(r.target);
        if (n) out.push({ node: structuredClone(n), relationship: structuredClone(r) });
      }
      if ((direction === 'in' || direction === 'both') && r.target === nodeId) {
        const n = nodes.get(r.source);
        if (n) out.push({ node: structuredClone(n), relationship: structuredClone(r) });
      }
    }
    return out;
  },

  /**
   * Bounded-depth traversal from one starting node. Never sweeps the whole
   * graph: depth defaults to 2 hops and is hard-capped at 5 regardless of
   * what a caller requests.
   * @param {string} nodeId
   * @param {{maxDepth?: number, minConfidence?: number, relation?: string}} [options]
   * @returns {{nodes: object[], relationships: object[]}}
   */
  getSubgraph(nodeId, options = {}) {
    const maxDepth = Math.min(5, Math.max(0, options.maxDepth ?? 2));
    const start = nodes.get(String(nodeId ?? ''));
    if (!start) return { nodes: [], relationships: [] };

    const visitedNodes = new Map([[start.id, start]]);
    const visitedRels = new Map();
    let frontier = [start.id];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next = [];
      for (const id of frontier) {
        for (const { node, relationship } of this.findRelated(id, { relation: options.relation, minConfidence: options.minConfidence })) {
          visitedRels.set(relationship.id, relationship);
          if (!visitedNodes.has(node.id)) {
            visitedNodes.set(node.id, node);
            next.push(node.id);
          }
        }
      }
      frontier = next;
    }
    const startCopy = visitedNodes.get(start.id);
    return {
      nodes: [...visitedNodes.values()].map((n) => (n === startCopy ? structuredClone(n) : n)),
      relationships: [...visitedRels.values()],
    };
  },

  /** Remove every node/relationship whose provenance points at this source document. */
  deleteDocumentGraph({ sourceDocumentId, sourceHash } = {}) {
    let removedNodes = 0;
    let removedRels = 0;
    const matches = (p) => (sourceDocumentId != null && p?.sourceDocumentId === sourceDocumentId) || (sourceHash != null && p?.sourceHash === sourceHash);
    for (const [id, n] of nodes) {
      if (matches(n.provenance)) {
        nodes.delete(id);
        removedNodes += 1;
      }
    }
    for (const [id, r] of relationships) {
      if (matches(r.provenance)) {
        relationships.delete(id);
        removedRels += 1;
      }
    }
    persist();
    return { removedNodes, removedRels };
  },

  getStats() {
    return { nodeCount: nodes.size, relationshipCount: relationships.size };
  },

  clear() {
    nodes = new Map();
    relationships = new Map();
    persist();
  },

  /** Test hook — re-read from KNOWLEDGE_GRAPH_FILE (which tests point at a tmp path). */
  _reload() {
    load();
  },
};

export default graphStore;
