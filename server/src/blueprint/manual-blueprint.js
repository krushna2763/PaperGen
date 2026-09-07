/**
 * manual-blueprint.js — MODE B builder (the second source of a blueprint).
 *
 *   Mode A   reference PDF → blueprint-extractor  → blueprint ┐
 *   Mode B   teacher form  → buildManualBlueprint → blueprint ┴→ ONE pipeline
 *
 * Emits the EXACT schema blueprint-extractor produces (contract fields:
 * label, itemsIndependent boolean, items[].label lowercase a/b/c, items[].marks,
 * marksComplete) so normalizeBlueprint, checkBlueprintShape, the validator, the
 * retrieval agent and the generator consume it UNMODIFIED. The single additive
 * contract field is per-slot `difficulty` (schema change shared by both paths;
 * extracted slots simply never set it).
 *
 * Registry-driven: every type fact (itemsIndependent, option requirements,
 * marks mode, default instruction, canonical pipeline type) comes from
 * question-types/index.js — this file hardcodes none of it.
 *
 * Blocking validation (task §5): registry type, itemCount >= 1, option-bearing
 * optionCount >= 2, every item has marks, sections complete, referenced units
 * have notes (when a slotUnitMap is supplied). Every error names its slot.
 *
 * Non-blocking warnings ride `blueprintWarnings[]` — marks-sum vs declared
 * paper total, unmatched topic coverage, no-topic questions.
 */

import { getDefinition } from './question-types/index.js';
import { classifyInstruction, classifyAnswerForm } from './blueprint-extractor.js';
import { normalizeBlueprint, normalizeOptionalRule } from './blueprint-normalizer.js';

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** Canonical slot key — identical to slot-unit-map.slotKeyOf for slot i. */
function slotKey(i) {
  return `Q${i + 1}`;
}

/** Clamp/canonicalize difficulty; unknown values fall back to Medium. */
function normalizeDifficulty(value) {
  if (value == null) return null; // absent → paper-level fallback at generate time
  const v = String(value).trim().toLowerCase();
  if (v.startsWith('e')) return 'Easy';
  if (v.startsWith('d') || v.startsWith('h')) return 'Difficult';
  if (v.startsWith('m')) return 'Medium';
  return null;
}

/** Positive finite number or null (never NaN leaking into the blueprint). */
function positiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

/**
 * Extract per-item marks from the form's marks payload.
 * Mode "perItem": values[] — the teacher supplied real numbers; a missing or
 * non-positive entry is a BLOCKING error (never distribute the total evenly).
 * Mode "whole" (MATCH): one total for the question, no per-item structure.
 * @returns {Array<number|null>} per-item marks (null where missing → error)
 */
function perItemMarksOf(q, itemCount) {
  const values = Array.isArray(q?.marks?.values) ? q.marks.values : [];
  const out = [];
  for (let i = 0; i < itemCount; i++) out.push(positiveNumber(values[i]));
  return out;
}

/**
 * Build ONE canonical blueprint question from a form row + its registry def.
 * Returns { question, errors } — errors name this slot.
 */
