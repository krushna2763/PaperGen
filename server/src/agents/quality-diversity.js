/**
 * quality-diversity.js — QUESTION QUALITY & DIVERSITY (Phase 6).
 *
 * Pure, deterministic, no-AI helpers integrated into the EXISTING pipeline:
 *
 *   1. ANSWER-FIRST GENERATION — deriveAnswerTarget() turns a blueprint slot
 *      (or one of its items) + its own retrieved RAG evidence into an
 *      internal ANSWER TARGET: the knowledge/concept the new question must
 *      test, the KIND of answer it must demand, and the evidence facts it
 *      must stay answerable from. The generator builds the question FROM
 *      this target instead of rewriting the reference text. The target is
 *      prompt/scoring plumbing only — normalizeGeneratedQuestion() never
 *      carries it, so it can never reach the student paper or answer key.
 *
 *   2. INFORMATION-DEMAND TRANSFORMATION — TRANSFORMATIONS maps the EXISTING
 *      cognitive-demand taxonomy (question-intent.js: DEFINITION/FACT/
 *      REASONING/APPLICATION/COMPARISON/CAUSE/EFFECT/EXAMPLE/PREDICTION)
 *      onto the seven named transformations. The reference demand defines
 *      WHERE the question starts; the target demand picks the row; the
 *      directive tells the generator HOW to move — while answer form,
 *      structure, marks and topic stay locked (the blueprint already
 *      enforces those; this layer never overrides them).
 *
 *   3. ANSWERABILITY — answerabilityIssues() flags genuinely vacuous stems
 *      (no task frame, no question mark, no content terms, or an MCQ item
 *      with fewer than two options). Conservative: a stem that carries any
 *      task verb or question mark is never flagged.
 *
 *   4. QUALITY SCORING — scoreCandidateQuality() ranks candidates that the
 *      REAL validators already judged, combining: structural tier (hard),
 *      validator failure count, lexical novelty (avgOverlap), semantic
 *      novelty (cosine vs the positional reference, when the caller
 *      supplied vectors), RAG grounding coverage, difficulty alignment and
 *      transformation application. Scoring only ORDERS candidates — it can
 *      never accept what a validator rejected.
 *
 * Fully generic: everything is derived from slot fields, reference text and
 * retrieved evidence — no class/subject/unit/question special cases.
 */

import { classifyCognitiveOperation, informationDemandOf, conceptTerms, fixedNumericLiterals, hasDynamicInputCue } from '../blueprint/question-intent.js';
import { contentTerms } from './grounding.agent.js';

/**
 * The seven named information-demand transformations (Phase 6 spec), keyed
 * `${referenceDemand}->${targetDemand}` over the EXISTING taxonomy. A row is
 * only ever SELECTED when the blueprint/type/marks constraints already allow
 * the target demand (target-selector.js gates that) — this table only names
 * HOW to move, never WHETHER.
 */
export const TRANSFORMATIONS = {
  'DEFINITION->APPLICATION': {
    name: 'Definition → Application',
    directive: 'the reference asked for a definition; ask the student to APPLY that concept to a concrete situation, object or use-case instead — the answer must still demonstrate the same definition, never state it verbatim.',
  },
  'FACT->CAUSE': {
    name: 'Fact → Cause/Effect',
    directive: 'the reference asked for a fact; ask WHY/WHAT-LEADS-TO that fact holds — the answer must reason about the underlying cause, not recall the fact.',
  },
  'FACT->EFFECT': {
    name: 'Event → Consequence',
    directive: 'the reference asked for a fact; ask what FOLLOWS from it — the answer must trace a consequence, not restate the fact.',
  },
  'FACT->SCENARIO': {
    name: 'Recall → Scenario',
    directive: 'the reference was direct recall; embed the same knowledge in a concrete scenario/situation the student must recognize it in — never ask for the fact directly.',
  },
  'REASONING->SCENARIO': {
    name: 'Recall → Scenario',
    directive: 'the reference was a direct recall ask; wrap the same knowledge in a concrete situation the student must reason about — never ask for the fact directly.',
  },
  'OBJECT->SCENARIO': {
    name: 'Recall → Scenario',
    directive: 'the reference was direct recall of an object/fact; present a situation in which that knowledge must be used — never ask for it directly.',
  },
  'FACT->INFERENCE': {
    name: 'Direct → Inference',
    directive: 'the reference asked for information directly; ask what can be INFERRED from given conditions — the answer must draw the conclusion, not quote the fact.',
  },
  'REASONING->INFERENCE': {
    name: 'Direct → Inference',
    directive: 'give conditions/evidence and ask what follows — the answer must be an inference drawn from them, not a recalled statement.',
  },
  'OBJECT->COMPARISON': {
    name: 'Identification → Comparison',
    directive: 'the reference asked the student to identify something; ask them to COMPARE/contrast the identified concept against a related one — the answer must weigh both, not name one.',
  },
  'DEFINITION->COMPARISON': {
    name: 'Identification → Comparison',
    directive: 'the reference asked for identification/a definition; ask how the concept differs from or resembles a related one — the answer must compare, not define.',
  },
  'EXAMPLE->PROBLEM': {
    name: 'Explanation → Problem/Situation',
    directive: 'the reference asked for an explanation/example; present a small problem or situation whose resolution requires that explanation — the answer must solve, not narrate.',
  },
  'REASONING->PROBLEM': {
    name: 'Explanation → Problem/Situation',
    directive: 'present a concrete problem/situation whose resolution requires the same reasoning the reference asked the student to explain — the answer must resolve it, not narrate.',
  },
  'FACT->COMPARISON': {
    name: 'Identification → Comparison',
    directive: 'the reference asked for a fact; ask how two relevant instances differ — the answer must compare, not recall.',
  },
};

