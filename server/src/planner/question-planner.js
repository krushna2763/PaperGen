/**
 * question-planner.js — Phase 9: Advanced Question Planner (DETERMINISTIC-FIRST).
 *
 * Sits between retrieval and the existing question generator. For every
 * reference question/slot (and every MIXED item) it produces a canonical
 * QuestionPlan: WHAT kind of NEW question must be created (cognitive demand,
 * transformation, answer target, evidence requirements, novelty constraints)
 * BEFORE the generator writes it.
 *
 * Rules enforced here (Phase 9 spec):
 *   - Deterministic-first: reuses existing structured data (slotTargets from
 *     target-selector.js, question intents from blueprint/question-intent.js,
 *     reference-analyzer fields, Phase 8 hybrid evidence). No LLM calls at all.
 *   - Never invents values: unknown topic/concept/answerTarget stay null and
 *     raise a plannerWarning + reviewRequired.
 *   - Source text (vector evidence) is the factual authority (Phase 8 rule);
 *     graph relationships are used ONLY when they carry source provenance.
 *   - Blueprint structure is never altered: type/marks/itemCount/answerForm/
 *     optionCount/image dependency travel through as immutable constraints.
 *   - The existing novelty agent remains the FINAL novelty authority; this
 *     planner only declares the intended transformation constraints.
 */

import { classifyCognitiveOperation, buildQuestionIntent, isCodingTask, conceptTerms } from '../blueprint/question-intent.js';
import { classifyItemDependency, labelSlotItemDependencies } from './item-dependency.js';

/** Canonical cognitive-demand taxonomy (Phase 9 §3). */
export const COGNITIVE_DEMANDS = Object.freeze([
  'RECALL', 'UNDERSTANDING', 'APPLICATION', 'ANALYSIS',
  'REASONING', 'EVALUATION', 'CREATION', 'PROCEDURAL', 'UNKNOWN',
]);

/** Canonical transformation set (Phase 9 §4). */
export const TRANSFORMATIONS = Object.freeze([
  'DIRECT_TO_NEW_CONTEXT', 'DIRECT_TO_APPLICATION', 'DIRECT_TO_SCENARIO',
  'DIRECT_TO_REASONING', 'DIRECT_TO_COMPARISON', 'DIRECT_TO_PROBLEM',
  'DIRECT_TO_CASE', 'DIRECT_TO_INTERPRETATION', 'DIRECT_TO_PROCEDURAL',
  'DIRECT_TO_VISUAL', 'STRUCTURAL_EQUIVALENT', 'NONE', 'UNKNOWN',
]);

/** Maps the EXISTING information-demand taxonomy (question-intent.js /
 * target-selector.js) onto the Phase 9 cognitive-demand taxonomy. */
const DEMAND_FROM_OPERATION = Object.freeze({
  FACT: 'RECALL',
  DEFINITION: 'RECALL',
  APPLICATION: 'APPLICATION',
  CAUSE: 'REASONING',
  EFFECT: 'REASONING',
  COMPARISON: 'ANALYSIS',
  REASONING: 'REASONING',
  EXAMPLE: 'UNDERSTANDING',
  PREDICTION: 'REASONING',
});

/** Verb heuristics, ordered so the STRONGEST signal wins (never "every
 * explain → the same demand"). Checked in this exact order. */
const DEMAND_VERB_RULES = Object.freeze([
  { re: /\b(compare|differentiate|contrast|distinguish)\b/i, demand: 'ANALYSIS' },
  { re: /\b(justify|evaluate|criticiz|assess|defend)\b/i, demand: 'EVALUATION' },
  { re: /\bwhy\b|\bgive reasons?\b|\bwhat happens if\b|\bpredict\b/i, demand: 'REASONING' },
  { re: /\b(write|implement|develop|create)\b[^.?!]{0,60}\b(program|function|method|code|script|class|algorithm)\b/i, demand: 'PROCEDURAL' },
  { re: /\b(apply|calculate|compute|solve|determine|convert|trace)\b/i, demand: 'APPLICATION' },
  { re: /\b(define|state|name|list|mention|identify)\b/i, demand: 'RECALL' },
  { re: /\b(explain|describe|discuss|elaborate|summariz|interpret)\b/i, demand: 'UNDERSTANDING' },
]);

/**
 * Infer the cognitive demand of ONE reference unit (slot or item).
 * Priority: coding-task detection → explicit existing operation → verb rules
 * on the reference anchor → UNKNOWN (never guessed silently).
 * Enriches — never replaces — the existing information-demand behavior.
 */
