/**
 * blueprint-schema.js
 *
 * Canonical data model for a LOCKED previous-year paper blueprint.
 *
 * A blueprint is a STRUCTURAL fingerprint of a reference paper — question
 * types, marks, item counts, sections and optional-answer rules — extracted
 * deterministically from the already-parsed questions. It deliberately does
 * NOT contain question content; content is regenerated fresh by the LLM while
 * the blueprint constrains the structure.
 *
 * Responsibilities live in the other blueprint modules:
 *   - blueprint-extractor.js  : reference paper → blueprint (deterministic)
 *   - blueprint-normalizer.js : raw/messy blueprint → canonical blueprint
 *   - blueprint-validator.js  : generated paper vs blueprint (per slot)
 */

/** Question types the free-form generator may emit on its own. */
export const GENERATOR_TYPES = ['MCQ', 'SHORT_ANSWER', 'LONG_ANSWER', 'TRUE_FALSE', 'FILL_IN_THE_BLANK'];

/**
 * Full set of question types a blueprint slot may carry. These are the types
 * found in real school papers; the generator is only allowed to use them when
 * a blueprint is locked (otherwise it stays within GENERATOR_TYPES).
 *
 * This is deliberately NOT a closed enumeration: papers with a structure the
 * classifier cannot name still get the generic 'UNKNOWN' type plus a warning,
 * and the analyzer never branches on subject/school/class.
 */
export const BLUEPRINT_TYPES = [
  ...GENERATOR_TYPES,
  // IMAGE_BASED — a first-class type for questions requiring visual interpretation of an associated image
  'IMAGE_BASED',
  // MIXED — a first-class type for a MAIN question whose sub-items are NOT all
  // the same type (e.g. "Fill in the blanks AND choose the correct answer":
  // two FILL_IN_THE_BLANK items beside two MCQ items). The parent type is
  // MIXED; items[].type is authoritative for generation, validation, rendering
  // and the answer key. Never inferred from the first/last item.
  'MIXED',
  'VERY_SHORT_ANSWER',
  'ESSAY',
  'EXPLAIN',
  'DIFFERENTIATE',
  'COMPARE',
  'MATCH_THE_FOLLOWING',
  'DEFINITION',
  'MAP',
  'DIAGRAM',
  'DRAWING',
  'PASSAGE',
  'COMPREHENSION',
  'CASE_BASED',
  'GRAMMAR',
  'CREATIVE_WRITING',
  'LETTER',
  'NOTICE',
  'NUMERICAL',
  'PROBLEM_SOLVING',
  'PROOF',
  'APPLICATION',
  'INTERNAL_CHOICE',
  'UNKNOWN',
];

/** Loose aliases so extractor/normalizer can canonicalize messy labels. */
const TYPE_ALIASES = {
  IMAGE_BASED: ['IMAGE_BASED', 'PICTURE_BASED', 'IMAGE', 'PICTURE', 'VISUAL', 'DIAGRAM_BASED', 'FIGURE_BASED', 'IMAGE_QUESTION'],
  MIXED: ['MIXED', 'MIXED_TYPE', 'HETEROGENEOUS', 'COMBINED', 'COMPOSITE'],
  MCQ: ['MCQ', 'MULTIPLE_CHOICE', 'MULTIPLE_CHOICE_QUESTION', 'CHOOSE_THE_CORRECT_OPTION', 'CHOOSE_THE_CORRECT'],
  TRUE_FALSE: ['TRUE_FALSE', 'TRUE_OR_FALSE', 'TRUE/FALSE', 'TRUE_FALSE_TYPE'],
  FILL_IN_THE_BLANK: ['FILL_IN_THE_BLANK', 'FILL_IN_THE_BLANKS', 'FILL_IN_THE_BLANKS_TYPE'],
  MATCH_THE_FOLLOWING: ['MATCH_THE_FOLLOWING', 'MATCH'],
  SHORT_ANSWER: ['SHORT_ANSWER', 'SHORT', 'SA'],
  VERY_SHORT_ANSWER: ['VERY_SHORT_ANSWER', 'VSA', 'VERY_SHORT'],
  LONG_ANSWER: ['LONG_ANSWER', 'LONG', 'LA'],
  ESSAY: ['ESSAY', 'ESSAY_TYPE'],
  EXPLAIN: ['EXPLAIN'],
  DIFFERENTIATE: ['DIFFERENTIATE', 'DIFFERENTIATION'],
  COMPARE: ['COMPARE', 'COMPARISON'],
  DEFINITION: ['DEFINITION', 'DEFINE'],
  MAP: ['MAP', 'MAP_WORK', 'MAP_POINTING'],
  DIAGRAM: ['DIAGRAM', 'LABELLED_DIAGRAM', 'DRAW_A_DIAGRAM'],
  DRAWING: ['DRAWING', 'DRAW', 'DRAW_AND_LABEL'],
  PASSAGE: ['PASSAGE', 'READING_COMPREHENSION'],
  COMPREHENSION: ['COMPREHENSION'],
  CASE_BASED: ['CASE_BASED', 'CASE_STUDY'],
  GRAMMAR: ['GRAMMAR'],
  CREATIVE_WRITING: ['CREATIVE_WRITING', 'WRITING', 'STORY_WRITING', 'PARAGRAPH_WRITING'],
  LETTER: ['LETTER', 'LETTER_WRITING', 'FORMAL_LETTER', 'INFORMAL_LETTER'],
  NOTICE: ['NOTICE', 'NOTICE_WRITING'],
  NUMERICAL: ['NUMERICAL', 'NUMERICALS'],
  PROBLEM_SOLVING: ['PROBLEM_SOLVING', 'PROBLEM'],
  PROOF: ['PROOF', 'PROVE'],
  APPLICATION: ['APPLICATION'],
  INTERNAL_CHOICE: ['INTERNAL_CHOICE', 'CHOICE', 'CHOOSE_ANY', 'OR_TYPE'],
  UNKNOWN: ['UNKNOWN', 'CUSTOM'],
};

