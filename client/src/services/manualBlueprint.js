/**
 * manualBlueprint.js — Mode B client model (PURE, unit-testable).
 *
 * The client builder holds RICH form state; `buildFormPayload` converts it to
 * the exact form payload the server's manual-blueprint builder consumes. The
 * server is the contract authority (it round-trips everything through the
 * unmodified normalizer); this module exists so the payload arrives right the
 * first time and so the client can compute preview totals.
 *
 * Form state shape (per question row):
 *   { type, instruction, topic, difficulty, itemCount, optionCount,
 *     marksMode: 'perItem' | 'whole', uniformMarks, itemMarks: number[],
 *     wholeMarks, section }
 */

export const DIFFICULTY_OPTIONS = ['Easy', 'Medium', 'Difficult'];

/** Create an empty question row with sane defaults. */
export function emptyQuestion(section = null) {
  return {
    type: '',
    instruction: '',
    topic: '',
    difficulty: 'Medium',
    itemCount: 4,
    optionCount: 4,
    marksMode: 'perItem',
    uniformMarks: 1,
    itemMarks: [1, 1, 1, 1],
    wholeMarks: 5,
    section,
  };
}

/** Sync per-item marks array when the item count changes (never lose data). */
export function resizeItemMarks(itemMarks, count, fallback = 1) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = Number(itemMarks?.[i]);
    out.push(Number.isFinite(v) && v > 0 ? v : (Number(fallback) > 0 ? Number(fallback) : 1));
  }
  return out;
}

/** Sum of a question's marks per its mode (preview only; server validates). */
export function questionTotal(q) {
  if (q.marksMode === 'whole') return Number(q.wholeMarks) || 0;
  return resizeItemMarks(q.itemMarks, q.itemCount, q.uniformMarks).reduce((a, b) => a + b, 0);
}

/** Paper total across all rows (preview only). */
export function paperTotal(questions) {
  return (questions || []).reduce((acc, q) => acc + questionTotal(q), 0);
}

/** Client-side completeness check mirroring the server's blocking rules. */
export function rowIssues(q, countMin = 1) {
  const issues = [];
  if (!q.type) issues.push('Pick a question type.');
  if (!Number.isFinite(Number(q.itemCount)) || Math.round(Number(q.itemCount)) < countMin) {
    issues.push(`Needs at least ${countMin} item(s).`);
  }
  if (q.optionCount != null && q.optionCount !== '' && Number(q.optionCount) < 2 && q.optionMode !== 'none') {
    issues.push('Options must be at least 2.');
  }
  if (q.marksMode === 'perItem') {
    const marks = resizeItemMarks(q.itemMarks, q.itemCount, q.uniformMarks);
    if (marks.some((m) => !(Number(m) > 0))) issues.push('Every item needs marks.');
  } else if (!(Number(q.wholeMarks) > 0)) {
    issues.push('Set the question total marks.');
  }
  return issues;
}

/**
 * Convert form rows → server form payload.
 * @param {Object} args - { paper, sections, questions }
 * @returns {Object} payload for POST /papers/manual { blueprint: ... }
 */
export function buildFormPayload({ paper, sections = [], questions = [] }) {
  return {
    paper,
    sections,
    questions: (questions || []).map((q) => ({
      type: q.type,
      instruction: q.instruction || undefined,
      topic: q.topic || '',
      difficulty: q.difficulty || undefined,
      section: q.section ?? null,
      itemCount: Math.max(1, Math.round(Number(q.itemCount) || 1)),
      optionCount: q.optionCount != null && q.optionCount !== '' ? Number(q.optionCount) : undefined,
      marks:
        q.marksMode === 'whole'
          ? { mode: 'whole', total: Number(q.wholeMarks) || 0 }
          : { mode: 'perItem', values: resizeItemMarks(q.itemMarks, q.itemCount, q.uniformMarks) },
    })),
  };
}

/**
 * Pre-seed per-question unit assignments from a loaded blueprint: whole-question
 * unit for MATCH-shaped slots (items: []), per-item nulls otherwise.
 * @param {Object} blueprint
 * @returns {Object} { label: { unit } | { items: { label: null } } }
 */
export function seedAssignments(blueprint) {
  const out = {};
  for (const q of blueprint?.questions || []) {
    if ((q.items || []).length > 0) {
      out[q.label] = { items: Object.fromEntries(q.items.map((it) => [it.label, null])) };
    } else {
      out[q.label] = { unit: null };
    }
  }
  return out;
}

/**
 * Convert a saved TEMPLATE blueprint (structure only) back into builder form
 * rows — per-item marks restored, units/topics untouched (templates carry none).
 * @param {Object} tplBlueprint
 * @returns {Array<Object>} question rows
 */
export function rowsFromTemplate(tplBlueprint) {
  const questions = tplBlueprint?.questions || [];
  return questions.map((q) => {
    const marksArePerItem = Array.isArray(q.items) && q.items.length > 0 && q.items.some((it) => it.marks != null);
    const values = marksArePerItem ? q.items.map((it) => it.marks ?? 1) : [];
    return {
      ...emptyQuestion(q.section ?? null),
      type: q.type || '',
      instruction: q.instruction || '',
      topic: '', // templates never carry topics
      itemCount: q.itemCount ?? 1,
      optionCount: q.optionCount ?? null,
      marksMode: marksArePerItem ? 'perItem' : 'whole',
      uniformMarks: values.length > 0 && new Set(values).size === 1 ? values[0] : 1,
      itemMarks: values,
      wholeMarks: q.marks?.total ?? 1,
      section: q.section ?? null,
    };
  });
}
