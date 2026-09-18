/**
 * question-types/index.js — the QUESTION TYPE REGISTRY.
 *
 * One type per module. Adding a type = add one file in this folder and list it
 * in TYPES below; the manual builder, the blueprint validator and the generator
 * need no changes (task §1). Passage- and case-based types are deliberately out
 * of scope but slot in later without restructuring: their definitions would
 * carry itemsIndependent: false and an extra stimulus field constraint.
 */
import mcq from './mcq.js';
import fillBlank from './fill-blank.js';
import trueFalse from './true-false.js';
import shortAnswer from './short-answer.js';
import longAnswer from './long-answer.js';
import matchType from './match.js';
import differenceBetween from './difference-between.js';
import imageBased from './image-based.js';

/** Registration order = display order in the teacher UI. */
export const TYPES = [mcq, fillBlank, trueFalse, shortAnswer, longAnswer, matchType, differenceBetween, imageBased];

/** id → definition. Duplicate ids fail fast at boot. */
const byId = new Map();
for (const def of TYPES) {
  if (byId.has(def.id)) {
    throw new Error(`[question-types] duplicate type id "${def.id}".`);
  }
  byId.set(def.id, def);
}

// ─── One-time structural validation of every definition (fail fast at boot) ──
const REQUIRED_KEYS = ['id', 'label', 'blueprintType', 'itemsIndependent', 'optionMode', 'marksMode', 'countKey', 'countMin', 'fields', 'answerShape'];
// The answer shape a type's items carry, declared alongside its field
// constraints so adding a type stays one file (task §"SCHEMA").
const ANSWER_SHAPES = new Set(['option', 'word', 'boolean', 'text', 'pairs', 'points']);
for (const def of TYPES) {
  for (const key of REQUIRED_KEYS) {
    if (def[key] === undefined) {
      throw new Error(`[question-types] definition "${def.id || '?'}" is missing required key "${key}".`);
    }
  }
  if (!ANSWER_SHAPES.has(def.answerShape)) {
    throw new Error(`[question-types] "${def.id}" answerShape must be one of ${[...ANSWER_SHAPES].join('|')}.`);
  }
  if (typeof def.itemsIndependent !== 'boolean') {
    throw new Error(`[question-types] "${def.id}" itemsIndependent must be a boolean.`);
  }
  if (!['none', 'required', 'optional'].includes(def.optionMode)) {
    throw new Error(`[question-types] "${def.id}" optionMode must be none|required|optional.`);
  }
  if (!['perItem', 'whole'].includes(def.marksMode)) {
    throw new Error(`[question-types] "${def.id}" marksMode must be perItem|whole.`);
  }
  if (def.optionMode === 'required' && !def.fields.some((f) => f.key === 'optionCount')) {
    throw new Error(`[question-types] "${def.id}" requires an optionCount field.`);
  }
}

/**
 * Look up one definition by registry id.
 * @param {string} id
 * @returns {Object|null}
 */
export function getDefinition(id) {
  return byId.get(String(id || '').trim()) ?? null;
}

/** Whether the id is a registered manual type. */
export function hasType(id) {
  return byId.has(String(id || '').trim());
}

/** blueprintType → definition (the pipeline works in blueprintType, not id). */
const byBlueprintType = new Map(TYPES.map((d) => [d.blueprintType, d]));

/**
 * The answer shape for a pipeline (blueprint) question type. Registry types
 * declare their own; types outside the registry (PASSAGE, INTERNAL_CHOICE, …)
 * fall back to free 'text' so the answer field is still produced and checked.
 * @param {string} blueprintType
 * @returns {'option'|'word'|'boolean'|'text'|'pairs'|'points'}
 */
export function answerShapeFor(blueprintType) {
  const t = String(blueprintType || '').trim().toUpperCase();
  const def = byBlueprintType.get(t);
  if (def) return def.answerShape;
  if (t === 'TRUE_FALSE') return 'boolean';
  if (t === 'FILL_IN_THE_BLANK') return 'word';
  if (t === 'MCQ') return 'option';
  if (t === 'MATCH_THE_FOLLOWING') return 'pairs';
  return 'text';
}

/**
 * Client-facing serialization (GET /api/question-types): everything the
 * QuestionBuilder needs to render fields from the registry — no server-internal
 * detail beyond that.
 */
export function listForClient() {
  return TYPES.map((d) => ({
    id: d.id,
    label: d.label,
    blueprintType: d.blueprintType,
    itemsIndependent: d.itemsIndependent,
    optionMode: d.optionMode,
    marksMode: d.marksMode,
    countKey: d.countKey,
    countLabel: d.countLabel,
    countMin: d.countMin,
    fields: d.fields,
    answerShape: d.answerShape,
    defaultInstruction: d.defaultInstruction ?? null,
    generatorHint: d.generatorHint ?? null,
  }));
}

export default { TYPES, getDefinition, hasType, answerShapeFor, listForClient };
