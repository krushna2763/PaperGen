/**
 * answer-validator.js
 *
 * DETERMINISTIC answer checks for a generated question, run BEFORE any LLM
 * validation and alongside the structural blueprint checks. A missing or
 * invalid answer is a structural failure: it fails the slot and routes it to
 * the existing targeted regeneration, exactly like a wrong item count.
 *
 * Checks (task §"VALIDATION"):
 *   - every item has a non-empty answer
 *   - an MCQ answer names an option that exists in that item
 *   - the correct option is not in the SAME position across every item of a
 *     question (a key that reads a, a, a, a is a real generation failure)
 *   - a MATCH answer pairs each left entry to exactly one right entry,
 *     bijectively
 *   - an item worth more than one mark carries a marking scheme whose points
 *     account for its marks
 *
 * Pure JavaScript, no LLM. Reasons are slot-labelled so one slot regenerates.
 */
import { answerShapeFor } from './question-types/index.js';
import { normalizeBlueprintType } from './blueprint-schema.js';

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Best-effort type of one generated item when unlabelled (mirrors the blueprint validator). */
function inferItemType(part) {
  if (!part || typeof part !== 'object') return null;
  const explicit = normalizeBlueprintType(part.type);
  if (explicit && explicit !== 'UNKNOWN') return explicit;
  if (Array.isArray(part.options) && part.options.length >= 2) return 'MCQ';
  if (/_{2,}/.test(String(part.text || ''))) return 'FILL_IN_THE_BLANK';
  if (/^(true|false)$/i.test(String(part.answer || '').trim())) return 'TRUE_FALSE';
  return 'SHORT_ANSWER';
}

/** Marks that actually apply to sub-part i (blueprint items are authoritative). */
function itemMarks(expected, g, i) {
  const fromSpec = Number(expected?.items?.[i]?.marks);
  if (Number.isFinite(fromSpec) && fromSpec > 0) return fromSpec;
  const fromGen = Number(g?.subParts?.[i]?.marks);
  if (Number.isFinite(fromGen) && fromGen > 0) return fromGen;
  return null;
}

/**
 * A marking scheme is required and must roughly account for `marks`.
 *
 * LAYER 2 STRUCTURAL REPAIR (additive) — `missingFields`, when supplied, is
 * pushed a PURE-OMISSION entry (`{ field: 'markingScheme', itemIndex, marks }`)
 * ONLY for the "rows.length < 2" case (the field is absent or empty) — never
 * for a sum-mismatch (that is an ARITHMETIC defect on an already-present
 * scheme, already deterministically repaired at normalization time by
 * question-generator.agent.js's repairMarkingScheme(), and is never something
 * a missing-field patch call should touch). This never changes `reasons` or
 * `ok` — purely additional classification for a caller that wants to attempt
 * a narrow, bounded repair instead of a full rejection.
 */
function checkMarkingScheme(scheme, marks, label, where, reasons, missingFields, itemIndex) {
  if (!(Number.isFinite(marks) && marks > 1)) return; // 1-mark items need no breakdown
  const rows = Array.isArray(scheme) ? scheme.filter((s) => String(s?.point ?? '').trim()) : [];
  if (rows.length < 2) {
    reasons.push(`${label} ${where} is worth ${marks} marks and needs a marking scheme (the points the marks break down across).`);
    if (Array.isArray(missingFields)) missingFields.push({ field: 'markingScheme', itemIndex, marks });
    return;
  }
  const nums = rows.map((s) => Number(s?.marks)).filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === rows.length) {
    const sum = nums.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - marks) > 0.5) {
      reasons.push(`${label} ${where} marking scheme points sum to ${Math.round(sum * 10) / 10}, not ${marks}.`);
    }
  }
}

/**
 * @param {Object} g - generated question (type, marks, subParts?, options?, columns?, answer?, answerPairs?, markingScheme?)
 * @param {Object} expected - blueprint slot (type, itemCount, totalMarks, items?)
 * @returns {{ ok: boolean, reasons: string[], missingFields: Array<{field:string, itemIndex:number|null, marks:number|null}> }}
 *   `missingFields` (additive, never affects `ok`/`reasons`) names PURE
 *   required-field omissions a caller may attempt a bounded, narrow repair
 *   for (LAYER 2) — see checkMarkingScheme's docstring. Empty whenever every
 *   failure is a real content/shape problem, never a bare omission.
 */
