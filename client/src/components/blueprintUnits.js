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
 * Per-item marks as [{ label, marks }].
 *
 * An explicit per-item value on the item wins. Otherwise, when the reference
 * stated a UNIFORM split (an "NxM=T" expression the extractor parsed into
 * `marks.perItem` / `marksPerItem`, and `perItem × itemCount === total`), each
 * item carries that value — this is the reference's own arithmetic, not a
 * guess. Marks stay `null` only when the split genuinely varies or was never
 * recorded; they are never derived by bare division of the total.
 *
 * A single-item / single-stem question returns one row carrying the question
 * total (or null when that is unknown too).
 */
export function itemMarksOf(q) {
  const items = Array.isArray(q && q.items) ? q.items : [];
  if (items.length > 1) {
    const total = Number(q && (q.totalMarks ?? (q.marks && q.marks.total)));
    const perItem = Number(q && (q.marksPerItem ?? (q.marks && q.marks.perItem)));
    const uniform =
      Number.isFinite(perItem) && perItem > 0 &&
      Number.isFinite(total) && Math.abs(perItem * items.length - total) < 1e-6;
    return items.map((it, i) => {
      const own = Number(it && it.marks);
      const marks = Number.isFinite(own) && own > 0 ? own : (uniform ? perItem : null);
      return {
        label: String((it && it.label) || String.fromCharCode(97 + i)),
        marks: marks == null ? null : round1(marks),
      };
    });
  }
  const total = Number(q && q.totalMarks);
  return [{ label: (items[0] && items[0].label) || 'a', marks: Number.isFinite(total) && total > 0 ? round1(total) : null }];
}

/**
 * One-line marks summary for a blueprint row, straight from the CANONICAL
 * fields — never re-parsed from the printed expression, never inferred,
 * never divided out, never fabricated.
 *
 * The blueprint's `itemCount` / `marksPerItem` / `totalMarks` are the
 * extractor's orientation-VERIFIED values ("1x3=3" and "3X1=3" both already
 * canonicalized to 3 items × 1 mark by the orientation verdict) — re-parsing
 * the verbatim expression here would re-introduce the very orientation
 * ambiguity the extractor settled, so the display reads the canonical result.
 *
 *   1. a multi-item split (itemCount > 1, perItem known, consistent with the
 *      total) → "N items × M mark each" — the reference's own arithmetic;
 *   2. otherwise the parent total → "T marks" (a single-item slot needs no
 *      split line);
 *   3. nothing recoverable → '' — the caller shows the honest
 *      "Marks not detected from reference" warning. A question with
 *      subquestions that DO carry marks is not "no evidence": the per-item
 *      marks rows below the parent row remain the truth for that case.
 */
export function marksSummaryOf(q) {
  if (!q) return '';
  const itemCount = Number(q.itemCount ?? (q.marks && q.marks.itemCount));
  const perItem = Number(q.marksPerItem ?? (q.marks && q.marks.perItem));
  const total = Number(q.totalMarks ?? (q.marks && q.marks.total));
  const consistent = !Number.isFinite(total) || total <= 0 || Math.abs(perItem * itemCount - total) < 1e-6;
  if (Number.isFinite(itemCount) && itemCount > 1 && Number.isFinite(perItem) && perItem > 0 && consistent) {
    return `${round1(itemCount)} item${itemCount === 1 ? '' : 's'} × ${round1(perItem)} mark${perItem === 1 ? '' : 's'} each`;
  }
  return marksText(total);
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

/** Roman numeral (I, II, III, IV, ... up to a few thousand) → integer, or
 * null when `s` isn't a well-formed roman numeral. Standard subtractive-pair
 * algorithm — generic, no lookup table capped at a specific unit count. */
function romanToInt(s) {
  const VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const t = String(s || '').toUpperCase();
  if (!/^[IVXLCDM]+$/.test(t)) return null;
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const cur = VALUES[t[i]];
    const next = VALUES[t[i + 1]];
    if (next != null && cur < next) total -= cur;
    else total += cur;
  }
  return total > 0 ? total : null;
}

/**
 * Normalize a "Unit <N>" style label for equivalence comparison: lowercases,
 * collapses whitespace, and converts a trailing roman numeral to its Arabic
 * digit form so "Unit I" and "Unit 1" (or "Chapter IV" / "Chapter 4")
 * compare equal — a reference paper's analyzer-detected unit is extracted
 * straight from the printed heading (often roman), while a teacher types the
 * notes-upload unit freehand (often arabic); the same unit legitimately
 * appears in both forms. Never used to CHANGE the value that gets submitted
 * (see defaultAssign) — only to decide whether indexed notes exist for it.
 */