const TRANSFORMATION_LABELS = {
  APPLICATION: 'Definition → Application',
  CAUSE: 'Fact → Cause/Effect',
  EFFECT: 'Event → Consequence',
  SCENARIO: 'Recall → Scenario',
  INFERENCE: 'Direct → Inference',
  COMPARISON: 'Identification → Comparison',
  PROBLEM: 'Explanation → Problem/Situation',
};

/** Public label for one target demand, when it maps to a named transformation. */
export function transformationLabelFor(targetDemand) {
  return TRANSFORMATION_LABELS[String(targetDemand || '').toUpperCase()] || null;
}

/**
 * The transformation row for moving FROM the reference demand TO the target
 * demand, falling back to the target demand's own canonical label. Returns
 * null when the target demand has no named transformation (it stays legal —
 * just unnamed).
 * @param {string} referenceDemand
 * @param {string} targetDemand
 * @returns {{ name: string, directive: string } | null}
 */
export function transformationFor(referenceDemand, targetDemand) {
  const key = `${String(referenceDemand || '').toUpperCase()}->${String(targetDemand || '').toUpperCase()}`;
  if (TRANSFORMATIONS[key]) return TRANSFORMATIONS[key];
  const label = transformationLabelFor(targetDemand);
  return label ? { name: label, directive: '' } : null;
}

/**
 * Normalize any demand alias onto the transformation taxonomy. The spec's
 * seven named rows are keyed on the canonical names; STATEMENT/PREDICTION
 * (statement recall) canonically map to FACT, PROCESS/REASON to REASONING.
 */
export function canonicalDemand(demand) {
  const d = String(demand || '').toUpperCase();
  if (d === 'STATEMENT' || d === 'PREDICTION') return 'FACT';
  if (d === 'PROCESS' || d === 'REASON') return 'REASONING';
  return d;
}

/**
 * The INTERNAL ANSWER TARGET for one slot (or one item of it): what the new
 * question must test, what KIND of answer it must demand, and the retrieved
 * evidence it must stay answerable from. Derived from the slot's own fields
 * + its per-slot RAG context — never from any hardcoded content.
 * @param {Object} opts
 * @param {Object} opts.slot - blueprint slot
 * @param {Object|null} [opts.item] - slot items[] entry (MIXED-aware)
 * @param {Object|null} [opts.slotContext] - per-slot retrieval context ({ results, compressed, unit })
 * @param {Object} [opts.requirements] - { difficulty, ... }
 * @returns {{
 *   answerTarget: string,      // REASON | PROCESS | OBJECT | DEFINITION | ...
 *   operation: string,         // cognitive operation (existing classifier)
 *   concept: string,           // concept terms of the reference anchor
 *   expectedAnswerKind: string,// what a correct answer looks like
 *   evidenceFacts: string[],   // bounded evidence lines the question must stay answerable from
 *   marksPerItem: number[],    // locked per-part marks (empty when uniform/unknown)
 * }}
 */
