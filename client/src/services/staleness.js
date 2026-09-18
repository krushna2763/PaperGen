/**
 * staleness.js — Mode B staleness tracking (PURE, unit-testable).
 *
 * The teacher built the structure, so it stays editable — but the generated
 * paper was produced against the OLD structure. Every structural edit to a
 * slot invalidates that slot's content:
 *
 *   question type changed · marks changed · item count changed · unit changed
 *
 * A slot fingerprint captures exactly those facts; comparing the generated
 * snapshot against the current state yields the stale slot keys. NO
 * auto-regeneration happens — the teacher may be making several edits in a
 * row; the UI only flags (amber) and warns on download without blocking.
 */

import { slotKey } from '../components/blueprintUnits.js';

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/**
 * Fingerprint of one slot's structure + its unit assignment.
 * @param {Object} q - blueprint question slot
 * @param {Object|null} assignment - { unit } | { items: { a: unitId } } | null
 * @returns {string} stable JSON fingerprint
 */
export function slotFingerprint(q, assignment = null) {
  const items = Array.isArray(q?.items) ? q.items : [];
  const parts = {
    type: q?.type ?? null,
    totalMarks: q?.totalMarks ?? null,
    itemCount: q?.itemCount ?? null,
    itemMarks: items.map((it) => (it?.marks == null ? null : round1(it.marks))),
    // Unit assignment: whole-question unit, or the per-item unit list.
    unit: assignment?.unit ?? null,
    itemUnits:
      assignment && assignment.items && typeof assignment.items === 'object'
        ? items.map((it) => assignment.items[it.label] ?? null)
        : null,
  };
  return JSON.stringify(parts);
}

/**
 * Fingerprints for the whole paper, keyed by `slotKey` — the SAME function the
 * review screen keys rendered questions by, so a stale key computed here is a
 * key the screen can actually look up.
 */
export function paperFingerprints(blueprint, slotUnitMap = {}) {
  const out = {};
  (blueprint?.questions || []).forEach((q, i) => {
    const key = slotKey(q, i);
    out[key] = slotFingerprint(q, slotUnitMap[key] ?? null);
  });
  return out;
}

/**
 * F2 — preferred fingerprint source for a RELOADED paper.
 *
 * The generate-time snapshot is persisted on the library record
 * (`generatedFingerprint`, written by App's post-generate patch; some paths
 * carry it as `generatedFp`). Reload MUST compare the CURRENT state against
 * THAT snapshot — recomputing fingerprints from the saved blueprint instead
 * would snapshot the (possibly edited) structure against itself and silently
 * clear every stale flag.
 *
 * Only a well-formed plain object counts. Anything else (legacy records from
 * before the field existed, malformed values) returns null so the caller can
 * fall back to recomputing from the blueprint — the old behaviour, which is
 * still correct for records that were saved without any post-save edit.
 *
 * @param {Object|null} record - library record
 * @returns {Object|null} the persisted generate-time fingerprint map, or null
 */
export function persistedGeneratedFingerprint(record) {
  const fp = record?.generatedFp ?? record?.generatedFingerprint ?? null;
  return fp && typeof fp === 'object' && !Array.isArray(fp) ? fp : null;
}

/**
 * Slots whose structure or units changed between two snapshots.
 * @param {Object} generated - fingerprints captured at generate time
 * @param {Object} current - fingerprints of the (possibly edited) state
 * @returns {string[]} stale slot keys (insertion order of `current`)
 */
export function staleSlots(generated, current) {
  // If there is no generated snapshot, nothing can be stale — there is nothing
  // to compare the current state against. This is the Mode A guard: no
  // generation fingerprint means no stale slots, regardless of what the current
  // blueprint is.
  if (!generated || typeof generated !== 'object') return [];
  const stale = [];
  for (const [key, fp] of Object.entries(current || {})) {
    if (generated[key] !== fp) stale.push(key);
  }
  return stale;
}

/**
 * PHASE 6 — Answer Key: does one question's answer need review?
 *
 * The hint means ONLY "the question changed after its answer was written" —
 * an edited answer NEVER makes its own question stale. True when any
 * sub-part's text differs from the generate-time snapshot (the fingerprint
 * captures the STRUCTURE the answer was written against; a changed item text
 * is what can invalidate an answer's depth/wording).
 *
 * Fail-open: no snapshot (Mode A papers, library papers without one) → false,
 * never a false alarm.
 *
 * @param {Object|null} generatedFp - paperFingerprints snapshot at generate time
 * @param {string} slotKey - the slot's key (blueprint label)
 * @param {Object} currentSlot - the CURRENT blueprint slot (possibly edited)
 * @param {boolean} currentStale - the slot's existing structure-stale flag
 * @returns {boolean}
 */
export function answerNeedsReview(generatedFp, slotKey, currentSlot, currentStale) {
  if (currentStale) return true; // structural change already invalidates content
  if (!generatedFp || typeof generatedFp !== 'object' || !slotKey || !currentSlot) return false;
  const gen = generatedFp[slotKey];
  const cur = slotFingerprint(currentSlot, null);
  // gen == null: the slot has no snapshot (added after generation) → needs review.
  return gen == null || gen !== cur;
}

