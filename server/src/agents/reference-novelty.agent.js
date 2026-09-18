/**
 * reference-novelty.agent.js — REFERENCE NOVELTY / INFORMATION-DEMAND GATE
 * (PARTS 15/16/17, 20).
 *
 * The 0.962 similarity case proved that cosine-vs-corpus checks are not enough:
 * the reference paper may never be indexed, so nothing compares the GENERATED
 * item against the REFERENCE item it came from. This agent closes that gap —
 * deterministically (CPU only, no AI calls):
 *
 *   per generated sub-part vs its POSITIONAL reference item:
 *     1. EXACT_COPY             — normalized text equality
 *     2. NEAR_PARAPHRASE        — same information demand + near-identical stems
 *     3. SAME_INFORMATION_DEMAND — different wording, but the item asks for the
 *                                  same answer/fact ("What did Alice find on
 *                                  the glass table?" → "What object did Alice
 *                                  discover on the glass table?")
 *
 * It does NOT reject legitimate structural similarity: same topic + same
 * question type + a DIFFERENT information demand (why/how/consequence) passes.
 * The SIMILARITY_THRESHOLD (0.85) is untouched — this layer adds a demand-level
 * check that embedding cosine cannot make.
 *
 * Rejection reasons carry explicit KEEP/CHANGE directives so targeted
 * regeneration can act on them (PART 20) instead of "generate again".
 *
 * Fully generic: no class/subject/unit/question-number special cases.
 */

import { contentTerms, visualEvidenceTermsFrom } from './grounding.agent.js';
import { informationDemandOf, isCodingTask, hasDynamicInputCue } from '../blueprint/question-intent.js';
import { cosineSimilarity, roundTo } from './agent-utils.js';
import { labelSlotItemDependencies } from '../planner/item-dependency.js';

/** Interrogative frames — stripped so demand comparison sees the content. */
const FRAME_RE =
  /^(what|why|how|which|who|whom|whose|where|when|name|list|state|define|explain|describe)\b[\s:,-]*/i;

