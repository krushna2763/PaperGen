/**
 * target-selector.js — PROACTIVE INFORMATION-DEMAND TARGETING (Phase 2, Part 1).
 *
 * Reuses the EXISTING cognitive-demand taxonomy from blueprint/question-intent.js
 * (classifyCognitiveOperation / buildQuestionIntent) — no duplicate taxonomy.
 * Turns the REACTIVE "you were rejected for X, try something else" directive
 * (adaptive-feedback.agent.js) into a PROACTIVE "use one of these N demands"
 * instruction handed to the generator BEFORE it produces a candidate.
 *
 * Pure, deterministic, no AI calls. Never invents a demand incompatible with
 * the slot's own type/marks (a 1-mark MCQ never gets a multi-step REASONING
 * target), never overrides the locked blueprint's structural facts (type,
 * marks, item count, answer form, unit) — those travel through unchanged in
 * `requiredConstraints` for the generator/validators to enforce as they
 * already do today.
 */
import { classifyCognitiveOperation, buildQuestionIntent, informationDemandOf, isCodingTask } from '../blueprint/question-intent.js';
import { usedDemandsFromLedger, usedConceptsFromLedger } from './question-ledger.js';
import { transformationFor, codingTaskDirective } from './quality-diversity.js';

/**
 * Allowed target demands by item TYPE — generic, never by subject/content.
 * A short, closed-form item (MCQ/TRUE_FALSE/FILL_IN_THE_BLANK) has no room for
 * a multi-step reasoning chain; a longer, open-ended item does. IMAGE_BASED is
 * restricted to demands answerable FROM the image.
 */
const ALLOWED_DEMANDS_BY_TYPE = {
  MCQ: ['FACT', 'DEFINITION', 'APPLICATION', 'CAUSE', 'EFFECT', 'COMPARISON'],
  TRUE_FALSE: ['FACT', 'DEFINITION', 'APPLICATION', 'CAUSE', 'EFFECT'],
  FILL_IN_THE_BLANK: ['FACT', 'DEFINITION', 'APPLICATION'],
  SHORT_ANSWER: ['FACT', 'DEFINITION', 'APPLICATION', 'CAUSE', 'EFFECT', 'COMPARISON', 'REASONING', 'EXAMPLE', 'PREDICTION'],
  LONG_ANSWER: ['REASONING', 'APPLICATION', 'CAUSE', 'EFFECT', 'COMPARISON', 'PREDICTION', 'EXAMPLE'],
  IMAGE_BASED: ['APPLICATION', 'REASONING', 'CAUSE', 'EFFECT', 'COMPARISON'],
  MATCH_THE_FOLLOWING: ['FACT', 'DEFINITION', 'COMPARISON'],
  INTERNAL_CHOICE: ['APPLICATION', 'REASONING', 'CAUSE', 'EFFECT', 'COMPARISON', 'EXAMPLE'],
};
const DEFAULT_ALLOWED = ['FACT', 'DEFINITION', 'APPLICATION', 'CAUSE', 'EFFECT', 'COMPARISON', 'REASONING', 'EXAMPLE'];

/** Allowed demand set for one item, gated by TYPE and (for low-mark items) MARKS. */
export function allowedDemandsFor(type, marks) {
  const key = String(type || '').trim().toUpperCase();
  const base = ALLOWED_DEMANDS_BY_TYPE[key] || DEFAULT_ALLOWED;
  const m = Number(marks);
  // Low-mark closed-form items never get a multi-step demand, even if the
  // TYPE table above generically allows it for a higher-mark sibling of the
  // same type (a homogeneous slot's per-item marks can still vary).
  if (Number.isFinite(m) && m <= 1 && (key === 'SHORT_ANSWER' || key === 'IMAGE_BASED')) {
    return base.filter((d) => d !== 'REASONING' && d !== 'PREDICTION');
  }
  return base;
}

