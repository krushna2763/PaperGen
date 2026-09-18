/**
 * candidate-selector.js — CANDIDATE POOL PRE-SCREEN / RANKING (Phase 2, Part 3).
 *
 * Runs a POOL of candidates through the SAME deterministic, no-LLM-call
 * validators the pipeline already trusts (blueprint structure, answers, topic
 * fidelity, reference novelty, grounding) and picks the strongest survivor.
 *
 * This is a PRE-SCREEN, not a competing validator: the winner it returns
 * still goes through the EXACT existing evaluateBatchNode/blueprintCheckNode
 * pipeline (embedding backstop, peer/source similarity, the real semantic
 * LLM validation call) — this module never accepts or rejects a slot itself,
 * it only orders candidates before the real gates see them. Never silently
 * drops a slot: with N candidates in, one candidate always comes out, even
 * when every one of them fails — the existing pipeline then rejects it
 * honestly, with real reasons, exactly as a single un-pooled candidate would.
 */
import { checkQuestion } from '../blueprint/blueprint-validator.js';
import { checkAnswers } from '../blueprint/answer-validator.js';
import { validationAgent } from './validation.agent.js';
import { checkReferenceNovelty, referenceItemPairs, subPartTexts } from './reference-novelty.agent.js';
import { checkGrounding } from './grounding.agent.js';
import { scoreCandidateQuality } from './quality-diversity.js';
import { cosineSimilarity } from './agent-utils.js';
import { checkCognitiveDemandFidelity } from './cognitive-demand-fidelity.js';
import { checkVisualEngagement } from '../rag/image-grounding.service.js';

/** The QuestionPlan (Phase 9) attached to this slot's retrieval context, or
 * null when the planner is disabled / planning failed for this slot. */
function planFor(slotContexts, slotIndex) {
  return (Array.isArray(slotContexts) && slotIndex != null ? slotContexts[slotIndex] : null)?.plan ?? null;
}

/** True when this slot is IMAGE_BASED and requires imageAssets to survive on the candidate. */
function imageRelationshipOk(candidate, slot) {
  const needsImage = String(slot?.type || '').toUpperCase() === 'IMAGE_BASED'
    && Array.isArray(slot?.imageAssets) && slot.imageAssets.length > 0;
  if (!needsImage) return true;
  const carries = (Array.isArray(candidate?.imageAssets) && candidate.imageAssets.length > 0)
    || (Array.isArray(candidate?.assetImages) && candidate.assetImages.length > 0);
  return carries;
}

/**
 * Run every existing deterministic gate against ONE candidate. Mirrors the
 * exact gate set/order orchestrator.agent.js's regenerateSlot already uses:
 * structure → answers → image relationship → topic fidelity → reference
 * novelty → grounding.
 * @param {Object} opts
 * @param {Object} opts.candidate - normalized generated question
 * @param {Object} opts.slot - locked blueprint slot
 * @param {number|null} opts.slotIndex
 * @param {Object|null} opts.blueprint - full locked blueprint (for reference-novelty/grounding)
 * @param {Array} [opts.slotContexts]
 * @param {Object|null} [opts.slotUnitMap]
 * @param {Object} [opts.thresholds] - reference-novelty threshold override (test-only; unchanged in production)
 * @returns {{ candidate: Object, structuralOk: boolean, reasons: string[], avgOverlap: number, failureCount: number }}
 */