export function classifyCognitiveDemand({ slot, item } = {}) {
  const operation = classifyCognitiveOperation(slot, item);
  const anchor = String(
    item?.referenceText
    || (Array.isArray(slot?.referenceItems) ? slot.referenceItems.filter(Boolean).join(' ') : '')
    || (Array.isArray(slot?.items) ? slot.items.map((it) => it?.referenceText).filter(Boolean).join(' ') : '')
    || slot?.instruction || slot?.stem || ''
  ).trim();

  const warnings = [];
  // A coding task is PROCEDURAL regardless of any other signal (Phase 9 §3).
  if (isCodingTask(anchor)) return { demand: 'PROCEDURAL', operation, warnings };
  if (operation && operation !== 'FACT' && operation !== 'UNKNOWN') {
    const mapped = DEMAND_FROM_OPERATION[operation];
    if (mapped) return { demand: mapped, operation, warnings };
  }
  for (const rule of DEMAND_VERB_RULES) {
    if (rule.re.test(anchor)) return { demand: rule.demand, operation, warnings };
  }
  if (operation === 'FACT') return { demand: 'RECALL', operation, warnings };
  warnings.push('cognitive demand could not be determined from the reference wording or intent signals');
  return { demand: 'UNKNOWN', operation, warnings };
}

/**
 * Select the transformation (Phase 9 §4): HOW the reference becomes a NEW
 * question. Deterministic from type + demand + paper style. 'NONE' is never
 * auto-selected (it would license a paraphrase); callers that want the
 * reference surface form reproduced must opt in explicitly.
 */
export function selectTransformation({ demand, paperStyle, isCoding, imageRequired } = {}) {
  if (imageRequired) return 'DIRECT_TO_VISUAL';
  if (isCoding) return 'DIRECT_TO_PROCEDURAL';
  switch (demand) {
    case 'CREATION': return 'DIRECT_TO_PROBLEM';
    case 'EVALUATION': return 'DIRECT_TO_CASE';
    case 'ANALYSIS': return 'DIRECT_TO_COMPARISON';
    case 'REASONING': return 'DIRECT_TO_REASONING';
    case 'APPLICATION': return 'DIRECT_TO_APPLICATION';
    case 'PROCEDURAL': return 'DIRECT_TO_PROCEDURAL';
    case 'UNDERSTANDING': return paperStyle === 'Creative' ? 'DIRECT_TO_SCENARIO' : 'DIRECT_TO_INTERPRETATION';
    case 'RECALL': return paperStyle === 'Creative' ? 'DIRECT_TO_SCENARIO' : 'DIRECT_TO_NEW_CONTEXT';
    default: return 'UNKNOWN';
  }
}

// ─── Target resolution (Phase 9 §2 priority order) ───────────────────────────

/**
 * Resolve topic/concept per the spec's priority chain. Never fabricates:
 * every level returns null when its source has no value. Returns the RESOLVED
 * value plus the priority LEVEL that produced it (for diagnostics).
 * 1. explicit slotTargets (existing target-selector output)
 * 2. blueprint/item topic anchors
 * 3. question intent (buildQuestionIntent)
 * 4. section/unit context (slot.topic / requirements.topic)
 * 5. retrieved vector evidence (dominant concept)
 * 6. graph evidence nodes
 * 7. reference question text (lexical concept terms)
 */
export function resolveTargets({ slot, item, slotTarget, requirements, vectorEvidence, graphEvidence } = {}) {
  const warnings = [];
  const usedLevels = { topic: null, concept: null };

  // 1. slotTargets (highest priority — already computed by target-selector).
  const stTopic = String(slotTarget?.topic ?? '').trim();
  const stConcept = String(slotTarget?.concept ?? '').trim();
  if (stTopic) usedLevels.topic = 1;
  if (stConcept) usedLevels.concept = 1;

  // 2. blueprint/item anchors.
  const anchorTopic = String(item?.topicAnchor ?? slot?.topicAnchor ?? '').trim();
  const anchorConcept = String(item?.concept ?? slot?.concept ?? '').trim();
  if (!stTopic && anchorTopic) usedLevels.topic = 2;
  if (!stConcept && anchorConcept) usedLevels.concept = 2;

  // 3. question intent.
  const intent = slotTarget?.intent ?? buildQuestionIntent(slot, item, requirements);
  const intentTopic = String(intent?.topic ?? '').trim();
  const intentConcept = String(intent?.concept ?? '').trim();
  if (!stTopic && !anchorTopic && intentTopic) usedLevels.topic = 3;
  if (!stConcept && !anchorConcept && intentConcept) usedLevels.concept = 3;

  // 4. section/unit context.
  const ctxTopic = String(slot?.topic ?? requirements?.topic ?? '').trim();
  if (!stTopic && !anchorTopic && !intentTopic && ctxTopic) usedLevels.topic = 4;

  // 5. retrieved vector evidence (source-text authority — highest-quality
  //    lexical fallback; uses each item's own `concept` when present).
  let evidenceConcept = null;
  const vecs = Array.isArray(vectorEvidence) ? vectorEvidence : [];
  for (const ev of vecs) {
    const c = String(ev?.concept ?? '').trim();
    if (c) { evidenceConcept = c; break; }
  }
  if (!stConcept && !anchorConcept && !intentConcept && evidenceConcept) usedLevels.concept = 5;

  // 6. graph nodes (structural context only; never overrides 1-4).
  let graphConcept = null;
  const gnodes = Array.isArray(graphEvidence) ? graphEvidence : [];
  for (const n of gnodes) {
    const c = String(n?.canonicalName ?? n?.concept ?? '').trim();
    if (c) { graphConcept = c; break; }
  }
  if (!stConcept && !anchorConcept && !intentConcept && !evidenceConcept && graphConcept) usedLevels.concept = 6;

  // 7. reference text lexical terms (weakest).
  const anchor = String(item?.referenceText || slot?.instruction || slot?.stem || '').trim();
  const lexical = (conceptTerms(anchor) || []).join(' ').toLowerCase();
  if (!usedLevels.topic && !stTopic && !anchorTopic && !intentTopic && !ctxTopic && lexical) usedLevels.topic = 7;
  if (!usedLevels.concept && !stConcept && !anchorConcept && !intentConcept && !evidenceConcept && !graphConcept && lexical) usedLevels.concept = 7;

  const topic = stTopic || anchorTopic || intentTopic || ctxTopic || (usedLevels.topic === 7 ? lexical : null) || null;
  const concept = stConcept || anchorConcept || intentConcept || evidenceConcept || graphConcept || (usedLevels.concept === 7 ? lexical : null) || null;

  if (!topic) warnings.push('no topic could be resolved from slotTargets, anchors, intent, context, or evidence');
  if (!concept) warnings.push('no concept could be resolved from slotTargets, anchors, intent, or evidence');
  return {
    topic: topic || null,
    concept: concept || null,
    intent,
    usedLevels,
    warnings,
  };
}

