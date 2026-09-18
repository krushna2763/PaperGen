/**
 * image-grounding.service.js — SEMANTIC IMAGE GROUNDING LAYER.
 *
 * Closes the "topic-related but image-independent" gap for IMAGE_BASED slots.
 * The reference paper's image is the PRIMARY visual object; the matching
 * mechanism is SEMANTIC (topic/concept), never image-to-image similarity:
 *
 *   Reference image ──(ONE vision call)──▶ { topic, concepts, visualType,
 *                                           visualElements, observationTargets,
 *                                           relationships }
 *        │
 *        ├─▶ Notes TEXT evidence  — the SAME topic/concepts are retrieved from
 *        │     the existing syllabus corpus (hybrid/vector + graph retrieval).
 *        │     Notes text is the PRIMARY academic grounding (Phase 8 rule:
 *        │     source text stays the authority).
 *        │
 *        ├─▶ Notes IMAGE evidence — OPTIONAL supporting evidence only, found
 *        │     by ASSOCIATION (same topic/concept) through the Docling
 *         │     structured document of the notes file. NO extra vision call is
 *        │     spent on any notes image, and a notes image can NEVER replace
 *        │     the reference image on the final paper.
 *        │
 *        └─▶ imageGroundingConfidence — deterministic, transparent scoring of
 *              topic match + concept matches + text-evidence sufficiency.
 *
 * Every downstream consumer (planner, generator prompt, validators, ranking)
 * receives the same ImageGrounding object; nothing here mutates a slot or a
 * question. Vision is used EXACTLY ONCE per reference image (cached per
 * process by image id), and never for text-only questions.
 *
 * Generic by design: no subject/topic vocabulary is hardcoded — the OOP/JDK
 * shapes in tests are fixtures, never logic.
 */

import { env } from '../config/env.js'; // IMAGE_GROUNDING_MIN_CONFIDENCE threshold
import { geminiClient } from '../services/gemini-client.service.js';
import { parseJsonObject } from '../agents/agent-utils.js';
import { loadStructuredDocByHash } from '../ingestion/ingestion.service.js';
import { retrieveGraphEvidence } from '../graph/graph-retriever.js';
import { contentTerms } from '../agents/grounding.agent.js';

/** In-process cache: sourceDocumentId + imageAssetId → grounding object. ONE vision call
 * per image per process, however many rounds/regenerations re-ask for it. */
const groundingCache = new Map();

/** Cache key ensuring image visual grounding is cached per document + asset id. */
function cacheKeyFor({ image, unit, cls, subject }) {
  const docId = String(image?.sourceDocumentId || image?.sourceHash || image?.documentId || '');
  const imgId = String(image?.assetId || image?.id || image?.dataUri?.slice(-24) || 'unknown');
  return [cls, subject, unit, docId, imgId].map((s) => String(s ?? '')).join('::');
}

// ─── Small deterministic text helpers ───────────────────────────────────────

/** Lowercase, whitespace-folded tokenization identical in spirit to grounding.agent.js. */
function tokensOf(text) {
  return String(text || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?? [];
}

/** A multi-word phrase present in text (word boundaries, case-insensitive). */
function phraseInText(phrase, text) {
  const p = String(phrase ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (p.length < 2) return false;
  const t = String(text ?? '').toLowerCase().replace(/\s+/g, ' ');
  if (t.includes(p)) return true;
  // Acronym/sing-plural tolerance: JDK vs jdk; machines vs machine.
  const words = p.split(' ');
  return words.length === 1 && tokensOf(t).includes(p.replace(/s$/, ''));
}

/** Bounded lexical overlap between two token lists (0..1, Jaccard-style). */
function tokenOverlap(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / Math.max(A.size, B.size);
}

/** Dedupe + cap a list of strings (bounded prompt/validator noise). */
function capList(list, max, maxChars = 160) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s);
    if (out.length >= max) break;
  }
  return out;
}

// ─── 1. VISION: reference-image analysis (the ONLY vision call in the flow) ─

const VISION_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string', description: 'The academic topic the image teaches (a notes-heading-like label, not a caption).' },
    concepts: { type: 'array', items: { type: 'string' }, description: 'Named concepts/terms visible or represented in the image (labels, components, processes).' },
    visualType: { type: 'string', description: 'One of: diagram | flowchart | table | photograph | illustration | map | chart | other' },
    visualElements: { type: 'array', items: { type: 'string' }, description: 'What is actually drawn/shown: shapes, labels, arrows, captions visible in the image.' },
    observationTargets: { type: 'array', items: { type: 'string' }, description: 'Specific things a student must observe/identify in THIS image to answer about it (never invented beyond what is visible).' },
    relationships: { type: 'array', items: { type: 'string' }, description: 'Relationships the image expresses between its elements (e.g. "A contains B", "flow from X to Y").' },
  },
  required: ['topic', 'concepts', 'visualType', 'visualElements', 'observationTargets', 'relationships'],
};

const visionResults = { calls: 0 };