/**
 * Select the target-demand set for ONE item (or a single-item slot when
 * `item` is null). Never returns an empty set — falls back to allowing a
 * repeat of the reference demand only when every other option is excluded by
 * `usedDemandsThisPaper`, since a structurally-compatible demand is always
 * better than none.
 * @param {Object} opts
 * @param {Object} opts.slot - locked blueprint slot
 * @param {Object|null} [opts.item] - the slot's items[] entry (MIXED-aware); null for a single-item slot
 * @param {Object} [opts.requirements] - { difficulty, ... }
 * @param {string[]} [opts.usedDemandsThisPaper] - demands already used by OTHER accepted slots this run
 * @param {Array<Object>} [opts.ledger] - Phase 3 Question Ledger (question-ledger.js buildLedger output);
 *   when given, its demands/concepts are merged into the exclusion set and
 *   into `usedConceptsThisPaper` — additive, `usedDemandsThisPaper` keeps working unchanged for old callers.
 * @returns {{
 *   slotId: string|null, itemLabel: string|null, topic: string, concept: string,
 *   subtopic: string|null, referenceDemand: string, answerTarget: string,
 *   informationDemand: { answerTarget: string, operation: string, relationship: null },
 *   allowedDemands: string[], targetDemands: string[],
 *   transformation: { name: string, directive: string } | null,
 *   requiredConstraints: Object, rationale: string, usedConceptsThisPaper: string[],
 * }}
 */
export function selectTarget({ slot, item = null, requirements = {}, usedDemandsThisPaper = [], ledger = [] }) {
  const intent = buildQuestionIntent(slot, item, requirements);
  const referenceDemand = classifyCognitiveOperation(slot, item);
  // Phase 5 — a richer, three-part semantic representation of the reference
  // item, reusing the two EXISTING classifiers rather than a duplicate
  // taxonomy: `answerTarget` (the kind of answer being asked for — REASON,
  // PROCESS, OBJECT, DEFINITION, COMPARISON, EXAMPLE, PREDICTION, STATEMENT —
  // from the already-existing informationDemandOf(), also used by
  // reference-novelty.agent.js) and `operation` (classifyCognitiveOperation(),
  // the SAME cognitive-operation value already driving allowedDemands/
  // targetDemands below). `relationship` (e.g. "helper → learner") is left
  // deliberately null: there is no safe deterministic way to extract a
  // directional actor/recipient relationship from arbitrary reference text
  // without either an NLP dependency or an LLM call, and Phase 5 explicitly
  // disallows adding either for this purpose — an invented relationship
  // would violate "do not invent unsupported concepts" more than an honest
  // null does.
  const anchorText = String(
    item?.referenceText || (Array.isArray(slot?.referenceItems) ? slot.referenceItems.join(' ') : '') || slot?.instruction || ''
  );
  const answerTarget = informationDemandOf(anchorText);
  const informationDemand = { answerTarget, operation: referenceDemand, relationship: null };
  const marks = item?.marks ?? slot?.totalMarks ?? null;
  const allowedDemands = allowedDemandsFor(intent.type, marks);

  const ledgerDemands = usedDemandsFromLedger(ledger);
  const usedConceptsThisPaper = usedConceptsFromLedger(ledger);
  const usedUpper = new Set([referenceDemand, ...(usedDemandsThisPaper || []), ...ledgerDemands].map((d) => String(d || '').toUpperCase()));
  let targetDemands = allowedDemands.filter((d) => !usedUpper.has(d));
  // Every allowed demand is excluded (a short paper reusing every demand
  // already, or a very restrictive type) — still exclude the reference's OWN
  // demand (the one thing we must never repeat), allow paper-level reuse.
  if (targetDemands.length === 0) targetDemands = allowedDemands.filter((d) => d !== referenceDemand);
  // Only the reference demand is even allowed for this type/marks — nothing
  // safe to switch to; report it honestly rather than propose an incompatible one.
  if (targetDemands.length === 0) targetDemands = allowedDemands.slice();

  // PHASE 6 — PREFER targets with a NAMED transformation (stable order):
  // Definition→Application, Fact→Cause/Effect, Recall→Scenario, Direct→
  // Inference, Identification→Comparison, Event→Consequence, Explanation→
  // Problem/Situation. A named row carries a concrete directive for the
  // generator; unnamed demands stay allowed as later fallbacks. Ordering
  // only — every entry already passed the type/marks/paper-level gates.
  const namedFirst = targetDemands.filter((d) => transformationFor(referenceDemand, d) != null);
  const unnamedRest = targetDemands.filter((d) => transformationFor(referenceDemand, d) == null);
  targetDemands = [...namedFirst, ...unnamedRest];

  // The named INFORMATION-DEMAND TRANSFORMATION for this item's primary target
  // demand. Its directive tells the generator HOW to move; it never overrides
  // the locked answer form, structure, marks or topic — requiredConstraints
  // below still binds those.
  const transformation = transformationFor(referenceDemand, targetDemands[0] ?? null);

  // PHASE 6.1 — a PROGRAMMING/CODE-WRITING reference item ("write a program
  // to X") has no meaningful academic why/what/compare demand at all; the
  // transformation table above still names a target demand (kept, harmless),
  // but the generator additionally needs a CONSTRUCTION-level directive: vary
  // the input model or the operation, never just the wording/numbers. See
  // quality-diversity.js's codingTaskDirective().
  const isCoding = isCodingTask(anchorText);
  const codingDirective = isCoding ? codingTaskDirective(anchorText) : null;
  const imageBearing = (intent.type === 'IMAGE_BASED')
    || (Array.isArray(item?.imageAssets) && item.imageAssets.length > 0)
    || (Array.isArray(slot?.imageAssets) && slot.imageAssets.length > 0);
  const imageDependency = item?.imageDependency ?? (imageBearing ? 'IMAGE_DEPENDENT' : 'none');
  const visualAnchor = item?.visualAnchor ?? slot?.visualAnchor ?? null;

  return {
    slotId: slot?.label ?? null,
    itemLabel: item?.label ?? null,
    topic: intent.topic,
    concept: intent.concept,
    subtopic: item?.topicAnchor ?? slot?.topicAnchor ?? null,
    referenceDemand,
    answerTarget,
    informationDemand,
    allowedDemands,
    targetDemands,
    transformation,
    isCodingTask: isCoding,
    codingDirective,
    imageDependency,
    visualAnchor,
    requiredConstraints: {
      type: intent.type,
      marks,
      itemCount: slot?.itemCount ?? null,
      answerForm: intent.answerForm,
      unit: intent.unit,
      imageRequired: intent.type === 'IMAGE_BASED',
    },
    rationale: `Reference item asks a ${referenceDemand} demand; target avoids repeating it`
      + ((usedDemandsThisPaper?.length || ledgerDemands.length) ? ' and demands already used elsewhere in this paper' : '') + '.',
    usedConceptsThisPaper,
  };
}