// ─── Answer target + evidence requirements (Phase 9 §5/§6) ──────────────────

/**
 * The answer target states what the NEW question's answer must ESTABLISH —
 * more specific than restating the question. Reuses the existing
 * target-selector answerTarget when present (priority 1); otherwise derives a
 * specific formulation from concept + topic + source-backed relationships.
 * Returns null only when nothing concrete is supportable (→ warning).
 */
export function buildAnswerTarget({ slotTarget, concept, topic, graphRelationships, vectorEvidence, imageRequirement = null, itemDependency = null, item = null, type = null } = {}) {
  const c = String(concept ?? '').trim();
  const t = String(topic ?? '').trim();
  const itemType = String(item?.type || type || '').toUpperCase();
  const itemMarks = Number(item?.marks);
  const isShort = itemType === 'SHORT_ANSWER' || (Number.isFinite(itemMarks) && itemMarks <= 1);

  // IMAGE_DEPENDENT target: require identifying/explaining the visual relationship
  const vaTarget = imageRequirement?.visualAnchor?.target ?? null;
  if ((itemDependency === 'IMAGE_DEPENDENT' || imageRequirement?.required) && vaTarget) {
    return {
      answerTarget: isShort
        ? `Identify and explain the visual relationship (${vaTarget}) concisely as depicted in the reference image.`
        : `Identify and explain the visual relationship (${vaTarget}) for ${c || 'the concept'}${t ? ` within ${t}` : ''} shown in the reference image.`,
      requiredRelationships: [vaTarget],
      source: 'visualAnchor',
    };
  }

  // Priority 1: the existing Phase 6 answer-target directive.
  const existing = String(slotTarget?.answerTarget ?? '').trim();
  if (existing) return { answerTarget: existing, requiredRelationships: [], source: 'slotTarget' };

  // Priority 2: source-backed graph relationships give a specific, checkable
  // formulation ("bytecode is executed by JVM"). Only relationships with
  // supporting source provenance qualify (Phase 8 §9 rule carried forward).
  const rels = [];
  for (const r of (Array.isArray(graphRelationships) ? graphRelationships : [])) {
    const p = r?.provenance || {};
    if (!p.sourceText && !p.sourceDocumentId) continue; // unsupported → skip
    const label = String(r?.label ?? r?.relation ?? '').trim();
    if (label) rels.push(label);
    if (rels.length >= 3) break;
  }
  if (rels.length > 0 && c) {
    return {
      answerTarget: `Establish how ${c} works${t ? ` within ${t}` : ''}, using the relationship(s): ${rels.join('; ')}.`,
      requiredRelationships: rels,
      source: 'graphRelationships',
    };
  }

  // Priority 3: evidence-derived formulation from actual retrieved text.
  const vecs = Array.isArray(vectorEvidence) ? vectorEvidence : [];
  const firstText = String(vecs.find((v) => String(v?.text ?? '').trim())?.text ?? '').trim();
  if (c && firstText) {
    return {
      answerTarget: `Explain ${c}${t ? ` (${t})` : ''} accurately using the retrieved source material.`,
      requiredRelationships: [],
      source: 'vectorEvidence',
    };
  }
  if (c) {
    return {
      answerTarget: `Explain ${c}${t ? ` (${t})` : ''} correctly and completely.`,
      requiredRelationships: [],
      source: 'conceptOnly',
    };
  }
  return { answerTarget: null, requiredRelationships: rels, source: null };
}

