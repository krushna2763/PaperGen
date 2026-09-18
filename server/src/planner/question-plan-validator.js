/**
 * question-plan-validator.js — Phase 9 §14: validates a QuestionPlan against
 * its slot/item snapshot. Deterministic; NEVER repairs — invalid plans return
 * { ok:false, errors, warnings } so the caller can fail safely or regenerate
 * with the same plan plus the failure reason (Phase 9 §16).
 *
 * Checks: required fields, valid cognitiveDemand/transformation/answerForm,
 * difficulty consistency, topic/concept presence, evidence requirements,
 * MIXED per-item integrity, IMAGE_BASED integrity, marks unchanged, item
 * count unchanged, construction unchanged, novelty constraints, unit
 * isolation, provenance where available.
 */

import { COGNITIVE_DEMANDS, TRANSFORMATIONS, marksOf } from './question-planner.js';
import { labelSlotItemDependencies } from './item-dependency.js';

function norm(v) {
  return String(v ?? '').trim();
}

/** Structural snapshot of the construction pattern for equality checks. */
function comparableConstruction(cp) {
  if (!cp || typeof cp !== 'object') return {};
  return {
    type: cp.type ?? null,
    marks: cp.marks ?? null,
    answerForm: cp.answerForm ?? null,
    optionCount: cp.optionCount ?? null,
    subquestionCount: cp.subquestionCount ?? null,
    blankCount: cp.blankCount ?? null,
    hasInternalChoice: cp.hasInternalChoice ?? false,
    imageDependent: cp.imageDependent ?? false,
  };
}

function constructionMismatch(planCp, refCp) {
  const a = comparableConstruction(planCp);
  const b = comparableConstruction(refCp);
  const diffs = [];
  for (const k of Object.keys(b)) {
    if (b[k] == null || b[k] === false) continue; // only enforce what the reference actually pins
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`constructionPattern.${k}: plan=${JSON.stringify(a[k])} reference=${JSON.stringify(b[k])}`);
  }
  return diffs;
}