/**
 * ONE structured vision call per reference image. Returns null on any failure
 * (vision outage must degrade to topic-anchor-only grounding — it must never
 * crash the pipeline and must never burn a retry).
 */
async function analyzeReferenceImage(image) {
  const dataUri = typeof image === 'string' ? image : (image?.dataUri || image?.data || image?.base64 || null);
  if (!dataUri || String(dataUri).length < 100) return null;
  const prompt = `You are analyzing ONE image from an exam question paper so a new image-dependent question can be grounded in study notes.

Describe the image ACADEMICALLY, not visually-cosmetically:
- topic: the subject-matter topic this image teaches (2-8 words).
- concepts: the named academic concepts/terms the image represents (component labels, stages, entities).
- visualType: diagram | flowchart | table | photograph | illustration | map | chart | other.
- visualElements: the concrete things actually shown (labels, boxes, arrows, numbers, captions).
- observationTargets: what a student must OBSERVE in this specific image to answer a question about it. Only what is really visible — never invent.
- relationships: relationships the image expresses between its elements ("X contains Y", "flow from A to B", "X compared with Y").

Respond with ONLY JSON.`;
  try {
    visionResults.calls += 1;
    const raw = await geminiClient.generateContent(prompt, {
      responseMimeType: 'application/json',
      responseSchema: VISION_SCHEMA,
      temperature: 0.1,
      images: [image],
    });
    const parsed = parseJsonObject(raw);
    if (!parsed) return null;
    return {
      topic: String(parsed.topic ?? '').trim() || null,
      concepts: capList(parsed.concepts, 8),
      visualType: String(parsed.visualType ?? 'other').trim().toLowerCase() || 'other',
      visualElements: capList(parsed.visualElements, 10),
      observationTargets: capList(parsed.observationTargets, 6),
      relationships: capList(parsed.relationships, 8),
    };
  } catch (err) {
    console.warn(`[ImageGrounding] vision analysis failed (degrading to topic-anchor grounding): ${String(err?.message || err).slice(0, 160)}`);
    return null;
  }
}

// ─── 2. NOTES TEXT EVIDENCE (existing retrieval — no new vector store) ──────

/**
 * Retrieve notes text evidence for the vision topic/concepts using the
 * EXISTING retrieval agent seam. The strategy ladder / hybrid / graph modes
 * inside retrievalAgent.retrieveForSlots remain the owners of HOW evidence is
 * retrieved; this builds one extra IMAGE-GROUNDED retrieval task and runs it
 * through the same public entry point used for every other slot.
 */
async function retrieveNotesTextEvidence({ unit, topic, concepts, blueprint, slot, requirements, slotUnitMap }) {
  try {
    // One-slot blueprint clone keeps per-item machinery (intents, ladders,
    // unit filters) exactly the same as a normal slot retrieval.
    const slotClone = { ...slot };
    // Image-grounded query = the vision topic + concepts, NOT the reference
    // paper's own question wording (novelty is enforced downstream anyway).
    const focus = [topic, ...concepts.slice(0, 4)].filter(Boolean).join(' ');
    const anchor = focus || String(slot?.topicAnchor || slot?.instruction || '').trim();
    if (!anchor) return null;
    slotClone.topicAnchor = anchor;
    slotClone.referenceItems = [anchor];
    slotClone.instruction = anchor;

    const singleBlueprint = { ...blueprint, questions: [slotClone] };
    const mapKey = slot?.label || null;
    const unitMap = mapKey && slotUnitMap?.[mapKey]
      ? { [mapKey]: slotUnitMap[mapKey] }
      : (unit ? { ...(mapKey ? { [mapKey]: { unit } } : {}) } : {});
    const perSlot = await retrievalAgentForGrounding().retrieveForSlots(singleBlueprint, { ...requirements }, {
      slotUnitMap: unitMap,
    });
    const ctx = perSlot?.[0] ?? null;
    if (!ctx || !Array.isArray(ctx.results)) return null;
    return ctx;
  } catch (err) {
    console.warn(`[ImageGrounding] notes retrieval failed (text evidence empty): ${String(err?.message || err).slice(0, 160)}`);
    return null;
  }
}

/** Late-bound import avoids a static import cycle with retrieval.agent.js. */
let _retrievalAgent = null;
function retrievalAgentForGrounding() {
  if (_retrievalAgent) return _retrievalAgent;
  throw new Error('[ImageGrounding] retrieval agent not injected — call setImageRetrievalAgent() in tests only.');
}

/**
 * Test seam ONLY: the orchestrator wires the real retrieval agent in
 * production; unit tests can inject a stub. Never used to change behavior.
 */
export function setImageRetrievalAgent(agent) {
  _retrievalAgent = agent ?? null;
}

// ─── 3. TOPIC / CONCEPT MATCHING (deterministic, no vision) ─────────────────

/**
 * Match the vision topic/concepts against the notes evidence we retrieved.
 * A match is TEXTUAL/SEMANTIC (the notes text actually discusses the concept),
 * never pixel-based — exactly the spec's "same topic, different diagram is a
 * valid grounding" rule.
 */