/**
 * Evidence requirements (Phase 9 §6). Deterministic from resolved targets +
 * retrieved evidence. Visual evidence is only required for IMAGE_BASED, and
 * requiredVisualRelationship is NEVER invented — it comes from the existing
 * image/layout metadata when present, else null.
 */
export function buildEvidenceRequirements({ type, concept, topic, vectorEvidence, graphRelationships, imageRequirement, imageBearing = null } = {}) {
  const requiredConcepts = new Set();
  if (concept) requiredConcepts.add(concept);
  const requiredTopics = new Set();
  if (topic) requiredTopics.add(topic);

  // Additional concepts present in source-backed evidence relevant to this unit.
  for (const ev of (Array.isArray(vectorEvidence) ? vectorEvidence : [])) {
    const c = String(ev?.concept ?? '').trim();
    if (c && c !== concept) requiredConcepts.add(c);
    if (requiredConcepts.size >= 4) break;
  }

  // SEMANTIC IMAGE GROUNDING — the concepts the reference-image vision
  // analysis extracted become REQUIRED evidence for IMAGE_BASED questions:
  // the generated question must engage what the image actually depicts.
  for (const c of (imageRequirement?.groundedConcepts ?? [])) {
    if (requiredConcepts.size >= 5) break;
    requiredConcepts.add(String(c ?? '').trim());
  }

  const requiredRelationships = [];
  for (const r of (Array.isArray(graphRelationships) ? graphRelationships : [])) {
    const p = r?.provenance || {};
    const label = String(r?.label ?? r?.relation ?? '').trim();
    if (label && (p.sourceText || p.sourceDocumentId)) requiredRelationships.push(label);
    if (requiredRelationships.length >= 3) break;
  }

  // imageBearing (when the caller supplies it) extends visual-evidence
  // requirement to image-bearing MIXED slots; null keeps the legacy type check.
  // ITEM-LEVEL refinement: a per-item plan whose reference item is
  // IMAGE_CONTEXTUAL (topic-grounded, not a visual-observation ask) is NOT
  // held to visual evidence — its grounding is the image topic in the notes.
  const visualEvidenceRequired = imageBearing === false ? false
    : imageBearing ?? (type === 'IMAGE_BASED');
  return {
    requiredConcepts: [...requiredConcepts].slice(0, 5),
    requiredTopics: [...requiredTopics],
    requiredFacts: [],
    requiredRelationships,
    visualEvidenceRequired,
    requiredVisualRelationship: visualEvidenceRequired
      ? String(imageRequirement?.observationTarget ?? '').trim() || null
      : null,
  };
}

// ─── Novelty constraints + construction pattern (Phase 9 §11/§12) ───

/**
 * Novelty constraints: planner-level intent only. The existing novelty agent
 * stays the FINAL authority (Phase 9 §11). Structure-preservation flags are
 * always true because the blueprint is immutable at this layer.
 */
export function buildNoveltyConstraints({ marks, itemCount, imageRequired } = {}) {
  return {
    mustNotCopyReferenceText: true,
    mustNotParaphraseReference: true,
    preserveConcept: true,
    preserveAnswerTarget: true,
    preserveConstructionPattern: true,
    preserveAnswerForm: true,
    preserveMarks: marks != null,
    preserveItemCount: itemCount != null,
    preserveImageDependency: Boolean(imageRequired),
  };
}

/**
 * Per-item / per-question mark count.
 *
 * A NORMALIZED blueprint slot carries `marks` as an OBJECT
 * ({ perItem, itemCount, total, expression }) — which is not a usable count —
 * and exposes the authoritative scalars as `marksPerItem` (slot) / `marks`
 * (item). Taking the raw value made the construction snapshot (and every
 * downstream comparison) NaN, so prefer explicit scalars and fall back to a
 * numeric slot.marks only when it really is one.
 */
export function marksOf(item, slot) {
  const candidates = [item?.marks, item?.marksPerItem, slot?.marksPerItem, slot?.marks];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string' && c.trim() !== '' && Number.isFinite(Number(c))) return Number(c);
  }
  return null;
}

/**
 * Construction-pattern snapshot (Phase 9 §12): HOW the reference is built —
 * captured verbatim from the slot so the generator cannot alter it. Never
 * modified by the planner or by difficulty.
 */
