/**
 * Pure helpers for the confirm screen (blueprint review + per-question unit
 * assignment). No React. Every function takes the blueprint, the local
 * `assign` map and the unit list explicitly, so the assignment / totals maths
 * is unit-testable and reused verbatim by the generate request.
 *
 * Contract (guaranteed by POST /api/papers/analyze — never synthesised here):
 *   question.label            non-empty string; the slotUnitMap key
 *   question.itemsIndependent boolean, never null
 *   question.items[].label    non-null, lowercase a/b/c, the canonical item key
 *   question.items[].marks    real number or null (null = genuinely unknown)
 *   question.marksComplete    boolean
 *   question.items[].sourceLabel  display-only (raw printed token); NEVER a key
 *
 * Local shapes:
 *   unit        : { id, label, chunkCount }
 *   assign[key] : { unit: unitId|null, items: { [itemLabel]: unitId|null } }
 *                 `items` stays {} until the row is expanded or an item edited.
 *   slotUnitMap : { [label]: { unit } | { items: { a, b, ... } } }
 */

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/** The slotUnitMap key. `label` is guaranteed; the fallbacks are belt-and-braces. */
export function slotKey(q, index) {
  if (q && q.label) return String(q.label);
  if (q && q.number != null) return `Q${q.number}`;
  return `Q${index + 1}`;
}

/**
 * Is this rendered question's slot in the stale set? The stale set is keyed by
 * `slotKey`, so the lookup must key the same way — both a blueprint slot and a
 * `buildPaperModel` question resolve through `slotKey`, which is why the model
 * question has to carry its slot `label`.
 */
export function slotIsStale(staled, q) {
  return Array.isArray(staled) && staled.includes(slotKey(q));
}

/** "any three" for an ANY_N optional-answer question, else null. */
export function anyText(q) {
  const n = q && q.optionalRule && q.optionalRule.n;
  if (!n) return null;
  return `any ${NUMBER_WORDS[n] || n}`;
}

/**
 * ANY_N questions: the teacher assigns every offered item but the student
 * answers only n, so the per-unit split is a range, not a value. Totals that
 * include such a question are flagged approximate.
 */
export function isApproximate(q) {
  const r = q && q.optionalRule;
  return !!(r && (r.n || r.kind === 'ANY_N'));
}