/** What a correct answer must look like, per answer-target demand. */
const ANSWER_KIND_BY_TARGET = {
  REASON: 'a causal explanation (because …)',
  PROCESS: 'a step-by-step description of the process/mechanism',
  OBJECT: 'the specific fact/term/value being asked for',
  DEFINITION: 'a precise definition with its key attributes',
  COMPARISON: 'a contrast naming the differing attribute(s) of both sides',
  EXAMPLE: 'a concrete instance satisfying the concept',
  PREDICTION: 'the expected outcome with its justification',
  STATEMENT: 'a correct statement/evaluation of the claim',
  UNKNOWN: 'an answer grounded in the retrieved evidence',
};

/** Public: the expected-answer KIND for one answer-target demand. */
export function expectedAnswerKindFor(answerTarget) {
  return ANSWER_KIND_BY_TARGET[String(answerTarget || '').toUpperCase()] || ANSWER_KIND_BY_TARGET.UNKNOWN;
}

/**
 * PHASE 6.1 — construction-aware directive for a PROGRAMMING/CODE-WRITING
 * reference item. The academic information-demand transformations above
 * (definition→application, fact→cause, …) have no meaning for an imperative
 * "write a program to X" task; this names the CODE-CONSTRUCTION-level moves
 * from the spec instead (fixed input→user input, fixed range→dynamic range,
 * direct example→generalized implementation, simple output→calculated
 * output, isolated condition→scenario, direct→constrained implementation).
 * Generic: never mentions a specific language, algorithm name, or number —
 * only the literal(s) actually found in THIS reference item, so it reads
 * naturally without being copy-pasteable into any other paper's Q1.
 * @param {string} referenceText
 * @returns {string}
 */
export function codingTaskDirective(referenceText) {
  const literals = fixedNumericLiterals(referenceText);
  const literalBit = literals.length > 0
    ? ` The reference fixes ${literals.join(', ')} as a literal value/range.`
    : '';
  return 'this is a PROGRAMMING/CODE-WRITING task, not an academic question — the why/what/compare demand '
    + 'above is not the point. A candidate that only rewords the task or swaps its fixed number(s) for a '
    + `different fixed number is a paraphrase and will be rejected.${literalBit} Instead, apply ONE genuine `
    + 'construction-level transformation while testing the SAME programming construct/concept: '
    + 'fixed input → accept the value from the user; fixed range → a dynamically supplied bound; '
    + 'a single hardcoded example → a generalized implementation (an array/list/arbitrary size); '
    + 'a simple output (e.g. print) → a calculated output (e.g. sum/count/average) over the same data; '
    + 'an isolated condition → a realistic scenario/application using it; '
    + 'or a direct implementation → one with an added constraint (e.g. validate the input, handle an edge case). '
    + 'Keep the same answer form, structure, marks and difficulty — only the task construction changes.';
}

export function deriveAnswerTarget({ slot, item = null, slotContext = null, requirements: _requirements = {} }) {
  // Per-item text wins, then the slot's items joined, then legacy flat
  // reference items, then the slot instruction — never an empty anchor when
  // the slot carries usable reference content at any level.
  const anchor = String(
    item?.referenceText
    || (Array.isArray(slot?.items) ? slot.items.map((it) => it?.referenceText || it?.topicAnchor).filter(Boolean).join(' ') : '')
    || (Array.isArray(slot?.referenceItems) ? slot.referenceItems.filter(Boolean).join(' ') : '')
    || slot?.instruction
    || ''
  );
  const answerTarget = informationDemandOf(anchor);
  // The cognitive-operation classifier builds its own anchor from
  // item.referenceText / slot.referenceItems[0] / slot.instruction — a slot
  // carrying only items[] would fall through to the FACT default, so surface
  // the SAME derived anchor to it (no second taxonomy, just the same text).
  const operation = classifyCognitiveOperation(
    anchor && !(Array.isArray(slot?.referenceItems) && slot.referenceItems.length > 0)
      ? { ...slot, referenceItems: [anchor] }
      : slot,
    item
  );
  const concept = conceptTerms(anchor).slice(0, 10).join(', ');

  // Evidence facts: prefer the hybrid pipeline's compressed sentence-level
  // blocks, else the raw per-slot results — bounded, deduped.
  const seen = new Set();
  const evidenceFacts = [];
  const pushFact = (text) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    evidenceFacts.push(t.slice(0, 220));
  };
  const blocks = slotContext?.compressed?.blocks;
  if (Array.isArray(blocks)) for (const b of blocks) pushFact(b?.text);
  if (evidenceFacts.length < 3 && Array.isArray(slotContext?.results)) {
    for (const r of slotContext.results) pushFact(r?.text);
  }

  // Locked per-part marks (empty when unknown/uniform — uniform marks ride on
  // the slot itself and never need per-item restating).
  const marksPerItem = Array.isArray(slot?.items)
    ? slot.items.map((it) => (Number.isFinite(Number(it?.marks)) && Number(it.marks) > 0 ? Number(it.marks) : null))
    : [];

  return {
    answerTarget,
    operation,
    concept,
    expectedAnswerKind: expectedAnswerKindFor(answerTarget),
    evidenceFacts: evidenceFacts.slice(0, 3),
    marksPerItem,
  };
}

