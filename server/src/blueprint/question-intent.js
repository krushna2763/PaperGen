/**
 * question-intent.js — QUESTION INTENT / CONCEPT SPECIFICATION (PARTS 13/17).
 *
 * The raw reference question must never become the academic retrieval query:
 *   "What did Alice find on the glass table?"  → retrieves a near-identical
 *   notes sentence → Gemini paraphrases it back (the 0.962 similarity case).
 *
 * Instead, each blueprint slot (or per-item reference text) is abstracted into
 * a QUESTION INTENT — a structured description of what the question must test
 * and what form it takes. The retrieval system operates on this representation;
 * the raw reference wording stays available for structural analysis only.
 *
 * Fully generic: no class/subject/unit/question-number special cases. Everything
 * is derived from the slot's own fields (type, cognitiveOperation, pattern,
 * reference text) with lexical classification heuristics.
 */

/** Interrogative frames that carry NO academic content — strip them. */
const INTERROGATIVE_RE =
  /^(what|why|how|which|who|whom|whose|where|when)\s+(did|does|do|is|are|was|were|can|could|will|would|should|has|have|had)?\s*/i;

/** Exam-verb frames that describe the task, not the content — strip them. */
const TASK_VERB_RE =
  /^(explain|describe|state|define|list|give|name|mention|write|differentiate|compare|identify|suggest|justify|illustrate)\b[\s:,-]*/i;

/**
 * A PROGRAMMING/CODE-WRITING reference item — "write/implement/develop a
 * program/function/method/script/class/algorithm to do X". Generic across
 * any subject/language: the pattern is the construction verb + artifact noun,
 * never a specific language or task name (never "Java", never "even
 * numbers"). Used to route these items through construction-aware
 * transformation instead of the academic why/what/compare demand taxonomy,
 * which has no meaning for an imperative coding task.
 */
const CODING_TASK_RE = /\b(?:write|implement|develop|design|create)\b[^.?!]{0,60}\b(?:program|function|method|code|script|class|algorithm|procedure)\b/i;

/** Whether `text` is a programming/code-writing task (Phase 6.1). */
export function isCodingTask(text) {
  return CODING_TASK_RE.test(String(text || ''));
}

/**
 * A cue that the task's input/scope is PARAMETERIZED rather than a hardcoded
 * literal — "accept a value from the user", "for any given array", "an
 * arbitrary number", "a user-specified limit", etc. Generic vocabulary, never
 * tied to a specific task's numbers or wording. Used to tell a genuine
 * fixed→dynamic transformation apart from a cosmetic reword of the same
 * fixed parameters.
 */