/**
 * Build the per-candidate, per-item target assignments for a regeneration
 * pool: `poolSize` candidates, each item in the slot gets ONE target demand
 * per candidate, rotating through that item's allowed target set so the pool
 * is diverse-by-construction rather than hoping the model diversifies on its
 * own. MIXED-safe: iterates the slot's own items[] (each may have a
 * different type), never flattens to the parent type.
 * @param {Object} opts
 * @param {Object} opts.slot
 * @param {Object} [opts.requirements]
 * @param {string[]} [opts.usedDemandsThisPaper]
 * @param {Array<Object>} [opts.ledger] - Phase 3 Question Ledger, forwarded to selectTarget for every item
 * @param {number} [opts.poolSize=3] - Phase 6: default of 3 candidates per pool
 * @returns {Array<Array<Object & { targetDemand: string }>>} candidateTargets[c][itemIndex]
 */
export function selectTargetsForPool({ slot, requirements = {}, usedDemandsThisPaper = [], ledger = [], poolSize = 3 }) {
  const items = Array.isArray(slot?.items) && slot.items.length > 0 ? slot.items : [null];
  const perItemTargets = items.map((item) => selectTarget({ slot, item, requirements, usedDemandsThisPaper, ledger }));

  const candidateTargets = [];
  for (let c = 0; c < poolSize; c++) {
    candidateTargets.push(perItemTargets.map((t) => ({
      ...t,
      targetDemand: t.targetDemands[c % t.targetDemands.length],
    })));
  }
  return candidateTargets;
}

export default { selectTarget, selectTargetsForPool, allowedDemandsFor };
