/**
 * graph-schema.js — Phase 7 Knowledge Graph foundation: node/relationship
 * shape, validation, and deterministic stable IDs.
 *
 * Isolated from the rest of the app by design (Phase 7 scope) — this module
 * has no import from rag/, agents/, or blueprint/. It mirrors two existing
 * conventions rather than inventing new ones:
 *  - stablePointId() in rag/qdrant.js: a full SHA-256 digest, not the
 *    collision-prone generateStableUUID linear-hash expansion.
 *  - canonicalScopeKey() in rag/qdrant.js: class/subject are folded
 *    (trim + collapse whitespace + lowercase) for identity, while unit keeps
 *    its exact form — the same rule applied here to canonicalName too, so
 *    trivial case/whitespace variants of the SAME name collapse to one node
 *    automatically. This is plain case-folding, not fuzzy matching; genuine
 *    alias merging (e.g. "JVM" vs "Java Virtual Machine") is a separate,
 *    confidence-gated step in graph-normalizer.js.
 */
import { createHash } from 'node:crypto';

export const NODE_TYPES = Object.freeze([
  'UNIT', 'TOPIC', 'SUBTOPIC', 'CONCEPT', 'TERM', 'FACT', 'EXAMPLE',
  'PERSON', 'EVENT', 'PROCESS', 'OBJECT', 'SKILL',
]);

// Base set from the Phase 7 spec, extended with PROVIDES — the OOP validation
// fixture (JDK --PROVIDES--> Compiler/Debugger) needs a relation the base 16
// don't cover, and the spec explicitly asks for this list to stay extensible.
export const RELATIONSHIP_TYPES = Object.freeze([
  'CONTAINS', 'PART_OF', 'RELATED_TO', 'IS_A', 'HAS_PROPERTY', 'CAUSES',
  'RESULTS_IN', 'USED_FOR', 'EXAMPLE_OF', 'DEPENDS_ON', 'COMPARED_WITH',
  'DIFFERENT_FROM', 'CONSISTS_OF', 'PRODUCES', 'ENABLES', 'PRECEDES',
  'PROVIDES',
]);

const NODE_TYPE_SET = new Set(NODE_TYPES);
const RELATIONSHIP_TYPE_SET = new Set(RELATIONSHIP_TYPES);

function fold(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function sha256(input) {
  return createHash('sha256').update(String(input)).digest('hex');
}

/**
 * Deterministic node id. class/subject/canonicalName are case/whitespace
 * folded (same convention as rag/qdrant.js's canonicalScopeKey); unit keeps
 * its exact form so "Unit 1" and "unit 1" are NOT silently treated as the
 * same unit at the identity layer.
 */
export function buildNodeId({ class: cls, subject, unit, type, canonicalName }) {
  const key = [fold(cls), fold(subject), unit != null ? String(unit) : '', String(type ?? ''), fold(canonicalName)].join('::');
  return `n_${sha256(key).slice(0, 40)}`;
}

/** Deterministic relationship id — changes if source, target, relation, or scope changes. */
export function buildRelationshipId({ source, relation, target, class: cls, subject, unit }) {
  const key = [String(source ?? ''), String(relation ?? ''), String(target ?? ''), fold(cls), fold(subject), unit != null ? String(unit) : ''].join('::');
  return `e_${sha256(key).slice(0, 40)}`;
}

function isFiniteInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validateProvenance(provenance, errors, label) {
  if (!provenance || typeof provenance !== 'object') {
    errors.push(`${label}.provenance is required`);
    return;
  }
  if (provenance.sourceDocumentId == null || String(provenance.sourceDocumentId).trim() === '') {
    errors.push(`${label}.provenance.sourceDocumentId is required`);
  }
  if (provenance.chunkId == null || String(provenance.chunkId).trim() === '') {
    errors.push(`${label}.provenance.chunkId is required`);
  }
  // sourceHash, pageNumber, section, sourceDocumentName, sourceText: optional,
  // may be null. Never fabricated when unavailable (Phase 7 spec section 15).
}

/** @returns {{ ok: boolean, errors: string[] }} */
export function validateNode(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['node input is required'] };

  if (!NODE_TYPE_SET.has(input.type)) errors.push(`type must be one of NODE_TYPES (got: ${input.type})`);
  if (input.canonicalName == null || String(input.canonicalName).trim() === '') errors.push('canonicalName is required');
  if (input.class == null || String(input.class).trim() === '') errors.push('class is required');
  if (input.subject == null || String(input.subject).trim() === '') errors.push('subject is required');
  if (!isFiniteInRange(input.confidence, 0, 1)) errors.push('confidence must be a finite number between 0 and 1');
  validateProvenance(input.provenance, errors, 'node');

  return { ok: errors.length === 0, errors };
}