/** Number words → digits, used for "(any four)"-style optional rules. */
export const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/**
 * Canonicalize any type label into the blueprint type set.
 * @param {*} value - e.g. "MCQ", "true or false", "MATCH_THE_FOLLOWING", "Map"
 * @returns {string} One of BLUEPRINT_TYPES
 */
export function normalizeBlueprintType(value) {
  if (value == null) return 'UNKNOWN';
  const v = String(value).trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_/]/g, '');
  if (!v) return 'UNKNOWN';
  if (BLUEPRINT_TYPES.includes(v)) return v;

  for (const [canon, aliases] of Object.entries(TYPE_ALIASES)) {
    if (aliases.some((a) => v === a || v.startsWith(a))) return canon;
  }
  // Loose heuristic fallbacks for common wordings
  if (v.includes('TRUE') && v.includes('FALSE')) return 'TRUE_FALSE';
  if (v.includes('FILL') && v.includes('BLANK')) return 'FILL_IN_THE_BLANK';
  if (v.includes('MATCH')) return 'MATCH_THE_FOLLOWING';
  if (v.includes('MAP')) return 'MAP';
  if (v.includes('DRAW')) return 'DRAWING';
  if (v.includes('DEFINE')) return 'DEFINITION';
  if (v.includes('MCQ') || v.includes('CHOOSE')) return 'MCQ';
  if (v.includes('READ')) return 'PASSAGE';
  if (v.includes('STORY') || v.includes('ESSAY') || v.includes('LETTER')) return 'CREATIVE_WRITING';
  return 'UNKNOWN';
}

/**
 * The canonical PARENT type for a main question, from its item types.
 *
 * THE canonical rule (shared by the extractor and the normalizer so the two
 * can never disagree):
 *   - no known item types            → null  (caller keeps its own guess)
 *   - every known item type is equal → that type
 *   - two or more distinct known types → 'MIXED'
 *
 * `null` / 'UNKNOWN' item types are ignored — a single unknown item does not
 * make an otherwise-homogeneous slot MIXED, and an all-unknown slot returns
 * null so the caller's stem-based classification still wins.
 *
 * @param {Array<string|null|undefined>} itemTypes
 * @returns {string|null} a BLUEPRINT_TYPES value, 'MIXED', or null
 */
export function deriveQuestionType(itemTypes) {
  const known = (Array.isArray(itemTypes) ? itemTypes : [])
    .map((t) => normalizeBlueprintType(t))
    .filter((t) => t && t !== 'UNKNOWN');
  if (known.length === 0) return null;
  const distinct = [...new Set(known)];
  return distinct.length === 1 ? distinct[0] : 'MIXED';
}

/**
 * The canonical ANSWER FORM tag for one item, from its type (+ recovered
 * option count for MCQ). Deterministic; used by the extractor, the generator
 * prompt and the answer validator so all three agree on what an item's answer
 * looks like.
 * @param {string} type - a BLUEPRINT_TYPES value
 * @param {number|null} [optionCount]
 * @returns {string}
 */
export function answerFormForType(type, optionCount = null) {
  const t = normalizeBlueprintType(type);
  switch (t) {
    case 'MCQ':
      return 'single-correct-option';
    case 'FILL_IN_THE_BLANK':
      return 'fill-in-blank';
    case 'TRUE_FALSE':
      return 'true-or-false';
    case 'MATCH_THE_FOLLOWING':
      return 'match-pairs';
    case 'SHORT_ANSWER':
    case 'VERY_SHORT_ANSWER':
      return 'short-sentence';
    case 'LONG_ANSWER':
    case 'ESSAY':
    case 'EXPLAIN':
      return 'extended-answer';
    default:
      return Number(optionCount) >= 2 ? 'single-correct-option' : 'free-response';
  }
}

/**
 * Basic shape sanity check for a blueprint (before trusting it in the pipeline).
 *
 * This is deliberately LENIENT: it only rejects blueprints that cannot drive
 * generation at all (empty question list, inconsistent totals). Unknown marks
 * or types are allowed — the per-slot validator only enforces the fields the
 * blueprint actually knows (unknown marks/types skip those checks).
 * @param {Object} blueprint
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkBlueprintShape(blueprint) {
  const reasons = [];
  if (!blueprint || typeof blueprint !== 'object') {
    return { ok: false, reasons: ['Blueprint is missing.'] };
  }
  if (!Array.isArray(blueprint.questions) || blueprint.questions.length === 0) {
    reasons.push('Blueprint has no questions.');
  }
  if (Number.isFinite(Number(blueprint.totalQuestions)) && Number(blueprint.totalQuestions) !== (blueprint.questions || []).length) {
    reasons.push('Blueprint totalQuestions does not match its question list.');
  }
  return { ok: reasons.length === 0, reasons };
}

export default {
  GENERATOR_TYPES,
  BLUEPRINT_TYPES,
  NUMBER_WORDS,
  normalizeBlueprintType,
  deriveQuestionType,
  answerFormForType,
  checkBlueprintShape,
};