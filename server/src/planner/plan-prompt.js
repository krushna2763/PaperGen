/**
 * plan-prompt.js — Phase 9: renders a QuestionPlan (or a MIXED slot's per-item
 * plans) as the generator prompt's PLAN block. Isolated here so the generator
 * needs only ONE additive branch (formatSlotSpec) and prompts stay
 * byte-identical when the planner is disabled (this returns '').
 *
 * Prompt contract (Phase 9 §15): the generator must see
 *   REFERENCE  — what the old question looked like
 *   PLAN       — what the new question must accomplish
 *   EVIDENCE   — what academic information may be used
 *   CONSTRAINTS— what must remain structurally identical
 *   NOVELTY    — what must NOT be copied/paraphrased
 * Source text stays the factual authority; graph relationships are context.
 */

// ITEM-LEVEL image dependency labels come straight from the deterministic
// classifier in the grounding service (single source of truth — the planner,
// generator prompts and validators all read the same labels).
import { labelSlotItemDependencies } from '../rag/image-grounding.service.js';

const KNOWN = (v) => (v != null && v !== '' && v !== 'UNKNOWN' ? String(v) : null);

function itemPlanLines(p, label) {
  const lines = [];
  const who = label ? `item ${label}` : 'slot';
  lines.push(`  cognitiveDemand=${p.cognitiveDemand} transformation=${p.transformation}`);
  if (KNOWN(p.answerTarget)) lines.push(`  answerTarget (${who}): ${p.answerTarget}`);
  if (KNOWN(p.topic)) lines.push(`  topic: ${p.topic}${KNOWN(p.concept) ? ` | concept: ${p.concept}` : ''}`);
  // ITEM-LEVEL image dependency: sub-parts planned IMAGE_CONTEXTUAL keep the
  // image's topic but are NOT forced to be answerable only from pixels —
  // faithfully mirroring the reference item's own relationship with the image.
  if (p.imageDependency === 'IMAGE_DEPENDENT') {
    lines.push('  imageDependency=IMAGE_DEPENDENT (this sub-part MUST require observing the reference image)');
    // EXPLICIT VISUAL TARGET (Part 3/4): one concrete, grounded relationship
    // (never invented — see buildImageRequirement) so the generator is not
    // choosing loosely among the whole relationships list. The instruction
    // is deliberately aimed at the STEM WORDING itself, not only the
    // structured visualAnchor field a candidate could fill in isolation
    // while still writing a definition-only question.
    const va = p.imageRequirement?.visualAnchor;
    if (va?.target) {
      lines.push(`  REQUIRED VISUAL TARGET (${who}): ${va.target}`);
      lines.push(`  The question text itself for ${who} (not only the visualAnchor field) must describe this relationship/position/structure — using its own relational wording (e.g. connects, contains, branch, flow, linked, positioned, grouped, compared) — so it cannot be answered without inspecting the image for this specific detail. Do not merely name a concept the image depicts.`);
      lines.push(`  Never prepend "Observe the diagram" to a textbook fact question that can be answered from memory; the question must genuinely require inspecting the diagram to identify the visible arrangement, relative layer position, hierarchy, or grouping.`);
    }
  } else if (p.imageDependency === 'IMAGE_CONTEXTUAL') lines.push('  imageDependency=IMAGE_CONTEXTUAL (this sub-part stays on the image topic; it need NOT be answerable only from the image — do NOT force visual wording onto it)');
  const er = p.evidenceRequirements || {};
  if (er.requiredConcepts?.length) lines.push(`  requiredConcepts: ${er.requiredConcepts.join(', ')}`);
  if (er.requiredRelationships?.length) lines.push(`  requiredRelationships (graph, source-backed): ${er.requiredRelationships.join('; ')}`);
  if (er.visualEvidenceRequired) lines.push('  visualEvidenceRequired=true (question MUST depend on the image)');
  if (KNOWN(p.difficulty)) lines.push(`  difficulty=${p.difficulty} paperStyle=${p.paperStyle ?? 'unspecified'}`);
  if (p.reviewRequired) lines.push(`  REVIEW-REQUIRED: ${(p.plannerWarnings || []).join('; ')}`);
  return lines;
}