const DYNAMIC_INPUT_RE = /\b(?:user|input|enter(?:ed)?|accept(?:s|ed|ing)?|given (?:a|an|any)|any (?:given|number|array|list|value|integer)|arbitrary|user-specified|user-defined|user-provided|specified by|of the user'?s choice|read (?:a|an|the) (?:value|number|input)|parameter|argument)\b/i;

/** Whether `text` carries a dynamic/parameterized-input cue (Phase 6.1). */
export function hasDynamicInputCue(text) {
  return DYNAMIC_INPUT_RE.test(String(text || ''));
}

/** Fixed numeric literal(s) found in a coding-task reference (e.g. a range
 * like "1 to 20", or a bare bound). Returns the raw matched strings, capped —
 * used only to phrase the transformation directive concretely; never used as
 * a hardcoded task name. */
export function fixedNumericLiterals(text) {
  const t = String(text || '');
  const ranged = t.match(/\b\d+\s*(?:to|-|–|—)\s*\d+\b/gi) || [];
  const bare = t.match(/\b\d+\b/g) || [];
  const all = ranged.length > 0 ? ranged : bare;
  return [...new Set(all)].slice(0, 3);
}

/**
 * Cognitive-operation classification from the reference text's leading frame.
 * Order matters: WHY/HOW-style demands are checked before WHAT-style recall.
 * Generic English heuristics — no subject-specific vocabulary.
 */
const OP_PATTERNS = [
  // Phase 6 — framed reasoning demands carry the SAME cognitive operation as
  // their bare interrogative ("Explain why X" ≡ "Why X"); classify them
  // BEFORE the recall fallbacks so a framed restatement never reads as FACT.
  { op: 'REASONING', re: /^(explain|describe|discuss|state|give)\s+why\b/i },
  { op: 'REASONING', re: /^(explain|describe|discuss)\s+how\b/i },
  { op: 'REASONING', re: /^(why|how come)\b/i },
  { op: 'REASONING', re: /^(how)\s+(do|does|did|can|could|will|would)\b/i },
  { op: 'APPLICATION', re: /^(how)\s+(would you|do you|can you)\b/i },
  { op: 'CAUSE', re: /\b(cause|caused|reason|because of|led to)\b/i },
  { op: 'EFFECT', re: /\b(what happens|result|effect|consequence)\b/i },
  { op: 'COMPARISON', re: /\b(difference|differentiate|compare|similar)\b/i },
  { op: 'EXAMPLE', re: /\b(example|instance|such as)\b/i },
  { op: 'PREDICTION', re: /\b(predict|what will happen|next)\b/i },
  { op: 'DEFINITION', re: /^(what is|what are|define|meaning of)\b/i },
  { op: 'FACT', re: /^(what|which|who|where|when|name|list|state)\b/i },
];

/** Per-type hint: what CONTENT the generator can construct the question from. */
const TYPE_CONTENT_HINTS = {
  MCQ: 'objects facts details',
  FILL_IN_THE_BLANK: 'key term fact',
  TRUE_FALSE: 'facts statements',
  SHORT_ANSWER: 'reasons explanation details',
  LONG_ANSWER: 'events sequence explanation summary',
  MATCH_THE_FOLLOWING: 'paired items associations',
  INTERNAL_CHOICE: 'facts explanations',
  MIXED: 'facts details key terms',
};

/**
 * The information demand of a reference text: WHY asks for a reason, HOW for a
 * process, WHAT for an object/fact, DEFINE for a meaning, and so on. Used by
 * both the intent builder and the reference-novelty agent.
 * @param {string} text
 * @returns {'REASON'|'PROCESS'|'OBJECT'|'DEFINITION'|'COMPARISON'|'EXAMPLE'|'PREDICTION'|'STATEMENT'|'UNKNOWN'}
 */
export function informationDemandOf(text) {
  const t = String(text || '').trim();
  // Phase 6 — SEMANTIC-DEMAND HARMONIZATION: "Explain why X" and "Why X" (and
  // "Explain how X" / "How X") carry the SAME information demand. Before this
  // line, "Explain why Java is platform independent" fell through to
  // UNKNOWN/STATEMENT while its true paraphrase "Why is Java platform
  // independent" classified REASON — the demand gate then saw *different*
  // demands and let a same-ask rewrite through. Canonicalize the framed
  // variants onto the same demand as their bare interrogative.
  if (/^(explain|describe|discuss)\s+why\b/i.test(t)) return 'REASON';
  if (/^(explain|describe|discuss)\s+how\b/i.test(t)) return 'PROCESS';
  // REASON cues anywhere in the stem, not just sentence-initial: "What
  // motivates/causes X…?" asks for a REASON even though it starts with "what".
  if (/^(why|what.*reason|give.*reason)/i.test(t) || /\b(motivates|motivate|causes|cause[sd]?\s+(him|her|it|them|alice|the)|led\s+(him|her|it|them)|made\s+(him|her|it|them))\b/i.test(t)) return 'REASON';
  if (/^(how|describe the (process|way)|explain the (process|way))/i.test(t)) return 'PROCESS';
  if (/^(what is|what are|define|meaning of|what do you mean by)/i.test(t)) return 'DEFINITION';
  if (/\b(difference|differentiate|compare)\b/i.test(t)) return 'COMPARISON';
  if (/\b(example|instance)\b/i.test(t)) return 'EXAMPLE';
  if (/\b(predict|what will happen|what happens next)\b/i.test(t)) return 'PREDICTION';
  // "Identify ..." is an identification demand — the answer is the OBJECT to
  // be named. Checked before the generic frame so it cannot fall through.
  if (/^(identify|recognize)\b/i.test(t)) return 'OBJECT';
  if (/^(what|which|who|whose|where|when|name|list)\b/i.test(t)) return 'OBJECT';
  if (/^(state|tell whether|is it true)/i.test(t)) return 'STATEMENT';
  return 'UNKNOWN';
}

/** Content terms of a reference text with the interrogative/task frame stripped:
 * the CONCEPT area the item tests, usable as the retrieval anchor.
 * @param {string} text
 * @returns {string[]}
 */
const CONCEPT_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'his',
  'from', 'that', 'this', 'with', 'has', 'have', 'had', 'did', 'does', 'its', 'their',
]);

