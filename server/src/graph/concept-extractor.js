/**
 * concept-extractor.js — Phase 7 Knowledge Graph foundation: deterministic
 * concept/entity + relationship extraction from already-created educational
 * chunks. Fully generic: the only vocabulary baked in below is a fixed table
 * of English connector phrases ("contains", "provides", "enables", ...) that
 * signal a relationship type — no subject-specific terms. Any OOP/Java
 * vocabulary that appears in tests is TEST DATA, never referenced here.
 *
 * Deliberately deterministic / regex-based, not LLM-based: this keeps
 * extraction free of network calls (no per-sentence or even per-chunk LLM
 * call), reusable offline, and fully unit-testable. The Phase 7 spec allows
 * an LLM-assisted path "when semantic extraction is genuinely required" but
 * does not require one — see the Known Limitations note in the Phase 7
 * report for why this foundation phase stays deterministic-only.
 *
 * Does NOT modify server/src/ingestion/* or server/src/rag/* — this module
 * only reads a chunk-shaped object passed in by the caller.
 */
import { createNode, createRelationship } from './graph-schema.js';

/**
 * Ordered longest-phrase-first so "is a type of" is matched before the
 * shorter "is a" — order in this source array does not matter, the module
 * re-sorts by phrase length at load time.
 */
const RELATION_PATTERNS = [
  { relation: 'IS_A', phrase: 'is a type of' },
  { relation: 'IS_A', phrase: 'is a kind of' },
  { relation: 'IS_A', phrase: 'is an example of' },
  { relation: 'EXAMPLE_OF', phrase: 'for example' },
  { relation: 'EXAMPLE_OF', phrase: 'such as' },
  { relation: 'CONSISTS_OF', phrase: 'consists of' },
  { relation: 'CONSISTS_OF', phrase: 'is made up of' },
  { relation: 'CONSISTS_OF', phrase: 'is composed of' },
  { relation: 'PART_OF', phrase: 'is a part of' },
  { relation: 'PART_OF', phrase: 'is part of' },
  { relation: 'CONTAINS', phrase: 'contains' },
  { relation: 'CONTAINS', phrase: 'includes' },
  { relation: 'DEPENDS_ON', phrase: 'depends on' },
  { relation: 'RESULTS_IN', phrase: 'results in' },
  { relation: 'CAUSES', phrase: 'leads to' },
  { relation: 'CAUSES', phrase: 'causes' },
  { relation: 'PRODUCES', phrase: 'produces' },
  { relation: 'PRODUCES', phrase: 'generates' },
  { relation: 'ENABLES', phrase: 'enables' },
  { relation: 'ENABLES', phrase: 'allows' },
  { relation: 'USED_FOR', phrase: 'is used for' },
  { relation: 'USED_FOR', phrase: 'is used to' },
  { relation: 'PROVIDES', phrase: 'provides' },
  { relation: 'PROVIDES', phrase: 'offers' },
  { relation: 'PRECEDES', phrase: 'comes before' },
  { relation: 'PRECEDES', phrase: 'precedes' },
  { relation: 'COMPARED_WITH', phrase: 'compared with' },
  { relation: 'COMPARED_WITH', phrase: 'compared to' },
  { relation: 'DIFFERENT_FROM', phrase: 'is different from' },
  { relation: 'DIFFERENT_FROM', phrase: 'unlike' },
  { relation: 'IS_A', phrase: 'is an' },
  { relation: 'IS_A', phrase: 'is a' },
  { relation: 'RELATED_TO', phrase: 'is related to' },
  { relation: 'RELATED_TO', phrase: 'related to' },
  { relation: 'RELATED_TO', phrase: 'associated with' },
  { relation: 'HAS_PROPERTY', phrase: 'has' },
]
  .sort((a, b) => b.phrase.length - a.phrase.length)
  .map((p) => ({ ...p, re: new RegExp(`\\b${p.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') }));

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Generic clause-boundary markers (relative pronouns, coordinators,
// subordinators, plus comma/semicolon) used to keep only the fragment of a
// span closest to the relation trigger — never subject-specific vocabulary.
const BOUNDARY_RE = /[,;]|\b(?:that|which|who|whom|whose|where|when|and|or|but|because|while|although|though|so)\b/gi;

/** Keep only the piece of `span` closest to the trigger: everything AFTER the
 * last boundary marker (side='left', span precedes the trigger) or everything
 * BEFORE the first boundary marker (side='right', span follows the trigger). */
function trimToBoundary(span, side) {
  const matches = [...span.matchAll(BOUNDARY_RE)];
  if (matches.length === 0) return span;
  return side === 'left'
    ? span.slice(matches[matches.length - 1].index + matches[matches.length - 1][0].length)
    : span.slice(0, matches[0].index);
}

// Generic filler adverbs that can drift into a trimmed window without
// carrying any of the concept's meaning (e.g. "...JDK also contains..." should
// not name the concept "JDK also"). Not subject-specific.
const ADVERB_NOISE = new Set(['also', 'further', 'then', 'now', 'still', 'even', 'just', 'only', 'simply', 'basically', 'actually']);

function cleanSpan(span) {
  return String(span || '')
    .replace(/^[\s,]+/, '')
    .replace(/[\s,]+$/, '')
    .replace(/^(the|a|an|this|that|these|those)\s+/i, '')
    .replace(/[.?!,;:]+$/, '')
    .trim();
}

function windowWords(span, side, maxWords) {
  const words = span.split(/\s+/).filter((w) => w && !ADVERB_NOISE.has(w.toLowerCase()));
  return (side === 'left' ? words.slice(Math.max(0, words.length - maxWords)) : words.slice(0, maxWords)).join(' ');
}

/** Extract the term closest to the trigger on one side of a sentence. */
function extractTerm(rawSpan, side, maxWords) {
  const trimmed = trimToBoundary(rawSpan, side);
  return cleanSpan(windowWords(trimmed, side, maxWords));
}

/** Whole-string acronym shape (2-6 uppercase letters) => TERM, else CONCEPT. */
function classifyTermType(term) {
  return /^[A-Z]{2,6}$/.test(term) ? 'TERM' : 'CONCEPT';
}

/** Deterministic, feature-based (not random) confidence estimate. */
function estimateConfidence(term, fullText) {
  let score = 0.55;
  if (/^[A-Z]/.test(term) || /^[A-Z]{2,6}$/.test(term)) score += 0.15;
  const mentions = fullText.split(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).length - 1;
  if (mentions > 1) score += 0.1;
  return Math.min(0.9, score);
}

function findRelationInSentence(sentence) {
  for (const p of RELATION_PATTERNS) {
    const m = sentence.match(p.re);
    if (m) return { relation: p.relation, matchIndex: m.index, matchLength: m[0].length };
  }
  return null;
}

/**
 * Extract candidate concept/term nodes and relationships from ONE chunk.
 *
 * @param {Object} chunk
 * @param {string} chunk.text
 * @param {string} chunk.class
 * @param {string} chunk.subject
 * @param {string|null} [chunk.unit]
 * @param {string|null} [chunk.topic]
 * @param {string[]|null} [chunk.headingPath] - optional deeper heading levels; only used to add a SUBTOPIC when the source genuinely has one (never fabricated)
 * @param {string} chunk.sourceDocumentId
 * @param {string|null} [chunk.sourceDocumentName]
 * @param {string|null} [chunk.sourceHash]
 * @param {string} chunk.chunkId
 * @param {number|null} [chunk.pageNumber]
 * @param {string|null} [chunk.section]
 * @returns {{ nodes: object[], relationships: object[] }}
 */
export function extractFromChunk(chunk) {
  const scope = { class: chunk.class, subject: chunk.subject, unit: chunk.unit ?? null };
  const provenanceBase = {
    sourceDocumentId: chunk.sourceDocumentId,
    sourceDocumentName: chunk.sourceDocumentName ?? null,
    sourceHash: chunk.sourceHash ?? null,
    chunkId: chunk.chunkId,
    pageNumber: chunk.pageNumber ?? null,
    section: chunk.section ?? null,
  };

  const nodeById = new Map();
  const relById = new Map();

  const upsertLocalNode = (input) => {
    const n = createNode(input);
    const existing = nodeById.get(n.id);
    if (!existing || n.confidence > existing.confidence) nodeById.set(n.id, n);
    return nodeById.get(n.id);
  };
  const upsertLocalRel = (input) => {
    const r = createRelationship(input);
    const existing = relById.get(r.id);
    if (!existing || r.confidence > existing.confidence) relById.set(r.id, r);
    return relById.get(r.id);
  };

  // ── Hierarchy from existing metadata only (never fabricated) ──────────────
  let unitNode = null;
  let topicNode = null;
  let subtopicNode = null;
  if (chunk.unit != null && String(chunk.unit).trim() !== '') {
    unitNode = upsertLocalNode({
      type: 'UNIT', canonicalName: String(chunk.unit), ...scope, topic: null, confidence: 1,
      provenance: provenanceBase,
    });
  }
  const topicName = Array.isArray(chunk.headingPath) && chunk.headingPath[0] ? chunk.headingPath[0] : chunk.topic;
  if (topicName != null && String(topicName).trim() !== '') {
    topicNode = upsertLocalNode({
      type: 'TOPIC', canonicalName: String(topicName), ...scope, topic: String(topicName), confidence: 1,
      provenance: provenanceBase,
    });
    if (unitNode) {
      upsertLocalRel({ source: unitNode.id, relation: 'CONTAINS', target: topicNode.id, ...scope, confidence: 1, provenance: provenanceBase });
    }
  }
  if (Array.isArray(chunk.headingPath) && chunk.headingPath.length > 1 && chunk.headingPath[1]) {
    subtopicNode = upsertLocalNode({
      type: 'SUBTOPIC', canonicalName: String(chunk.headingPath[1]), ...scope, topic: topicName ? String(topicName) : null, confidence: 1,
      provenance: provenanceBase,
    });
    if (topicNode) {
      upsertLocalRel({ source: topicNode.id, relation: 'CONTAINS', target: subtopicNode.id, ...scope, confidence: 1, provenance: provenanceBase });
    }
  }
  const anchorNode = subtopicNode || topicNode || unitNode || null;

  // ── Sentence-level connector-phrase extraction ────────────────────────────
  const fullText = String(chunk.text || '');
  const anchoredConceptIds = new Set();

  for (const sentence of splitSentences(fullText)) {
    // Parenthetical asides ("JVM (Java Virtual Machine)") are stripped ONLY
    // for locating terms/triggers — provenance.sourceText below keeps the
    // original sentence verbatim.
    const forMatching = sentence.replace(/\([^)]*\)/g, ' ');
    const hit = findRelationInSentence(forMatching);
    if (!hit) continue;

    const leftRaw = extractTerm(forMatching.slice(0, hit.matchIndex), 'left', 4);
    const rightRaw = extractTerm(forMatching.slice(hit.matchIndex + hit.matchLength), 'right', 6);
    if (!leftRaw || !rightRaw) continue;

    const leftNode = upsertLocalNode({
      type: classifyTermType(leftRaw), canonicalName: leftRaw, ...scope, topic: topicName ? String(topicName) : null,
      confidence: estimateConfidence(leftRaw, fullText),
      provenance: { ...provenanceBase, sourceText: sentence },
    });
    const rightNode = upsertLocalNode({
      type: classifyTermType(rightRaw), canonicalName: rightRaw, ...scope, topic: topicName ? String(topicName) : null,
      confidence: estimateConfidence(rightRaw, fullText),
      provenance: { ...provenanceBase, sourceText: sentence },
    });
    anchoredConceptIds.add(leftNode.id);
    anchoredConceptIds.add(rightNode.id);

    upsertLocalRel({
      source: leftNode.id, relation: hit.relation, target: rightNode.id, ...scope,
      confidence: Math.min(leftNode.confidence, rightNode.confidence),
      provenance: { ...provenanceBase, sourceText: sentence },
    });
  }

  // Anchor every extracted concept/term under the deepest hierarchy node this
  // chunk has (topic/subtopic/unit) — using metadata already on the chunk,
  // never inventing a new hierarchy level.
  if (anchorNode) {
    for (const id of anchoredConceptIds) {
      upsertLocalRel({ source: anchorNode.id, relation: 'CONTAINS', target: id, ...scope, confidence: 1, provenance: provenanceBase });
    }
  }

  return { nodes: [...nodeById.values()], relationships: [...relById.values()] };
}

/** Aggregate + dedupe extraction across multiple chunks (same document or a whole ingestion batch). */
export function extractFromChunks(chunks) {
  const nodeById = new Map();
  const relById = new Map();
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const { nodes, relationships } = extractFromChunk(chunk);
    for (const n of nodes) {
      const existing = nodeById.get(n.id);
      if (!existing || n.confidence > existing.confidence) nodeById.set(n.id, n);
    }
    for (const r of relationships) {
      const existing = relById.get(r.id);
      if (!existing || r.confidence > existing.confidence) relById.set(r.id, r);
    }
  }
  return { nodes: [...nodeById.values()], relationships: [...relById.values()] };
}

export default { extractFromChunk, extractFromChunks };