/**
 * Deterministic ANSWERABILITY check — flags genuinely vacuous stems only:
 *  - a stem with NO task verb and NO question mark (nothing asked), or
 *  - a stem with no content terms at all (pure filler), or
 *  - an MCQ sub-part carrying fewer than two options (unanswerable as MCQ).
 * Anything with a question mark or any task verb passes — this must never
 * reject legitimate imperative stems ("Fill in the blanks:", "State True or
 * False:").
 * @param {Object} candidate - normalized generated question
 * @returns {string[]} human-readable issues (empty when answerable)
 */
export function answerabilityIssues(candidate) {
  const issues = [];
  const parts = Array.isArray(candidate?.subParts) && candidate.subParts.length > 0
    ? candidate.subParts
    : [{ text: String(candidate?.text || ''), options: candidate?.options }];

  for (let i = 0; i < parts.length; i++) {
    const letter = String.fromCharCode(97 + (i % 26));
    const stem = String(parts[i]?.text || '').trim();
    if (!stem) {
      issues.push(`item (${letter}) has an empty stem — nothing is asked.`);
      continue;
    }
    const hasTaskFrame = /\b(explain|describe|state|define|list|give|name|mention|write|identify|differentiate|compare|suggest|justify|illustrate|choose|select|fill|match|answer|complete|find|calculate|draw|label|why|how|what|which|who|when|where|whether|true|false|following|except)\b/i.test(stem)
      || /\?$/.test(stem)
      || /_{2,}/.test(stem)
      || /:\s*$/.test(stem);
    const terms = contentTerms(stem);
    if (!hasTaskFrame) {
      issues.push(`item (${letter}) does not pose a clear, answerable request — rewrite it with an explicit task and enough context to answer unambiguously.`);
    } else if (terms.length === 0) {
      issues.push(`item (${letter}) carries no content — nothing answerable is being asked.`);
    }
    const opts = Array.isArray(parts[i]?.options) ? parts[i].options.filter(Boolean) : [];
    const isMcq = String(parts[i]?.type || candidate?.type || '').toUpperCase() === 'MCQ';
    if (isMcq && opts.length < 2) {
      issues.push(`item (${letter}) is an MCQ with fewer than two options — it cannot be answered as a choice question.`);
    }
  }
  return [...new Set(issues)];
}

/**
 * PHASE 10 — deterministic, no-LLM grammar/clarity check. Deliberately kept
 * simple and generic: this is a soft quality signal for ranking candidates
 * against each other, never a structural gate (a messy stem still gets
 * generated and can still win if every sibling is worse) and never a
 * substitute for real grammar checking. Preserves candidate-selector.js's
 * "no-LLM-call validators" invariant for the pool pre-screen.
 * @param {Object} candidate - normalized generated question (or one sub-part-shaped object)
 * @returns {string[]} human-readable issues, empty when clean
 */