export function buildConstructionPattern(slot, item) {
  const s = slot ?? {};
  const it = item ?? {};
  return {
    type: it.type ?? s.type ?? null,
    marks: marksOf(it, s),
    answerForm: it.answerForm ?? s.answerForm ?? null,
    optionCount: it.optionCount ?? s.optionCount ?? null,
    optionLabels: Array.isArray(it.optionLabels ?? s.optionLabels) ? (it.optionLabels ?? s.optionLabels) : null,
    blankCount: it.blankCount ?? s.blankCount ?? null,
    subquestionCount: Array.isArray(it.subParts ?? s.subParts) ? (it.subParts ?? s.subParts).length : (Array.isArray(s.items) ? s.items.length : null),
    internalChoice: Boolean(it.internalChoice ?? s.internalChoice),
    passageContext: Boolean(s.passage ?? it.passage),
    imageDependency: (it.type ?? s.type) === 'IMAGE_BASED' || Boolean(it.imageAsset ?? s.imageAsset) || (Array.isArray(s.imageAssets) && s.imageAssets.length > 0),
    subParts: Array.isArray(it.subParts ?? s.subParts) ? (it.subParts ?? s.subParts) : null,
  };
}

// ─── Image requirements (Phase 9 §10) ───

/**
 * imageRequirement for the plan. Required/locked for IMAGE_BASED; explicitly
 * not-required otherwise. observationTarget is NEVER invented — it comes from
 * existing vision/layout metadata only, else null (+ warning → review).
 *
 * SEMANTIC IMAGE GROUNDING (additive): when the caller supplies an
 * ImageGrounding object (built from ONE reference-image vision call + notes
 * retrieval), the requirement additionally carries the grounded topic,
 * concepts, visual relationships, safe observation targets, the notes text
 * evidence and the optional notes-image evidence. dependency is 'required'
 * for IMAGE_BASED (the question MUST be answerable only through the image).
 * Every grounded field degrades to its pre-grounding value when grounding is
 * absent — the disabled/unavailable path is byte-identical to before.
 */
export function buildImageRequirement({ type, slot, item, imageGrounding, itemIndex = 0 } = {}) {
  // Image-bearing (label-agnostic): the blueprint normalizer can re-derive an
  // analyze-declared IMAGE_BASED slot to MIXED (heterogeneous item types) while
  // keeping its imageAssets — the image requirement must survive that.
  // NOTE: a bare singular imageAsset on a non-IMAGE_BASED slot does NOT make
  // it image-bearing (Phase 9 K4 contract); the plural imageAssets (what the
  // normalizer preserves and the asset associator produces) is the signal.
  const imageBearing = type === 'IMAGE_BASED'
    || (Array.isArray(item?.imageAssets) && item.imageAssets.length > 0)
    || (Array.isArray(slot?.imageAssets) && slot.imageAssets.length > 0);
  // Production slots carry imageAssets (plural); the singular asset is a
  // legacy/fixture shape. Fall back to the first slot image so the requirement
  // really binds the REFERENCE image (never a notes image).
  const img = item?.imageAsset ?? item?.image ?? slot?.imageAsset ?? slot?.image
    ?? (Array.isArray(slot?.imageAssets) && slot.imageAssets.length > 0 ? slot.imageAssets[0] : null);
  const layout = item?.imageLayout ?? slot?.imageLayout ?? null;
  const lockedTopic = item?.topicAnchor ?? slot?.topicAnchor ?? null;
  const ri = imageGrounding?.status === 'ok' ? imageGrounding.referenceImage ?? null : null;
  if (imageBearing) {
    const observation = String(item?.observationTarget ?? slot?.observationTarget ?? '').trim();
    // Safe observation targets: vision-extracted targets are authoritative;
    // legacy layout text fills in ONLY when vision produced none. Never both
    // invented — an empty target list stays empty (review flags it).
    const safeTargets = (ri?.observationTargets ?? []).filter(Boolean);
    const groundedTopic = ri?.topic ?? null;
    const warnings = [];
    if (!img) warnings.push('IMAGE_BASED item has no image asset reference available to the planner');
    // The warning fires only when NOTHING can describe the observation — a
    // grounded slot whose vision targets fill observationTarget is not stale.
    if (!observation && safeTargets.length === 0) warnings.push('no vision/layout evidence available to describe the required image observation');
    if (imageGrounding && imageGrounding.status === 'ok' && !groundedTopic && safeTargets.length === 0) {
      warnings.push('image grounding produced no usable topic or observation targets');
    }
    // EXPLICIT VISUAL TARGET (Part 3): a relationship the image actually
    // expresses ("X contains Y", "flow from A to B") is a stronger, more
    // specific instruction than a bare observation target — it tells the
    // generator WHAT structure to inspect, not just WHAT topic to stay on.
    // Preferring the grounded relationship first, falling back to the first
    // safe observation target, means this is NEVER invented: it is always a
    // value the vision call itself returned for THIS image, never a
    // hardcoded or subject-specific string.
    //
    // POSITIONAL selection: item i of an image-bearing slot takes grounded
    // relationship i (modulo the grounded count) instead of every sub-part
    // being told to inspect the SAME relationship. Still never invented — a
    // modulo index only ever picks an entry the vision call returned.
    const rels = (Array.isArray(ri?.relationships) ? ri.relationships : []).filter(Boolean);
    const pickAt = (list) => (list.length > 0 ? list[itemIndex % list.length] : null);
    const visualAnchorTarget = pickAt(rels) || pickAt(safeTargets) || rels[0] || safeTargets[0] || null;
    // The image WAS analysed but yielded nothing concrete to observe: an
    // image-dependent question cannot then be told what to require, so flag it
    // for review instead of silently letting the generator write a generic
    // notes-answerable question (the caller's reviewRequired path).
    if (imageGrounding && imageGrounding.status === 'ok' && !visualAnchorTarget) {
      warnings.push('image grounding produced no grounded visual target (no relationships or observation targets) — an image-dependent question cannot be told what to require');
    }
    const visualAnchor = visualAnchorTarget ? {
      target: visualAnchorTarget,
      usage: 'The student must inspect the reference image to identify or verify this specific visual detail — naming the topic or a concept it depicts is not enough.',
      evidenceSource: 'reference image',
    } : null;
    return {
      required: true,
      dependency: 'required',
      imageAsset: img ?? null,
      imageLayout: layout ?? null,
      lockedTopic: lockedTopic ?? null,
      lockedUnit: item?.unit ?? slot?.unit ?? null,
      observationTarget: observation || (safeTargets[0] ?? null),
      // ── Grounding-enriched fields (null/[] without grounding) ──
      groundedTopic,
      groundedConcepts: ri?.concepts ?? [],
      visualRelationships: ri?.relationships ?? [],
      observationTargets: safeTargets,
      visualAnchor,
      notesTextEvidence: Array.isArray(imageGrounding?.notesTextEvidence) ? imageGrounding.notesTextEvidence : [],
      notesImageEvidence: Array.isArray(imageGrounding?.notesImageEvidence) ? imageGrounding.notesImageEvidence : [],
      imageGroundingConfidence: Number.isFinite(imageGrounding?.imageGroundingConfidence) ? imageGrounding.imageGroundingConfidence : null,
      textEvidenceSufficient: Boolean(imageGrounding?.textEvidenceSufficient),
      warnings,
    };
  }
  return {
    required: false,
    dependency: 'none',
    imageAsset: img ?? null,
    imageLayout: layout ?? null,
    lockedTopic: null,
    lockedUnit: null,
    observationTarget: null,
    groundedTopic: null,
    groundedConcepts: [],
    visualRelationships: [],
    observationTargets: [],
    visualAnchor: null,
    notesTextEvidence: [],
    notesImageEvidence: [],
    imageGroundingConfidence: null,
    textEvidenceSufficient: false,
    warnings: [],
  };
}

