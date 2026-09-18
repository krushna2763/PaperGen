/**
 * blueprint-normalizer.js
 *
 * Deterministic normalization of marks expressions, optional-answer rules and
 * whole blueprints. Everything here is pure JavaScript — no LLM calls.
 *
 * The reference papers express marks in compact exam style:
 *   "1x5=5"  → 1 mark × 5 items = 5 total
 *   "2x4=8"  → 2 marks × 4 items = 8 total
 *   "3x3=9"  → 3 marks × 3 items = 9 total
 *   "4+1"    → drawing style, 4 + 1 = 5 total (single item)
 *   "5"      → plain 5 marks
 * The blueprint keeps these expressions verbatim AND the parsed numbers so the
 * generator/validator never re-derive or redesign the marks.
 */

import { normalizeBlueprintType, deriveQuestionType, answerFormForType, NUMBER_WORDS } from './blueprint-schema.js';

/**
 * Parse an exam-style marks expression found inside a question text.
 * @param {string} text - Question text possibly containing e.g. "1x5=5", "2X4=8", "4+1"
 * @returns {{ expression: string, marksPerItem: number, itemCount: number, totalMarks: number } | null}
 */
export function parseMarksExpression(text) {
  const t = String(text || '');

  // "1x5=5" / "2X4=8" / "3 x 3 = 9"
  let m = t.match(/(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+)\s*=\s*(\d+)/);
  if (m) {
    const per = Number(m[1]);
    const count = Number(m[2]);
    const total = Number(m[3]);
    if (per > 0 && count > 0 && total > 0) {
      return { expression: `${m[1]}X${m[2]}=${m[3]}`, marksPerItem: per, itemCount: count, totalMarks: total };
    }
  }

  // "4+1" (drawing / split marks, single item)
  m = t.match(/(\d+)\s*\+\s*(\d+)/);
  if (m) {
    const total = Number(m[1]) + Number(m[2]);
    if (total > 0) return { expression: `${m[1]}+${m[2]}`, marksPerItem: total, itemCount: 1, totalMarks: total };
  }

  // Bare "5" (trailing number only, not a year/date)
  m = t.match(/(?:^|\s)(\d{1,2})(?:\s*marks?)?\s*$/i);
  if (m) {
    const total = Number(m[1]);
    if (total > 0 && total <= 25) return { expression: String(total), marksPerItem: total, itemCount: 1, totalMarks: total };
  }

  return null;
}

/**
 * Strip a matched marks expression from a question text.
 * @param {string} text
 * @returns {string} Cleaned stem
 */