function matchTopicAndConcepts({ referenceImage, notesCtx }) {
  const notesTexts = (Array.isArray(notesCtx?.results) ? notesCtx.results : [])
    .map((r) => String(r?.text ?? ''))
    .filter(Boolean);
  const notesBlob = notesTexts.join('\n');
  const notesTokens = tokensOf(notesBlob);
  const graphNodes = Array.isArray(notesCtx?.graphEvidence) ? notesCtx.graphEvidence : [];

  const evidence = [];
  let topicScore = 0;
  const topic = referenceImage?.topic ?? null;
  if (topic && notesBlob) {
    if (phraseInText(topic, notesBlob)) {
      topicScore = 1;
      evidence.push(`notes text explicitly discusses "${topic}"`);
    } else {
      const overlap = tokenOverlap(tokensOf(topic), notesTokens);
      topicScore = overlap >= 0.5 ? Math.min(0.9, overlap) : overlap;
      if (topicScore > 0) evidence.push(`notes text partially overlaps the image topic "${topic}" (lexical overlap ${overlap.toFixed(2)})`);
    }
  }

  const conceptMatches = [];
  for (const c of referenceImage?.concepts ?? []) {
    const textual = notesBlob ? phraseInText(c, notesBlob) : false;
    const inGraph = graphNodes.some((g) => {
      const name = String(g?.concept ?? g?.canonicalName ?? '').toLowerCase();
      return name && (name === c.toLowerCase() || name.includes(c.toLowerCase()) || c.toLowerCase().includes(name));
    });
    const matched = textual || inGraph;
    if (matched) {
      conceptMatches.push({
        concept: c,
        confidence: textual ? 1 : 0.7,
        evidence: textual
          ? `notes text mentions "${c}"`
          : `knowledge graph node "${c}" carries source-backed provenance`,
      });
    }
  }

  return { topic, topicScore, conceptMatches, evidence: capList(evidence, 6, 200), notesBlobLen: notesBlob.length };
}

// ─── 4. NOTES IMAGE EVIDENCE (association-only; NO vision call) ─────────────

/**
 * OPTIONAL supporting evidence: does the NOTES file itself contain images for
 * the same topic/concept? Found through the notes Docling structured document
 * (already cached on disk by ingestion) — pure metadata association, never an
 * image-to-image comparison and never a second vision call. A notes image is
 * recorded as metadata only; it can NEVER replace the reference image.
 */
function findNotesImageEvidence({ topic, concepts, notesDocHash }) {
  const out = [];
  if (!notesDocHash) return out;
  const doc = loadStructuredDocByHash(notesDocHash);
  if (!doc || !Array.isArray(doc.elements)) return out;
  const conceptSet = [...new Set([...(concepts ?? []).map((c) => String(c).toLowerCase()), topic ? String(topic).toLowerCase() : null].filter(Boolean))];
  for (const el of doc.elements) {
    if (el?.type !== 'picture') continue;
    const idx = doc.elements.indexOf(el);
    // Association evidence = nearby text (same reading-order window) that
    // mentions the topic/concepts. Deterministic, bounded, honest: without
    // such text we still record the image but with no claimed association.
    const windowText = doc.elements
      .slice(Math.max(0, idx - 3), idx + 4)
      .map((e) => String(e?.text ?? ''))
      .join(' ');
    const hits = conceptSet.filter((c) => phraseInText(c, windowText));
    out.push({
      elementId: el.id ?? null,
      pageNumber: el.pageNumber ?? null,
      associated: hits.length > 0,
      associatedBy: hits,
      hasPixelData: Boolean(el?.meta?.dataUri),
    });
    if (out.length >= 5) break;
  }
  return out;
}

// ─── 5. CONFIDENCE + the grounding object ───────────────────────────────────

function computeGroundingConfidence({ topicScore, conceptMatches, notesCtx, notesImageEvidence, vision }) {
  // Weights are fixed and documented: text evidence is PRIMARY, concepts are
  // the strongest semantic anchor, notes images are supporting-only.
  const conceptScore = conceptMatches.length > 0
    ? Math.min(1, conceptMatches.reduce((a, c) => a + (c.confidence ?? 0), 0) / Math.max(1, (vision?.concepts ?? []).length || 1))
    : 0;
  const textScore = Array.isArray(notesCtx?.results) && notesCtx.results.length > 0
    ? Math.min(1, notesCtx.results.length / 3)
    : 0;
  const notesImageBonus = notesImageEvidence.some((i) => i.associated) ? 0.05 : 0;
  const base = 0.4 * conceptScore + 0.3 * topicScore + 0.3 * textScore;
  return Math.round(Math.min(1, base + notesImageBonus) * 1000) / 1000;
}