export function normalizeUnitLabel(label) {
  const t = String(label || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const m = t.match(/^(.*?)(\d+|[ivxlcdm]+)$/);
  if (!m) return t;
  const [, prefix, tail] = m;
  const asRoman = romanToInt(tail);
  const arabic = asRoman != null ? String(asRoman) : String(Number(tail) || tail);
  return `${prefix}${arabic}`;
}

/**
 * Default assignment: spread questions round-robin across availableUnits so the
 * teacher edits a filled form. When there are no units every question is left
 * unassigned (generate stays disabled and the screen points at notes upload).
 *
 * Locked slots with a reference-detected unit (IMAGE_BASED / MIXED — the
 * analyzer stamped `isLocked` + `detectedUnit`) are seeded to that unit instead
 * of round-robin: the unit came from the reference paper, the UI field is
 * disabled, so seeding it keeps the row out of `unassignedKeys` and never
 * blocks Generate. Matches against the indexed unit list using
 * `normalizeUnitLabel` (case-insensitive, roman-numeral-aware) so "Unit I"
 * finds notes indexed as "Unit 1"; if nothing matches even after
 * normalization, the slot stays unassigned so the teacher is told to upload
 * the notes that cover it (never silently re-unit-ed). The ASSIGNED VALUE is
 * always the analyzer's own `detectedUnit` string verbatim — never the pool
 * entry's own spelling — because the backend's lock validation requires an
 * EXACT match against `question.detectedUnit` (slot-unit-map.js); submitting
 * a differently-spelled-but-equivalent id would fail that check.
 *
 * @param {Object} blueprint
 * @param {Array<Object>} units - the GLOBAL indexed-unit pool (Qdrant, via
 *   /kb/units) — the only pool a LOCKED slot's evidence is checked against
 *   (RAG can legitimately draw on notes indexed in an earlier session, not
 *   just ones just uploaded).
 * @param {Object} [opts]
 * @param {Array<Object>|null} [opts.dropdownUnits] - the pool UNLOCKED slots
 *   round-robin across and the teacher can actually pick from in the UI.
 *   Defaults to `units` (existing callers — e.g. Mode B's ConfirmScreen,
 *   which has no separate "current session uploads" concept — keep their
 *   exact prior behavior unchanged). Generate Paper (Mode A) passes its own
 *   session-scoped unit list here so a locked slot's globally-available
 *   evidence is never confused with what an UNLOCKED slot may be assigned.
 */
export function defaultAssign(blueprint, units, opts = {}) {
  const pool = Array.isArray(units) ? units : [];
  const roundRobinPool = Array.isArray(opts.dropdownUnits) ? opts.dropdownUnits : pool;
  const out = {};
  // Round-robin advances only for slots that actually consume a round-robin
  // turn (see below) — a locked slot's own array position must never create
  // a "gap" that shifts which pool unit a later UNLOCKED slot lands on.
  let roundRobinIndex = 0;
  ((blueprint && blueprint.questions) || []).forEach((q, i) => {
    let assignedUnit = null;
    const detected = q.detectedUnit != null ? String(q.detectedUnit).trim() : null;
    if (detected && q.isLocked) {
      // AUTHORITATIVE, checked FIRST: a reference-locked slot's unit always
      // comes from the analyzer's own detectedUnit — never from `q.unit` (a
      // stray/persisted value from an earlier save-reload cycle must not
      // override a lock), never from round-robin.
      const normalizedDetected = normalizeUnitLabel(detected);
      const match = pool.find(
        (u) =>
          normalizeUnitLabel(u.id) === normalizedDetected ||
          normalizeUnitLabel(u.label) === normalizedDetected ||
          normalizeUnitLabel(u.name || '') === normalizedDetected
      );
      // The SUBMITTED value is always the verbatim detected string (see the
      // docstring above) — `match` only proves equivalent notes exist.
      assignedUnit = match ? detected : null;
    } else if (q.unit != null) {
      const match = pool.find(
        (u) =>
          String(u.id) === String(q.unit) ||
          String(u.label).toLowerCase() === String(q.unit).toLowerCase() ||
          String(u.name || '').toLowerCase() === String(q.unit).toLowerCase()
      );
      assignedUnit = match ? match.id : q.unit;
    } else if (roundRobinPool.length) {
      assignedUnit = roundRobinPool[roundRobinIndex % roundRobinPool.length].id;
      roundRobinIndex += 1;
    }
    out[slotKey(q, i)] = { unit: assignedUnit, items: {} };
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
/**
 * Resolve a raw assigned unit value (which, for a locked slot, is the
 * analyzer's verbatim `detectedUnit` — see defaultAssign — and may be
 * spelled differently from the pool's own id, e.g. "Unit I" vs "Unit 1") to
 * the POOL's own id, so it buckets into the SAME running total as every
 * other question assigned to that unit. Returns null when nothing in the
 * pool is equivalent (never fabricates a bucket that doesn't exist).
 */
function resolvePoolUnitId(rawUnit, pool) {
  if (rawUnit == null) return null;
  const direct = (pool || []).find((u) => String(u.id) === String(rawUnit));
  if (direct) return direct.id;
  const normalized = normalizeUnitLabel(rawUnit);
  const equivalent = (pool || []).find(
    (u) => normalizeUnitLabel(u.id) === normalized || normalizeUnitLabel(u.label) === normalized
  );
  return equivalent ? equivalent.id : null;
}

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
      const poolId = resolvePoolUnitId(unit, units);
      if (it.marks == null) {
        unknownItems += 1;
        continue;
      }
      if (unit == null || poolId == null) {
        unassigned += it.marks;
      } else {
        totals[poolId] += it.marks;
        contributed = true;
      }
    }
    if (contributed && isApproximate(q)) approximate = true;
  });

  for (const k of Object.keys(totals)) totals[k] = round1(totals[k]);
  return { totals, unassigned: round1(unassigned), unknownItems, approximate };
}