// ─── Canonical plan assembly (Phase 9 §1) ───

/**
 * Build ONE QuestionPlan for one reference unit.
 *
 * `unit` is a slot for homogeneous questions, or ONE item of a MIXED slot
 * (MIXED never merges items into a single plan — Phase 9 §9). Deterministic:
 * no LLM calls; unknowns stay null and raise warnings.
 */
export function buildQuestionPlan({
  slot, item, slotTarget, requirements,
  vectorEvidence, graphEvidence, graphRelationships,
  imageGrounding = null,
  detectedUnit, detectedTopic, difficulty, paperStyle,
  klass, subject, slotIndex = null, questionNumber = null, itemLabel = null,
  itemIndex = null,
  evidence = [],
} = {}) {
  const s = slot ?? {};
  const it = item ?? {};
  const warnings = [];
  const type = it.type ?? s.type ?? null;
  // Image-bearing slot (label-agnostic): a slot whose question carries a
  // reference image is treated as an image question even when the blueprint
  // normalizer re-derived its parent type to MIXED (heterogeneous item types).
  // The item's own imageAsset (when the asset was associated per-item) or the
  // slot's imageAssets both count.
  const imageBearing = type === 'IMAGE_BASED'
    || (Array.isArray(it.imageAssets) && it.imageAssets.length > 0)
    || (Array.isArray(s.imageAssets) && s.imageAssets.length > 0);

  // 1. Targets (Phase 9 §2 priority chain).
  const resolved = resolveTargets({ slot: s, item: it, slotTarget, requirements, vectorEvidence, graphEvidence });
  warnings.push(...resolved.warnings);

  // 2. Cognitive demand (enriches, never replaces, the existing info-demand).
  const demandRes = classifyCognitiveDemand({ slot: s, item: it, requirements });
  warnings.push(...demandRes.warnings);

  // 3. Transformation + image handling (Phase 9 §4/§10 + image grounding).
  const imageRequirement = buildImageRequirement({
    type, slot: s, item: it, imageGrounding,
    // Positional item index (modulo'd inside) so sub-parts of one image-bearing
    // slot do not all receive the SAME grounded relationship as their target.
    itemIndex: Number.isInteger(itemIndex) ? itemIndex : Math.max(0, (Array.isArray(s.items) ? s.items.indexOf(it) : -1)),
  });
  warnings.push(...imageRequirement.warnings);
  const transformation = selectTransformation({
    demand: demandRes.demand,
    paperStyle: paperStyle ?? requirements?.paperStyle ?? null,
    isCoding: isCodingTask(String(it.referenceText || s.instruction || s.stem || '')),
    imageRequired: imageRequirement.required,
  });

  // 4. Item-level image dependency & Answer target (Phase 9 §5/§6).
  const itemDependency = classifyPlanItemDependency({ slot: s, item: it, imageBearing, itemIndex });
  const at = buildAnswerTarget({
    slotTarget, concept: resolved.concept, topic: resolved.topic,
    graphRelationships, vectorEvidence, imageRequirement, itemDependency,
    item: it, slot: s, type,
  });
  if (!at.answerTarget) warnings.push('no answer target could be derived from slotTargets, graph relationships, or retrieved evidence');

  // 5. Evidence requirements (Phase 9 §6). ITEM-LEVEL image dependency: the
  // reference item's own relationship with the image decides whether this
  // plan demands visual evidence (IMAGE_DEPENDENT) or only topic grounding
  // (IMAGE_CONTEXTUAL) — never a blanket rule for every sub-part.
  const evidenceRequirements = buildEvidenceRequirements({
    type, concept: resolved.concept, topic: resolved.topic,
    vectorEvidence, graphRelationships, imageRequirement,
    imageBearing: itemDependency === 'IMAGE_CONTEXTUAL' ? false : imageBearing,
  });
  if (evidenceRequirements.requiredConcepts.length === 0) {
    warnings.push('evidence requirements contain no required concepts (nothing supported to anchor the question)');
  }

  // 6. Construction snapshot — immutable structural constraints (Phase 9 §12).
  const constructionPattern = buildConstructionPattern(s, it);

  // 7. Difficulty + paper style passthrough (never altered by the planner).
  const finalDifficulty = difficulty ?? requirements?.difficulty ?? null;
  const finalPaperStyle = paperStyle ?? requirements?.paperStyle ?? null;
  if (finalDifficulty != null && !['Easy', 'Medium', 'Hard'].includes(finalDifficulty)) {
    warnings.push(`unknown difficulty "${finalDifficulty}" passed through unchanged`);
  }

  // 8. Provenance / source references for the plan.
  const sourceReferences = collectSourceReferences(vectorEvidence, graphEvidence, evidence);

  // 9. Confidence + review gating (Phase 9 §2: ambiguity ⇒ reviewRequired).
  const reviewRequired = warnings.length > 0 || demandRes.demand === 'UNKNOWN' || !resolved.concept;
  const confidence = computePlanConfidence({
    concept: resolved.concept, topic: resolved.topic,
    answerTarget: at.answerTarget, demand: demandRes.demand,
    usedLevels: resolved.usedLevels, sourceRefCount: sourceReferences.length,
  });

  return {
    slotIndex, questionNumber, itemLabel: itemLabel ?? it.label ?? null,
    topic: resolved.topic ?? detectedTopic ?? null,
    concept: resolved.concept ?? null,
    answerTarget: at.answerTarget,
    answerTargetSource: at.source,
    cognitiveDemand: demandRes.demand,
    cognitiveOperation: demandRes.operation ?? null,
    transformation,
    answerForm: it.answerForm ?? s.answerForm ?? null,
    constructionPattern,
    evidenceRequirements,
    difficulty: finalDifficulty,
    paperStyle: finalPaperStyle,
    imageRequirement,
    // ITEM-LEVEL image dependency (IMAGE_DEPENDENT vs IMAGE_CONTEXTUAL) —
    // null when the item text is unknown; consumers must treat null as
    // "parent-level rule applies" for backward compatibility.
    imageDependency: itemDependency,
    // SEMANTIC IMAGE GROUNDING — full evidence object on image-bearing plans
    // (topic/concepts/relationships/observation targets/notes text + optional
    // notes images). Null for every other type and whenever grounding was
    // unavailable — consumers must treat null as "no grounding evidence".
    imageGrounding: imageBearing ? (imageGrounding ?? null) : null,
    contextRequirement: {
      class: klass ?? requirements?.class ?? null,
      subject: subject ?? requirements?.subject ?? null,
      unit: detectedUnit ?? it.unit ?? s.unit ?? requirements?.unit ?? null,
      topic: resolved.topic ?? detectedTopic ?? null,
    },
    noveltyConstraints: buildNoveltyConstraints({
      type, marks: constructionPattern.marks,
      itemCount: constructionPattern.subquestionCount,
      imageRequired: imageRequirement.required,
    }),
    sourceReferences,
    confidence,
    reviewRequired,
    plannerWarnings: warnings,
  };
}