export function conceptTerms(text) {
  let t = String(text || '');
  t = t.replace(INTERROGATIVE_RE, ' ');
  t = t.replace(TASK_VERB_RE, ' ');
  t = t.replace(/_{2,}/g, ' '); // fill-blank markers carry no content
  t = t.replace(/[?"'“”‘’.:;,!()]+/g, ' ');
  return t
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 2 && !CONCEPT_STOPWORDS.has(w));
}

/** Answer form of a slot/item, aligned with the blueprint pattern vocabulary. */
function answerFormFor(type, pattern) {
  const form = pattern?.answerForm;
  if (form) return String(form);
  switch (String(type || '').toUpperCase()) {
    case 'MCQ': return 'single-correct-option';
    case 'FILL_IN_THE_BLANK': return 'word-or-phrase';
    case 'TRUE_FALSE': return 'true-or-false';
    case 'SHORT_ANSWER': return 'short-sentence';
    case 'LONG_ANSWER': return 'multi-sentence-explanation';
    case 'MATCH_THE_FOLLOWING': return 'matched-pairs';
    default: return 'unknown';
  }
}

/**
 * Classify the cognitive operation of ONE item (or a whole slot): prefer the
 * slot's own deterministic analysis, fall back to lexical classification.
 * @param {Object} slot - blueprint slot (may carry cognitiveOperation/pattern)
 * @param {Object|null} item - slot items[] entry (referenceText)
 * @returns {string} e.g. FACT | DEFINITION | REASONING | APPLICATION | COMPARISON | EXAMPLE | PREDICTION | CAUSE | EFFECT
 */
export function classifyCognitiveOperation(slot, item) {
  const explicit = String(item?.cognitiveOperation || slot?.cognitiveOperation || '').trim().toUpperCase();
  if (explicit && explicit !== 'UNKNOWN') return explicit;
  const anchor = String(item?.referenceText || (Array.isArray(slot?.referenceItems) ? slot.referenceItems[0] : '') || slot?.instruction || slot?.stem || '');
  for (const { op, re } of OP_PATTERNS) {
    if (re.test(anchor.trim())) return op;
  }
  return 'FACT';
}

/**
 * Build the QUESTION INTENT for one retrieval unit (a slot, or one item of a
 * slot). This is the abstract specification the retrieval system should use —
 * NOT the raw reference wording.
 *
 * @param {Object} slot - blueprint slot
 * @param {Object|null} item - blueprint slot's items[] entry (per-item units)
 * @param {Object} requirements - { class, subject, difficulty, ... }
 * @returns {{
 *   type: string, topic: string, concept: string,
 *   cognitiveOperation: string, answerForm: string, difficulty: string,
 *   unit: string|null, itemPurpose: string, contentQuery: string,
 * }}
 */
export function buildQuestionIntent(slot, item, requirements = {}) {
  // A MIXED slot's item carries its own type — the intent reflects the ITEM's
  // form when one is given, else the slot's.
  const type = String(item?.type || slot?.type || requirements.questionType || 'UNKNOWN').toUpperCase();
  const anchor =
    String(item?.referenceText || '').trim() ||
    (Array.isArray(slot?.referenceItems) ? slot.referenceItems.filter(Boolean).join(' ') : '') ||
    (Array.isArray(slot?.items) ? slot.items.map((it) => it?.referenceText).filter(Boolean).join(' ') : '') ||
    String(slot?.instruction || slot?.stem || '').trim();

  const terms = conceptTerms(anchor);
  const concept = terms.join(' ').toLowerCase();
  const topic = String(
    slot?.topicAnchor
      || slot?.topic
      || (Array.isArray(slot?.referenceItems) ? slot.referenceItems.filter(Boolean).join(', ') : '')
      || concept
  ).slice(0, 160).toLowerCase();

  const cognitiveOperation = classifyCognitiveOperation(slot, item);
  const answerForm = answerFormFor(type, slot?.pattern);
  const difficulty = String(requirements.difficulty || 'Medium');
  const unit = slot?.unit ?? null;

  // What this item is FOR — one line the generator/reranker can reason with.
  const itemPurpose = `${cognitiveOperation.toLowerCase()} demand in ${answerForm.replace(/-/g, ' ')} form`;

  // The CONTENT-ORIENTED retrieval query: concept terms + what the generator
  // needs to construct the question. Never the interrogative reference frame.
  const hint = TYPE_CONTENT_HINTS[type] || 'facts details';
  const contentQuery = `${concept} ${cognitiveOperation.toLowerCase()} ${hint}`
    .replace(/\s+/g, ' ').trim().slice(0, 400);

  return {
    type,
    topic,
    concept: concept || topic,
    cognitiveOperation,
    answerForm,
    difficulty,
    unit,
    itemPurpose,
    contentQuery,
  };
}

/**
 * Convenience: intent for a slot's i-th retrieval unit (item-aware), mirroring
 * the retrieval agent's task shape (one unit per item when units differ, else
 * one per slot).
 */
export function intentForRetrievalTask(slot, item, requirements) {
  return buildQuestionIntent(slot, item, requirements);
}

export default {
  buildQuestionIntent,
  intentForRetrievalTask,
  classifyCognitiveOperation,
  informationDemandOf,
  conceptTerms,
  isCodingTask,
  hasDynamicInputCue,
  fixedNumericLiterals,
};