/**
 * Merge a handed-off/restored assignment (Mode B builder pre-assignments, or
 * a persisted UI state) onto a freshly-seeded `base` (from `defaultAssign`).
 * A row may arrive as a whole-question unit (`{ unit }`) or, from the
 * per-item builder, as `{ items: { a: unitId, … } }` — both are honoured;
 * anything unrecognised falls back to `base`. Only unit ids that exist in
 * `units` are kept.
 *
 * A reference-LOCKED slot (isLocked + detectedUnit) is never touched by this
 * merge — `base` already carries its authoritative unit (or an honest null
 * when that unit isn't indexed), and a restored/handed-off value — however
 * it got there — must never override a lock.
 *
 * @param {Object} blueprint
 * @param {Object} base - defaultAssign(blueprint, units) output
 * @param {Object|null} initialAssign - the handed-off/restored assignment
 * @param {Array<Object>} units
 * @returns {Object} the merged assignment map
 */
export function mergeInitialAssign(blueprint, base, initialAssign, units) {
  if (initialAssign == null) return base;
  const questions = (blueprint && blueprint.questions) || [];
  const lockedKeys = new Set(
    questions
      .map((q, i) => [slotKey(q, i), q])
      .filter(([, q]) => q?.isLocked && q?.detectedUnit != null)
      .map(([k]) => k)
  );
  const known = new Set((units || []).map((u) => String(u.id)));
  const merged = { ...base };
  for (const [k, v] of Object.entries(initialAssign)) {
    if (!merged[k] || lockedKeys.has(k)) continue;
    if (v?.items && typeof v.items === 'object') {
      const items = {};
      for (const [lbl, u] of Object.entries(v.items)) {
        if (u != null && known.has(String(u))) items[lbl] = u;
      }
      if (Object.keys(items).length > 0) {
        merged[k] = { ...merged[k], items };
        continue;
      }
    }
    if (v?.unit != null) {
      merged[k] = { ...merged[k], unit: v.unit, items: {} };
    }
  }
  return merged;
}

/**
 * Upsert one uploaded-notes entry into the Generate Paper screen's
 * CURRENT-SESSION file list (distinct from the global historical
 * Qdrant-indexed unit list — see GeneratePaperA.jsx's NotesCard). Keyed by
 * `entry.id`: re-uploading the exact same file to the same unit updates its
 * existing card in place rather than adding a duplicate; a different file,
 * or the same file under a different unit, gets its own card. Chunk count
 * is carried as metadata on the entry — it is never used as the entry's
 * identity.
 * @param {Array<Object>} list - the current session-uploads list
 * @param {{id: string}} entry - the new/updated upload entry
 * @returns {Array<Object>} the new list
 */
export function upsertSessionUpload(list, entry) {
  const prev = Array.isArray(list) ? list : [];
  return [...prev.filter((e) => e.id !== entry.id), entry];
}

/**
 * The Unit/Topic dropdown's SELECTABLE pool for Generate Paper: units
 * belonging ONLY to files explicitly uploaded/selected in the CURRENT
 * session (`sessionNotesUploads`) — never the full historical Qdrant-indexed
 * unit list (that stays `availableUnits`, still used internally for
 * locked-slot evidence checks, RAG and the Knowledge Base page; see
 * defaultAssign's `dropdownUnits` param).
 *
 * "Unit 1" and "unit 1" uploaded as two separate files collapse into ONE
 * selectable option (case/roman-numeral-aware, via normalizeUnitLabel) —
 * the FIRST-uploaded spelling wins for display; this never touches the
 * original per-file metadata in `sessionNotesUploads` itself.
 *
 * @param {Array<Object>} sessionNotesUploads - { fileName, unit, chunkCount, ... }[]
 * @returns {Array<{id: string, label: string}>} deduped, in first-seen order
 */
export function deriveSessionUnits(sessionNotesUploads) {
  const list = Array.isArray(sessionNotesUploads) ? sessionNotesUploads : [];
  const seen = new Map();
  for (const f of list) {
    const unit = String(f?.unit || '').trim();
    if (!unit) continue;
    const key = normalizeUnitLabel(unit);
    if (!seen.has(key)) seen.set(key, { id: unit, label: unit });
  }
  return [...seen.values()];
}