export function grammarIssuesOf(candidate) {
  const parts = Array.isArray(candidate?.subParts) && candidate.subParts.length > 0
    ? candidate.subParts
    : [{ text: candidate?.text }];
  const issues = [];
  parts.forEach((part, i) => {
    const letter = String.fromCharCode(97 + (i % 26));
    const label = parts.length > 1 ? `(${letter}) ` : '';
    const raw = String(part?.text || '');
    const stem = raw.trim();
    if (!stem) return; // emptiness is answerabilityIssues()'s concern, not grammar's

    if (/\b(\w+)\s+\1\b/i.test(stem)) {
      issues.push(`${label}doubled word — the same word appears twice in a row.`);
    }
    if (/  +/.test(raw) || /\t/.test(raw)) {
      issues.push(`${label}extra space — the stem has doubled/stray whitespace.`);
    }
    const firstLetter = stem.match(/[a-zA-Z]/);
    if (firstLetter && firstLetter[0] === firstLetter[0].toLowerCase()) {
      issues.push(`${label}missing capital — the stem does not start with a capital letter.`);
    }
    const startsInterrogative = /^(what|why|how|which|who|whom|whose|where|when|does|do|did|is|are|was|were|can|could|will|would|should)\b/i.test(stem);
    const isFillBlank = /_{2,}/.test(stem);
    if (startsInterrogative && !isFillBlank && !/[?]\s*$/.test(stem)) {
      issues.push(`${label}missing question mark — the stem reads as a question but does not end with one.`);
    }
  });
  return issues;
}

/**
 * PHASE 10 — how different this candidate is from the OTHER candidates in the
 * same pool, as 1 minus the mean lexical stem-overlap against each sibling.
 * Deterministic, generic (bag-of-words), no LLM. A pool of size 1 (or a
 * candidate with no distinguishable siblings) is neutral (1 = fully diverse
 * by definition — nothing to be similar to), never penalized.
 * @param {Object} candidate
 * @param {Object[]} poolPeers - every candidate in the same pool, INCLUDING this one
 * @returns {number} 0..1, higher = more diverse from its siblings
 */
export function pairwiseDiversityOf(candidate, poolPeers) {
  const peers = (Array.isArray(poolPeers) ? poolPeers : []).filter((p) => p && p !== candidate);
  if (peers.length === 0) return 1;
  const textOf = (c) => [c?.text, ...(Array.isArray(c?.subParts) ? c.subParts.map((p) => p?.text) : [])].filter(Boolean).join(' ');
  const termsOf = (text) => new Set(contentTerms(String(text || '')));
  const mine = termsOf(textOf(candidate));
  if (mine.size === 0) return 1;
  const overlapWith = (otherTerms) => {
    if (otherTerms.size === 0) return 0;
    let shared = 0;
    for (const t of mine) if (otherTerms.has(t)) shared += 1;
    return shared / Math.max(mine.size, otherTerms.size);
  };
  const overlaps = peers.map((p) => overlapWith(termsOf(textOf(p))));
  const avgOverlap = mean(overlaps);
  return Math.min(1, Math.max(0, 1 - avgOverlap));
}

/** Simple deterministic difficulty-fit signal (score-only, never a gate).
 * @returns {number} 1 aligned, 0 neutral, -1 misaligned */
export function difficultySignalOf(candidate, difficulty) {
  const level = String(difficulty || 'Medium').toLowerCase();
  const text = [candidate?.text, ...(Array.isArray(candidate?.subParts) ? candidate.subParts.map((p) => p?.text) : [])]
    .filter(Boolean).join(' ');
  const hasApplicationFrame = /\b(suppose|scenario|situation|if .+(then|what)|what happens|analyze|evaluate|justify|design|compare|consequence|infer)\b/i.test(text);
  const isBareRecall = /^(what|name|list|state|define|who|when|where)\b/i.test(String(candidate?.text || '').trim());
  if (level === 'easy') return isBareRecall ? 1 : (hasApplicationFrame ? -1 : 0);
  if (level === 'difficult') return hasApplicationFrame ? 1 : (isBareRecall ? -1 : 0);
  return 0; // Medium accepts anything — neutral
}

