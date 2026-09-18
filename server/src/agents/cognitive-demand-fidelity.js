/**
 * cognitive-demand-fidelity.js — PHASE 11: does the GENERATED candidate
 * actually demonstrate the cognitive demand the Question Planner (Phase 9)
 * intended, or did it quietly drift to something simpler?
 *
 * The planner already classifies the INTENDED demand per slot/item
 * (plan.cognitiveDemand / plan.itemPlans[i].cognitiveDemand — one of
 * question-planner.js's canonical COGNITIVE_DEMANDS). Nothing previously
 * compared that against what the model actually wrote: a candidate could
 * pass every structural/topic/novelty/grounding check while asking a bare
 * RECALL question in a slot the reference clearly demanded REASONING for
 * (observed live, repeatedly, on the real OOP Unit 1 Q1 slot).
 *
 * This is deliberately NOT a new taxonomy or a new classifier — it reuses
 * question-planner.js's own classifyCognitiveDemand() (by feeding it the
 * GENERATED text as if it were the "reference" text; the function only ever
 * reads item.referenceText, so this is a legitimate, unmodified reuse) and
 * its own declared COGNITIVE_DEMANDS array for the ladder ordering. Pure,
 * deterministic, no AI calls — matches every other content-fidelity gate in
 * this pipeline (checkPerItemTopicFidelity, checkGrounding).
 *
 * Gracefully absent when there is no plan (QUESTION_PLANNER_ENABLED=false,
 * or planning failed for this slot) — this check simply does not run, never
 * fabricating an "intended demand" out of thin air.
 */
import { classifyCognitiveDemand, COGNITIVE_DEMANDS } from '../planner/question-planner.js';

// Bloom's-style ladder, taken directly from question-planner.js's own
// declared order. PROCEDURAL (coding tasks) and UNKNOWN (nothing reliable to
// compare against) are deliberately excluded from ranking — neither is a
// position on this ladder, so neither can "drop".
const RANK = Object.freeze(
  Object.fromEntries(
    COGNITIVE_DEMANDS.filter((d) => d !== 'PROCEDURAL' && d !== 'UNKNOWN').map((d, i) => [d, i])
  )
);

function rankOf(demand) {
  return Object.prototype.hasOwnProperty.call(RANK, demand) ? RANK[demand] : null;
}

/** The candidate's sub-parts (or the whole stem as one implicit part). */
function partsOf(candidate) {
  return Array.isArray(candidate?.subParts) && candidate.subParts.length > 0
    ? candidate.subParts
    : [{ text: candidate?.text }];
}

/**
 * @param {Object} candidate - normalized generated question
 * @param {Object|null} plan - the slot's attached QuestionPlan (sc.plan), or
 *   null when the planner is disabled or planning failed for this slot
 * @returns {{ ok: boolean, items: Array<{index:number, letter:string|null, ok:boolean, intended:string|null, generated:string|null}>, reasons: string[] }}
 */
export function checkCognitiveDemandFidelity(candidate, plan) {
  if (!plan) return { ok: true, items: [], reasons: [] };

  const parts = partsOf(candidate);
  const itemPlans = Array.isArray(plan.itemPlans) && plan.itemPlans.length > 0 ? plan.itemPlans : null;

  const items = [];
  const reasons = [];

  parts.forEach((part, i) => {
    const intended = itemPlans ? (itemPlans[i]?.cognitiveDemand ?? null) : (i === 0 ? (plan.cognitiveDemand ?? null) : null);
    const intendedRank = intended != null ? rankOf(intended) : null;
    const letter = parts.length > 1 ? String.fromCharCode(97 + i) : null;

    if (intendedRank == null) {
      // No intended demand to compare against (absent, PROCEDURAL, or
      // UNKNOWN) — nothing to fail here, by design.
      items.push({ index: i, letter, ok: true, intended, generated: null });
      return;
    }

    const text = String(part?.text || '').trim();
    const generated = text ? classifyCognitiveDemand({ item: { referenceText: text } }).demand : 'UNKNOWN';
    const generatedRank = rankOf(generated);

    // A generated demand this check can't place on the ladder (PROCEDURAL —
    // e.g. the model answered a reasoning prompt with a code snippet — or
    // UNKNOWN) is never penalized: there is nothing reliable to compare.
    const ok = generatedRank == null || generatedRank >= intendedRank;
    items.push({ index: i, letter, ok, intended, generated });

    if (!ok) {
      const where = letter ? `(${letter}) ` : '';
      reasons.push(
        `${where}cognitive demand dropped to ${generated} (too easy) — the plan requires ${intended}-level `
        + `reasoning here; needs deeper reasoning/application, not recall.`
      );
    }
  });

  return { ok: reasons.length === 0, items, reasons };
}

export default { checkCognitiveDemandFidelity };