function buildSlot(formQ, index) {
  const key = slotKey(index);
  const errors = [];
  const def = getDefinition(formQ?.type);
  if (!def) {
    const rawType = String(formQ?.type ?? '(none)');
    // Unknown registry id — nothing else can be checked meaningfully.
    return {
      question: null,
      errors: [{
        slot: key,
        message: `Slot "${key}" has unknown question type "${rawType}" — pick one of the registered types.`,
      }],
    };
  }

  const itemCountRaw = Number(formQ?.itemCount);
  if (!Number.isFinite(itemCountRaw) || Math.round(itemCountRaw) < def.countMin) {
    errors.push({
      slot: key,
      message: `Slot "${key}" (${def.label}) needs at least ${def.countMin} ${def.countLabel.toLowerCase()} but declared ${Number.isFinite(itemCountRaw) ? Math.round(itemCountRaw) : 'none'}.`,
    });
  }
  const itemCount = Number.isFinite(itemCountRaw) && itemCountRaw >= def.countMin
    ? Math.round(itemCountRaw)
    : Math.max(1, Math.round(itemCountRaw) || def.countMin);

  // Option constraints (registry-driven; TRUE_FALSE forbids, MCQ requires).
  let optionCount = positiveNumber(formQ?.optionCount);
  if (def.optionMode === 'required') {
    if (optionCount == null || optionCount < 2) {
      errors.push({
        slot: key,
        message: `Slot "${key}" (${def.label}) needs at least 2 options per item${optionCount != null ? ` but declared ${optionCount}` : ''}.`,
      });
    }
    optionCount = optionCount != null && optionCount >= 2 ? Math.round(optionCount) : null;
  } else if (def.optionMode === 'optional') {
    optionCount = optionCount != null && optionCount >= 2 ? Math.round(optionCount) : null;
  } else {
    optionCount = null; // optionMode 'none' — never carries options
  }

  // Marks (registry marksMode). Every item must have marks — blocking.
  let totalMarks = null;
  let marksPerItem = null;
  let items = [];
  let itemMarks = [];
  if (def.marksMode === 'whole') {
    totalMarks = positiveNumber(formQ?.marks?.total);
    if (totalMarks == null) {
      errors.push({ slot: key, message: `Slot "${key}" (${def.label}) is missing its total marks.` });
    }
  } else {
    const perItem = perItemMarksOf(formQ, itemCount);
    perItem.forEach((m, i) => {
      if (m == null) {
        errors.push({ slot: key, message: `Slot "${key}" item ${String.fromCharCode(97 + i)} has no marks — every item must carry its own marks (never auto-distributed).` });
      }
    });
    items = perItem.map((m, i) => ({
      label: String.fromCharCode(97 + i), // canonical lowercase a/b/c, positional
      sourceLabel: null,
      referenceText: null,
      marks: m,
      optionCount: def.optionMode !== 'none' && optionCount != null ? optionCount : null,
    }));
    itemMarks = perItem.filter((m) => m != null);
    const sum = itemMarks.reduce((a, b) => a + b, 0);
    totalMarks = itemMarks.length === itemCount && itemMarks.length > 0 ? Math.round(sum * 10) / 10 : null;
    // Uniform per-item marks keep a perItem value; non-uniform stay null
    // (the reference path does the same — never fake an average).
    marksPerItem = new Set(itemMarks).size === 1 && itemMarks.length === itemCount ? itemMarks[0] : null;
  }

  // Topic anchoring: the teacher's topic text lands in the SAME fields the
  // extractor fills — referenceItems (slot anchor) + items[].referenceText
  // (per-item anchor). Retrieval and the generator read exactly these.
  const topic = String(formQ?.topic ?? '').trim();
  const referenceItems = topic ? [topic.slice(0, 220)] : [];
  if (items.length > 0) {
    items = items.map((it) => ({ ...it, referenceText: topic ? topic.slice(0, 220) : null }));
  }

  // Optional rule ("any N") — optional on every manual type.
  const optionalRule = normalizeOptionalRule(formQ?.optionalRule ?? formQ?.optionalRuleN ?? null);

  const section = formQ?.section != null && String(formQ.section).trim() !== ''
    ? String(formQ.section).trim()
    : null;

  const instruction = String(formQ?.instruction ?? '').trim() || def.defaultInstruction;
  const stem = String(formQ?.stem ?? '').trim() || instruction;

  const question = {
    number: index + 1,
    label: key, // the slotUnitMap key — ALWAYS present
    type: def.blueprintType,
    difficulty: normalizeDifficulty(formQ?.difficulty), // additive contract field
    itemsIndependent: def.itemsIndependent, // boolean, never null
    marksComplete: totalMarks != null && (def.marksMode === 'whole' || items.every((it) => it.marks != null)),
    stem,
    instruction,
    referenceItems,
    pattern: {
      instructionType: classifyInstruction(instruction, def.blueprintType),
      answerForm: classifyAnswerForm(def.blueprintType),
      layout: items.length > 0 ? 'grouped-sub-items' : 'single-item',
      optionCounts: optionCount != null ? Array.from({ length: items.length || 1 }, () => optionCount) : [],
      maxOptionCount: optionCount,
      optionLabelStyle: null,
    },
    marks: {
      perItem: marksPerItem,
      itemCount,
      total: totalMarks,
      expression: null, // teacher-supplied, no extractor expression
    },
    itemCount,
    marksPerItem,
    totalMarks,
    markExpression: null,
    optionalRule,
    subQuestionCount: items.length,
    optionCount,
    section,
    sectionName: section, // manual sections are already canonical names
    items,
    itemMarks,
    // Builder provenance + registry hint (consumed by the prompt builder).
    source: 'manual',
    generatorHint: def.generatorHint ?? null,
    // Topic coverage result is attached by the endpoint (async), not here.
    topicMatch: null,
  };

  return { question, errors };
}