/**
 * SEMANTIC IMAGE GROUNDING — render the grounding evidence as an IMAGE
 * GROUNDING block: what the reference image depicts (from the ONE vision
 * call), which notes text grounds it, and what the generator must therefore
 * do. Empty string when no grounding is attached (byte-identical prompts
 * when the grounding layer is disabled/unavailable). A notes image is never
 * mentioned as replaceable — the reference image stays on the paper.
 */
function formatImageGroundingBlock(grounding, slot = null) {
  if (!grounding || grounding.status !== 'ok') return '';
  const ri = grounding.referenceImage ?? {};
  const deps = slot ? labelSlotItemDependencies(slot) : null;
  const nDependent = deps ? deps.filter((d) => d === 'IMAGE_DEPENDENT').length : 0;
  const parts = [];
  parts.push('   IMAGE GROUNDING (the question is grounded in this evidence; each sub-part follows ITS OWN dependency class below):');
  parts.push('   - DUAL-GROUNDING RULE (IMAGE CONTEXT + NOTES CONTEXT):');
  parts.push('     Every Image-Based question MUST meaningfully connect what is VISIBLE in the image with the ACADEMIC KNOWLEDGE from the syllabus notes:');
  parts.push('     1. Visual Evidence: Student must observe specific visual elements, people, actions, labels, or interactions depicted in the picture.');
  parts.push('     2. Academic Evidence: The educational fact, concept, or explanation must be supported by the syllabus notes text provided below.');
  parts.push('     3. Avoid asking questions that could be answered from memory without looking at the picture.');
  if (KNOWN(ri.topic)) parts.push(`   - Image topic: ${ri.topic}`);
  if (ri.concepts?.length) parts.push(`   - Concepts depicted (each sub-part engages them per its OWN dependency class below): ${ri.concepts.join(', ')}`);
  if (deps && deps.length > 0) {
    const letters = deps.map((_, i) => String.fromCharCode(97 + (i % 26)));
    parts.push(`   - ITEM-LEVEL IMAGE DEPENDENCY (determined by the REFERENCE paper's own relationship with the image — preserve it):`);
    deps.forEach((d, i) => {
      if (d === 'IMAGE_DEPENDENT') {
        parts.push(`     · (${letters[i]}) IMAGE_DEPENDENT — MUST be answerable ONLY by observing the reference image (identify/describe/compare something shown in it). Naming a concept the image depicts is NOT enough (e.g. "What is the role of the JVM?" or "Based on the diagram, what is JVM?" are REJECTED — neither actually requires looking). The question must require inspecting a genuine visual relationship, position, label, arrow, grouping, sequence or component placement — something only visible in the image, not recoverable from notes/general knowledge alone. Also fill this sub-part's "visualAnchor": { target, usage } — target = the specific observation target below it engages (in your own words, semantic meaning, not copied verbatim); usage = one line on how the student must use that visual detail to answer.`);
      } else if (d === 'IMAGE_CONTEXTUAL') {
        parts.push(`     · (${letters[i]}) IMAGE_CONTEXTUAL — stays on the image topic, but its answer is topic knowledge: it must NOT be forced into visual wording and being answerable without the image is correct. Do NOT fill visualAnchor for this sub-part.`);
      }
    });
  } else {
    parts.push('   - EVERY sub-part (a, b, …) must be answerable ONLY by observing the reference image; no sub-part may be answerable from the notes or general knowledge alone. Keep every sub-part on the slot\'s reference topic as well.');
    parts.push('   - Naming a depicted concept is NOT enough (e.g. "What is the role of the JVM?" or "Based on the diagram, what is JVM?" are REJECTED). Require inspecting a genuine visual relationship, position, label, arrow, grouping, sequence or component placement. Fill each sub-part\'s "visualAnchor": { target, usage } with the observation target it engages (semantic meaning, not copied verbatim) and how the student must use it.');
  }
  if (nDependent > 0) {
    parts.push(`   - At least ${nDependent === 1 ? 'one sub-part (the IMAGE_DEPENDENT one(s)) must' : `${nDependent} sub-parts (the IMAGE_DEPENDENT ones) must`} genuinely require the image.`);
  }
  if (ri.visualElements?.length) parts.push(`   - Elements actually shown: ${ri.visualElements.join('; ')}`);
  if (ri.relationships?.length) parts.push(`   - Visual relationships the image expresses: ${ri.relationships.join('; ')}`);
  if (ri.observationTargets?.length) {
    parts.push(`   - Observation targets (require the student to identify/describe/compare these in the image): ${ri.observationTargets.join('; ')}`);
    parts.push('   - Do NOT invent any visual detail beyond these observation targets.');
  } else {
    parts.push('   - No verified observation target is available: do NOT invent one. Build the question strictly on the concepts/relationships listed above as they appear in the image.');
  }
  const textEv = (grounding.notesTextEvidence ?? []).filter((e) => String(e?.text ?? '').trim()).slice(0, 3);
  if (textEv.length > 0) {
    parts.push('   - Notes text evidence for the same topic/concepts (the ACADEMIC grounding — build the question on it):');
    for (const e of textEv) parts.push(`     · ${String(e.text).slice(0, 220)}`);
  }
  const notesImgs = (grounding.notesImageEvidence ?? []).filter((i) => i.associated);
  if (notesImgs.length > 0) {
    parts.push(`   - The notes contain ${notesImgs.length} image(s) on the same topic (supporting evidence only — the REFERENCE image stays on the paper; never describe the notes images).`);
  }
  return `\n${parts.join('\n')}`;
}

