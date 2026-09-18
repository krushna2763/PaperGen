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
    selectedImage: null,
    imageAssets: null,
    answerType: 'SHORT_ANSWER',
    imageTopic: '',
    teacherHint: '',
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
  if (q.type === 'IMAGE_BASED' && !q.selectedImage && (!q.imageAssets || q.imageAssets.length === 0)) {
    issues.push('Select an image from the available images.');
  }
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
      ...(q.selectedImage ? { selectedImage: q.selectedImage } : {}),
      ...(Array.isArray(q.imageAssets) && q.imageAssets.length > 0 ? { imageAssets: q.imageAssets } : (q.selectedImage ? { imageAssets: [q.selectedImage] } : {})),
      ...(q.answerType ? { answerType: q.answerType } : {}),
      ...(q.imageTopic ? { imageTopic: q.imageTopic } : {}),
      ...(q.teacherHint ? { teacherHint: q.teacherHint } : {}),
      ...(q.unit ? { unit: q.unit } : {}),
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

/**
 * PHASE 3 — Restore builder form rows from a LIVE blueprint (builder re-entry
 * after generation). Unlike rowsFromTemplate (templates carry no topics), the
 * live blueprint DOES carry topic anchors — they land in `referenceItems[0]`,
 * the same field both the manual builder and the extractor write.
 *
 * Type resolution: the blueprint stores the CANONICAL pipeline type (e.g.
 * FILL_IN_THE_BLANK), while the builder rows key on the REGISTRY id (e.g.
 * FILL_BLANK). `typeIdFor` maps canonical → registry id using the same
 * definitions the builder renders; unknown canonical types fall back to the
 * canonical id itself (the server registry round-trips them).
 *
 * Per-item hints: the builder folds item hints into `instruction`
 * ("Each item should cover — a) …; b) …") because the blueprint contract has
 * no per-item hint field. Restoration parses that suffix back out — round-
 * tripping the builder's OWN convention, not inventing a second schema.
 *
 * @param {Object} blueprint - the current (possibly edited) blueprint
 * @param {Array<Object>} types - registry definitions (server list or FALLBACK_TYPES)
 * @returns {Array<Object>} builder rows
 */
export function rowsFromBlueprint(blueprint, types = []) {
  const questions = Array.isArray(blueprint?.questions) ? blueprint.questions : [];
  return questions.map((q) => {
    const items = Array.isArray(q.items) ? q.items : [];
    const marksArePerItem = items.length > 0 && items.some((it) => it.marks != null);
    const values = marksArePerItem ? items.map((it) => it.marks ?? 1) : [];
    const uniform = values.length > 0 && new Set(values).size === 1 ? values[0] : 1;
    const def = (types || []).find((t) => t.blueprintType === q.type);
    const { instruction, itemHints } = splitHints(q.instruction);
    return {
      ...emptyQuestion(q.section ?? null),
      type: def?.id || q.type || '',
      instruction,
      topic: (q.referenceItems && q.referenceItems[0]) || '',
      difficulty: q.difficulty || 'Medium',
      itemCount: q.itemCount ?? items.length ?? 1,
      optionCount: q.optionCount ?? null,
      marksMode: marksArePerItem ? 'perItem' : 'whole',
      uniformMarks: uniform,
      itemMarks: values,
      wholeMarks: q.totalMarks ?? q.marks?.total ?? 1,
      section: q.section ?? null,
      itemHints,
      selectedImage: q.imageAssets?.[0] || q.selectedImage || null,
      imageAssets: q.imageAssets || null,
      answerType: q.answerType || 'SHORT_ANSWER',
      imageTopic: q.imageTopic || '',
      teacherHint: q.teacherHint || '',
    };
  });
}

/**
 * Inverse of QuestionBuilder.withHints: split a folded instruction back into
 * the bare instruction + per-item hints. Exact prefix match on the joiner the
 * builder writes; no match → the instruction is returned whole.
 * @param {string} instruction
 * @returns {{ instruction: string, itemHints: string[] }}
 */
export function splitHints(instruction) {
  const raw = String(instruction ?? '');
  const marker = 'Each item should cover — ';
  const at = raw.indexOf(marker);
  if (at === -1) return { instruction: raw, itemHints: [] };
  const bare = raw.slice(0, at).trim();
  const body = raw.slice(at + marker.length);
  const hints = body
    .split(/;\s*/)
    .map((part) => {
      const m = part.match(/^\s*([a-z])\)\s*/);
      return m ? part.slice(m[0].length) : part.trim();
    })
    .map((h) => h.trim())
    .filter(Boolean);
  return { instruction: bare, itemHints: hints };
}