/**
 * Blocking validation over a BUILT blueprint (task §5 list) — SYNC part:
 * sections completeness. (The units check touches Qdrant and lives in the
 * separate async unitErrorsFor(), which the endpoint composes.)
 * @param {Object} blueprint
 * @param {Object} opts - { sections }
 * @returns {Array<{ slot: string|null, message: string }>}
 */
function blockingErrors(blueprint, opts = {}) {
  const errors = [];
  const questions = blueprint.questions || [];

  // Sections complete: when sections are declared, every question must be
  // inside one of them.
  const declared = (opts.sections || blueprint.sections || [])
    .map((s) => String(s?.name ?? s ?? '').trim())
    .filter(Boolean);
  if (declared.length > 0) {
    const declaredSet = new Set(declared);
    for (const q of questions) {
      if (!q.section || !declaredSet.has(q.section)) {
        errors.push({
          slot: q.label,
          message: `Slot "${q.label}" must belong to a declared section (${declared.join(', ')}) but carries ${q.section ?? 'none'}.`,
        });
      }
    }
  }

  return errors;
}

/**
 * Blocking UNITS check (async — Qdrant): every referenced unit must have notes
 * indexed for this class + subject. Runs only when a slotUnitMap accompanies
 * the manual blueprint; otherwise the existing ConfirmScreen + generate-time
 * validateSlotUnitMap enforce it exactly as in Mode A. One rule, one validator.
 * @param {Object} blueprint
 * @param {Object} ctx - { class, subject, slotUnitMap }
 * @returns {Promise<Array<{ slot: string|null, message: string }>>}
 */
export async function unitErrorsFor(blueprint, ctx = {}) {
  const errors = [];
  const slotUnitMap = ctx.slotUnitMap;
  if (!slotUnitMap || typeof slotUnitMap !== 'object') return errors;
  const { qdrantStore } = await import('../rag/qdrant.js');
  for (const q of blueprint.questions || []) {
    const entry = slotUnitMap[q.label];
    if (!entry) continue;
    const units = new Set();
    if (entry.unit != null && String(entry.unit).trim() !== '') units.add(String(entry.unit));
    if (entry.items && typeof entry.items === 'object') {
      for (const u of Object.values(entry.items)) {
        if (u != null && String(u).trim() !== '') units.add(String(u));
      }
    }
    await Promise.all([...units].map(async (unit) => {
      const has = await qdrantStore.unitHasNotes({ class: ctx.class, subject: ctx.subject, unit });
      if (!has) {
        errors.push({
          slot: q.label,
          message: `Slot "${q.label}" references unit "${unit}" which has no notes indexed for Class ${ctx.class} / ${ctx.subject}.`,
        });
      }
    }));
  }
  return errors;
}

/**
 * Non-blocking warnings (task §5): marks-sum mismatch, no-topic questions.
 * Topic-coverage warnings are appended by the endpoint after the async
 * coverage check (this function stays sync and cheap).
 */
function warningsFor(blueprint, formPaper) {
  const warnings = [];
  const declaredTotal = positiveNumber(formPaper?.maximumMarks);
  const sum = (blueprint.questions || [])
    .map((q) => q.totalMarks)
    .filter((m) => m != null)
    .reduce((a, b) => a + b, 0);
  if (declaredTotal != null && sum !== declaredTotal) {
    warnings.push({
      field: 'marksTotal',
      warning: `Questions sum to ${sum} marks but the declared paper total is ${declaredTotal}.`,
    });
  }
  for (const q of blueprint.questions) {
    if (!q.referenceItems || q.referenceItems.length === 0) {
      warnings.push({
        field: 'topic',
        label: q.label,
        warning: `Slot "${q.label}" has no topic — retrieval will draw from the whole assigned unit with a repetition risk.`,
      });
    }
  }
  return warnings;
}

/**
 * Build a canonical blueprint from the teacher's form payload.
 *
 * @param {Object} form - { paper?, sections?, questions: [...] }
 * @param {Object} [opts] - { validate, class, subject, slotUnitMap }
 *   validate:true also runs blocking checks (used by POST /papers/manual).
 * @returns {Promise<{ ok, blueprint, warnings, errors }>}
 *   ok:false → errors name their slots; blueprint is still returned for UI round-trip.
 */