/**
 * @param {Object|null} slotCtx — a per-slot context possibly carrying
 *   slotCtx.plan and (for MIXED) slotCtx.plan.itemPlans.
 * @returns {string} '' when no plan is attached (planner disabled).
 */
export function formatPlanBlock(slotCtx, slot = null) {
  const plan = slotCtx?.plan ?? null;
  if (!plan) return '';
  const parts = [];
  parts.push('   QUESTION PLAN (generate FROM this plan — do NOT rewrite the reference):');
  if (KNOWN(plan.topic)) parts.push(`   topic=${plan.topic}${KNOWN(plan.concept) ? ` concept=${plan.concept}` : ''}`);
  // SEMANTIC IMAGE GROUNDING — rides INSIDE the PLAN block so the whole
  // planner-ON/OFF byte-identity contract is preserved (stripping PLAN_LINE
  // removes it together with the rest of the block). The blueprint slot rides
  // along so the grounding block can label each sub-part with its reference
  // item's image-dependency class.
  const groundingBlock = formatImageGroundingBlock(plan.imageGrounding, slot);
  if (groundingBlock) parts.push(groundingBlock);
  const itemPlans = Array.isArray(plan.itemPlans) && plan.itemPlans.length > 0 ? plan.itemPlans : null;
  if (itemPlans) {
    parts.push('   Per-item plans (MIXED — each sub-part follows its OWN plan; never merge them):');
    for (const ip of itemPlans) parts.push(...itemPlanLines(ip, ip.itemLabel));
  } else {
    parts.push(...itemPlanLines(plan, null));
  }
  const nc = plan.noveltyConstraints || {};
  const novelty = [
    nc.mustNotCopyReferenceText ? 'never copy reference wording' : null,
    nc.mustNotParaphraseReference ? 'never paraphrase the reference question' : null,
    nc.preserveConcept ? 'preserve the target concept' : null,
    nc.preserveAnswerTarget ? 'preserve the answer target' : null,
    nc.preserveAnswerForm ? 'preserve the answer form' : null,
    nc.preserveMarks ? 'preserve marks exactly' : null,
    nc.preserveItemCount ? 'preserve the item/subquestion count exactly' : null,
    nc.preserveImageDependency ? 'preserve the image dependency (the question MUST require the image)' : null,
  ].filter(Boolean);
  if (novelty.length) parts.push(`   NOVELTY CONSTRAINTS: ${novelty.join('; ')}.`);
  const er = plan.evidenceRequirements || {};
  parts.push(
    '   EVIDENCE AUTHORITY: SOURCE EVIDENCE (retrieved textbook/notes text) is the factual authority; ' +
    'GRAPH CONTEXT (concept relationships) is structural context only. Do not state any academic claim unsupported by source evidence.'
  );
  if (er.visualEvidenceRequired && !plan.imageRequirement?.observationTarget) {
    parts.push('   VISUAL: rely on the provided image; no textual description of the image content is available — do not invent one.');
  }
  return `\n${parts.join('\n')}`;
}

export { formatImageGroundingBlock };

export default { formatPlanBlock, formatImageGroundingBlock };
