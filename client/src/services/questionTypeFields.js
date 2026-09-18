/**
 * questionTypeFields.js — client view of the QUESTION TYPE REGISTRY.
 *
 * The server (GET /api/question-types) is the source of truth; this module
 * fetches it once and falls back to the same seven definitions offline, so the
 * builder still works when the API is unreachable. Field rendering is driven
 * by each definition's `fields` — adding a server type needs NO change here
 * (the fallback list only covers the offline case).
 */

export const FALLBACK_TYPES = [
  { id: 'MCQ', label: 'Multiple choice', blueprintType: 'MCQ', itemsIndependent: true, optionMode: 'required', marksMode: 'perItem', countKey: 'itemCount', countLabel: 'Items', countMin: 1, defaultInstruction: 'Choose the correct option:' },
  { id: 'FILL_BLANK', label: 'Fill in the blanks', blueprintType: 'FILL_IN_THE_BLANK', itemsIndependent: true, optionMode: 'optional', marksMode: 'perItem', countKey: 'itemCount', countLabel: 'Items', countMin: 1, defaultInstruction: 'Fill in the blanks:' },
  { id: 'TRUE_FALSE', label: 'True / False', blueprintType: 'TRUE_FALSE', itemsIndependent: true, optionMode: 'none', marksMode: 'perItem', countKey: 'itemCount', countLabel: 'Statements', countMin: 1, defaultInstruction: 'State whether true or false:' },
  { id: 'SHORT_ANSWER', label: 'Short answer', blueprintType: 'SHORT_ANSWER', itemsIndependent: true, optionMode: 'none', marksMode: 'perItem', countKey: 'itemCount', countLabel: 'Items', countMin: 1, defaultInstruction: 'Answer the following questions:' },
  { id: 'LONG_ANSWER', label: 'Long answer', blueprintType: 'LONG_ANSWER', itemsIndependent: true, optionMode: 'none', marksMode: 'perItem', countKey: 'itemCount', countLabel: 'Items', countMin: 1, defaultInstruction: 'Answer the following questions in detail:' },
  { id: 'MATCH', label: 'Match the following', blueprintType: 'MATCH_THE_FOLLOWING', itemsIndependent: true, optionMode: 'none', marksMode: 'whole', countKey: 'itemCount', countLabel: 'Pairs', countMin: 2, defaultInstruction: 'Match the following columns:' },
  { id: 'DIFFERENCE_BETWEEN', label: 'Difference between', blueprintType: 'DIFFERENTIATE', itemsIndependent: true, optionMode: 'none', marksMode: 'perItem', countKey: 'itemCount', countLabel: 'Items', countMin: 1, defaultInstruction: 'Write the difference between the following:' },
  { id: 'IMAGE_BASED', label: 'Image Based', blueprintType: 'IMAGE_BASED', itemsIndependent: false, optionMode: 'none', marksMode: 'perItem', countKey: 'itemCount', countLabel: 'Items', countMin: 1, defaultInstruction: 'Study the following image and answer the questions:' },
];

/** Registry fields each type renders in the builder (mirrors server defs). */
export const FIELD_BY_KEY = {
  itemCount: { key: 'itemCount', label: 'Items', type: 'number', min: 1, step: 1, required: true },
  optionCount: { key: 'optionCount', label: 'Options per item', type: 'number', min: 2, max: 6, step: 1, required: true },
};

export function defOf(types, id) {
  return (types || []).find((t) => t.id === id) || null;
}

/** Fields a type's row shows, in order: count + options (when any). */
export function fieldsFor(def) {
  if (!def) return [];
  const out = [FIELD_BY_KEY.itemCount];
  if (def.optionMode === 'required' || def.optionMode === 'optional') {
    out.push({ ...FIELD_BY_KEY.optionCount, required: def.optionMode === 'required', label: def.optionMode === 'optional' ? 'Word bank (optional)' : FIELD_BY_KEY.optionCount.label });
  }
  return out;
}

/** Whether the type stores whole-question marks instead of per-item marks. */
export function isWholeMarks(def) {
  return def?.marksMode === 'whole';
}
