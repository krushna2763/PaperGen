/**
 * quality-diversity-prompt.js — ANSWER-FIRST PROMPT BLOCK (Phase 6).
 *
 * Kept separate from quality-diversity.js (pure logic) so the logic module
 * stays import-free of prompt concerns. One pure formatter, no AI calls.
 *
 * The block realizes the ANSWER-FIRST GENERATION requirement: the generator
 * must derive the question FROM the internal answer target (what knowledge
 * the question tests + what kind of answer is expected + the retrieved
 * evidence facts it must stay answerable from), NOT by rewriting the
 * reference text. The target is internal — it directs generation and never
 * appears on the student paper (normalizeGeneratedQuestion carries no such
 * field, so it physically cannot leak into the rendered paper).
 */

import { expectedAnswerKindFor } from './quality-diversity.js';

/** One item's (or a slot's) directive bits from a selectTarget()-shaped target. */
function directiveBits(target) {
  const bits = [];
  const targetDemand = String(target.targetDemands?.[0] || '').toUpperCase();
  const kind = expectedAnswerKindFor(target.answerTarget);
  if (target.answerTarget) bits.push(`it must demand ${kind}`);
  if (targetDemand) bits.push(`approach it as a ${targetDemand} task (the reference asked ${String(target.referenceDemand || target.answerTarget || '').toUpperCase()} — test the SAME concept through that different demand; a mere re-wording of the reference question is rejected, and so is dropping the concept)`);
  if (target.transformation?.name) {
    bits.push(
      target.transformation.directive
        ? `apply the transformation ${target.transformation.name}: ${target.transformation.directive}`
        : `apply the transformation ${target.transformation.name}`
    );
  }
  // PHASE 6.1 — a programming/code-writing item gets its OWN construction-
  // level directive instead of (never in addition to conflicting with) the
  // academic transformation bits above; codingDirective already states the
  // full requirement on its own.
  if (target.isCodingTask && target.codingDirective) {
    return [target.codingDirective];
  }
  return bits;
}

/**
 * Format ONE slot's answer-first directive.
 * @param {Object|null} target - selectTarget()-shaped: { answerTarget,
 *   targetDemands, transformation, referenceDemand, requiredConstraints, ... },
 *   optionally carrying `items` (per-item selectTarget() outputs) — a MIXED/
 *   multi-item slot then gets one directive line PER item.
 * @returns {string} '' when no target — prompts stay byte-identical for
 *   existing callers/tests.
 */
export function formatAnswerTargetDirective(target) {
  if (!target) return '';
  const itemLines = (Array.isArray(target.items) ? target.items : [])
    .map((t, i) => {
      const bits = directiveBits(t || {});
      if (bits.length === 0) return null;
      const label = t?.itemLabel || String.fromCharCode(97 + (i % 26));
      return `\n   - item (${label}): ${bits.join('; ')}.`;
    })
    .filter(Boolean);
  if (itemLines.length > 0) {
    return `\n   ANSWER-FIRST DIRECTIVE (internal — build each item from this, never print it): decide WHAT KNOWLEDGE each item tests, then:${itemLines.join('')}
   The new stems must NOT reuse the reference items' distinctive phrasing, and must NOT drop the reference items' underlying concepts either — new demand, same concept.`;
  }
  const bits = directiveBits(target);
  if (bits.length === 0) return '';
  return `\n   ANSWER-FIRST DIRECTIVE (internal — build the question from this, never print it): decide WHAT KNOWLEDGE is tested and ${bits.join('; ')}. The new stem must NOT reuse the reference item's distinctive phrasing, and must NOT drop the reference item's underlying concept — new demand, same concept.`;
}

export default { formatAnswerTargetDirective };