/** Normalize a text for equality comparison: lowercase, punctuation-free, collapsed. */
function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Overlap coefficient |A∩B| / min(|A|,|B|) — 1 when one side subsumes the other. */
export function overlapCoefficient(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/**
 * Shared-vocabulary overlap between a reference stem and a generated stem,
 * with the interrogative frame ("what/why/how/...") stripped from both so the
 * comparison sees the CONTENT words, not the question word. Used both by the
 * lexical demand gate (compareItem) and by the embedding backstop's
 * type-aware scoring below — one derivation, so the two layers never disagree
 * about what "shares vocabulary" means.
 *
 * SOURCE-AWARE NOVELTY (additive, optional 3rd param): `visualAnchorTerms` are
 * terms a reference IMAGE forces both the reference and a genuine generated
 * question to share (e.g. the named components of a diagram) — their overlap
 * is expected, not evidence of copying, so they are removed from BOTH term
 * sets before the ratio is computed. This masks only vocabulary, never
 * sentence structure: a genuinely copied FRAMING still shares its remaining
 * (non-anchor) words and is still caught. Omitting the argument (every
 * existing caller) is byte-identical to before this addition.
 * @param {string} refText
 * @param {string} genText
 * @param {string[]} [visualAnchorTerms]
 */
export function lexicalStemOverlap(refText, genText, visualAnchorTerms = []) {
  let refTerms = contentTerms(String(refText || '').replace(FRAME_RE, ' '));
  let genTerms = contentTerms(String(genText || '').replace(FRAME_RE, ' '));
  if (Array.isArray(visualAnchorTerms) && visualAnchorTerms.length > 0) {
    const anchorSet = new Set(visualAnchorTerms);
    refTerms = refTerms.filter((t) => !anchorSet.has(t));
    genTerms = genTerms.filter((t) => !anchorSet.has(t));
  }
  return overlapCoefficient(refTerms, genTerms);
}

/**
 * The information demand of a question stem, e.g. OBJECT (what/which → an
 * object/fact), REASON (why), PROCESS (how), DEFINITION. Falls back to the
 * first content word frame so stems like "The poem X was written by ____"
 * still classify instead of collapsing to UNKNOWN.
 * @param {string} stem
 * @returns {string}
 */
export function demandOf(stem) {
  const d = informationDemandOf(stem);
  if (d !== 'UNKNOWN') return d;
  const t = String(stem || '').trim();
  if (/_{2,}/.test(t)) return 'OBJECT'; // fill-blank demands the missing term
  return 'STATEMENT';
}

/**
 * Per-QUESTION-TYPE stem-overlap floors. A short MCQ/fill-blank/true-false
 * stem sharing 55%+ of its content words with the reference IS suspicious —
 * there is little room for two genuinely different short stems to overlap
 * that much by accident. A multi-clause SHORT_ANSWER/LONG_ANSWER/IMAGE_BASED
 * prompt is longer and naturally shares more topic/structural vocabulary
 * (character names, the poem/story title, "explain"/"include" framing) even
 * when it asks a genuinely different angle — so it needs a higher floor
 * before the SAME overlap ratio is read as "still the same ask". Generic by
 * TYPE only — never by subject, class, or paper content.
 */
const TYPE_NOVELTY_THRESHOLDS = {
  MCQ: { paraphrase: 0.8, demand: 0.55 },
  TRUE_FALSE: { paraphrase: 0.8, demand: 0.55 },
  FILL_IN_THE_BLANK: { paraphrase: 0.8, demand: 0.55 },
  SHORT_ANSWER: { paraphrase: 0.85, demand: 0.65 },
  LONG_ANSWER: { paraphrase: 0.9, demand: 0.7 },
  CREATIVE_WRITING: { paraphrase: 0.9, demand: 0.7 },
  IMAGE_BASED: { paraphrase: 0.85, demand: 0.65 },
};
const DEFAULT_NOVELTY_THRESHOLDS = { paraphrase: 0.8, demand: 0.55 };

/** Threshold pair for one item's type (falls back to the slot's own type). */
export function noveltyThresholdsForType(type) {
  const key = String(type || '').trim().toUpperCase();
  return TYPE_NOVELTY_THRESHOLDS[key] || DEFAULT_NOVELTY_THRESHOLDS;
}

/**
 * The type that governs ONE reference item's novelty thresholds. Only a
 * MIXED slot's items legitimately carry their own type different from the
 * slot ("Fill in the blanks AND choose the correct answer" mixes
 * FILL_IN_THE_BLANK and MCQ items in one slot) — for every other, homogeneous
 * slot, the SLOT's own declared type is authoritative regardless of what the
 * item record says, because a homogeneous slot's per-item `type` field can be
 * a lower-confidence extraction artifact (e.g. a blank marker garbled by OCR
 * falls through the extractor's per-item classifier to a generic default)
 * while the slot's own type was already confirmed by the structural
 * detector. Shared by the lexical gate and the embedding backstop below so
 * the two layers never pick different thresholds for the same item.
 * @param {Object|null} item
 * @param {Object|null} slot
 * @returns {string|null}
 */
export function effectiveItemType(item, slot) {
  const slotType = String(slot?.type || '').trim().toUpperCase();
  if (slotType && slotType !== 'MIXED') return slot.type;
  return item?.type || slot?.type || null;
}

/**
 * Literal banned-vocabulary words for a broad moral/theme-summary demand.
 * Single source for both the classifier below and adaptive regeneration
 * feedback (adaptive-feedback.agent.js), which names the ACTUAL word a
 * rejected candidate used — the two must never drift apart on what counts as
 * "broad summary vocabulary".
 */
export const BROAD_SUMMARY_WORDS = [
  'lesson', 'lessons', 'moral', 'morals', 'takeaway', 'take-away',
  'central idea', 'main idea', 'central message', 'main message',
  'key message', 'overall message', 'message', 'theme',
];
const BROAD_SUMMARY_WORDS_RE = new RegExp(
  `\\b(${BROAD_SUMMARY_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
);

/**
 * The SPECIFIC word or phrase in `text` that makes it a broad moral/theme
 * summary demand ("what can we learn from X", "what lesson/message/moral
 * does X teach/give", "what is the central idea/theme of X") — or null when
 * none is present. The literal word list is checked first; "learn"/"teach"
 * are checked as FULL FRAME patterns rather than bare words, because "learn"
 * alone is not suspicious outside that frame (e.g. "what did the class learn
 * about photosynthesis" is a normal recall question, not a summary ask).
 * These all name the SAME underlying question (summarize the takeaway)
 * regardless of which verb/noun phrases it — "lesson"/"message"/"moral" and
 * "learn" share no word root at all, so lexical overlap (which needs shared
 * roots) cannot tell two such phrasings apart; this catches that
 * synonym-family sameness directly, by DEMAND SHAPE rather than vocabulary.
 * @param {string} text
 * @returns {string|null}
 */
export function findBroadSummaryTrigger(text) {
  const t = String(text || '').toLowerCase();
  const wordMatch = t.match(BROAD_SUMMARY_WORDS_RE);
  if (wordMatch) return wordMatch[1];
  const learnMatch = t.match(/\bwhat (?:can|do|does|should|could) (?:we|you|students|readers|children|people)?\s*learn\b/);
  if (learnMatch) return learnMatch[0].trim();
  const teachUsMatch = t.match(/\bwhat (?:do|does) .*\bteach us\b/);
  if (teachUsMatch) return teachUsMatch[0].trim();
  const teachMatch = t.match(/\bwhat does .*\bteach\b/);
  if (teachMatch) return teachMatch[0].trim();
  return null;
}

/**
 * Whether `text` has the broad moral/theme-summary demand shape at all.
 * @param {string} text
 * @returns {boolean}
 */
export function isBroadSummaryDemand(text) {
  return findBroadSummaryTrigger(text) !== null;
}

/**
 * Whether ANY item in this slot asks a broad moral/theme-summary demand.
 * Used to grant a small extra retry budget (PART 23): correcting AWAY from
 * this shape requires landing on a genuinely different demand, not just
 * different wording, which realistically needs more than the standard bound
 * number of attempts. Driven purely by the reference item TEXT's shape —
 * never by slot label, subject, or specific story/unit content.
 * @param {Object|null} slot
 * @returns {boolean}
 */
export function slotHasBroadSummaryItem(slot) {
  if (!slot || !Array.isArray(slot.items)) return false;
  return slot.items.some((it) => isBroadSummaryDemand(it?.referenceText || it?.topicAnchor || ''));
}

/**
 * Concrete, generic redirection for a BROAD_MORAL_SUMMARY item — used only
 * when the reference item itself asks this shape of question. Names the
 * ALLOWED narrower demands (never hard-coded to any story) and tells the
 * generator to avoid recreating the same broad-summary framing in different
 * words, without banning those words globally elsewhere.
 */
function narrowDemandDirective() {
  return 'this reference item asks a BROAD MORAL/THEME SUMMARY question (a "what can we learn / '
    + 'lesson / message / moral / central idea" ask) — move to a NARROWER, concrete demand instead: '
    + 'a character trait, a specific event, a cause/effect relationship, a consequence, a character\'s '
    + 'action, evidence from one event, or an application. Do not use the words "lesson", "message", '
    + '"moral", "learn", "takeaway" or "central idea" in this item — asking the same broad summary in '
    + 'different words is still the same demand.';
}

/** KEEP/CHANGE directive text built from the slot's own contract. */
function keepChangeDirectives(slot, refText = '') {
  const optionBits = slot?.pattern?.maxOptionCount
    ? ` ${slot.pattern.maxOptionCount} options per MCQ item,`
    : '';
  const marksBits = slot?.totalMarks != null ? ` ${slot.totalMarks} total marks,` : '';
  const unitBits = slot?.unit ? ` unit ${slot.unit},` : '';
  const keep = `KEEP: the slot's question type (${slot?.type ?? 'unchanged'}),${optionBits}${marksBits}${unitBits} and the same concept/topic`;
  const change = isBroadSummaryDemand(refText)
    ? `CHANGE: ${narrowDemandDirective()}`
    : 'CHANGE: the information demand and framing — ask why/how/infer, or query a consequence, purpose, or relationship; never reuse the reference item\'s distinctive noun phrase in the stem.';
  return `${keep}. ${change}`;
}

/**
 * Compare ONE generated sub-part against its positional reference item.
 *
 * SOURCE-AWARE NOVELTY (additive): `visualAnchorTerms` — when the item
 * belongs to an IMAGE_BASED slot — are the reference image's own forced
 * vocabulary (see `visualEvidenceTermsFrom`). They are removed from BOTH
 * sides before `stemOverlap` is computed (see `lexicalStemOverlap`), so their
 * unavoidable repetition never counts as paraphrase/demand-sharing evidence.
 * EXACT_COPY is checked on the RAW text first and is never affected by
 * masking — a byte-identical restatement always fails regardless. Omitting
 * the argument (every non-image caller) is byte-identical to before.
 * @param {string} genStem
 * @param {string} refText
 * @param {string[]} [visualAnchorTerms]
 * @returns {{ kind: 'OK'|'EXACT_COPY'|'SAME_DEMAND_SHAPE'|'NEAR_PARAPHRASE'|'SAME_INFORMATION_DEMAND',
 *             refDemand: string, genDemand: string, stemOverlap: number, rawStemOverlap?: number, visualAnchorTermsMasked?: string[] }}
 */
export function compareItem(genStem, refText, visualAnchorTerms = []) {
  const ref = String(refText || '').trim();
  const gen = String(genStem || '').trim();
  if (!ref || !gen) return { kind: 'OK', refDemand: 'UNKNOWN', genDemand: 'UNKNOWN', stemOverlap: 0 };

  // 1) Exact copy (normalized) — RAW text, never masked: a byte-identical
  //    restatement is copying regardless of what vocabulary it contains.
  if (normalizeText(ref) === normalizeText(gen)) {
    return { kind: 'EXACT_COPY', refDemand: demandOf(ref), genDemand: demandOf(gen), stemOverlap: 1 };
  }

  // 1b) Same DEMAND SHAPE (broad moral/theme summary) regardless of overlap.
  // A "what can we learn" vs "what lesson does it teach" pair shares almost
  // no word roots (learn/lesson/teach don't stem to each other), so the
  // lexical-overlap check below would wrongly call this genuinely new — it
  // is the SAME underlying ask, just phrased with a synonym-family verb/noun.
  if (isBroadSummaryDemand(ref) && isBroadSummaryDemand(gen)) {
    return { kind: 'SAME_DEMAND_SHAPE', refDemand: 'BROAD_MORAL_SUMMARY', genDemand: 'BROAD_MORAL_SUMMARY', stemOverlap: overlapCoefficient(contentTerms(ref), contentTerms(gen)) };
  }

  const refDemand = demandOf(ref);
  const genDemand = demandOf(gen);
  const hasAnchors = Array.isArray(visualAnchorTerms) && visualAnchorTerms.length > 0;
  const stemOverlap = lexicalStemOverlap(ref, gen, visualAnchorTerms);
  const sameDemand = refDemand !== 'UNKNOWN' && genDemand !== 'UNKNOWN' && refDemand === genDemand;

  // Observability only (never affects the verdict): the UNMASKED overlap and
  // which forced-anchor terms were actually present in this pair, so a
  // rejection/acceptance can be diagnosed as "forced visual overlap masked
  // out X terms; remaining framing overlap was Y" rather than a bare number.
  const diagnostics = hasAnchors ? {
    rawStemOverlap: lexicalStemOverlap(ref, gen),
    visualAnchorTermsMasked: visualAnchorTerms.filter((t) => contentTerms(ref).includes(t) || contentTerms(gen).includes(t)),
  } : {};

  // 2) Near-paraphrase: same demand + near-identical stems.
  if (sameDemand && stemOverlap >= 0.8) return { kind: 'NEAR_PARAPHRASE', refDemand, genDemand, stemOverlap, ...diagnostics };

  // 3) Same information demand: reworded but asking for the same answer/fact.
  //    Require meaningful term overlap so a genuinely new WHY question on the
  //    same topic is not rejected (topic sharing is legal, demand sharing alone
  //    with low overlap is not).
  if (sameDemand && stemOverlap >= 0.55) return { kind: 'SAME_INFORMATION_DEMAND', refDemand, genDemand, stemOverlap, ...diagnostics };

  return { kind: 'OK', refDemand, genDemand, stemOverlap, ...diagnostics };
}

// ─── Task-aware novelty for PROGRAMMING/CODE-WRITING items (PHASE 6.1) ─────
// The academic why/what/compare demand taxonomy above has no meaning for an
// imperative "write a program to X" item — it is neither a WHY, a WHAT, nor
// a comparison. Two failure modes need a DIFFERENT test than lexical stem
// overlap: (a) a candidate that only swaps the reference's fixed numbers
// and/or a print/display/output synonym is a paraphrase even when the raw
// overlap ratio happens to fall under the generic threshold on a short
// one-line task description; (b) a candidate that genuinely parameterizes
// the task (accepts a value from the user, generalizes the range/scope) can
// still share heavy surface vocabulary with the reference ("program",
// "even numbers") and must NOT be rejected for that shared, unavoidable
// domain vocabulary.

/** Verb synonyms that name the SAME coding-task operation ("print" family)
 * so a bare verb swap doesn't read as lexically different from the reference. */
const PRINT_SYNONYMS_RE = /\b(?:print|display|output|show|write out)\b/gi;

/** Skeleton of a coding-task stem: verb-synonym family collapsed, every
 * digit collapsed, punctuation stripped — so "print even numbers from 1 to
 * 20" and "display even numbers from 1 to 10" reduce to the identical
 * skeleton (only the swapped verb/numbers made them look different). */
function codingTaskSkeleton(text) {
  return String(text || '')
    .toLowerCase()
    .replace(PRINT_SYNONYMS_RE, 'print')
    .replace(/\d+/g, '#')
    .replace(/[^a-z0-9#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a generated coding-task candidate only swapped the reference's
 * fixed numeric literal(s) and/or a print/display/output synonym, with no
 * genuine change to the input model or the operation performed. Never fires
 * when the candidate carries a dynamic-input cue (question-intent.js) — that
 * is exactly the accepted fixed→dynamic transformation, not a swap. Only
 * meaningful for items question-intent.js classifies as a coding task.
 * @param {string} refText
 * @param {string} genText
 * @returns {boolean}
 */
export function isCodingParameterSwap(refText, genText) {
  if (!isCodingTask(refText) || hasDynamicInputCue(genText)) return false;
  const refSkeleton = codingTaskSkeleton(refText);
  const genSkeleton = codingTaskSkeleton(genText);
  if (!refSkeleton || !genSkeleton) return false;
  const overlap = overlapCoefficient(refSkeleton.split(' ').filter(Boolean), genSkeleton.split(' ').filter(Boolean));
  return overlap >= 0.75;
}

/**
 * Deterministic reference-novelty verdict for ONE generated question against
 * its blueprint slot. Positional: sub-part i ↔ reference item i (the same
 * mapping the topic-fidelity and generator rules already use).
 *
 * @param {Object} opts
 * @param {Object} opts.question - normalized generated question (or null)
 * @param {number|null} opts.slotIndex
 * @param {Object|null} opts.blueprint - locked blueprint
 * @param {Object} [opts.thresholds] - { paraphrase: 0.8, demand: 0.55 } (test override)
 * @param {Object|null} [opts.imageGrounding] - the slot's ImageGrounding
 *   (SEMANTIC IMAGE GROUNDING layer). SOURCE-AWARE NOVELTY (additive): when
 *   supplied for an image-bearing slot, terms forced by the reference image's
 *   own Vision-extracted vocabulary (observationTargets/visualElements/
 *   relationships — the SAME source checkGrounding already uses) are exempted
 *   from paraphrase/demand-overlap scoring for that item, whether it is
 *   IMAGE_DEPENDENT or IMAGE_CONTEXTUAL (both may be forced to reuse the
 *   image's vocabulary; only construction/framing overlap still counts).
 *   Every non-image slot, and every image slot when this is omitted, is
 *   byte-identical to before this addition.
 * @returns {{ ok: boolean, items: Array, reasons: string[] }}
 */
export function checkReferenceNovelty({ question, slotIndex = null, blueprint = null, thresholds = {}, imageGrounding = null }) {
  const reasons = [];
  if (!question || !blueprint) return { ok: true, items: [], reasons };

  const slot = blueprint.questions?.[slotIndex] ?? null;
  if (!slot) return { ok: true, items: [], reasons };
  const refItems = Array.isArray(slot.items) ? slot.items : [];
  const parts = Array.isArray(question.subParts) ? question.subParts : [];
  if (refItems.length === 0 || parts.length === 0) return { ok: true, items: [], reasons };

  // Explicit caller overrides (thresholds.paraphrase/demand) win when given —
  // otherwise each item picks its own floor by ITEM TYPE (falling back to the
  // slot's own type for a homogeneous slot).
  const hasOverride = Number.isFinite(thresholds.paraphrase) || Number.isFinite(thresholds.demand);

  const label = slot.label || `Q${slotIndex + 1}`;
  const maxPairs = Math.min(parts.length, refItems.length);
  const items = [];

  // SOURCE-AWARE NOVELTY — scoped to image-bearing slots only (label-agnostic,
  // mirrors buildImageGrounding's/checkGrounding's own guard): a plain text
  // slot must never run labelSlotItemDependencies at all, since its
  // conservative "no visual cue anywhere -> every item is IMAGE_DEPENDENT"
  // fallback exists for real image slots and must not fire on text questions.
  // Both dependency classes get the SAME exemption — the anchors are equally
  // forced by the image regardless of which class the item belongs to; only
  // the classification differs, not the masking rule.
  const slotImageBearing = String(slot.type || '').toUpperCase() === 'IMAGE_BASED'
    || (Array.isArray(slot.imageAssets) && slot.imageAssets.length > 0);
  const itemDeps = slotImageBearing && refItems.length > 0 ? labelSlotItemDependencies(slot) : [];
  const visualAnchorTermsAll = slotImageBearing ? visualEvidenceTermsFrom(imageGrounding) : [];

  for (let i = 0; i < maxPairs; i++) {
    const letter = String.fromCharCode(97 + (i % 26));
    const refText = String(refItems[i]?.referenceText || refItems[i]?.topicAnchor || '').trim();
    const part = parts[i];
    if (!refText || !part?.text) continue;

    const itemType = effectiveItemType(refItems[i], slot);
    const typeDefaults = noveltyThresholdsForType(itemType);
    const paraphraseT = hasOverride && Number.isFinite(thresholds.paraphrase) ? thresholds.paraphrase : typeDefaults.paraphrase;
    const demandT = hasOverride && Number.isFinite(thresholds.demand) ? thresholds.demand : typeDefaults.demand;

    const dep = itemDeps[i] ?? null;
    const anchorTerms = (dep === 'IMAGE_DEPENDENT' || dep === 'IMAGE_CONTEXTUAL') ? visualAnchorTermsAll : [];
    const verdict = compareItem(part.text, refText, anchorTerms);
    // Recompute with the per-item thresholds when tighter than the defaults.
    let kind = verdict.kind;
    if (kind === 'NEAR_PARAPHRASE' && verdict.stemOverlap < paraphraseT) kind = 'SAME_INFORMATION_DEMAND';
    if (kind === 'SAME_INFORMATION_DEMAND' && verdict.stemOverlap < demandT) kind = 'OK';

    // Task-aware novelty for coding items (PHASE 6.1): a genuine fixed→dynamic
    // transformation must never be rejected for sharing domain vocabulary
    // ("program", "even numbers") with the reference, and a bare
    // number/verb-synonym swap must be caught even when it happens to clear
    // the generic lexical threshold on a short one-line task description.
    if (kind !== 'EXACT_COPY' && isCodingTask(refText)) {
      if (hasDynamicInputCue(part.text)) {
        kind = 'OK';
      } else if (kind === 'OK' && isCodingParameterSwap(refText, part.text)) {
        kind = 'PARAMETER_SWAP';
      }
    }

    const answer = part.answer ? ` Answer target: "${String(part.answer).slice(0, 60)}".` : '';
    items.push({ label: letter, ...verdict, kind, visualAnchorEligible: anchorTerms.length > 0 });

    // OBSERVABILITY (additive): when forced visual anchors were actually
    // masked for this item, name them and the raw (unmasked) overlap so a
    // rejection/acceptance is diagnosable — was it framing overlap, or would
    // this have ONLY looked similar because of the forced image vocabulary?
    const anchorNote = (verdict.visualAnchorTermsMasked?.length > 0)
      ? ` [source-aware: forced visual term(s) ${verdict.visualAnchorTermsMasked.join(', ')} excluded from overlap; raw overlap was ${(verdict.rawStemOverlap * 100).toFixed(0)}%]`
      : '';

    if (kind === 'EXACT_COPY') {
      reasons.push(
        `${label}(${letter}) EXACT_COPY of reference "${refText.slice(0, 80)}". ${keepChangeDirectives(slot, refText)}`
      );
    } else if (kind === 'SAME_DEMAND_SHAPE') {
      reasons.push(
        `${label}(${letter}) SAME_DEMAND_SHAPE (BROAD_MORAL_SUMMARY) as reference "${refText.slice(0, 80)}" — both ask for the same broad moral/theme summary regardless of the exact words used.${answer} ${keepChangeDirectives(slot, refText)}`
      );
    } else if (kind === 'NEAR_PARAPHRASE') {
      reasons.push(
        `${label}(${letter}) NEAR_PARAPHRASE of reference "${refText.slice(0, 80)}" — same information demand (${verdict.refDemand}) with ${(verdict.stemOverlap * 100).toFixed(0)}% stem overlap.${anchorNote}${answer} ${keepChangeDirectives(slot, refText)}`
      );
    } else if (kind === 'SAME_INFORMATION_DEMAND') {
      reasons.push(
        `${label}(${letter}) SAME_INFORMATION_DEMAND as reference "${refText.slice(0, 80)}" — reworded (${(verdict.stemOverlap * 100).toFixed(0)}% overlap) but still asking for the same ${verdict.refDemand.toLowerCase()} as the answer.${anchorNote}${answer} ${keepChangeDirectives(slot, refText)}`
      );
    } else if (kind === 'PARAMETER_SWAP') {
      reasons.push(
        `${label}(${letter}) PARAMETER_SWAP of the coding task "${refText.slice(0, 80)}" — only a fixed number and/or a print/display/output synonym changed; the underlying task is unchanged.${answer} `
        + `KEEP: the slot's question type (${slot?.type ?? 'unchanged'}), the same marks, and the same programming construct/concept. `
        + `CHANGE: do not just reword or swap the fixed numbers — change the INPUT MODEL (accept the bound/value from the user, or generalize to an arbitrary array/list/parameter) or the OPERATION performed (e.g. print → sum → count → search) while testing the same construct.`
      );
    }
  }

  return { ok: reasons.length === 0, items, reasons };
}

// ─── Reference-embedding backstop (PARTS 15/16) ────────────────────────────
// The lexical gate above works on demand cues + stem overlap. The E2E showed
// restatements at 0.91–0.95 embedding cosine can still slip past lexical
// cues. This backstop compares each generated sub-part against its POSITIONAL
// reference item at the SAME 0.85 SIMILARITY_THRESHOLD used by source/peer
// checks — it never lowers the bar, it applies it against the reference item
// itself (which may not be indexed in the past_paper corpus at all).

/**
 * Positional reference texts of a slot: items[].referenceText (falling back to
 * topicAnchor), with empty/whitespace anchors dropped. Generic — no
 * class/subject/unit special cases.
 * @param {Object|null} slot
 * @returns {Array<{ letter: string, text: string, marks: number|null, type: string|null }>}
 */
export function referenceItemPairs(slot) {
  if (!slot || !Array.isArray(slot.items)) return [];
  return slot.items
    .map((it, i) => ({
      letter: String(it?.label || String.fromCharCode(97 + (i % 26))),
      text: String(it?.referenceText || it?.topicAnchor || '').trim(),
      marks: it?.marks ?? null,
      type: effectiveItemType(it, slot),
    }))
    .filter((it) => it.text.length > 0);
}

/**
 * Item types with little room for two genuinely different short stems to
 * overlap in embedding space by accident — same taxonomy as
 * TYPE_NOVELTY_THRESHOLDS's short/closed-form row. For these, high cosine is
 * trusted as a restatement signal ONLY when the wording also shares real
 * vocabulary with the reference; otherwise it is embedding happenstance, not
 * a restatement. Longer, open-ended types (LONG_ANSWER, SHORT_ANSWER,
 * CREATIVE_WRITING, IMAGE_BASED) keep the original cosine-alone behavior —
 * that is the case this backstop was built for (see file header).
 */
const NARROW_EMBEDDING_TYPES = new Set(['MCQ', 'TRUE_FALSE', 'FILL_IN_THE_BLANK']);

/**
 * Generated sub-part texts ready for embedding (trimmed, non-empty).
 * @param {Object|null} question
 * @returns {Array<{ letter: string, text: string }>}
 */
export function subPartTexts(question) {
  const parts = Array.isArray(question?.subParts) ? question.subParts : [];
  return parts
    .map((p, i) => ({
      letter: String(p?.label || String.fromCharCode(97 + (i % 26))),
      text: String(p?.text || '').trim(),
    }))
    .filter((p) => p.text.length > 0);
}

/**
 * Max cosine similarity between one vector and a set of candidate vectors.
 * @returns {{ max: number, matched: number[]|null }}
 */
export function maxReferenceSimilarity(vector, refVectors) {
  let max = 0;
  let matched = null;
  if (!Array.isArray(vector)) return { max, matched };
  for (const v of Array.isArray(refVectors) ? refVectors : []) {
    if (!Array.isArray(v)) continue;
    const sim = cosineSimilarity(vector, v);
    if (sim > max) {
      max = sim;
      matched = v;
    }
  }
  return { max, matched };
}

/**
 * Build the rejection reason for ONE entry whose sub-part restates its
 * positional reference item at/above the embedding threshold. Missing vectors
 * on either side never block (question-level source checks already flag
 * missing embeddings).
 *
 * @param {Object} opts
 * @param {Object|null} opts.question - generated question
 * @param {number|null} opts.slotIndex
 * @param {Object|null} opts.blueprint - locked blueprint
 * @param {Map<string, number[]>} opts.vectorsByText - text → embedding for BOTH
 *   generated sub-part texts and reference texts
 * @param {number} opts.threshold - SIMILARITY_THRESHOLD (0.85 by default)
 * @returns {string|null} rejection reason, or null when the entry passes
 */
export function embeddingNoveltyReason({ question, slotIndex = null, blueprint = null, vectorsByText, threshold }) {
  if (!question || !blueprint || !(vectorsByText instanceof Map)) return null;
  const slot = blueprint.questions?.[slotIndex] ?? null;
  if (!slot) return null;
  const parts = subPartTexts(question);
  const refs = referenceItemPairs(slot);
  if (parts.length === 0 || refs.length === 0) return null;

  const label = slot.label || `Q${slotIndex + 1}`;
  const maxPairs = Math.min(parts.length, refs.length);
  for (let i = 0; i < maxPairs; i++) {
    const genVec = vectorsByText.get(parts[i].text);
    const refVec = vectorsByText.get(refs[i].text);
    if (!Array.isArray(genVec) || !Array.isArray(refVec)) continue;
    const sim = cosineSimilarity(genVec, refVec);
    if (sim < threshold) continue;

    // Task-aware exemption (PHASE 6.1): a genuine fixed→dynamic
    // transformation of a coding task shares heavy domain vocabulary
    // ("program", "even numbers") with the reference by necessity, which
    // keeps cosine high even though the input model genuinely changed — the
    // lexical gate above already exempts this; the embedding backstop must
    // agree, or a candidate that clears the lexical check still dies here.
    if (isCodingTask(refs[i].text) && hasDynamicInputCue(parts[i].text)) continue;

    // Type-aware confirmation: a narrow/closed-form item's high cosine is
    // trusted as a restatement only when the stems also share real
    // vocabulary — otherwise two short, unrelated stems landing close in
    // embedding space is happenstance, not a restatement. Long-form items
    // keep the original cosine-alone behavior (the case this backstop was
    // built to catch — see file header).
    const itemType = String(refs[i].type || '').trim().toUpperCase();
    if (NARROW_EMBEDDING_TYPES.has(itemType)) {
      const demandFloor = noveltyThresholdsForType(itemType).demand;
      const overlap = lexicalStemOverlap(refs[i].text, parts[i].text);
      if (overlap < demandFloor) continue;
    }

    return (
      `${label}(${refs[i].letter}) is a near-verbatim restatement of the reference item "${refs[i].text.slice(0, 80)}" ` +
      `(cosine ${roundTo(sim)} >= threshold ${threshold}). ${keepChangeDirectives(slot, refs[i].text)}`
    );
  }
  return null;
}

/**
 * Split entries into pass/failed by the embedding backstop. Pure — no I/O; the
 * caller supplies the vector map (batch-embedded once per evaluate round).
 *
 * @param {Object} opts
 * @param {Array<{ question: Object, slotIndex: number|null }>} opts.entries
 * @param {Object|null} opts.blueprint
 * @param {Map<string, number[]>} opts.vectorsByText
 * @param {number} opts.threshold
 * @returns {{ pass: Array, failed: Array<{ entry: Object, reasons: string[] }> }}
 */
export function applyReferenceEmbeddingBackstop({ entries, blueprint, vectorsByText, threshold }) {
  const pass = [];
  const failed = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const reason = embeddingNoveltyReason({
      question: entry?.question ?? null,
      slotIndex: entry?.slotIndex ?? null,
      blueprint,
      vectorsByText,
      threshold,
    });
    if (reason) failed.push({ entry, reasons: [reason] });
    else pass.push(entry);
  }
  return { pass, failed };
}

export default {
  checkReferenceNovelty,
  compareItem,
  overlapCoefficient,
  lexicalStemOverlap,
  effectiveItemType,
  BROAD_SUMMARY_WORDS,
  findBroadSummaryTrigger,
  isBroadSummaryDemand,
  slotHasBroadSummaryItem,
  demandOf,
  referenceItemPairs,
  subPartTexts,
  maxReferenceSimilarity,
  embeddingNoveltyReason,
  applyReferenceEmbeddingBackstop,
  isCodingParameterSwap,
};