export function stripMarksExpression(text) {
  return String(text || '')
    .replace(/\s*(\d+(?:\.\d+)?)\s*[xX×*]\s*\d+\s*=\s*\d+\s*/g, ' ')
    .replace(/\s*\d+\s*\+\s*\d+\s*/g, ' ')
    .replace(/\s+\d{1,2}\s*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse an optional-answer rule like "(Any four)", "Attempt any five", "Answer
 * any 2 of the following" into a canonical rule.
 * @param {string} text
 * @returns {{ kind: 'ANY_N', n: number } | null}
 */
export function parseOptionalRule(text) {
  const t = String(text || '');
  const m = t.match(/\b(?:any|attempt|choose|answer)\b(?:\s+of\s+)?(?:\s+the\s+)?\s*(?:any\s+)?(?:of\s+)?(?:the\s+)?\s*(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const n = NUMBER_WORDS[raw] ?? Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 25) return null;
  return { kind: 'ANY_N', n };
}

/**
 * Canonicalize an optional rule from any accepted representation.
 * @param {*} rule - { n }, { kind, n }, "any four", null
 * @returns {{ kind: 'ANY_N', n: number } | null}
 */
export function normalizeOptionalRule(rule) {
  if (!rule) return null;
  if (typeof rule === 'string') return parseOptionalRule(rule);
  if (typeof rule === 'number') return { kind: 'ANY_N', n: rule };
  if (typeof rule === 'object') {
    const n = Number(rule.n ?? rule.count);
    if (Number.isFinite(n) && n >= 1 && n <= 25) return { kind: 'ANY_N', n };
  }
  return null;
}

/**
 * Normalize a (possibly raw / client-supplied) blueprint into the canonical
 * shape used by the orchestrator, generator and validator. Missing numbers get
 * sane defaults; UNKNOWN-type or empty questions are dropped; totals are
 * recomputed from the question list (marks are NEVER invented here).
 * @param {Object} raw
 * @returns {Object|null} Canonical blueprint or null when unusable
 */
export function normalizeBlueprint(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const paper = {
    schoolName: raw.paper?.schoolName != null ? String(raw.paper.schoolName) : null,
    examTitle: raw.paper?.examTitle != null ? String(raw.paper.examTitle) : null,
    session: raw.paper?.session != null ? String(raw.paper.session) : null,
    class: raw.paper?.class != null ? String(raw.paper.class) : null,
    subject: raw.paper?.subject != null ? String(raw.paper.subject) : null,
    duration: raw.paper?.duration != null ? String(raw.paper.duration) : null,
    maximumMarks: Number.isFinite(Number(raw.paper?.maximumMarks)) ? Number(raw.paper.maximumMarks) : null,
  };

  const sections = normalizeSections(raw.sections);
  // Map question labels to their section name so generated questions can carry
  // the reference section structure forward.
  const sectionNameByLabel = new Map();
  for (const s of sections) {
    for (const label of s.questionNumbers || []) {
      if (!sectionNameByLabel.has(String(label))) sectionNameByLabel.set(String(label), s.name);
    }
  }

  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .map((q, i) => {
      const totalMarks = Number.isFinite(Number(q?.totalMarks)) && Number(q.totalMarks) > 0 ? Number(q.totalMarks) : null;
      const itemCount = Number.isFinite(Number(q?.itemCount)) && Number(q.itemCount) > 0 ? Math.round(Number(q.itemCount)) : 1;
      // marksPerItem is NEVER re-derived by dividing the total when the
      // observed items PROVE a non-uniform split (their own printed marks all
      // exist and differ, e.g. "[03] … [02]"): the extractor already left
      // perItem null for that case, and re-dividing (5/2 = 2.5) would
      // fabricate a value no sub-question prints. The legacy division
      // fallback (no per-item marks at all, e.g. 4 items × 4 marks → 1 each)
      // keeps working unchanged.
      const allItemsMarked = (Array.isArray(q?.items) ? q.items : []).length > 0
        && (Array.isArray(q?.items) ? q.items : []).every((it) => Number.isFinite(Number(it?.marks)) && Number(it.marks) > 0);
      const distinctItemMarks = [...new Set((Array.isArray(q?.items) ? q.items : [])
        .map((it) => Number(it?.marks))
        .filter((n) => Number.isFinite(n) && n > 0))];
      const provenNonUniform = allItemsMarked && distinctItemMarks.length > 1;
      const marksPerItem = Number.isFinite(Number(q?.marksPerItem)) && Number(q.marksPerItem) > 0
        ? Number(q.marksPerItem)
        : (totalMarks != null && !provenNonUniform ? totalMarks / itemCount : null);
      const stem = String(q?.stem ?? '').trim();
      const label = String(q?.label ?? `Q${i + 1}`).trim() || `Q${i + 1}`;
      // PARENT TYPE — re-derive from the item types using THE canonical rule so
      // a round-tripped or manually-built blueprint whose items disagree gets
      // corrected to MIXED (or to the single item type). A slot whose stated
      // type already survives and whose items give no signal keeps its stated
      // type. deriveQuestionType ignores null/UNKNOWN item types.
      const declaredType = normalizeBlueprintType(q?.type);
      const itemTypeHint = deriveQuestionType(
        (Array.isArray(q?.items) ? q.items : []).map((it) => it?.type),
      );
      const bpType = itemTypeHint === 'MIXED'
        ? 'MIXED'
        : (declaredType && declaredType !== 'UNKNOWN'
            ? declaredType
            : (itemTypeHint || 'UNKNOWN'));
      // Per-slot difficulty — ADDITIVE contract field shared by both paths.
      // Mode B (manual builder) sets it per question; extracted (Mode A) slots
      // never set it, so the generator falls back to the paper-level value.
      // Anything outside the canonical trio is dropped, not guessed.
      const slotDifficulty = ['Easy', 'Medium', 'Difficult'].includes(q?.difficulty) ? q.difficulty : null;
      // itemsIndependent: honour an explicit boolean; otherwise derive from
      // type / construction. NEVER null — an absent flag silently disables
      // per-item assignment on the client.
      const itemsIndependent =
        typeof q?.itemsIndependent === 'boolean'
          ? q.itemsIndependent
          : !(
              bpType === 'PASSAGE' ||
              bpType === 'COMPREHENSION' ||
              bpType === 'CASE_BASED' ||
              (q?.pattern && q.pattern.instructionType === 'passage-comprehension') ||
              Boolean(q?.passage)
            );
      const itemsArr = Array.isArray(q?.items) ? q.items : [];
      const marksComplete =
        totalMarks != null &&
        (itemsArr.length > 0 ? itemsArr.every((it) => Number.isFinite(Number(it?.marks)) && Number(it.marks) > 0) : true);
      return {
        number: i + 1,
        label,
        type: bpType,
        difficulty: slotDifficulty,
        itemsIndependent,
        marksComplete,
        stem,
        instruction: String(q?.instruction ?? q?.stem ?? '').trim(),
        marks: {
          // NOTE: Number(null) === 0 — a null perItem (the extractor's honest
          // "non-uniform split, never derived" verdict) must stay null, never
          // collapse to 0 (which a consumer would read as a real zero-mark
          // item). Only a genuinely finite, non-null value passes through.
          perItem: (q?.marks?.perItem != null && Number.isFinite(Number(q.marks.perItem)))
            ? Number(q.marks.perItem)
            : marksPerItem,
          itemCount,
          total: totalMarks,
          expression: String(q?.marks?.expression ?? q?.markExpression ?? '').trim() || null,
        },
        itemCount,
        marksPerItem,
        totalMarks,
        markExpression: String(q?.markExpression ?? q?.marks?.expression ?? '').trim() || null,
        optionalRule: normalizeOptionalRule(q?.optionalRule),
        subQuestionCount: Number.isFinite(Number(q?.subQuestionCount)) ? Math.round(Number(q.subQuestionCount)) : 0,
        // ADDITIVE (Phase 1): deterministic cognitive-operation tag from the
        // reference instruction (recall/identify/explain/analyze/apply/create
        // — or null when extraction could not support one).
        cognitiveOperation: String(q?.cognitiveOperation ?? '').trim() || null,
        optionCount: Number.isFinite(Number(q?.optionCount)) ? Math.round(Number(q.optionCount)) : null,
        section: q?.section != null ? String(q.section) : null,
        sectionName: sectionNameByLabel.get(label) ?? null,
        // QUESTION PATTERN + TOPIC ANCHORS (deterministic, from the extractor):
        // construction tags + the reference item texts used to keep per-slot
        // generation on the same topic area. Never rendered to students.
        pattern: q?.pattern && typeof q?.pattern === 'object'
          ? {
              instructionType: String(q.pattern.instructionType ?? '').trim() || null,
              answerForm: String(q.pattern.answerForm ?? '').trim() || null,
              layout: String(q.pattern.layout ?? '').trim() || null,
              // POSITIONAL per-item option counts — zeros are KEPT so index i
              // always corresponds to reference item i, including MIXED slots
              // ("fill in the blanks and choose the correct answer": items
              // a/b are blanks [0], items c/d are MCQs [3, 3]).
              optionCounts: Array.isArray(q.pattern.optionCounts)
                ? q.pattern.optionCounts.map(Number).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 12)
                : [],
              maxOptionCount: Number.isFinite(Number(q.pattern.maxOptionCount)) && Number(q.pattern.maxOptionCount) > 0 ? Number(q.pattern.maxOptionCount) : null,
              optionLabelStyle: String(q.pattern.optionLabelStyle ?? '').trim() || null,
            }
          : {},
        referenceItems: Array.isArray(q.referenceItems)
          ? q.referenceItems.map((i) => String(i || '').trim()).filter(Boolean).slice(0, 12)
          : [],
        // CANONICAL PER-ITEM REFERENCE SPEC: one object per reference
        // sub-question ({ label, marks, referenceText, optionCount }). Marks
        // are structural — carried verbatim, never re-derived from the total.
        // Canonical per-item spec. Item labels are POSITIONAL (a, b, c…) and
        // ALWAYS present — both client and server must key items identically.
        // Every observed item is kept (no drop) so the item count is stable,
        // and per-item marks stay null where unrecoverable (never spread).
        items: Array.isArray(q.items)
          ? q.items
              .slice(0, 26)
              .map((it, idx) => {
                const mark = Number(it?.marks);
                const oc = Number(it?.optionCount);
                const rawLabel = String(it?.label ?? '').trim();
                // PER-ITEM TYPE is preserved verbatim (canonicalized), never
                // collapsed back into the parent type — it is authoritative for
                // a MIXED slot. Absent → null (a homogeneous slot's items do
                // not need an explicit type).
                const itType = it?.type != null && String(it.type).trim() !== ''
                  ? normalizeBlueprintType(it.type)
                  : null;
                const ocCanon = Number.isFinite(oc) && oc > 0 ? Math.round(oc) : null;
                const anchor = String(it?.topicAnchor ?? it?.referenceText ?? '').trim().slice(0, 220) || null;
                return {
                  label: /^[a-z]$/.test(rawLabel) ? rawLabel : String.fromCharCode(97 + idx),
                  sourceLabel: it?.sourceLabel != null ? String(it.sourceLabel).trim() || null : (rawLabel || null),
                  referenceText: String(it?.referenceText ?? '').trim().slice(0, 220) || null,
                  topicAnchor: anchor,
                  type: itType && itType !== 'UNKNOWN' ? itType : null,
                  answerForm: String(it?.answerForm ?? '').trim()
                    || (itType && itType !== 'UNKNOWN' ? answerFormForType(itType, ocCanon) : null),
                  construction: String(it?.construction ?? '').trim() || null,
                  marks: Number.isFinite(mark) && mark > 0 ? Math.round(mark * 10) / 10 : null,
                  optionCount: ocCanon,
                  // ADDITIVE (Phase 1): whether extraction actually recovered
                  // this item's content. Padded placeholder slots (declared
                  // > observed) carry recovered: false + referenceText null —
                  // structural slots, never fabricated content. Absent flag
                  // (e.g. Mode B manual items) defaults to true.
                  recovered: it?.recovered !== false,
                };
              })
          : [],
        itemMarks: Array.isArray(q.itemMarks)
          ? q.itemMarks.map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 12)
          : (Array.isArray(q.items)
              ? q.items.map((it) => Number(it?.marks)).filter((n) => Number.isFinite(n) && n > 0)
              : []),
        // Mode A image-based locking (PHASE 4) — additive passthrough only,
        // never fabricated. Without this an IMAGE_BASED slot's real image
        // bytes and lock metadata were silently dropped on every
        // generate/regenerate call (this function runs before the blueprint
        // ever reaches the question generator), degrading every "vision"
        // request to text-only with nothing to signal the loss.
        ...(Array.isArray(q?.imageAssets) && q.imageAssets.length > 0 ? { imageAssets: q.imageAssets, assetImages: q.imageAssets } : {}),
        ...(q?.imageLayout && typeof q.imageLayout === 'object' ? { imageLayout: q.imageLayout } : {}),
        ...(q?.isLocked === true ? { isLocked: true } : {}),
        ...(q?.detectedUnit != null ? { detectedUnit: q.detectedUnit } : {}),
        ...(q?.detectedUnitSource != null ? { detectedUnitSource: q.detectedUnitSource } : {}),
        ...(q?.detectedTopic != null ? { detectedTopic: q.detectedTopic } : {}),
        ...(q?.topicConfidence != null ? { topicConfidence: q.topicConfidence } : {}),
        ...(q?.reviewRequired === true ? { reviewRequired: true } : {}),
        ...(Array.isArray(q?.lockedFields) && q.lockedFields.length > 0 ? { lockedFields: q.lockedFields } : {}),
      };
    })
    .filter((q) => q.type !== 'UNKNOWN' || q.stem || q.totalMarks != null);

  if (questions.length === 0) return null;

  const allMarksKnown = questions.every((q) => q.totalMarks != null);
  const knownSum = questions.reduce((acc, q) => acc + (q.totalMarks ?? 0), 0);

  return {
    paper,
    studentInstructions: Array.isArray(raw.studentInstructions)
      ? raw.studentInstructions.map((i) => String(i || '').trim()).filter(Boolean).slice(0, 10)
      : [],
    sections,
    questions,
    totalQuestions: questions.length,
    totalMarks: allMarksKnown ? knownSum : null,
    marksComplete: allMarksKnown,
    blueprintWarnings: Array.isArray(raw.blueprintWarnings) ? raw.blueprintWarnings : [],
  };
}

/** Normalize the sections array (kept as a structural, display-only field). */
function normalizeSections(sections) {
  if (!Array.isArray(sections)) return [];
  return sections
    .map((s) => ({
      name: String(s?.name ?? '').trim() || null,
      title: String(s?.title ?? '').trim() || null,
      questionNumbers: Array.isArray(s?.questionNumbers) ? s.questionNumbers.map(String) : [],
    }))
    .filter((s) => s.name || s.title || s.questionNumbers.length > 0);
}

export default { parseMarksExpression, stripMarksExpression, parseOptionalRule, normalizeOptionalRule, normalizeBlueprint };