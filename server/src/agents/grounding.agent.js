import { env } from '../config/env.js';
import { labelSlotItemDependencies } from '../planner/item-dependency.js';

/** Exam / concept-generation glue words — never evidence signals. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'if', 'then', 'else', 'so', 'in',
  'on', 'at', 'to', 'from', 'by', 'with', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'do', 'does', 'did', 'done', 'have', 'has', 'had',
  'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might',
  'this', 'that', 'these', 'those', 'it', 'you', 'they', 'we', 'he', 'she',
  'as', 'not', 'no', 'nor', 'such', 'rather', 'what', 'which', 'who',
  'whom', 'whose', 'how', 'when', 'where', 'why', 'about', 'into', 'upon',
  'after', 'out', 'under', 'over', 'among', 'between', 'write', 'writes',
  'answer', 'answers', 'question', 'questions', 'following', 'given',
  'state', 'name', 'define', 'list', 'describe', 'explain', 'fill',
  'blanks', 'blank', 'true', 'false', 'tick', 'mark', 'marks', 'max',
  'attempt', 'any', 'all', 'some', 'one', 'two', 'three', 'each', 'every',
  'own', 'your', 'their', 'our', 'him', 'her', 'them', 'me', 'us', 'i',
  'very', 'much', 'more', 'most', 'other', 'another', 'also', 'than',
  'both', 'during', 'yet', 'onto', 'directly', 'way', 'ways', 'student', 'students',
  'teacher', 'teachers', 'result', 'effect', 'action', 'actions', 'method', 'methods',
  'using', 'used', 'make', 'makes', 'made', 'take', 'takes', 'took', 'help', 'helps', 'helped',
]);

/**
 * Question instruction, examination directive, and visual framing words for
 * image-based questions (Requirement §3.C, §14).
 * These are question-construction language and framing/positioning cues —
 * they are NOT academic claims and must NOT be treated as missing RAG evidence.
 */
export const IMAGE_INSTRUCTION_WORDS = new Set([
  'observe', 'observing', 'observed', 'observation',
  'look', 'looking', 'looked',
  'identify', 'identifying', 'identified', 'identification',
  'examine', 'examining', 'examined',
  'study', 'studying', 'studied',
  'notice', 'noticing', 'noticed',
  'locate', 'locating', 'located',
  'view', 'viewing', 'viewed',
  'see', 'seeing', 'seen',
  'find', 'finding', 'found',
  'read', 'reading',
  'picture', 'image', 'diagram', 'illustration', 'figure', 'photo', 'photograph', 'scene',
  'shown', 'show', 'shows', 'showing', 'depicted', 'depict', 'depicts', 'depicting',
  'given', 'provided', 'displayed', 'display', 'displays',
  'refer', 'referring', 'referred', 'reference',
  'carefully', 'closely', 'clearly', 'specifically', 'specific',
  'mention', 'describe', 'explain', 'tell', 'answer', 'write', 'point',
  'apply', 'relate', 'connect', 'understand',
  'foreground', 'background', 'left', 'right', 'top', 'bottom', 'middle', 'center',
  'above', 'below', 'beneath', 'underneath', 'behind', 'front', 'beside', 'next',
  'side', 'corner', 'across',
  'resting', 'placed', 'lying', 'hanging', 'position', 'positioned',
  'according', 'based', 'relation', 'relates', 'related', 'relating',
]);

/**
 * Light morphological normalization — enough for exam English without a full
 * stemmer: lowercase + de-pluralize trailing s/es/ies. "leaves"→"leave",
 * "roots"→"root", "stems"→"stem". A bounded heuristic; over-stemming here is
 * safer than under-matching.
 */
function normalizeToken(word) {
  let t = String(word || '').toLowerCase();
  if (t.length <= 3) return t;
  if (t.endsWith('ies') && t.length > 4) return t.slice(0, -3) + 'y';
  if (t.endsWith('es') && !t.endsWith('ss') && t.length > 4) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss') && t.length > 3) return t.slice(0, -1);
  return t;
}