export function checkAnswers(g = {}, expected = {}) {
  const reasons = [];
  const missingFields = [];
  const label = expected?.label || g?.questionId || 'This question';
  const parentType = normalizeBlueprintType(expected?.type || g?.type);
  const shape = answerShapeFor(expected?.type || g?.type);
  const parts = Array.isArray(g?.subParts) ? g.subParts : [];
  // MIXED slot: each item's ANSWER FORM is resolved from its OWN type
  // (blueprint items[].type is authoritative; the generated part's own type or
  // an inference is the fallback), never from the parent slot type.
  const isMixed = parentType === 'MIXED';
  const refItems = Array.isArray(expected?.items) ? expected.items : [];
  const shapeAt = (i) => {
    if (!isMixed) return shape;
    const t = normalizeBlueprintType(refItems[i]?.type) !== 'UNKNOWN'
      ? normalizeBlueprintType(refItems[i]?.type)
      : inferItemType(parts[i]);
    return answerShapeFor(t) || 'text';
  };

  // ── MATCH: whole-question bijective pairing ────────────────────────────────
  if (shape === 'pairs') {
    const left = Array.isArray(g?.columns?.left) ? g.columns.left.map(norm) : [];
    const right = Array.isArray(g?.columns?.right) ? g.columns.right.map(norm) : [];
    const pairs = Array.isArray(g?.answerPairs) ? g.answerPairs : [];
    if (pairs.length === 0) {
      reasons.push(`${label} (match) has no answer key — expected one left↔right pair per row.`);
      return { ok: false, reasons, missingFields };
    }
    if (left.length > 0 && pairs.length !== left.length) {
      reasons.push(`${label} (match) answer has ${pairs.length} pair(s) but the question has ${left.length} row(s).`);
    }
    const seenL = new Map();
    const seenR = new Map();
    for (const p of pairs) {
      const l = norm(p?.left);
      const r = norm(p?.right);
      if (!l || !r) { reasons.push(`${label} (match) has an incomplete answer pair.`); continue; }
      if (left.length > 0 && !left.includes(l)) reasons.push(`${label} (match) answer pairs a left entry ("${p.left}") that is not in the left column.`);
      if (right.length > 0 && !right.includes(r)) reasons.push(`${label} (match) answer pairs a right entry ("${p.right}") that is not in the right column.`);
      seenL.set(l, (seenL.get(l) ?? 0) + 1);
      seenR.set(r, (seenR.get(r) ?? 0) + 1);
    }
    for (const [k, n] of seenL) if (n > 1) reasons.push(`${label} (match) left entry "${k}" is answered ${n} times — pairing must be one-to-one.`);
    for (const [k, n] of seenR) if (n > 1) reasons.push(`${label} (match) right entry "${k}" is used ${n} times — each right entry maps to exactly one left entry.`);
    // The pairs ARE the marks breakdown for a match question — no separate scheme.
    return { ok: reasons.length === 0, reasons, missingFields };
  }

  // ── Multi-item questions: one answer per sub-part ──────────────────────────
  if (parts.length > 0) {
    const optionIndexPerItem = [];
    parts.forEach((sp, i) => {
      const letter = String(sp?.label || String.fromCharCode(97 + i));
      const answer = String(sp?.answer ?? '').trim();
      const itemShape = shapeAt(i);
      if (!answer) {
        reasons.push(`${label}(${letter}) has no answer.`);
      } else if (itemShape === 'option') {
        const opts = Array.isArray(sp?.options) ? sp.options.map(norm) : [];
        const idx = opts.indexOf(norm(answer));
        if (opts.length === 0 && /_{2,}/.test(String(sp?.text || ''))) {
          // MIXED slot: a blank item in an option-typed slot is a word/phrase
          // fill item — its answer is the missing word, not one of options.
        } else if (opts.length === 0) {
          reasons.push(`${label}(${letter}) is multiple-choice but the item carries no options to be the answer.`);
        } else if (idx === -1) {
          reasons.push(`${label}(${letter}) answer "${answer}" is not one of that item's options.`);
        } else {
          optionIndexPerItem.push(idx);
        }
      } else if (itemShape === 'boolean' && !/^(true|false|t|f)$/i.test(answer)) {
        reasons.push(`${label}(${letter}) answer must be "True" or "False".`);
      }
      // A marking scheme is only meaningful for an extended written answer;
      // option / word / boolean items are single-mark and self-scoring.
      if (itemShape === 'text') checkMarkingScheme(sp?.markingScheme, itemMarks(expected, g, i), label, `(${letter})`, reasons, missingFields, i);
    });

    // Correct option must not sit in the same position for every item.
    if (!isMixed && shape === 'option' && optionIndexPerItem.length >= 3) {
      const distinct = new Set(optionIndexPerItem);
      if (distinct.size === 1) {
        reasons.push(`${label} — the correct option is in the same position for all ${optionIndexPerItem.length} items; vary the answer positions.`);
      }
    }
    // MCQ option quality: uniqueness, empty, label-only (per-item shape).
    {
      parts.forEach((sp, i) => {
        if (shapeAt(i) !== 'option') return;
        const letter = String(sp?.label || String.fromCharCode(97 + i));
        const opts = Array.isArray(sp?.options) ? sp.options : [];
        const rawOpts = opts.map((o) => String(o ?? '').trim());
        for (let j = 0; j < rawOpts.length; j++) {
          if (!rawOpts[j]) {
            reasons.push(`${label}(${letter}) has an empty option.`);
          } else if (/^[A-Z]$/.test(rawOpts[j])) {
            reasons.push(`${label}(${letter}) option "${rawOpts[j]}" is a bare label, not real content.`);
          }
        }
        const seen = new Map();
        rawOpts.forEach((o) => {
          const key = o.toLowerCase().replace(/\s+/g, ' ');
          if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
        });
        for (const [k, n] of seen) {
          if (n > 1) reasons.push(`${label}(${letter}) has duplicate option "${k}" (${n} times).`);
        }
      });
    }
    return { ok: reasons.length === 0, reasons, missingFields };
  }

  // ── Single-stem question ──────────────────────────────────────────────────
  const answer = String(g?.answer ?? '').trim();
  if (!answer) {
    reasons.push(`${label} has no answer.`);
  } else if (shape === 'option') {
    const opts = Array.isArray(g?.options) ? g.options.map(norm) : [];
    if (opts.length === 0) reasons.push(`${label} is multiple-choice but carries no options.`);
    else if (!opts.includes(norm(answer))) reasons.push(`${label} answer "${answer}" is not one of its options.`);
    // MCQ option quality: uniqueness, empty, label-only
    const rawOpts = (Array.isArray(g?.options) ? g.options : []).map((o) => String(o ?? '').trim());
    for (let j = 0; j < rawOpts.length; j++) {
      if (!rawOpts[j]) {
        reasons.push(`${label} has an empty option.`);
      } else if (/^[A-Z]$/.test(rawOpts[j])) {
        reasons.push(`${label} option "${rawOpts[j]}" is a bare label, not real content.`);
      }
    }
    const seen = new Map();
    rawOpts.forEach((o) => {
      const key = o.toLowerCase().replace(/\s+/g, ' ');
      if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
    });
    for (const [k, n] of seen) {
      if (n > 1) reasons.push(`${label} has duplicate option "${k}" (${n} times).`);
    }
  } else if (shape === 'boolean' && !/^(true|false|t|f)$/i.test(answer)) {
    reasons.push(`${label} answer must be "True" or "False".`);
  }
  if (shape === 'text') checkMarkingScheme(g?.markingScheme, Number(expected?.totalMarks ?? g?.marks), label, 'answer', reasons, missingFields, null);

  return { ok: reasons.length === 0, reasons, missingFields };
}

export default { checkAnswers };