/** Builds + validates a node, computing its deterministic id. Throws on invalid input. */
export function createNode(input) {
  const { ok, errors } = validateNode(input);
  if (!ok) throw new Error(`Invalid graph node: ${errors.join('; ')}`);
  const canonicalName = String(input.canonicalName).trim();
  const id = buildNodeId({ class: input.class, subject: input.subject, unit: input.unit ?? null, type: input.type, canonicalName });
  return {
    id,
    type: input.type,
    canonicalName,
    aliases: Array.isArray(input.aliases) ? [...new Set(input.aliases.filter(Boolean))] : [],
    class: String(input.class),
    subject: String(input.subject),
    unit: input.unit != null ? String(input.unit) : null,
    topic: input.topic != null ? String(input.topic) : null,
    confidence: input.confidence,
    provenance: {
      sourceDocumentId: input.provenance.sourceDocumentId,
      sourceDocumentName: input.provenance.sourceDocumentName ?? null,
      sourceHash: input.provenance.sourceHash ?? null,
      chunkId: input.provenance.chunkId,
      pageNumber: input.provenance.pageNumber ?? null,
      section: input.provenance.section ?? null,
      sourceText: input.provenance.sourceText ?? null,
    },
  };
}

/** @returns {{ ok: boolean, errors: string[] }} */
export function validateRelationship(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['relationship input is required'] };

  if (input.source == null || String(input.source).trim() === '') errors.push('source is required');
  if (input.target == null || String(input.target).trim() === '') errors.push('target is required');
  if (!RELATIONSHIP_TYPE_SET.has(input.relation)) errors.push(`relation must be one of RELATIONSHIP_TYPES (got: ${input.relation})`);
  if (input.class == null || String(input.class).trim() === '') errors.push('class is required');
  if (input.subject == null || String(input.subject).trim() === '') errors.push('subject is required');
  if (!isFiniteInRange(input.confidence, 0, 1)) errors.push('confidence must be a finite number between 0 and 1');
  validateProvenance(input.provenance, errors, 'relationship');

  return { ok: errors.length === 0, errors };
}

/** Builds + validates a relationship, computing its deterministic id. Throws on invalid input. */
export function createRelationship(input) {
  const { ok, errors } = validateRelationship(input);
  if (!ok) throw new Error(`Invalid graph relationship: ${errors.join('; ')}`);
  const id = buildRelationshipId({ source: input.source, relation: input.relation, target: input.target, class: input.class, subject: input.subject, unit: input.unit ?? null });
  return {
    id,
    source: input.source,
    relation: input.relation,
    target: input.target,
    class: String(input.class),
    subject: String(input.subject),
    unit: input.unit != null ? String(input.unit) : null,
    confidence: input.confidence,
    provenance: {
      sourceDocumentId: input.provenance.sourceDocumentId,
      sourceDocumentName: input.provenance.sourceDocumentName ?? null,
      sourceHash: input.provenance.sourceHash ?? null,
      chunkId: input.provenance.chunkId,
      pageNumber: input.provenance.pageNumber ?? null,
      section: input.provenance.section ?? null,
      sourceText: input.provenance.sourceText ?? null,
    },
  };
}

export default {
  NODE_TYPES, RELATIONSHIP_TYPES, buildNodeId, buildRelationshipId,
  validateNode, createNode, validateRelationship, createRelationship,
};