/** "9 marks" / "1 mark" / "" when unknown. */
export function marksText(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${round1(n)} mark${n === 1 ? '' : 's'}`;
}

/** Canonical item labels for a question, straight from the blueprint. */
export function itemLabels(q) {
  const items = Array.isArray(q && q.items) ? q.items : [];
  return items.map((it, i) => String((it && it.label) || String.fromCharCode(97 + i)));
}

/**
 * Per-item marks as [{ label, marks }], marks kept EXACTLY as analyze gave
 * them — `null` where the reference did not record a per-item value. Never
 * distributed, never scaled: per-item marks genuinely vary (1,2,2,2,3) and a
 * guess would make the running totals confidently wrong.
 *
 * A single-item / single-stem question returns one row carrying the question
 * total (or null when that is unknown too).
 */
export function itemMarksOf(q) {
  const items = Array.isArray(q && q.items) ? q.items : [];
  if (items.length > 1) {
    return items.map((it, i) => ({
      label: String((it && it.label) || String.fromCharCode(97 + i)),
      marks: Number.isFinite(Number(it && it.marks)) && Number(it.marks) > 0 ? round1(Number(it.marks)) : null,
    }));
  }
  const total = Number(q && q.totalMarks);
  return [{ label: (items[0] && items[0].label) || 'a', marks: Number.isFinite(total) && total > 0 ? round1(total) : null }];
}

/**
 * A row can be expanded to per-item units only when it has more than one item
 * AND the blueprint says the items are independent. `itemsIndependent === false`
 * means a shared stimulus (passage, case study) — splitting it would ground
 * subquestions in unrelated notes.
 */
export function isExpandable(q) {
  return itemLabels(q).length > 1 && q.itemsIndependent !== false;
}

/** Hover text for a multi-item row that cannot be expanded. */
export function lockReason(q) {
  const kind = String((q && q.type) || '').toLowerCase().replace(/_/g, ' ').trim() || 'shared';
  return `Items share a ${kind} stimulus — splitting them across units would draw subquestions from unrelated notes.`;
}

/** Two or more distinct units across a row's items. */
export function isMixed(q, a) {
  if (!a || !a.items) return false;
  const vals = itemLabels(q).map((l) => a.items[l]);
  if (!vals.some((v) => v != null)) return false;
  return new Set(vals).size > 1;
}

/** The single unit a non-mixed row resolves to (null when unset). */
export function sharedUnit(q, a) {
  if (!a) return null;
  const labels = itemLabels(q);
  const vals = labels.map((l) => a.items && a.items[l]).filter((v) => v != null);
  if (labels.length > 0 && vals.length === labels.length && new Set(vals).size === 1) return vals[0];
  return a.unit ?? null;
}

/** Unassigned = some item (or the whole question) still has no unit. */
export function isUnassigned(q, a) {
  if (!a) return true;
  const hasItems = a.items && Object.keys(a.items).length > 0;
  if (hasItems) return itemLabels(q).some((l) => a.items[l] == null);
  return a.unit == null;
}

/** Labels of every still-unassigned question, e.g. ["Q3", "Q7"]. */
export function unassignedList(blueprint, assign) {
  return ((blueprint && blueprint.questions) || [])
    .map((q, i) => ({ q, key: slotKey(q, i) }))
    .filter(({ q, key }) => isUnassigned(q, assign[key]))
    .map(({ key }) => key);
}

/**
 * Default assignment: spread questions round-robin across availableUnits so the
 * teacher edits a filled form. When there are no units every question is left
 * unassigned (generate stays disabled and the screen points at notes upload).
 */
export function defaultAssign(blueprint, units) {
  const pool = Array.isArray(units) ? units : [];
  const out = {};
  ((blueprint && blueprint.questions) || []).forEach((q, i) => {
    out[slotKey(q, i)] = { unit: pool.length ? pool[i % pool.length].id : null, items: {} };
  });
  return out;
}

/**
 * Build the request-body `slotUnitMap` from local state, keyed by question
 * label. A row whose items all resolve to one unit sends `{ unit }` even if it
 * was expanded; only a genuinely mixed row sends `{ items }`.
 */
export function buildSlotUnitMap(blueprint, assign) {
  const map = {};
  ((blueprint && blueprint.questions) || []).forEach((q, i) => {
    const key = slotKey(q, i);
    const a = assign[key];
    if (!a) return;
    if (isMixed(q, a)) {
      const items = {};
      for (const l of itemLabels(q)) items[l] = a.items[l] ?? null;
      map[key] = { items };
    } else {
      map[key] = { unit: sharedUnit(q, a) };
    }
  });
  return map;
}

/**
 * Marks per unit, live, from per-item marks and the current assignment.
 *
 *   - items with `marks == null` are excluded from every bucket and counted in
 *     `unknownItems` (rendered "marks n/a", never guessed)
 *   - items with a known mark and no resolved unit go to `unassigned`
 *   - `approximate` is true when any assigned question is ANY_N: the student
 *     answers only n items, so those contributions are a range
 *
 * @returns {{ totals: Record<unitId, number>, unassigned: number,
 *             unknownItems: number, approximate: boolean }}
 */
export function runningTotals(blueprint, assign, units) {
  const totals = {};
  for (const u of units || []) totals[u.id] = 0;
  let unassigned = 0;
  let unknownItems = 0;
  let approximate = false;

  ((blueprint && blueprint.questions) || []).forEach((q, i) => {
    const a = assign[slotKey(q, i)];
    const hasItems = a && a.items && Object.keys(a.items).length > 0;
    let contributed = false;
    for (const it of itemMarksOf(q)) {
      const unit = !a ? null : hasItems ? a.items[it.label] ?? null : a.unit;
      if (it.marks == null) {
        unknownItems += 1;
        continue;
      }
      if (unit == null || !(unit in totals)) {
        unassigned += it.marks;
      } else {
        totals[unit] += it.marks;
        contributed = true;
      }
    }
    if (contributed && isApproximate(q)) approximate = true;
  });

  for (const k of Object.keys(totals)) totals[k] = round1(totals[k]);
  return { totals, unassigned: round1(unassigned), unknownItems, approximate };
}