/**
 * PHASE 6 — persisted answer-review set: slot keys whose questions changed
 * after generation (their stored answers may no longer match). Computed from
 * the generate-time fingerprint saved alongside the paper, so it survives
 * reload. An answer EDIT alone never adds a slot here.
 *
 * @param {Object|null} generatedFp
 * @param {Object} blueprint - current (possibly edited) blueprint
 * @param {Array<string>} extraStale - additional slot keys to include (e.g. live structural staleness)
 * @returns {string[]}
 */
export function answersNeedingReview(generatedFp, blueprint, extraStale = []) {
  if (!generatedFp || typeof generatedFp !== 'object' || !blueprint) return [];
  const out = [];
  (blueprint.questions || []).forEach((q, i) => {
    const key = slotKey(q, i);
    if (extraStale.includes(key)) return;
    const gen = generatedFp[key];
    const cur = slotFingerprint(q, null);
    // gen == null: the slot has no snapshot (added after generation) → its
    // answer was never generated against anything → needs review.
    if (gen == null || gen !== cur) out.push(key);
  });
  return [...new Set(out)];
}

/**
 * PHASE 3 (M2) — Unit-dimension staleness.
 *
 * A slot's UNIT assignment changed when its entry in the CURRENT slotUnitMap
 * differs from the map captured at generate time. Compares canonical entries:
 * `{ unit }` vs `{ items: { a: id, … } }`, null-normalised, so the whole-
 * question and per-item shapes compare consistently.
 *
 * Rules:
 *   - no generated map (Mode A, legacy rows, unassigned generate) → [] (fail-open,
 *     identical to every other dimension's behaviour without a snapshot)
 *   - a slot ABSENT from the generated map but present now → stale (its unit
 *     was chosen after generation → content not grounded in that unit)
 *   - a slot present at generate time but ABSENT now → stale (assignment removed)
 *   - `null` equals `null` — unassigned-then and unassigned-now is NOT a change
 *
 * @param {Object|null} generatedUnits - snapshot of the slotUnitMap at generate time
 * @param {Object|null} currentUnitMap - the current slotUnitMap
 * @returns {string[]} stale slot keys
 */
export function unitStaleSlots(generatedUnits, currentUnitMap) {
  if (!generatedUnits || typeof generatedUnits !== 'object') return [];
  const current = currentUnitMap && typeof currentUnitMap === 'object' ? currentUnitMap : {};
  const keys = new Set([...Object.keys(generatedUnits), ...Object.keys(current)]);
  const stale = [];
  for (const key of keys) {
    if (!unitEntryEquals(generatedUnits[key], current[key])) stale.push(key);
  }
  return stale;
}

/** Canonical equality for one slotUnitMap entry (null-normalised). */
function unitEntryEquals(a, b) {
  if (a === b) return true;
  const unitOf = (e) => (e && e.unit != null ? String(e.unit) : null);
  const itemsOf = (e) => {
    if (!e || !e.items || typeof e.items !== 'object') return null;
    const out = {};
    for (const [k, v] of Object.entries(e.items)) out[k] = v == null ? null : String(v);
    return out;
  };
  const itemsA = itemsOf(a);
  const itemsB = itemsOf(b);
  if (itemsA || itemsB) {
    if (!itemsA || !itemsB) return false;
    const keys = new Set([...Object.keys(itemsA), ...Object.keys(itemsB)]);
    for (const k of keys) if ((itemsA[k] ?? null) !== (itemsB[k] ?? null)) return false;
    return true;
  }
  return unitOf(a) === unitOf(b);
}

/**
 * PHASE 3 — Topic dimension: slotKey → topic anchor of the CURRENT blueprint.
 * Topics live in the blueprint itself (`referenceItems[0]` — the slot anchor
 * the manual builder and the extractor both write), so this needs no extra
 * state and works on any blueprint shape.
 * @param {Object} blueprint
 * @returns {Object} { [slotKey]: string|null }
 */
export function blueprintTopicMap(blueprint) {
  const out = {};
  (blueprint?.questions || []).forEach((q, i) => {
    const topic = q?.referenceItems?.[0];
    out[slotKey(q, i)] = topic != null && String(topic).trim() !== '' ? String(topic) : null;
  });
  return out;
}

/**
 * PHASE 3 — the snapshot of ONE slot for the moment it becomes fresh again
 * (after a successful targeted regeneration against the CURRENT structure).
 * Structure fingerprint + unit entry + topic — everything the staleness
 * report compares for this slot, captured in one place so the regen path and
 * the snapshot shape can never drift apart.
 *
 * @param {Object} blueprint - the CURRENT blueprint (the regen ran against it)
 * @param {string} key - the slot's key
 * @param {Object} slotUnitMap - the current slotUnitMap (the regen's grounding)
 * @param {Object} topics - blueprintTopicMap(blueprint) (or an equivalent map)
 * @returns {{ fingerprint: string, unit: Object|null, topic: string|null }}
 */