export function buildManualBlueprint(form, opts = {}) {
  const rows = Array.isArray(form?.questions) ? form.questions : [];
  if (rows.length === 0) {
    throw httpError('The manual blueprint needs at least one question.', 400);
  }
  if (rows.length > 30) {
    throw httpError('A manual blueprint supports at most 30 questions.', 400);
  }

  const questions = [];
  const errors = [];
  rows.forEach((row, i) => {
    const { question, errors: slotErrors } = buildSlot(row, i);
    if (question) questions.push(question);
    errors.push(...slotErrors);
  });

  const sections = (Array.isArray(form?.sections) ? form.sections : [])
    .map((s) => ({
      name: String(s?.name ?? '').trim() || null,
      title: String(s?.title ?? '').trim() || null,
      questionNumbers: Array.isArray(s?.questionNumbers)
        ? s.questionNumbers.map(String)
        : questions.filter((q) => q.section === String(s?.name ?? '').trim()).map((q) => q.label),
    }))
    .filter((s) => s.name);

  const knownSum = questions.reduce((acc, q) => acc + (q.totalMarks ?? 0), 0);
  const allKnown = questions.length > 0 && questions.every((q) => q.totalMarks != null);

  const blueprint = {
    paper: {
      schoolName: form?.paper?.schoolName != null ? String(form.paper.schoolName) : null,
      examTitle: form?.paper?.examTitle != null ? String(form.paper.examTitle) : null,
      session: form?.paper?.session != null ? String(form.paper.session) : null,
      class: form?.paper?.class != null ? String(form.paper.class) : null,
      subject: form?.paper?.subject != null ? String(form.paper.subject) : null,
      duration: form?.paper?.duration != null ? String(form.paper.duration) : null,
      maximumMarks: positiveNumber(form?.paper?.maximumMarks),
    },
    studentInstructions: [],
    sections,
    questions,
    totalQuestions: questions.length,
    totalMarks: allKnown ? Math.round(knownSum * 10) / 10 : null,
    marksComplete: allKnown,
    blueprintWarnings: [],
  };

  const warnings = warningsFor(blueprint, form?.paper);

  // Prove the contract: the builder output must survive the UNMODIFIED
  // normalizer. (Round-trips through the same code path as Mode A.)
  if (errors.length === 0) {
    const normalized = normalizeBlueprint(blueprint);
    if (!normalized) {
      errors.push({ slot: null, message: 'The manual blueprint could not be normalized into the canonical contract.' });
    }
  }

  if (opts.validate) {
    errors.push(...blockingErrors(blueprint, { sections }));
  }

  blueprint.blueprintWarnings = warnings;

  return {
    ok: errors.length === 0,
    blueprint,
    warnings,
    errors,
  };
}

/**
 * Attach topic-coverage results to the built blueprint (async part of the
 * endpoint; kept out of the pure builder so tests can run without Qdrant).
 * Coverage is advisory — never a block.
 * @param {Object} blueprint
 * @param {Object} ctx - { class, subject }
 * @returns {Promise<Object>} warnings added for unmatched topics
 */
export async function attachTopicCoverage(blueprint, ctx) {
  const { checkTopicCoverage } = await import('../rag/topic-coverage.js');
  const added = [];
  for (const q of blueprint.questions) {
    const topic = q.referenceItems?.[0];
    if (!topic) continue; // no-topic slots already carry their warning
    try {
      const cov = await checkTopicCoverage({ topic, class: ctx.class, subject: ctx.subject, unit: null });
      q.topicMatch = cov; // { matched, chunkCount, topScore }
      if (!cov.matched) {
        added.push({
          field: 'topicCoverage',
          label: q.label,
          warning: `Topic "${topic}" matched nothing in the indexed notes for Class ${ctx.class} / ${ctx.subject} — generation may have nothing to ground in.`,
        });
      }
    } catch (err) {
      // Coverage is advisory: an infra failure must never block the teacher.
      console.warn('[Manual Blueprint] topic coverage check failed (non-fatal):', err.message);
    }
  }
  return added;
}

export default { buildManualBlueprint, unitErrorsFor, attachTopicCoverage };