/**
 * Content terms of a piece of text: lowercased, punctuation-stripped,
 * stopword-free, deduped, lightly de-pluralized. A pure-formula or
 * instruction-only question yields no terms and cannot be grounded.
 * @param {string} text
 * @returns {string[]}
 */
export function contentTerms(text) {
  const raw = String(text || '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const seen = new Set();
  const out = [];
  for (const w of raw) {
    const t = normalizeToken(w);
    if (t.length < 3) continue; // 2-letter words never carry evidence
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Union of the content terms of up to `maxChunks` evidence chunks. */
export function evidenceTermsFromChunks(chunks, { maxChunks = 5 } = {}) {
  const list = Array.isArray(chunks) ? chunks.slice(0, maxChunks) : [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const text = String(c?.text ?? '').trim();
    if (!text) continue;
    for (const t of contentTerms(text)) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

/**
 * Ground ONE unit of content against an evidence chunk list.
 *
 * DUAL GROUNDING MODEL (Requirement §2, §3, §4, §26):
 * For IMAGE_BASED questions, evidence comes from TWO sources:
 *   - notesEvidence (retrieved syllabus notes chunks)
 *   - imageEvidence (observation targets, visible elements, visible text, labels)
 * Question instruction words (observe, look, locate, etc.) are excluded from substantive
 * evidence demands so they never penalize valid questions.
 *
 * @returns {{ termCount, coverage, matchedTerms, unmatchedTerms, matchedNotesTerms, matchedVisualTerms, ok, chunkCount }}
 */
export function groundUnit(subject, chunks, {
  minCoverage = env.MIN_EVIDENCE_COVERAGE,
  minTerms = env.MIN_EVIDENCE_TERMS,
  visualTerms = [],
  isImageBased = false,
} = {}) {
  const allTerms = contentTerms(subject);
  const ev = evidenceTermsFromChunks(chunks);
  const evSet = new Set(ev);
  const visualSet = new Set(Array.isArray(visualTerms) ? visualTerms : []);

  if (isImageBased) {
    const instructionTermsIgnored = allTerms.filter((t) => IMAGE_INSTRUCTION_WORDS.has(t));
    const terms = allTerms.filter((t) => !IMAGE_INSTRUCTION_WORDS.has(t));
    const termCount = terms.length;
    const matchedNotesTerms = terms.filter((t) => evSet.has(t));
    const remainingAfterNotes = terms.filter((t) => !evSet.has(t));
    const matchedVisualTerms = remainingAfterNotes.filter((t) => visualSet.has(t));
    const matchedBoth = terms.filter((t) => evSet.has(t) && visualSet.has(t));
    const matched = [...matchedNotesTerms, ...matchedVisualTerms];
    const unmatched = remainingAfterNotes.filter((t) => !visualSet.has(t));
    const coverage = termCount > 0 ? matched.length / termCount : (allTerms.length > 0 ? 1.0 : 0);

    // Image-Based acceptance rule:
    // 1. Must carry substantive terms
    // 2. Must meet minimum term count match (at least minTerms or 2)
    // 3. Must meet minimum evidence coverage on substantive terms (coverage >= minCoverage)
    const ok = termCount > 0
      && matched.length >= Math.min(minTerms, 2)
      && coverage >= minCoverage;

    return {
      termCount,
      coverage,
      matchedTerms: matched,
      unmatchedTerms: unmatched,
      matchedNotesTerms,
      matchedVisualTerms,
      matchedBoth,
      instructionTermsIgnored,
      ok,
      chunkCount: Array.isArray(chunks) ? chunks.length : 0,
    };
  }

  // Standard text-question grounding (byte-identical)
  const termCount = allTerms.length;
  const matchedNotesTerms = allTerms.filter((t) => evSet.has(t));
  const remainingAfterNotes = allTerms.filter((t) => !evSet.has(t));
  const matchedVisualTerms = remainingAfterNotes.filter((t) => visualSet.has(t));
  const matched = [...matchedNotesTerms, ...matchedVisualTerms];
  const unmatched = remainingAfterNotes.filter((t) => !visualSet.has(t));
  const coverage = termCount > 0 ? matched.length / termCount : 0;
  const ok = termCount > 0 && matched.length >= minTerms && coverage >= minCoverage;
  return {
    termCount, coverage, matchedTerms: matched, unmatchedTerms: unmatched,
    matchedNotesTerms, matchedVisualTerms,
    ok, chunkCount: Array.isArray(chunks) ? chunks.length : 0,
  };
}

/**
 * SOURCE-AWARE GROUNDING — the reference image's own Vision-extracted
 * vocabulary (observationTargets/visualElements/relationships/visibleText/people/objects)
 * + metadata from the selected document's image assets (nearbyText/title/concepts/ocrText).
 *
 * @param {Object|null} imageGrounding - the slot's ImageGrounding object
 * @param {Object|null} [slot] - blueprint slot, for imageAssets metadata
 * @returns {string[]}
 */
export function visualEvidenceTermsFrom(imageGrounding, slot = null) {
  const texts = [];
  if (imageGrounding && imageGrounding.status === 'ok') {
    const ri = imageGrounding.referenceImage || {};
    if (Array.isArray(ri.observationTargets)) texts.push(...ri.observationTargets);
    if (Array.isArray(ri.visualElements)) texts.push(...ri.visualElements);
    if (Array.isArray(ri.relationships)) texts.push(...ri.relationships);
    if (Array.isArray(ri.concepts)) texts.push(...ri.concepts);
    if (ri.topic) texts.push(ri.topic);
    if (Array.isArray(ri.visibleText)) texts.push(...ri.visibleText);
    else if (ri.visibleText) texts.push(ri.visibleText);
    if (Array.isArray(ri.objects)) texts.push(...ri.objects);
    else if (ri.objects) texts.push(ri.objects);
    if (Array.isArray(ri.people)) texts.push(...ri.people);
    else if (ri.people) texts.push(ri.people);
  }

  // Include deterministic metadata from slot.imageAssets (from the selected notes document)
  const assets = Array.isArray(slot?.imageAssets) ? slot.imageAssets : [];
  for (const a of assets) {
    if (a?.title) texts.push(a.title);
    if (a?.topic) texts.push(a.topic);
    if (a?.nearbyText) texts.push(a.nearbyText);
    if (Array.isArray(a?.concepts)) texts.push(...a.concepts);
    if (a?.imageType) texts.push(a.imageType);
    if (a?.ocrText) texts.push(a.ocrText);
    if (a?.extractedText) texts.push(a.extractedText);
    if (a?.caption) texts.push(a.caption);
  }

  // Include notesImageEvidence metadata
  if (Array.isArray(imageGrounding?.notesImageEvidence)) {
    for (const nie of imageGrounding.notesImageEvidence) {
      if (nie?.title) texts.push(nie.title);
      if (nie?.nearbyText) texts.push(nie.nearbyText);
      if (nie?.ocrText) texts.push(nie.ocrText);
    }
  }

  const seen = new Set();
  const out = [];
  for (const text of texts) {
    for (const term of contentTerms(text)) {
      if (!seen.has(term)) { seen.add(term); out.push(term); }
    }
  }
  return out;
}

/** Marking-scheme point texts (real academic answer content). */
function schemePoints(q) {
  return Array.isArray(q?.markingScheme)
    ? q.markingScheme.map((s) => s?.point ?? s?.text ?? '').filter(Boolean)
    : [];
}

const join = (...bits) => bits.filter(Boolean).join(' ');

/**
 * The units of content a question must be grounded on, by type:
 *   - single stem            → one unit (text + answer + options for a lone MCQ)
 *   - MCQ                    → one unit per item: stem + correct option
 *   - TRUE_FALSE             → one unit per statement (statement terms only; a
 *                              boolean value is not content)
 *   - FILL_IN_THE_BLANK      → one unit per item: stem + the missing term
 *   - SHORT/LONG_ANSWER      → one unit per item: stem + answer + scheme points
 *   - MATCH_THE_FOLLOWING    → one unit: both columns
 *   - INTERNAL_CHOICE        → one unit per OR branch
 *   - PASSAGE/CASE based     → one unit per sub-question (the composed passage
 *                              is the generator's own stimulus, never graded)
 * @param {Object} question - a normalized generated question
 * @returns {Array<{ label: string|null, subject: string, shape: string }>}
 */
export function groundingUnitsFor(question = {}) {
  const type = String(question.type || '').trim().toUpperCase();
  const parts = Array.isArray(question.subParts) ? question.subParts : [];
  const units = [];

  // MATCH: the whole pairing is the grounded unit (both columns in one unit).
  if (type === 'MATCH_THE_FOLLOWING' || (question.columns && Array.isArray(question.columns.left))) {
    units.push({
      label: null,
      shape: 'pairs',
      subject: join(question.text, ...(question.columns?.left || []), ...(question.columns?.right || [])),
    });
    return units;
  }

  // INTERNAL_CHOICE: each OR branch is its own grounded alternative.
  if (type === 'INTERNAL_CHOICE' && Array.isArray(question.choices) && question.choices.length > 0) {
    question.choices.forEach((c, i) => {
      units.push({
        label: c?.label ? String(c.label) : `choice-${i + 1}`,
        shape: 'choice',
        subject: join(c.text, ...(Array.isArray(c.subParts) ? c.subParts.map((s) => s?.text ?? '') : [])),
      });
    });
    return units;
  }

  // Single-stem question (a lone MCQ, SHORT/LONG answer, etc.)
  if (parts.length === 0) {
    const answer = join(question.answer, ...schemePoints(question));
    const options = type === 'MCQ' && Array.isArray(question.options) ? question.options.join(' ') : '';
    units.push({ label: null, shape: 'single', subject: join(question.text, answer, options) });
    return units;
  }

  // Multi-item questions: each lettered sub-part is one grounded unit. For a
  // MIXED slot each sub-part's shape comes from ITS OWN type (or an inference
  // from its options / blank), never the parent question type.
  const isMixed = type === 'MIXED';
  parts.forEach((p, i) => {
    const label = p?.label ? String(p.label) : String.fromCharCode(97 + i);
    const answer = join(p.answer, ...schemePoints(p));
    let itemType = type;
    if (isMixed) {
      const explicit = String(p?.type || '').trim().toUpperCase();
      itemType = explicit && explicit !== 'UNKNOWN'
        ? explicit
        : (Array.isArray(p?.options) && p.options.length >= 2 ? 'MCQ'
          : /_{2,}/.test(String(p?.text || '')) ? 'FILL_IN_THE_BLANK'
          : 'SHORT_ANSWER');
    }
    let subject = p?.text;
    if (itemType === 'MCQ') subject = join(p.text, answer); // stem + correct option
    else if (itemType === 'TRUE_FALSE') subject = join(p.text); // boolean value is not content
    else subject = join(p.text, answer); // fill-blank missing term, short/long answer
    units.push({
      label,
      shape: itemType === 'MCQ' ? 'option' : itemType === 'TRUE_FALSE' ? 'boolean' : 'text',
      subject,
    });
  });

  return units;
}

/**
 * Choose each unit's evidence: per-item chunks when the slot retrieval carried
 * item-level results for that unit's label, else the slot's merged results.
 * @returns {Array<{ chunks: Array, source: 'itemResults'|'slotResults' }>}
 */
function evidenceListFor(units, slotCtx) {
  const itemResults = slotCtx?.itemResults && typeof slotCtx.itemResults === 'object' ? slotCtx.itemResults : null;
  const hasItemEvidence = itemResults != null
    && units.some((u) => u.label != null && Array.isArray(itemResults[u.label]) && itemResults[u.label].length > 0);
  if (hasItemEvidence) {
    return units.map((u) => {
      const chunks = u.label != null && Array.isArray(itemResults[u.label]) ? itemResults[u.label] : [];
      return { chunks, source: chunks.length > 0 ? 'itemResults' : 'slotResults' };
    });
  }
  const merged = Array.isArray(slotCtx?.results)
    ? slotCtx.results
    : (Array.isArray(slotCtx?.slotResults) ? slotCtx.slotResults : []);
  return units.map(() => ({ chunks: merged, source: 'slotResults' }));
}

/** Resolve the slotUnitMap entry ({ unit } or { items: {a:unit} }) for a slot. */
function unitAssignmentFor(slot, slotUnitMap) {
  if (!slotUnitMap || typeof slotUnitMap !== 'object') return null;
  const label = slot?.label ?? slot?.number ?? null;
  if (label != null && slotUnitMap[label] && typeof slotUnitMap[label] === 'object') return slotUnitMap[label];
  return null;
}

/** Expected unit for one item (whole-slot assignment vs per-item assignment). */
function expectedUnitFor(label, assign) {
  if (!assign) return null;
  if (assign.unit != null) return String(assign.unit);
  if (label != null && assign.items && assign.items[label] != null) return String(assign.items[label]);
  return null;
}
/**
 * Deterministic grounding verdict for ONE generated question against the
 * evidence already retrieved for its slot (CPU-only, no AI calls).
 *
 * @param {Object} opts
 * @param {Object} opts.question - the normalized generated question (or null
 *   for a slot whose question was never produced).
 * @param {number|null} opts.slotIndex - state entry.slotIndex
 * @param {Array} opts.slotContexts - state.slotContexts from retrieval
 * @param {Object|null} opts.blueprint - the normalized locked blueprint
 * @param {Object|null} opts.slotUnitMap - teacher unit assignments
 * @param {Object} [opts.thresholds] - { minCoverage, minTerms } (test override)
 * @param {Object|null} [opts.imageGrounding] - the slot's ImageGrounding
 *   (SEMANTIC IMAGE GROUNDING layer). Additive: when supplied, an
 *   IMAGE_DEPENDENT sub-part (per labelSlotItemDependencies — the SAME
 *   deterministic classifier checkImageGroundingFidelity/checkVisualEngagement
 *   already use) may also satisfy coverage with the image's own Vision-
 *   extracted vocabulary (observationTargets/visualElements/relationships).
 *   IMAGE_CONTEXTUAL parts and every non-image slot are UNCHANGED — Notes
 *   evidence stays the only evidence pool for them, byte-identical to before.
 * @returns {{ grounded: boolean, threshold: number, minTerms: number,
 *   unit: string|null, items: Array, reasons: string[] }}
 */
export function checkGrounding({ question, slotIndex = null, slotContexts = [], blueprint = null, slotUnitMap = null, thresholds = {}, imageGrounding = null }) {
  if (!question || typeof question !== 'object') {
    return { grounded: false, threshold: null, minTerms: null, unit: null, items: [], reasons: ['No question body to ground.'] };
  }
  const minCoverage = Number.isFinite(thresholds.minCoverage) ? thresholds.minCoverage : env.MIN_EVIDENCE_COVERAGE;
  const minTerms = Number.isFinite(thresholds.minTerms) ? thresholds.minTerms : env.MIN_EVIDENCE_TERMS;
  const slot = blueprint?.questions?.[slotIndex] ?? null;
  const slotLabel = slot?.label ?? (slotIndex != null ? `Q${slotIndex + 1}` : 'question');
  const assign = unitAssignmentFor(slot, slotUnitMap);
  const slotCtx = slotContexts[slotIndex] ?? null;
  const unitPhrase = slotCtx?.unit != null && slotCtx.unit !== ''
    ? `unit '${slotCtx.unit}' notes`
    : 'the retrieved notes';

  const units = groundingUnitsFor(question);
  const evidenceByUnit = evidenceListFor(units, slotCtx);

  // SOURCE-AWARE GROUNDING (additive) — per-item dependency labels come from
  // the SAME deterministic classifier every other image-fidelity check uses
  // (positional: unit i ↔ slot.items[i], the established contract). Scoped to
  // IMAGE-BEARING slots only (label-agnostic, mirrors buildImageGrounding's
  // own guard): a plain text slot must never run labelSlotItemDependencies at
  // all — its conservative "no visual cue anywhere -> treat every item as
  // IMAGE_DEPENDENT" fallback exists for real image slots and must not fire
  // on ordinary text questions. Visual evidence is computed ONCE (no extra
  // Vision call — it's already in the supplied imageGrounding object) and
  // applied ONLY to IMAGE_DEPENDENT units of an image-bearing slot.
  const slotImageBearing = Boolean(slot) && (String(slot.type || '').toUpperCase() === 'IMAGE_BASED'
    || (Array.isArray(slot.imageAssets) && slot.imageAssets.length > 0)
    || String(question?.type || '').toUpperCase() === 'IMAGE_BASED');

  const effectiveImageGrounding = imageGrounding
    || (slotIndex != null && Array.isArray(slotContexts) ? slotContexts[slotIndex]?.imageGrounding : null)
    || null;

  const itemDeps = slotImageBearing && Array.isArray(slot?.items) && slot.items.length > 0
    ? labelSlotItemDependencies(slot)
    : [];
  const visualTermsAll = slotImageBearing ? visualEvidenceTermsFrom(effectiveImageGrounding, slot) : [];

  const items = units.map((u, i) => {
    const { chunks, source } = evidenceByUnit[i] ?? { chunks: [], source: 'slotResults' };
    const dep = itemDeps[i];
    const isImageDependent = slotImageBearing && dep !== 'IMAGE_CONTEXTUAL';
    const visualTerms = isImageDependent ? visualTermsAll : [];
    const result = groundUnit(u.subject, chunks, {
      minCoverage,
      minTerms,
      visualTerms,
      isImageBased: slotImageBearing,
    });

    // Unit-consistency: when chunk payloads carry `unit` metadata AND an
    // expected unit is known, at least one chunk must come from that unit.
    const expectedUnit = expectedUnitFor(u.label, assign);
    const knownChunkUnits = [...new Set(chunks.map((c) => (c?.unit != null ? String(c.unit) : null)).filter(Boolean))];
    const unitMatch = !(expectedUnit != null && knownChunkUnits.length > 0 && !knownChunkUnits.includes(String(expectedUnit)));

    return {
      label: u.label,
      shape: u.shape,
      coverage: result.coverage,
      termCount: result.termCount,
      matchedTerms: result.matchedTerms,
      unmatchedTerms: result.unmatchedTerms,
      matchedNotesTerms: result.matchedNotesTerms,
      matchedVisualTerms: result.matchedVisualTerms,
      instructionTermsIgnored: result.instructionTermsIgnored || [],
      visualEvidenceEligible: isImageDependent && visualTermsAll.length > 0,
      chunkCount: result.chunkCount,
      evidenceSource: source,
      unitMatch,
      knownChunkUnits,
      ok: result.ok && unitMatch,
    };
  });

  const reasons = [];
  for (const it of items) {
    if (it.ok) continue;
    const where = it.label ? `(${it.label})` : '';
    // OBSERVABILITY (additive): when visual evidence was actually eligible for
    // this item, break the count down by source so a future grounding
    // failure is diagnosable at a glance — never for a text-only/CONTEXTUAL
    // item, whose message stays byte-identical to before this addition.
    const sourceNote = it.visualEvidenceEligible
      ? ` (notes: ${it.matchedNotesTerms.length}, visual: ${it.matchedVisualTerms.length}, uncovered: ${it.unmatchedTerms.length})`
      : '';
    if (it.chunkCount === 0) {
      reasons.push(`${slotLabel}${where} has no retrieved notes evidence for ${unitPhrase} — a question with no supporting evidence must not be accepted.`);
    } else if (it.matchedTerms.length === 0) {
      reasons.push(`${slotLabel}${where} is not supported by ${unitPhrase}${it.visualEvidenceEligible ? ' or the selected image' : ''}: none of its ${it.termCount} content term(s) appear in the notes${it.visualEvidenceEligible ? ' or the image evidence' : ''} (${it.coverage === 0 ? 'unsupported fact' : 'weak overlap'})${sourceNote}.`);
    } else {
      reasons.push(
        `${slotLabel}${where} is not fully supported by ${unitPhrase}${it.visualEvidenceEligible ? ' + image evidence' : ''}: ` +
        `${it.matchedTerms.length}/${it.termCount} content term(s) covered${sourceNote} ` +
        `(${(it.coverage * 100).toFixed(0)}% < ${Math.round(minCoverage * 100)}%); missing: ` +
        `${it.unmatchedTerms.slice(0, 6).join(', ') || '—'}`
      );
    }
    if (!it.unitMatch) {
      reasons.push(`${slotLabel}${where} evidence comes from the wrong unit (found: ${(it.knownChunkUnits || []).join(', ') || 'none'}; expected: '${expectedUnitFor(it.label, assign)}')`);
    }
  }

  // A question carrying no content terms cannot be grounded or rejected fairly
  // on evidence — treat it as a grounding failure (unsupportable), never accept.
  if (items.length > 0 && items.every((it) => it.termCount === 0)) {
    reasons.length = 0;
    reasons.push(`${slotLabel}: the question carries no content terms to ground against ${unitPhrase}.`);
  }

  if (slotImageBearing) {
    const allInstructionTerms = items.flatMap((it) => it.instructionTermsIgnored || []);
    const allMatchedNotesTerms = [...new Set(items.flatMap((it) => it.matchedNotesTerms || []))];
    const allMatchedVisualTerms = [...new Set(items.flatMap((it) => it.matchedVisualTerms || []))];
    const allUnmatchedTerms = [...new Set(items.flatMap((it) => it.unmatchedTerms || []))];
    const isImageAligned = effectiveImageGrounding?.alignment?.aligned !== false;

    return {
      grounded: reasons.length === 0,
      ok: reasons.length === 0,
      questionType: 'IMAGE_BASED',
      imageContext: {
        ok: allMatchedVisualTerms.length > 0 || isImageAligned,
        supportedClaims: allMatchedVisualTerms,
        unsupportedClaims: allUnmatchedTerms,
      },
      notesContext: {
        ok: allMatchedNotesTerms.length > 0 || (slotCtx?.results?.length || slotCtx?.slotResults?.length || 0) > 0,
        supportedClaims: allMatchedNotesTerms,
        unsupportedClaims: allUnmatchedTerms,
      },
      alignment: {
        ok: isImageAligned,
        confidence: effectiveImageGrounding?.alignment?.confidence ?? 1.0,
      },
      instructionTermsIgnored: allInstructionTerms,
      threshold: minCoverage,
      minTerms,
      unit: slotCtx?.unit ?? null,
      items,
      reasons,
    };
  }

  return {
    grounded: reasons.length === 0,
    threshold: minCoverage,
    minTerms,
    unit: slotCtx?.unit ?? null,
    items,
    reasons,
  };
}

export default {
  contentTerms,
  evidenceTermsFromChunks,
  groundingUnitsFor,
  groundUnit,
  visualEvidenceTermsFrom,
  checkGrounding,
};