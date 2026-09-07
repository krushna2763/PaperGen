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

import { normalizeBlueprintType, NUMBER_WORDS } from './blueprint-schema.js';

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
      const marksPerItem = Number.isFinite(Number(q?.marksPerItem)) && Number(q.marksPerItem) > 0
        ? Number(q.marksPerItem)
        : totalMarks != null ? totalMarks / itemCount : null;
      const stem = String(q?.stem ?? '').trim();
      const label = String(q?.label ?? `Q${i + 1}`).trim() || `Q${i + 1}`;
      const bpType = normalizeBlueprintType(q?.type);
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
          perItem: Number.isFinite(Number(q?.marks?.perItem)) ? Number(q.marks.perItem) : marksPerItem,
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
              optionCounts: Array.isArray(q.pattern.optionCounts)
                ? q.pattern.optionCounts.map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 12)
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
                return {
                  label: /^[a-z]$/.test(rawLabel) ? rawLabel : String.fromCharCode(97 + idx),
                  sourceLabel: it?.sourceLabel != null ? String(it.sourceLabel).trim() || null : (rawLabel || null),
                  referenceText: String(it?.referenceText ?? '').trim().slice(0, 220) || null,
                  marks: Number.isFinite(mark) && mark > 0 ? Math.round(mark * 10) / 10 : null,
                  optionCount: Number.isFinite(oc) && oc > 0 ? Math.round(oc) : null,
                };
              })
          : [],
        itemMarks: Array.isArray(q.itemMarks)
          ? q.itemMarks.map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 12)
          : (Array.isArray(q.items)
              ? q.items.map((it) => Number(it?.marks)).filter((n) => Number.isFinite(n) && n > 0)
              : []),
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