export function evaluateCandidate({ candidate, slot, slotIndex = null, blueprint = null, slotContexts = [], slotUnitMap = null, thresholds = {} }) {
  const structure = checkQuestion(candidate, slot);
  const answers = checkAnswers(candidate, slot);
  const imageOk = imageRelationshipOk(candidate, slot);
  const imageReasons = imageOk ? [] : [
    `Candidate for IMAGE_BASED slot ${slot?.label ?? slotIndex ?? ''} lost the required image relationship — imageAssets missing.`,
  ];
  const topic = validationAgent.checkPerItemTopicFidelity(candidate, slot, {
    imageGrounding: slotContexts?.[slotIndex ?? -1]?.imageGrounding ?? null,
  });
  const novelty = blueprint
    ? checkReferenceNovelty({ question: candidate, slotIndex, blueprint, thresholds, imageGrounding: slotContexts?.[slotIndex ?? -1]?.imageGrounding ?? null })
    : { ok: true, items: [], reasons: [] };
  // Mirrors orchestrator.agent.js's own guard exactly: grounding only runs
  // when real per-slot RAG evidence is actually available. Without it there
  // is nothing to ground against, and the check must not manufacture a
  // failure out of its own absence — the orchestrator's un-pooled path
  // already skips it the same way, so a pooled candidate is judged by the
  // identical rule.
  const hasContext = Array.isArray(slotContexts) && slotContexts.some((ctx) => ctx != null && (Array.isArray(ctx.results) || ctx.itemResults));
  const grounding = hasContext
    ? checkGrounding({ question: candidate, slotIndex, slotContexts, blueprint, slotUnitMap, imageGrounding: slotContexts?.[slotIndex ?? -1]?.imageGrounding ?? null })
    : { grounded: true, reasons: [] };
  // PHASE 11 — does the candidate demonstrate the cognitive demand the
  // Question Planner (Phase 9) intended, or did it quietly drift simpler
  // (e.g. a REASONING-intended item answered with bare RECALL)? A genuine
  // no-op when the planner is disabled or planning failed for this slot.
  const demandFidelity = checkCognitiveDemandFidelity(candidate, planFor(slotContexts, slotIndex));
  // IMAGE-DEPENDENT VISUAL ENGAGEMENT — closes the "names a concept but never
  // requires looking at the image" gap (e.g. "What is the role of the JVM?").
  // A no-op when no image grounding exists for this slot; never forces visual
  // wording onto an IMAGE_CONTEXTUAL part.
  const visualEngagement = checkVisualEngagement(candidate, slotContexts?.[slotIndex ?? -1]?.imageGrounding ?? null, slot);

  const structuralOk = structure.ok && answers.ok && imageOk;
  const reasons = [...structure.reasons, ...answers.reasons, ...imageReasons, ...topic.reasons, ...novelty.reasons, ...grounding.reasons, ...demandFidelity.reasons, ...visualEngagement.reasons];

  // Novelty score: mean lexical stem-overlap across the candidate's items vs
  // their positional reference (reference-novelty.agent.js already computes
  // this per item) — lower overlap = more novel = ranks better among
  // otherwise-equal candidates. 0 when there is nothing to compare (no
  // blueprint, or a slot with no reference items) so it never penalizes.
  const overlaps = (novelty.items || []).map((it) => it.stemOverlap).filter((n) => Number.isFinite(n));
  const avgOverlap = overlaps.length > 0 ? overlaps.reduce((a, b) => a + b, 0) / overlaps.length : 0;

  return { candidate, structuralOk, reasons, avgOverlap, failureCount: reasons.length };
}

/**
 * Mean cosine similarity between the candidate's sub-parts and their
 * POSITIONAL reference items, using caller-precomputed vectors (the same
 * batch the embedding-novelty backstop already builds — never a second
 * embedding pass). 0 when either side lacks vectors; null when no vector map
 * was supplied at all (the signal is then simply absent from ranking).
 * @returns {number|null}
 */
export function semanticSimilarityToReference(candidate, slot, vectorsByText) {
  if (!(vectorsByText instanceof Map)) return null;
  const parts = subPartTexts(candidate);
  const refs = referenceItemPairs(slot);
  if (parts.length === 0 || refs.length === 0) return null;
  const sims = [];
  const maxPairs = Math.min(parts.length, refs.length);
  for (let i = 0; i < maxPairs; i++) {
    const genVec = vectorsByText.get(parts[i].text);
    const refVec = vectorsByText.get(refs[i].text);
    if (!Array.isArray(genVec) || !Array.isArray(refVec)) continue;
    sims.push(cosineSimilarity(genVec, refVec));
  }
  if (sims.length === 0) return null;
  return sims.reduce((a, b) => a + b, 0) / sims.length;
}