/** Mean of a numeric list (0 when empty). */
function mean(list) {
  const nums = (Array.isArray(list) ? list : []).filter((n) => Number.isFinite(n));
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * SEMANTIC IMAGE GROUNDING — deterministic 0..1 signal of how well a candidate
 * engages the reference image's grounded topic/concepts. Generic: the concepts
 * come from the grounding object (built per reference image), never from any
 * hardcoded vocabulary. A candidate that names/asks about a grounded concept
 * scores higher than one that merely shares the topic; a candidate that names
 * an observation target (i.e. requires actually looking at the image) scores
 * highest. 0 when grounding is absent — neutral for every text slot.
 */
function imageGroundingSignalOf(candidate, grounding) {
  if (!grounding || grounding.status !== 'ok') return 0;
  const ri = grounding.referenceImage ?? {};
  const concepts = (ri.concepts ?? []).map((c) => String(c ?? '').toLowerCase().trim()).filter(Boolean);
  const targets = (ri.observationTargets ?? []).map((c) => String(c ?? '').toLowerCase().trim()).filter(Boolean);
  const topic = String(ri.topic ?? '').toLowerCase().trim();
  if (concepts.length === 0 && targets.length === 0 && !topic) return 0;
  const text = [
    String(candidate?.text ?? ''),
    ...(Array.isArray(candidate?.subParts) ? candidate.subParts.map((p) => String(p?.text ?? '')) : []),
  ].join(' ').toLowerCase();
  if (!text) return 0;
  let signal = 0;
  if (topic && text.includes(topic)) signal = Math.max(signal, 0.3);
  if (concepts.some((c) => text.includes(c))) signal = Math.max(signal, 0.6);
  if (targets.some((t) => text.includes(t))) signal = 1;
  return signal;
}

/**
 * Rank one candidate with the REAL validators' verdicts + quality signals.
 * Mirrors candidate-selector.evaluateCandidate's gate set, then adds a
 * additive SCORE on top — scoring orders candidates; it can never accept
 * what a validator failed.
 * @param {Object} args - same shape as evaluateCandidate, plus:
 *   - gates: { structure, answers, imageOk, topic, novelty, grounding } —
 *     the ALREADY-COMPUTED validator results (avoids recomputation and keeps
 *     this module free of validator imports/duplication)
 *   - semanticSim: number|null — cosine(candidate, positional reference)
 *     when the caller precomputed vectors (null → ignored)
 *   - requirements: { difficulty, ... }
 *   - targets: selectTarget()-shaped per-item targets (for the transformation bonus)
 *   - imageGrounding: Object|null — the slot's ImageGrounding (semantic image
 *     grounding layer). When present, candidates that engage the grounded
 *     image topic/concepts rank ABOVE those that merely touch the topic — a
 *     ranking signal only; it never accepts what a validator failed.
 * @returns {{ score: number, structuralOk: boolean, failureCount: number,
 *             reasons: string[], avgOverlap: number, checks: Object }}
 */
export function scoreCandidateQuality({
  candidate, _slot = null, requirements = {}, gates, semanticSim = null, targets = [], poolPeers = null, graphEvidence = null, imageGrounding = null,
}) {
  // Every gate defaults to "passed" and tolerates partial results — a caller
  // that supplies only some gates, or a gate result without a reasons array,
  // must never crash the scorer.
  const withDefaults = (gate, extra = {}) => ({ ok: true, reasons: [], ...extra, ...(gate || {}) });
  const structure = withDefaults(gates?.structure);
  const answers = withDefaults(gates?.answers);
  const imageOk = gates?.imageOk !== false;
  const topic = withDefaults(gates?.topic);
  const novelty = withDefaults(gates?.novelty, { items: [] });
  const grounding = withDefaults(gates?.grounding, { items: [] });
  // PHASE 11 — cognitive-demand fidelity vs the Question Planner's intended
  // demand (absent gate / no plan -> ok:true, reasons:[], same neutral
  // convention as every other gate here).
  const demandFidelity = withDefaults(gates?.demandFidelity);
  // IMAGE-DEPENDENT VISUAL ENGAGEMENT — a candidate that only names a grounded
  // concept without describing a real visual relationship/position/structure
  // pays the same validator-failure cost as any other gate here, so it can
  // never outrank a genuinely image-dependent candidate merely on the soft
  // imageGroundingSignal below. Absent grounding -> ok:true, same convention.
  const visualEngagement = withDefaults(gates?.visualEngagement);

  const structuralOk = structure.ok && answers.ok && imageOk;
  const answerability = answerabilityIssues(candidate);
  const validatorReasons = [
    ...structure.reasons, ...answers.reasons,
    ...(imageOk ? [] : ['Candidate lost the required image relationship — imageAssets missing.']),
    ...topic.reasons, ...novelty.reasons, ...grounding.reasons, ...demandFidelity.reasons, ...visualEngagement.reasons,
  ];
  // Answerability: hard failures (empty stem, MCQ with <2 options, no content)
  // count like validator failures; the softer "unclear request" signal only
  // penalizes the score and surfaces as a reason for the feedback loop.
  const answerabilityHard = answerability.filter((iss) => /no content|empty stem|fewer than two options/.test(iss));
  const answerabilitySoft = answerability.filter((iss) => !answerabilityHard.includes(iss));
  const reasons = [...validatorReasons, ...answerability];

  const overlaps = (novelty.items || []).map((it) => it.stemOverlap).filter((n) => Number.isFinite(n));
  const avgOverlap = mean(overlaps);

  const groundingCoverage = mean((grounding.items || []).map((it) => it.coverage));
  const difficultyAligned = difficultySignalOf(candidate, requirements.difficulty);
  // PHASE 10 — Phase 8's graph evidence (Evidence[], each carrying its own
  // fused .score) as a SMALL additional structural-relevance signal, on top
  // of (never instead of) groundingCoverage. Absent/empty -> 0, same neutral
  // convention as poolPeers, so callers that never pass hybrid_graph evidence
  // score exactly as before this addition.
  const graphEvidenceQuality = Array.isArray(graphEvidence) && graphEvidence.length > 0
    ? mean(graphEvidence.map((e) => e?.score))
    : 0;

  // SEMANTIC IMAGE GROUNDING — a ranking signal (0..1) for how well the
  // candidate engages the reference image's grounded topic/concepts. 0 when
  // no grounding exists (the neutral convention every other optional signal
  // here uses), so non-image slots are completely unaffected.
  const imageGroundingSignal = imageGroundingSignalOf(candidate, imageGrounding);

  const transformationApplied = targets.some((t) => {
    const demand = t?.targetDemand ?? (Array.isArray(t?.targetDemands) ? t.targetDemands[0] : null);
    return demand != null && transformationFor(t?.referenceDemand, demand) != null;
  });
  // PHASE 6.1 — reward a candidate that actually parameterized a coding-task
  // item (the construction-level transformation codingTaskDirective() asks
  // for): a dynamic-input cue on the corresponding sub-part. Only ranks
  // candidates; it never lets a structurally invalid one outrank a valid one.
  const parts = Array.isArray(candidate?.subParts) ? candidate.subParts : [];
  const codingTransformApplied = targets.some((t, i) => t?.isCodingTask && hasDynamicInputCue(parts[i]?.text));
  const semanticRisk = Number.isFinite(semanticSim) ? Math.max(0, semanticSim - 0.75) : 0;

  // PHASE 10 — grammar/clarity is always evaluated (a soft signal, never a
  // gate); pairwise diversity only applies when the caller supplies the pool
  // (poolPeers=null, or a pool of just this one candidate, is neutral — no
  // penalty, no bonus — so omitting it is byte-identical to before Phase 10).
  const grammarIssues = grammarIssuesOf(candidate);
  const diversityScore = poolPeers ? pairwiseDiversityOf(candidate, poolPeers) : 1;

  // Additive score — structural tier dominates, then validator failures, then
  // the quality signals. A structurally invalid candidate can never outrank a
  // valid one (same non-negotiable tier as candidate-selector.js).
  const score =
    (structuralOk ? 1000 : 0)
    - validatorReasons.length * 100
    - answerabilityHard.length * 100
    - avgOverlap * 40
    - semanticRisk * 100
    + groundingCoverage * 20
    + difficultyAligned * 10
    + (transformationApplied ? 5 : 0)
    + (codingTransformApplied ? 5 : 0)
    - answerabilitySoft.length * 5
    - grammarIssues.length * 5
    - (1 - diversityScore) * 10
    + graphEvidenceQuality * 5
    + imageGroundingSignal * 8;

  return {
    score,
    structuralOk,
    failureCount: validatorReasons.length + answerabilityHard.length,
    reasons,
    avgOverlap,
    checks: {
      groundingCoverage,
      difficultyAligned,
      transformationApplied,
      codingTransformApplied,
      semanticSim: Number.isFinite(semanticSim) ? semanticSim : null,
      answerabilitySoft,
      grammarIssues,
      diversityScore,
      graphEvidenceQuality,
      imageGroundingSignal,
    },
  };
}

export default {
  TRANSFORMATIONS,
  transformationFor,
  transformationLabelFor,
  deriveAnswerTarget,
  expectedAnswerKindFor,
  codingTaskDirective,
  answerabilityIssues,
  difficultySignalOf,
  grammarIssuesOf,
  pairwiseDiversityOf,
  imageGroundingSignalOf,
  scoreCandidateQuality,
};
