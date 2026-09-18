/**
 * graph-normalizer.js — Phase 7 Knowledge Graph foundation: canonicalization.
 *
 * graph-schema.js's id computation already case/whitespace-folds
 * canonicalName (class/subject too), so trivial spelling variants of the
 * SAME string ("JVM" vs "jvm") are already one node by construction before
 * this module ever runs. What is NOT solved at that layer is a genuine
 * ACRONYM <-> EXPANSION alias ("JVM" vs "Java Virtual Machine") — two
 * entirely different strings that mean the same concept. This module merges
 * exactly that one deterministic, generic pattern (initials-of-the-expansion
 * equal the acronym), gated by a confidence floor, and NEVER merges across a
 * class/subject/unit boundary. It deliberately does not do fuzzy/Levenshtein
 * string-similarity merging — the Phase 7 spec explicitly asks not to.
 */
import { buildNodeId, buildRelationshipId } from './graph-schema.js';

export const DEFAULT_MIN_MERGE_CONFIDENCE = 0.5;

function initialsOf(phrase) {
  return String(phrase)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** Is `short` a plausible acronym of `long` (e.g. "JVM" / "Java Virtual Machine")? */
function isAcronymPair(short, long) {
  if (!/^[A-Z]{2,6}$/.test(short)) return false;
  if (short.toUpperCase() === long.toUpperCase()) return false; // identical strings are handled by id-folding already
  const words = String(long).trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  return initialsOf(long) === short.toUpperCase();
}

function scopeKey(n) {
  return [n.class, n.subject, n.unit ?? '', n.type].join('::');
}

// ── tiny union-find (disjoint set) over node ids ────────────────────────────
function makeDsu() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union };
}

/**
 * @param {{nodes: object[], relationships: object[]}} graph
 * @param {{minMergeConfidence?: number}} [opts]
 * @returns {{nodes: object[], relationships: object[], merges: Array<{from:string,to:string,alias:string}>}}
 */
export function normalizeGraph({ nodes = [], relationships = [] } = {}, opts = {}) {
  const minMergeConfidence = opts.minMergeConfidence ?? DEFAULT_MIN_MERGE_CONFIDENCE;

  const dsu = makeDsu();
  for (const n of nodes) dsu.find(n.id); // register every id, even singletons

  const byScope = new Map();
  for (const n of nodes) {
    const key = scopeKey(n);
    if (!byScope.has(key)) byScope.set(key, []);
    byScope.get(key).push(n);
  }

  for (const group of byScope.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.confidence < minMergeConfidence || b.confidence < minMergeConfidence) continue;
        if (isAcronymPair(a.canonicalName, b.canonicalName) || isAcronymPair(b.canonicalName, a.canonicalName)) {
          dsu.union(a.id, b.id);
        }
      }
    }
  }

  // Build merged node per disjoint set.
  const setMembers = new Map(); // root -> node[]
  for (const n of nodes) {
    const root = dsu.find(n.id);
    if (!setMembers.has(root)) setMembers.set(root, []);
    setMembers.get(root).push(n);
  }

  const idRemap = new Map(); // old id -> new (canonical) id
  const merges = [];
  const mergedNodes = [];

  for (const members of setMembers.values()) {
    if (members.length === 1) {
      mergedNodes.push(members[0]);
      idRemap.set(members[0].id, members[0].id);
      continue;
    }
    // Canonical = longest canonicalName (the expansion, not the acronym);
    // tie-break by highest confidence, then lexical order for determinism.
    const sorted = [...members].sort((a, b) => {
      if (b.canonicalName.length !== a.canonicalName.length) return b.canonicalName.length - a.canonicalName.length;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.canonicalName.localeCompare(b.canonicalName);
    });
    const canonical = sorted[0];
    const aliasSet = new Set(canonical.aliases || []);
    for (const m of members) {
      if (m.id !== canonical.id) aliasSet.add(m.canonicalName);
      for (const a of m.aliases || []) aliasSet.add(a);
    }
    const merged = {
      ...canonical,
      id: buildNodeId({ class: canonical.class, subject: canonical.subject, unit: canonical.unit, type: canonical.type, canonicalName: canonical.canonicalName }),
      aliases: [...aliasSet].filter((a) => a !== canonical.canonicalName),
      confidence: Math.max(...members.map((m) => m.confidence)),
    };
    mergedNodes.push(merged);
    for (const m of members) {
      idRemap.set(m.id, merged.id);
      if (m.id !== merged.id) merges.push({ from: m.id, to: merged.id, alias: m.canonicalName });
    }
  }

  // Remap + dedupe relationships.
  const relByNewId = new Map();
  for (const r of relationships) {
    const newSource = idRemap.get(r.source) ?? r.source;
    const newTarget = idRemap.get(r.target) ?? r.target;
    const newId = buildRelationshipId({ source: newSource, relation: r.relation, target: newTarget, class: r.class, subject: r.subject, unit: r.unit });
    const remapped = { ...r, id: newId, source: newSource, target: newTarget };
    const existing = relByNewId.get(newId);
    if (!existing || remapped.confidence > existing.confidence) relByNewId.set(newId, remapped);
  }

  return { nodes: mergedNodes, relationships: [...relByNewId.values()], merges };
}

export default { normalizeGraph, DEFAULT_MIN_MERGE_CONFIDENCE };