/**
 * Select the strongest candidate from a pool. Structural validity (blueprint
 * shape, answers, image relationship) is NON-NEGOTIABLE — a structurally
 * invalid candidate can never outrank a structurally valid one, regardless of
 * novelty/grounding scores. Among structurally-equal candidates the PHASE 6
 * quality score decides: fewer validator failures, lower lexical AND semantic
 * overlap against the reference (novelty in both spaces), stronger RAG
 * grounding coverage, better difficulty alignment and an applied information-
 * demand transformation all push the score up. The score only ORDERS — every
 * winner still goes through the real pipeline gates unchanged.
 * @param {Object} opts - same shape as evaluateCandidate, plus `candidates: Object[]`
 *   and optional `vectorsByText` (Map text→embedding) and `targets`
 *   (selectTarget()-shaped per-item targets for the transformation signal)
 * @returns {{ winner: Object|null, winnerEval: Object|null, evaluations: Object[] }}
 */
export function selectBestCandidate({ candidates, slot, slotIndex = null, blueprint = null, slotContexts = [], slotUnitMap = null, thresholds = {}, vectorsByText = null, targets = [], requirements = {} }) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length === 0) return { winner: null, winnerEval: null, evaluations: [] };

  const evaluations = list.map((candidate) => {
    const base = evaluateCandidate({ candidate, slot, slotIndex, blueprint, slotContexts, slotUnitMap, thresholds });
    const semanticSim = semanticSimilarityToReference(candidate, slot, vectorsByText);
    const quality = scoreCandidateQuality({
      candidate,
      slot,
      requirements,
      gates: {
        structure: checkQuestion(candidate, slot),
        answers: checkAnswers(candidate, slot),
        imageOk: imageRelationshipOk(candidate, slot),
        topic: validationAgent.checkPerItemTopicFidelity(candidate, slot, {
          imageGrounding: slotContexts?.[slotIndex ?? -1]?.imageGrounding ?? null,
        }),
        novelty: blueprint
          ? checkReferenceNovelty({ question: candidate, slotIndex, blueprint, thresholds, imageGrounding: slotContexts?.[slotIndex ?? -1]?.imageGrounding ?? null })
          : { ok: true, items: [], reasons: [] },
        grounding: (Array.isArray(slotContexts) && slotContexts.some((ctx) => ctx != null && (Array.isArray(ctx.results) || ctx.itemResults)))
          ? checkGrounding({ question: candidate, slotIndex, slotContexts, blueprint, slotUnitMap, imageGrounding: slotContexts?.[slotIndex ?? -1]?.imageGrounding ?? null })
          : { grounded: true, items: [], reasons: [] },
        // PHASE 11 — see evaluateCandidate's comment above.
        demandFidelity: checkCognitiveDemandFidelity(candidate, planFor(slotContexts, slotIndex)),
        // IMAGE-DEPENDENT VISUAL ENGAGEMENT — see evaluateCandidate's comment above.
        visualEngagement: checkVisualEngagement(candidate, slotContexts?.[slotIndex ?? -1]?.imageGrounding ?? null, slot),
      },
      semanticSim,
      targets,
      poolPeers: list,
      // PHASE 10 — Phase 8's fused graph evidence for THIS slot, when the
      // hybrid_graph retrieval mode populated it; absent/empty in every other
      // mode, so scoring is unaffected unless a deployer opts into it.
      graphEvidence: (Array.isArray(slotContexts) ? slotContexts[slotIndex] : null)?.graphEvidence || null,
      // SEMANTIC IMAGE GROUNDING — the slot's grounding evidence (when the
      // image-grounding layer ran). Candidates that engage the grounded image
      // topic/concepts rank higher; absent → 0, byte-identical to before.
      imageGrounding: (Array.isArray(slotContexts) ? slotContexts[slotIndex] : null)?.imageGrounding || null,
    });
    return { ...base, score: quality.score, checks: quality.checks, quality };
  });
  const ranked = [...evaluations].sort((a, b) => {
    if (a.structuralOk !== b.structuralOk) return a.structuralOk ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.avgOverlap - b.avgOverlap;
  });

  return { winner: ranked[0].candidate, winnerEval: ranked[0], evaluations };
}

export default { evaluateCandidate, selectBestCandidate, semanticSimilarityToReference };