export function freshSlotSnapshot(blueprint, key, slotUnitMap, topics) {
  const questions = blueprint?.questions || [];
  const idx = questions.findIndex((qq, i) => slotKey(qq, i) === key);
  const q = idx >= 0 ? questions[idx] : undefined;
  return {
    // Unit-free by the dimension rule: structure fingerprints never embed
    // units — the unit dimension is compared solely via the unit maps.
    // (Matches handleGenerate's snapshot and the answer-review comparators,
    // which both call slotFingerprint WITHOUT an assignment.)
    fingerprint: q ? slotFingerprint(q, null) : null,
    unit: slotUnitMap?.[key]
      ? JSON.parse(JSON.stringify(slotUnitMap[key]))
      : null,
    topic: topics?.[key] ?? null,
    ...(q ? { order: idx } : {}),
  };
}

/**
 * PHASE 3 — ONE staleness comparison for the whole paper, combining all three
 * dimensions. This is the single source of truth: App's stale memo, the
 * download warning, and the builder's edit summary all consume THIS, so the
 * rule cannot drift between surfaces.
 *
 * Snapshot-absence semantics per dimension (fail-open, matching Phase 2):
 *   structure  — null snapshot → no structural staleness
 *   units      — null snapshot → no unit staleness
 *   topics     — null snapshot → no topic staleness
 *
 * A slot keyed in the CURRENT blueprint but absent from a PRESENT snapshot is
 * stale in that dimension: the slot was added after generation (its content
 * was never generated against anything).
 *
 * @param {Object} args
 * @param {Object} args.blueprint - current (possibly edited) blueprint
 * @param {Object|null} args.generatedFingerprint - persisted structure snapshot
 * @param {Object|null} args.generatedUnitMap - persisted slotUnitMap snapshot
 * @param {Object|null} args.generatedTopics - persisted topic snapshot
 * @param {Object|null} args.slotUnitMap - current slotUnitMap
 * @param {Object|null} args.topics - current topic map (blueprintTopicMap(blueprint))
 * @returns {{ stale: string[], byDimension: { structure: string[], units: string[], topics: string[] }, summary: string[] }}
 *   `summary` is a human-readable per-slot change list for the UI, e.g.
 *   "Q2: marks changed". New/removed slots read "Q4: new question" / "Q3: removed".
 */
export function stalenessReport({ blueprint, generatedFingerprint, generatedUnitMap, generatedTopics, slotUnitMap, topics }) {
  // Unit-free structure fingerprints on BOTH sides of the comparison — the
  // dimension rule: structure never embeds units (the generated snapshot from
  // handleGenerate and the answer-review comparators both compute without a
  // unit map); units are compared solely in the units dimension below.
  const currentFps = paperFingerprints(blueprint);
  const currentUnits = slotUnitMap && typeof slotUnitMap === 'object' ? slotUnitMap : {};
  const currentTopics = topics && typeof topics === 'object'
    ? topics
    : blueprintTopicMap(blueprint);

  const byStructure = staleSlots(generatedFingerprint, currentFps);
  const byUnits = unitStaleSlots(generatedUnitMap, currentUnits);
  const byTopics = staleSlots(generatedTopics, currentTopics);

  const stale = [...new Set([...byStructure, ...byUnits, ...byTopics])];

  const summary = stale.map((key) => {
    const parts = [];
    if (byStructure.includes(key)) {
      const gen = generatedFingerprint?.[key];
      const cur = currentFps[key];
      if (gen == null) parts.push('new question — not generated yet');
      else parts.push('structure changed (type / marks / items)');
      void cur;
    }
    if (byUnits.includes(key)) {
      const genU = generatedUnitMap?.[key];
      const curU = currentUnits[key];
      if (genU == null) parts.push('unit assigned after generation');
      else if (curU == null) parts.push('unit assignment removed');
      else parts.push('unit changed');
    }
    if (byTopics.includes(key)) {
      const genT = generatedTopics?.[key];
      if (genT == null) parts.push('topic added after generation');
      else parts.push('topic changed');
    }
    return `${key}: ${parts.join(' · ') || 'changed'}`;
  });

  return { stale, byDimension: { structure: byStructure, units: byUnits, topics: byTopics }, summary };
}

/**
 * Live paper total from the CURRENT per-item marks (recomputed after edits).
 * @param {Object} blueprint
 * @returns {{ total: number, declared: number|null, drifted: boolean }}
 */
export function liveTotals(blueprint) {
  let total = 0;
  for (const q of blueprint?.questions || []) {
    const items = Array.isArray(q?.items) ? q.items : [];
    if (items.length > 0 && items.every((it) => Number(it?.marks) > 0)) {
      total += items.reduce((a, it) => a + Number(it.marks), 0);
    } else if (Number(q?.totalMarks) > 0) {
      total += Number(q.totalMarks);
    }
  }
  total = round1(total);
  const declaredRaw = Number(blueprint?.paper?.maximumMarks);
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;
  return { total, declared, drifted: declared != null && declared !== total };
}

export default { slotFingerprint, paperFingerprints, staleSlots, persistedGeneratedFingerprint, unitStaleSlots, blueprintTopicMap, freshSlotSnapshot, stalenessReport, answerNeedsReview, answersNeedingReview, liveTotals };