/** Provenance rows carried into the plan (dedup by doc::chunk). */
function collectSourceReferences(vectorEvidence, graphEvidence, extra = []) {
  const byKey = new Map();
  for (const ev of [...(Array.isArray(vectorEvidence) ? vectorEvidence : []), ...(Array.isArray(graphEvidence) ? graphEvidence : []), ...extra]) {
    const p = ev?.provenance ?? ev ?? {};
    const doc = p.sourceDocumentId ?? p.sourceHash ?? null;
    if (doc == null) continue;
    const key = `${doc}::${p.chunkId ?? ''}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        sourceDocumentId: doc, sourceHash: p.sourceHash ?? null,
        chunkId: p.chunkId ?? null, pageNumber: p.pageNumber ?? null,
        section: p.section ?? null, sourceType: ev?.type ?? null,
      });
    }
  }
  return [...byKey.values()];
}

/** Transparent 0..1 confidence: what the plan actually managed to resolve. */
function computePlanConfidence({ concept, topic, answerTarget, demand, usedLevels, sourceRefCount }) {
  let score = 0;
  const weights = { concept: 0.3, topic: 0.2, answerTarget: 0.3, demand: 0.15, provenance: 0.05 };
  if (concept) score += weights.concept * (usedLevels?.concept != null && usedLevels.concept <= 3 ? 1 : 0.6);
  if (topic) score += weights.topic * (usedLevels?.topic != null && usedLevels.topic <= 3 ? 1 : 0.6);
  if (answerTarget) score += weights.answerTarget;
  if (demand && demand !== 'UNKNOWN') score += weights.demand;
  if (sourceRefCount > 0) score += weights.provenance;
  return Number(score.toFixed(3));
}

/**
 * ITEM-LEVEL image dependency for ONE plan — the SINGLE SOURCE OF TRUTH.
 *
 * The prompt's IMAGE GROUNDING block (plan-prompt.js), the grounding and
 * novelty agents and the plan validator all classify a slot's items with
 * `labelSlotItemDependencies` (positional, and conservative: an image-bearing
 * slot whose own items carry NO explicit visual cue keeps EVERY item
 * image-dependent). Classifying the item's wording in isolation here produced
 * a plan that CONTRADICTED that block inside the very same prompt — itemPlan
 * said "do NOT force visual wording" while the grounding block right above it
 * said "MUST be answerable ONLY by observing the reference image" — so the
 * generator wrote a notes-answerable question and the validators, correctly,
 * rejected it.
 *
 * Non-image-bearing plans keep the isolated per-item classifier, unchanged.
 */
function classifyPlanItemDependency({ slot, item, imageBearing, itemIndex = null }) {
  if (!item) return null;
  if (!String(item.referenceText || item.text || '').trim()) return null;
  const items = Array.isArray(slot?.items) ? slot.items : [];
  if (!imageBearing || items.length === 0) return classifyItemDependency(item);
  const idx = Number.isInteger(itemIndex) ? itemIndex : items.indexOf(item);
  if (idx < 0 || idx >= items.length) return classifyItemDependency(item);
  return labelSlotItemDependencies(slot)[idx] ?? classifyItemDependency(item);
}

/**
 * Build plans for a whole slot: one plan per MIXED item (per-item planning,
 * Phase 9 §9) or a single plan for a homogeneous slot.
 */
export function buildPlansForSlot(slotContext) {
  const { slot, slotTarget, requirements, vectorEvidence, graphEvidence, graphRelationships, imageGrounding, ...rest } = slotContext ?? {};
  const s = slot ?? {};
  const items = Array.isArray(s.items) && s.items.length > 0 && (s.type === 'MIXED' || s.items.some((x) => x?.type)) ? s.items : null;

  if (!items) {
    const plan = buildQuestionPlan({ slot: s, slotTarget, requirements, vectorEvidence, graphEvidence, graphRelationships, imageGrounding, ...rest });
    return { plans: [plan], itemPlans: null };
  }

  // MIXED: NEVER merge items — each gets its own full plan with its own
  // demand/transformation/targets/evidence, retaining its own type/marks/answerForm.
  const itemPlans = items.map((it, idx) => buildQuestionPlan({
    slot: s, item: it, slotTarget, requirements, vectorEvidence, graphEvidence, graphRelationships, imageGrounding,
    slotIndex: rest.slotIndex ?? null,
    questionNumber: rest.questionNumber ?? null,
    itemLabel: it.label ?? String.fromCharCode(97 + idx) /* a, b, c... */,
    itemIndex: idx,
  }));
  // A slot-level header plan records the MIXED structure without merging items.
  const header = buildQuestionPlan({ slot: s, slotTarget, requirements, vectorEvidence, graphEvidence, graphRelationships, imageGrounding, ...rest });
  header.itemPlans = itemPlans;
  header.plannerWarnings.push(`MIXED slot planned per-item: ${itemPlans.length} item plans (types: ${[...new Set(itemPlans.map((p) => p.constructionPattern.type ?? 'UNKNOWN'))].join(', ')})`);
  return { plans: [header], itemPlans };
}

export default {
  COGNITIVE_DEMANDS, TRANSFORMATIONS,
  classifyCognitiveDemand, selectTransformation, resolveTargets,
  buildAnswerTarget, buildEvidenceRequirements, buildNoveltyConstraints,
  buildConstructionPattern, buildImageRequirement, marksOf,
  buildQuestionPlan, buildPlansForSlot,
};