/**
 * @param {Object} plan — the QuestionPlan (or MIXED header with itemPlans)
 * @param {Object} ctx — { slot, item, requirements } snapshot from the pipeline
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateQuestionPlan(plan, ctx = {}) {
  const errors = [];
  const warnings = [];
  const { slot, item, requirements } = ctx;
  const s = slot ?? {};
  const it = item ?? {};
  const p = plan ?? null;

  if (!p || typeof p !== 'object') {
    return { ok: false, errors: ['plan is missing or not an object'], warnings };
  }

  // ── 1. Required fields ──
  for (const f of ['cognitiveDemand', 'transformation', 'constructionPattern', 'evidenceRequirements', 'noveltyConstraints']) {
    if (p[f] == null) errors.push(`missing required field: ${f}`);
  }
  if (!COGNITIVE_DEMANDS.includes(p.cognitiveDemand)) {
    errors.push(`invalid cognitiveDemand "${p.cognitiveDemand}" (allowed: ${COGNITIVE_DEMANDS.join(', ')})`);
  }
  if (!TRANSFORMATIONS.includes(p.transformation)) {
    errors.push(`invalid transformation "${p.transformation}" (allowed: ${TRANSFORMATIONS.join(', ')})`);
  }

  // ── 2. Topic/concept presence when required (Phase 9 §2) ──
  const conceptMissing = norm(p.concept) === '' || p.concept == null;
  if (conceptMissing) {
    warnings.push('concept missing — downstream retrieval must fall back to topic-level evidence');
  }
  if (norm(p.topic) === '' && requirements?.topicAnchor) {
    warnings.push(`topic missing but blueprint has topicAnchor "${requirements.topicAnchor}"`);
  }

  // ── 3. Difficulty consistency (Phase 9 §7 — planner never alters it) ──
  const refDifficulty = it.difficulty ?? s.difficulty ?? requirements?.difficulty ?? null;
  if (refDifficulty != null && norm(p.difficulty) !== '' && norm(p.difficulty).toLowerCase() !== norm(refDifficulty).toLowerCase()) {
    errors.push(`difficulty changed: plan=${p.difficulty} reference=${refDifficulty} (planner must never alter difficulty)`);
  }
  if (p.difficulty != null && !['Easy', 'Medium', 'Hard'].includes(p.difficulty) && p.difficulty !== 'UNKNOWN') {
    errors.push(`invalid difficulty "${p.difficulty}" (allowed: Easy, Medium, Hard)`);
  }

  // ── 4. Evidence requirements shape (Phase 9 §6) ──
  const er = p.evidenceRequirements ?? {};
  for (const f of ['requiredConcepts', 'requiredTopics', 'requiredFacts', 'requiredRelationships']) {
    if (!Array.isArray(er[f])) errors.push(`evidenceRequirements.${f} must be an array`);
  }
  if (typeof er.visualEvidenceRequired !== 'boolean') {
    errors.push('evidenceRequirements.visualEvidenceRequired must be boolean');
  }
  if (Array.isArray(er.requiredConcepts) && er.requiredConcepts.length === 0 && conceptMissing) {
    warnings.push('no required concepts AND no concept — the question would have no supported academic anchor');
  }

  // ── 5. Novelty constraints (Phase 9 §11) ──
  const nc = p.noveltyConstraints ?? {};
  if (nc.mustNotCopyReferenceText !== true) errors.push('noveltyConstraints.mustNotCopyReferenceText must be true');
  if (nc.mustNotParaphraseReference !== true) errors.push('noveltyConstraints.mustNotParaphraseReference must be true');
  if (nc.preserveAnswerForm === false && nc.preserveMarks === false) {
    warnings.push('novelty constraints allow both answer form and marks to change — verify the blueprint permits this');
  }

  // ── 6. Construction preservation / marks / item count (Phase 9 §12) ──
  const refCp = it.constructionPattern ?? s.constructionPattern ?? null;
  if (refCp) {
    errors.push(...constructionMismatch(p.constructionPattern, refCp).map((d) => `construction changed: ${d}`));
  }
  // Share the SAME scalar-marks derivation the planner itself uses
  // (question-planner.js's marksOf) — a normalized blueprint slot carries
  // `marks` as an OBJECT ({ perItem, itemCount, total, expression }), and
  // comparing that object against a number is always unequal, which falsely
  // flagged "marks changed" on every real (normalized) blueprint slot.
  const refMarks = marksOf(it, s);
  if (refMarks != null && p.constructionPattern?.marks != null && Number(p.constructionPattern.marks) !== Number(refMarks)) {
    errors.push(`marks changed: plan=${p.constructionPattern.marks} reference=${refMarks}`);
  }
  const refItemCount = Array.isArray(s.items) ? s.items.length : (it.itemCount ?? null);
  if (refItemCount != null && p.constructionPattern?.subquestionCount != null &&
      Number(p.constructionPattern.subquestionCount) !== Number(refItemCount)) {
    errors.push(`item count changed: plan=${p.constructionPattern.subquestionCount} reference=${refItemCount}`);
  }

  // ── 7. Image integrity (Phase 9 §10) ──
  // IMAGE-BEARING is a property of the SLOT'S DATA — the reference image
  // asset(s) it carries — NOT of its question type. The blueprint normalizer
  // legitimately re-derives an analyze-declared IMAGE_BASED slot to MIXED when
  // its items carry two or more distinct types (question type describes the
  // slot's item STRUCTURE; image dependency describes its relationship with a
  // reference image — two independent dimensions). The plan builder sets
  // imageRequirement.required from the same asset signal, so the validator must
  // accept it for an image-bearing MIXED slot rather than reject the planner's
  // own contract (which made every real image-bearing MIXED slot invalid while
  // the plan itself was correct).
  const type = it.type ?? s.type ?? null;
  const imageBearing = type === 'IMAGE_BASED'
    || (Array.isArray(it.imageAssets) && it.imageAssets.length > 0)
    || (Array.isArray(s.imageAssets) && s.imageAssets.length > 0);
  if (imageBearing) {
    if (p.imageRequirement?.required !== true) {
      errors.push(`${type} plan for an image-bearing slot must set imageRequirement.required=true`);
    }
    if (nc.preserveImageDependency !== true) {
      errors.push(`${type} plan for an image-bearing slot must set noveltyConstraints.preserveImageDependency=true`);
    }
    if (p.imageRequirement?.observationTarget == null && p.imageRequirement?.visualAnchor?.target == null && !p.reviewRequired) {
      warnings.push(`${type} plan has no observationTarget/visualAnchor and is not flagged reviewRequired — visual understanding may be insufficient`);
    }
  } else if (p.imageRequirement?.required === true) {
    errors.push(`non-image-bearing plan (${type}) must not require an image`);
  }

  // ── 7b. Grounded visual target for every IMAGE_DEPENDENT unit (Phase 9 §10) ──
  // An image-dependent unit that carries grounding evidence MUST expose the
  // concrete grounded target the generator has to require. Without it the
  // planner would be asking for an image-dependent question while telling the
  // generator nothing to observe — how a generic, notes-answerable question
  // gets written. A warning (never an error): the grounding-disabled path
  // legitimately has no vision evidence to anchor on.
  const visualUnits = (Array.isArray(p.itemPlans) && p.itemPlans.length > 0)
    ? p.itemPlans.map((ip, i) => ({ who: `itemPlans[${i}]`, dep: ip?.imageDependency ?? null, ir: ip?.imageRequirement ?? null, grounding: ip?.imageGrounding ?? null }))
    : [{ who: 'plan', dep: p.imageDependency ?? (type === 'IMAGE_BASED' ? 'IMAGE_DEPENDENT' : null), ir: p.imageRequirement ?? null, grounding: p.imageGrounding ?? null }];
  for (const u of visualUnits) {
    if (u.dep === 'IMAGE_DEPENDENT' && u.grounding && !u.ir?.visualAnchor?.target) {
      warnings.push(`${u.who} is IMAGE_DEPENDENT and carries image grounding but has no grounded visualAnchor target — nothing concrete tells the generator what the question must require`);
    }
  }

  // ── 8. MIXED per-item integrity (Phase 9 §9) ──
  if (type === 'MIXED') {
    const ips = Array.isArray(p.itemPlans) ? p.itemPlans : null;
    const refItems = Array.isArray(s.items) ? s.items : [];
    // The SAME positional classification the prompt's IMAGE GROUNDING block,
    // the grounding/novelty agents and the image checks below use. A plan whose
    // sub-part disagrees with it contradicts the rest of the pipeline — the
    // exact silent divergence that made the generator write a notes-answerable
    // question while the prompt required the image.
    const itemDeps = imageBearing && refItems.length > 0 ? labelSlotItemDependencies(s) : null;
    if (!ips) {
      errors.push('MIXED slot plan is missing per-item itemPlans (items must never be merged into one plan)');
    } else {
      if (ips.length !== s.items.length) {
        errors.push(`MIXED itemPlans count (${ips.length}) does not match slot items (${s.items.length})`);
      } else {
        s.items.forEach((refItem, i) => {
          const ip = ips[i];
          if (!ip) { errors.push(`MIXED itemPlans[${i}] missing`); return; }
          const refType = refItem.type ?? null;
          if (refType && ip.constructionPattern?.type !== refType) {
            errors.push(`MIXED itemPlans[${i}] type changed: plan=${ip.constructionPattern?.type} reference=${refType}`);
          }
          if (refItem.marks != null && ip.constructionPattern?.marks != null &&
              Number(ip.constructionPattern.marks) !== Number(refItem.marks)) {
            errors.push(`MIXED itemPlans[${i}] marks changed: plan=${ip.constructionPattern.marks} reference=${refItem.marks}`);
          }
          if (ip.itemLabel == null) warnings.push(`MIXED itemPlans[${i}] has no itemLabel`);
        });
      }
      for (let i = 0; i < ips.length; i += 1) {
        const ip = ips[i];
        if (!COGNITIVE_DEMANDS.includes(ip.cognitiveDemand)) errors.push(`MIXED itemPlans[${i}] invalid cognitiveDemand "${ip.cognitiveDemand}"`);
        if (!TRANSFORMATIONS.includes(ip.transformation)) errors.push(`MIXED itemPlans[${i}] invalid transformation "${ip.transformation}"`);
        // ITEM-LEVEL IMAGE DEPENDENCY for an image-bearing slot: every item
        // with reference text must carry its dependency class, and it must be
        // the class the reference item's own classification yields.
        if (itemDeps && String(refItems[i]?.referenceText ?? '').trim()) {
          const expected = itemDeps[i] ?? null;
          if (ip.imageDependency == null) {
            errors.push(`MIXED itemPlans[${i}] has no imageDependency although the image-bearing slot's reference item has text`);
          } else if (expected && ip.imageDependency !== expected) {
            errors.push(`MIXED itemPlans[${i}] imageDependency=${ip.imageDependency} contradicts the reference item's own classification (${expected})`);
          }
        }
      }
    }
  }

  // ── 9. Unit isolation (Phase 9 — inherits Phase 8 §11) ──
  const refUnit = requirements?.detectedUnit ?? s.unit ?? null;
  if (refUnit != null && norm(p.topic) !== '' && p.sourceReferences?.length > 0) {
    const offUnit = p.sourceReferences.filter((sr) => sr.unit != null && norm(sr.unit) !== norm(refUnit));
    if (offUnit.length > 0) {
      errors.push(`unit isolation violated: ${offUnit.length} source reference(s) from outside unit "${refUnit}"`);
    }
  }

  // ── 10. Provenance where available ──
  if (Array.isArray(p.sourceReferences)) {
    for (let i = 0; i < p.sourceReferences.length; i += 1) {
      const sr = p.sourceReferences[i];
      if (sr.sourceDocumentId == null && sr.sourceHash == null) {
        warnings.push(`sourceReferences[${i}] has neither sourceDocumentId nor sourceHash (provenance incomplete)`);
      }
    }
  }

  // ── 11. Review propagation ──
  if (p.reviewRequired && (!p.plannerWarnings || p.plannerWarnings.length === 0)) {
    warnings.push('reviewRequired=true but plannerWarnings is empty — the review reason is unrecorded');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Batch validation for buildPlansForSlot output (Phase 9 §14).
 * @returns {{ok, errors, warnings, perPlan: Array<{index, ok, errors, warnings}>}}
 */
export function validatePlansForSlot(plans, ctx = {}) {
  const perPlan = [];
  const allErrors = [];
  const allWarnings = [];
  const list = Array.isArray(plans) ? plans : [plans];
  list.forEach((plan, i) => {
    const r = validateQuestionPlan(plan, ctx);
    perPlan.push({ index: i, ...r });
    for (const e of r.errors) allErrors.push(`plans[${i}]: ${e}`);
    for (const w of r.warnings) allWarnings.push(`plans[${i}]: ${w}`);
  });
  return { ok: allErrors.length === 0, errors: allErrors, warnings: allWarnings, perPlan };
}

export default { validateQuestionPlan, validatePlansForSlot };