/** Text evidence is "sufficient" when it can ground a question by itself. */
function textEvidenceSufficiency(notesCtx, conceptMatches) {
  const results = Array.isArray(notesCtx?.results) ? notesCtx.results.filter((r) => String(r?.text ?? '').trim()) : [];
  if (results.length === 0) return { sufficient: false, reason: 'no notes text evidence retrieved for the image topic/concepts' };
  const enoughChunks = results.length >= 2 || results.some((r) => String(r.text).length >= 220);
  const enoughConcepts = conceptMatches.length >= 1;
  if (enoughChunks && enoughConcepts) {
    return { sufficient: true, reason: `${results.length} notes text chunk(s) covering ≥1 image concept` };
  }
  return { sufficient: false, reason: enoughChunks ? 'notes text present but no image concept matched it' : 'notes text too thin to ground a question alone' };
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Build the ImageGrounding object for ONE IMAGE_BASED slot.
 *
 * @param {Object} args
 * @param {Object} args.slot - locked blueprint slot (IMAGE_BASED, with imageAssets)
 * @param {Object} args.blueprint - full locked blueprint
 * @param {Object} args.requirements - { class, subject, difficulty, ... }
 * @param {Object|null} [args.slotUnitMap] - teacher unit assignment for the slot
 * @returns {Promise<Object|null>} ImageGrounding|null (null ⇒ no grounding was possible;
 *   callers must treat that as "no grounding evidence", never as a pass).
 */
export async function buildImageGrounding({ slot, blueprint, requirements, slotUnitMap = null } = {}) {
  const images = Array.isArray(slot?.imageAssets) ? slot.imageAssets.filter(Boolean) : [];
  // An image-bearing slot qualifies regardless of the parent type label:
  // the blueprint normalizer re-derives a slot with heterogeneous item types
  // to MIXED even when analyze declared IMAGE_BASED and attached the image.
  // The semantic object (an IMAGE_BASED question WITH a reference image) is
  // what grounds — never the label alone.
  const typeIsImageBased = String(slot?.type || '').toUpperCase() === 'IMAGE_BASED';
  const hasImageAsset = images.length > 0;
  if (!slot || (!typeIsImageBased && !hasImageAsset)) return null;
  const image = images[0];
  const cls = requirements?.class ?? blueprint?.paper?.class ?? null;
  const subject = requirements?.subject ?? blueprint?.paper?.subject ?? null;
  const unit = slotUnitMap?.[slot?.label]?.unit ?? slot?.unit ?? slot?.detectedUnit ?? null;

  const key = cacheKeyFor({ image, unit, cls, subject });
  if (groundingCache.has(key)) return groundingCache.get(key);

  // ── 1. ONE vision call on the reference image ──
  const vision = await analyzeReferenceImage(image);

  // Blend visual observation from Vision with academic concepts from note metadata (Requirement §4, §5)
  const combinedConcepts = [...new Set([
    ...(vision?.concepts || []),
    ...(Array.isArray(image?.concepts) ? image.concepts : []),
    ...(image?.topic ? [image.topic] : []),
  ].filter(Boolean))];

  const combinedTargets = [...new Set([
    ...(vision?.observationTargets || []),
    ...(Array.isArray(image?.observationTargets) ? image.observationTargets : []),
  ].filter(Boolean))];

  const combinedRelationships = [...new Set([
    ...(vision?.relationships || []),
    ...(Array.isArray(image?.relationships) ? image.relationships : []),
    ...(Array.isArray(image?.visualElements) ? image.visualElements : []),
  ].filter(Boolean))];

  let effectiveVision = {
    topic: vision?.topic || image?.topic || image?.title || 'General',
    concepts: combinedConcepts,
    visualType: vision?.visualType || (image?.imageType ? String(image.imageType).toLowerCase() : 'diagram') || 'diagram',
    visualElements: (vision?.visualElements?.length ? vision.visualElements : image?.visualElements) || [],
    observationTargets: combinedTargets.length > 0
      ? combinedTargets
      : [`Observe the visual details, labels, and interactions depicted in the image`],
    relationships: combinedRelationships.length > 0
      ? combinedRelationships
      : [`Visual elements interact within the depicted scene`],
  };

  if (!vision && (!effectiveVision.concepts.length && !image?.topic)) {
    const failed = {
      referenceImage: { topic: null, concepts: [], visualType: null, visualElements: [], observationTargets: [], relationships: [] },
      topicMatch: { matchedTopic: null, confidence: 0, evidence: ['vision analysis of the reference image was unavailable'] },
      conceptMatches: [],
      notesTextEvidence: [],
      notesImageEvidence: [],
      imageGroundingConfidence: 0,
      status: 'vision_unavailable',
      visionCallMade: true,
    };
    groundingCache.set(key, failed);
    return failed;
  }

  // ── 2. Notes text evidence through the EXISTING retrieval pipeline ──
  const notesCtx = await retrieveNotesTextEvidence({
    cls, subject, unit,
    topic: effectiveVision.topic,
    concepts: effectiveVision.concepts,
    blueprint, slot, requirements, slotUnitMap,
  });
  const match = matchTopicAndConcepts({ referenceImage: effectiveVision, notesCtx });

  // ── 3. OPTIONAL notes-image evidence (metadata association only) ──
  const notesDocHash = notesCtx?.results?.find((r) => r?.hash)?.hash ?? null;
  const notesImageEvidence = findNotesImageEvidence({
    topic: effectiveVision.topic, concepts: effectiveVision.concepts, notesDocHash,
  });

  // ── 4. Confidence + sufficiency + Alignment check (Requirement §6) ──
  const confidence = computeGroundingConfidence({
    topicScore: match.topicScore, conceptMatches: match.conceptMatches,
    notesCtx, notesImageEvidence, vision: effectiveVision,
  });
  const sufficiency = textEvidenceSufficiency(notesCtx, match.conceptMatches);

  const hasTextEvidence = Array.isArray(notesCtx?.results) && notesCtx.results.length > 0;
  const isAligned = hasTextEvidence && (match.topicScore > 0 || match.conceptMatches.length > 0);
  const alignmentMessage = isAligned
    ? 'Strong alignment between selected image and syllabus notes.'
    : (hasTextEvidence
        ? 'No meaningful match between the selected image and the retrieved notes for this topic.'
        : 'No relevant syllabus notes found for the selected unit/topic.');

  const grounding = {
    referenceImage: {
      topic: effectiveVision.topic,
      concepts: effectiveVision.concepts,
      visualType: effectiveVision.visualType,
      visualElements: effectiveVision.visualElements,
      observationTargets: effectiveVision.observationTargets,
      relationships: effectiveVision.relationships,
    },
    topicMatch: {
      matchedTopic: match.topicScore > 0 ? effectiveVision.topic : null,
      confidence: Math.round(match.topicScore * 1000) / 1000,
      evidence: match.evidence,
    },
    conceptMatches: match.conceptMatches,
    notesTextEvidence: (Array.isArray(notesCtx?.results) ? notesCtx.results : []).slice(0, 5).map((r) => ({
      text: String(r?.text ?? '').slice(0, 400),
      chunkId: r?.chunkId ?? null,
      sourcePage: r?.sourcePage ?? r?.pageNumber ?? null,
      section: r?.section ?? null,
      unit: r?.unit ?? null,
      hash: r?.hash ?? null,
    })),
    notesImageEvidence,
    imageGroundingConfidence: confidence,
    alignment: {
      aligned: isAligned,
      status: isAligned ? 'STRONG_MATCH' : 'MISMATCH',
      message: alignmentMessage,
      matchedConcepts: match.conceptMatches.map((m) => m.concept),
    },
    status: 'ok',
    visionCallMade: true,
    textEvidenceSufficient: sufficiency.sufficient,
    textEvidenceReason: sufficiency.reason,
    // Below the confidence threshold the grounding is reported honestly but
    // treated as best-effort context only (the planner flags it for review).
    belowConfidenceThreshold: confidence < env.IMAGE_GROUNDING_MIN_CONFIDENCE,
    // Safe observation target: only what the vision analysis actually saw.
    // Never invented; empty when vision produced no usable targets.
    safeObservationTargets: vision.observationTargets ?? [],
  };
  groundingCache.set(key, grounding);
  console.log(`[ImageGrounding] slot=${slot?.label ?? '?'} topic="${vision.topic ?? '—'}" concepts=${vision.concepts.length} conceptMatches=${match.conceptMatches.length} textEvidence=${grounding.notesTextEvidence.length} notesImages=${notesImageEvidence.length} confidence=${confidence}`);
  return grounding;
}

/** Test isolation hook: clear the per-process grounding cache. */
export function clearImageGroundingCache() {
  groundingCache.clear();
  visionResults.calls = 0;
}

/** Number of vision calls this process has spent on reference-image analysis. */
export function visionCallCount() {
  return visionResults.calls;
}

// ─── 6. Deterministic candidate fidelity check (no LLM, no vision) ──────────

/**
 * Deterministic image-grounding fidelity check for ONE candidate question.
 * Verifies the candidate's visible content actually engages the image's
 * grounded topic/concepts — a topic-drifted or purely notes-recall question
 * fails BEFORE the vision validator spends a call. This complements (never
 * replaces) validationAgent.checkImageDependency, which stays the final
 * authority on image dependency.
 *
 * ITEM-LEVEL MODEL: when the blueprint slot is supplied, the check runs PER
 * SUB-PART using the slot's deterministic dependency labels
 * (labelSlotItemDependencies):
 *   - an IMAGE_DEPENDENT part must engage a grounded CONCEPT (and stay in
 *     topic) — it claims to be about what the image shows;
 *   - an IMAGE_CONTEXTUAL part must engage the grounded topic OR any concept
 *     — topic grounding suffices, visual dependency is not demanded.
 * Without a slot (or when no per-part labels exist) the legacy whole-question
 * rules apply.
 *
 * @param {Object} question - normalized candidate
 * @param {Object|null} grounding - the slot's ImageGrounding (null → ok:true)
 * @param {Object|null} [slot] - blueprint slot, for per-part dependency labels
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkImageGroundingFidelity(question, grounding, slot = null) {
  if (!grounding || grounding.status !== 'ok') return { ok: true, reasons: [] };
  const conceptList = [
    ...(grounding.referenceImage?.concepts ?? []),
    ...(grounding.conceptMatches?.map((c) => c.concept) ?? []),
    ...(slot?.imageAssets ?? []).flatMap((im) => im.concepts || []),
  ]
    .map((c) => String(c ?? '').trim())
    .filter(Boolean)
    .filter((c, i, arr) => arr.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i);
  const topic = grounding.referenceImage?.topic ?? null;
  if (conceptList.length === 0 && !topic) return { ok: true, reasons: [] };

  const conceptTerms = new Set(conceptList.flatMap((c) => contentTerms(c)));
  const topicTerms = new Set(topic ? contentTerms(topic) : []);
  const label = topic || conceptList.slice(0, 3).join(', ');

  const parts = Array.isArray(question?.subParts) && question.subParts.length > 0
    ? question.subParts
    : [{ text: String(question?.text ?? '') }];
  const deps = slot ? labelSlotItemDependencies(slot) : null;
  const reasons = [];
  const partTexts = parts.map((p, i) => ({
    letter: String.fromCharCode(97 + (i % 26)),
    text: String(p?.text ?? ''),
  }));

  // LEGACY whole-question mode (no slot / no per-part labels): the question as
  // a WHOLE must engage the grounding — a part that does is pooled across the
  // whole question. Backward-compatible with the pre-item-level contract.
  const legacy = !deps || deps.length === 0;
  if (legacy) {
    const allTokens = new Set(partTexts.flatMap((p) => [...tokensOf(p.text)]));
    const conceptHits = [...conceptTerms].filter((t) => allTokens.has(t));
    const topicHits = [...topicTerms].filter((t) => allTokens.has(t));
    if (conceptHits.length === 0) {
      if (topicHits.length === 0) {
        reasons.push(`Image-grounding fidelity: the question never engages the reference image's grounded topic/concepts (${label}). It must ask about what the image actually depicts.`);
      } else {
        reasons.push(`Image-grounding fidelity: the question engages the topic "${topic}" but none of the image's grounded concepts (${conceptList.slice(0, 4).join(', ')}). Narrow it to a concept actually shown in the image.`);
      }
    }
    if (reasons.length > 0) return { ok: false, reasons };
  }

  for (const part of partTexts) {
    const idx = partTexts.indexOf(part);
    const tokens = new Set(tokensOf(part.text));
    const conceptHits = [...conceptTerms].filter((t) => tokens.has(t));
    const topicHits = [...topicTerms].filter((t) => tokens.has(t));
    const dep = deps?.[idx] ?? null;
    if (dep === 'IMAGE_CONTEXTUAL') {
      // Topic-grounded item: topic OR concept engagement suffices — it must
      // NOT be rejected merely because it is answerable without pixels.
      if (conceptHits.length === 0 && topicHits.length === 0) {
        reasons.push(`Image-grounding fidelity (${part.letter}): the sub-part engages neither the reference image's grounded topic "${label}" nor any of its concepts. Keep it on the image's topic.`);
      }
      continue;
    }
    if (legacy) continue; // whole-question verdict already rendered above
    // IMAGE_DEPENDENT: must engage a concept.
    if (conceptHits.length === 0) {
      if (topicHits.length === 0) {
        reasons.push(`Image-grounding fidelity (${part.letter}): the sub-part never engages the reference image's grounded topic/concepts (${label}). It must ask about what the image actually depicts.`);
      } else {
        reasons.push(`Image-grounding fidelity (${part.letter}): the sub-part engages the topic "${topic}" but none of the image's grounded concepts (${conceptList.slice(0, 4).join(', ')}). Narrow it to a concept actually shown in the image.`);
      }
    }
  }
  if (reasons.length > 0) return { ok: false, reasons };

  // (3) Unsupported visual claims: a question asserting visual details the
  //     vision analysis never observed is a hallucination risk — check the
  //     candidate's named visual nouns against the observed element labels.
  //     ITEM-LEVEL: only IMAGE_DEPENDENT parts claim to be about the image's
  //     visuals, so with per-part labels the check scopes to those parts (a
  //     contextual part is never rejected for visual-claim shape).
  const text = [
    String(question?.text ?? ''),
    String(question?.passage ?? ''),
    ...partTexts.map((p) => p.text),
    ...(Array.isArray(question?.options) ? question.options : []),
  ].join(' ');
  const visualVocab = new Set([
    ...conceptList,
    ...(grounding.referenceImage?.visualElements ?? []),
    ...(grounding.referenceImage?.observationTargets ?? []),
    ...(grounding.referenceImage?.visibleText ?? []),
    ...(grounding.referenceImage?.relationships ?? []),
    ...(grounding.notesTextEvidence ?? []).flatMap((n) => contentTerms(typeof n === 'string' ? n : (n?.text || ''))),
  ].flatMap((v) => contentTerms(v)));

  const COMMON_ACADEMIC_TERMS = new Set([
    'observe', 'observation', 'look', 'study', 'picture', 'image', 'photo', 'photograph',
    'view', 'seen', 'scene', 'show', 'shows', 'shown', 'depict', 'depicts', 'depicted',
    'illustrate', 'illustrates', 'illustrated', 'display', 'displays', 'displayed',
    'lesson', 'method', 'action', 'activity', 'interaction', 'gesture', 'hand', 'hands',
    'girl', 'woman', 'child', 'person', 'people', 'student', 'teacher', 'table', 'book',
    'background', 'foreground', 'wall', 'room', 'detail', 'details', 'specific', 'feature',
    'features', 'physical', 'contact', 'necessary', 'understand', 'understanding',
    'learning', 'learn', 'teach', 'teaching', 'connect', 'connection', 'relationship',
    'relate', 'relates', 'meaning', 'reason', 'cause', 'effect', 'result', 'purpose',
    'explain', 'describe', 'identify', 'notice', 'tell', 'suggest', 'indicate', 'focus',
    'direction', 'position', 'expression', 'answer', 'questions', 'following', 'based',
    'using', 'given', 'present', 'presence', 'cover', 'title', 'lying', 'nearby',
    'hanging', 'holding', 'placed', 'reading', 'read', 'speak', 'speaking', 'write', 'writing',
  ]);

  // Only enforce when the candidate names a concrete visual noun that vision
  // did NOT observe at all AND the question asserts it as present ("shown in").
  const assertive = /\b(shown|depicted|illustrated|displayed|marked|labelled|labeled)\b/i;
  const claimsText = (deps && deps.length > 0)
    ? partTexts.filter((_, i) => deps[i] !== 'IMAGE_CONTEXTUAL').map((p) => p.text).join(' ')
    : text;
  if (assertive.test(claimsText) && visualVocab.size > 0) {
    const claimTerms = contentTerms(claimsText).filter((t) => t.length >= 4 && !COMMON_ACADEMIC_TERMS.has(t.toLowerCase()));
    const supported = claimTerms.filter((t) => (visualVocab.has(t) || conceptTerms.has(t)) && !/(diagram|figure|label|box|arrow|chart|graph)/.test(t));
    const unsupported = claimTerms.filter((t) => !visualVocab.has(t) && !conceptTerms.has(t) && /(diagram|figure|label|box|arrow|chart|graph)/.test(t) === false);
    // Conservative: only flag when the candidate invents concrete nouns that vision never saw and notes never supported
    if (unsupported.length >= 3 && supported.length === 0) {
      return {
        ok: false,
        reasons: ['Image-grounding fidelity: the question asserts visual details that were not observed in the reference image. Ground every visual claim in what the image actually shows.'],
      };
    }
  }

  return { ok: true, reasons: [] };
}

// ─── 6b. Deterministic VISUAL-ENGAGEMENT check (no LLM, no vision) ──────────

/**
 * Subject-neutral lexicon of genuine spatial/structural/comparative cues.
 * Deliberately EXCLUDES bare image-referencing nouns ("diagram", "figure",
 * "image", "picture") — a question that only SAYS "based on the diagram"
 * without describing an actual relationship must NOT pass on that alone
 * (the exact gap this check closes). Generic by design: never a subject
 * vocabulary, just the shapes a visual relationship is expressed in.
 */
const RELATIONAL_CUE_RE = /\b(inside|outside|contains?|contained|containing|nested?|nesting|between|beside|above|below|beneath|underneath|left|right|top|bottom|outer|outermost|inner|innermost|surrounds?|surrounding|enclos(?:e|es|ed|ing)|wraps?|wrapped|arrows?|points?\s*to|leads?\s*to|flows?|sequence|hierarchy|layers?|levels?|stages?|steps?|positions?|positioned|labell?ed|structure|structured|groups?|grouped|grouping|components?|placement|relationships?|relat(?:e|es|ed|ion)|connects?|connected|connection|links?|linked|maps?\s*to|corresponds?\s*to|adjacent|compares?|comparison|versus|\bvs\.?\b|distinguishes?|differs?|difference)\b/i;

/**
 * ITEM-LEVEL VISUAL ENGAGEMENT (generation-side fix): closes the gap where a
 * candidate trivially "passes" concept engagement by naming a concept
 * (e.g. "JVM") without ever describing a visual relationship, position or
 * structure — "What is the role of the JVM?" and "Based on the diagram, what
 * is JVM?" both name a grounded concept but neither requires the image. An
 * IMAGE_DEPENDENT part must do BOTH: engage the image's actually-observed
 * visual vocabulary (observationTargets/relationships/visualElements — never
 * generic concepts, which are too easy to name without looking) AND express
 * a genuine spatial/structural/comparative relationship (RELATIONAL_CUE_RE).
 * IMAGE_CONTEXTUAL parts are exempt entirely (topic grounding is enough —
 * never forced into visual wording). Runs BEFORE the expensive vision
 * validator (checkImageDependency) so a hopeless candidate is caught for
 * free; also used as a candidate-ranking signal so a genuinely visual
 * candidate wins the pool over a generic topic-recall one.
 * @param {Object} question - normalized candidate
 * @param {Object|null} grounding - the slot's ImageGrounding (null -> ok:true)
 * @param {Object|null} [slot] - blueprint slot, for per-part dependency labels
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkVisualEngagement(question, grounding, slot = null) {
  if (!grounding || grounding.status !== 'ok') return { ok: true, reasons: [] };
  const ri = grounding.referenceImage ?? {};
  const visualVocab = new Set([
    ...(ri.observationTargets ?? []),
    ...(ri.relationships ?? []),
    ...(ri.visualElements ?? []),
  ].flatMap((v) => contentTerms(v)));
  // Nothing was actually observed in the image — never invent a requirement
  // the vision analysis itself could not supply (mirrors buildImageRequirement's
  // "never invent" contract).
  if (visualVocab.size === 0) return { ok: true, reasons: [] };

  const parts = Array.isArray(question?.subParts) && question.subParts.length > 0
    ? question.subParts
    : [{ text: String(question?.text ?? ''), visualAnchor: question?.visualAnchor }];
  const deps = slot ? labelSlotItemDependencies(slot) : null;
  const legacy = !deps || deps.length === 0;
  const reasons = [];

  parts.forEach((part, i) => {
    const dep = legacy ? 'IMAGE_DEPENDENT' : (deps[i] ?? null);
    if (dep !== 'IMAGE_DEPENDENT') return; // IMAGE_CONTEXTUAL / unknown: exempt
    const letter = String.fromCharCode(97 + (i % 26));
    const stemText = String(part?.text ?? '');
    const tokens = new Set(tokensOf(stemText));
    const engagesVisualVocab = [...visualVocab].some((t) => tokens.has(t));
    const hasRelationalCue = RELATIONAL_CUE_RE.test(stemText);
    if (!engagesVisualVocab || !hasRelationalCue) {
      const missing = !engagesVisualVocab && !hasRelationalCue
        ? 'never engages what the image actually shows AND never describes a visual relationship, position or structure in its question text'
        : !engagesVisualVocab
          ? 'never engages what the image actually shows (its observed elements/relationships) in its question text'
          : 'never describes a visual relationship, position or structure in its question text — naming the topic/component is not enough';
      reasons.push(
        `Visual engagement (${letter}): this IMAGE_DEPENDENT part ${missing}. Merely mentioning the image ("based on the diagram...") or naming a concept it depicts is not sufficient — the question text itself must require inspecting a specific relationship, position, label or structure the image shows.`
      );
    }
  });
  return { ok: reasons.length === 0, reasons };
}

// ─── 7. Item-level image-dependency classification (deterministic) ─────────

/**
 * ITEM-LEVEL IMAGE DEPENDENCY (spec correction):
 *
 * Image dependency is decided at ITEM/SUBQUESTION level, from the reference
 * paper's ACTUAL relationship with the image — never blanket "every sub-part
 * of an image question must be answerable only from pixels". Two classes:
 *
 *   IMAGE_DEPENDENT  — the item explicitly asks the student to identify /
 *                      describe / compare something shown in the image; it
 *                      cannot be answered without inspecting the image.
 *                      (Real example, Q2(a): "Identify the components shown
 *                      in the diagram and explain the relationship between
 *                      JVM, JRE and JDK.")
 *   IMAGE_CONTEXTUAL — the item belongs to the image's topic (it was asked
 *                      under the image in the reference paper) but its answer
 *                      is topic-grounded knowledge, not a unique visual
 *                      feature. (Real example, Q2(b): "Which component is
 *                      required for developing Java applications? Give one
 *                      reason.") It must keep topic/concept grounding but
 *                      must NOT be rejected merely because it can be answered
 *                      without visually inspecting the image.
 *
 * Deterministic and generic: a subject-neutral visual-cue lexicon decides the
 * class; marks expressions, course-outcome / Bloom metadata and OCR noise are
 * stripped BEFORE matching so they can never steer the classification. No
 * subject vocabulary is hardcoded (the JVM/JDK strings here are the real
 * reference's fixture, never logic).
 */

// ─── Item-level image dependency (spec correction) ──────────────────────────
// The classification helpers are PURE and live in planner/item-dependency.js
// so the planner can use them without violating its zero-LLM/no-retrieval
// contract (test N3). They are re-exported here for backward compatibility.
import {
  cleanAcademicText,
  classifyItemDependency,
  labelSlotItemDependencies,
} from '../planner/item-dependency.js';

export {
  cleanAcademicText,
  classifyItemDependency,
  labelSlotItemDependencies,
};

/** Exposed for tests/diagnostics only. */
export const _internal = {
  tokensOf, phraseInText, tokenOverlap, capList, matchTopicAndConcepts,
  computeGroundingConfidence, textEvidenceSufficiency,
  retrieveGraphEvidence,
};

export default {
  buildImageGrounding, checkImageGroundingFidelity, checkVisualEngagement,
  clearImageGroundingCache, visionCallCount, setImageRetrievalAgent,
  cleanAcademicText, classifyItemDependency, labelSlotItemDependencies,
};
