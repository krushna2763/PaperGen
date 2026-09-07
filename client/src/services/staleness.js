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
 * Slots whose structure or units changed between two snapshots.
 * @param {Object} generated - fingerprints captured at generate time
 * @param {Object} current - fingerprints of the (possibly edited) state
 * @returns {string[]} stale slot keys (insertion order of `current`)
 */
export function staleSlots(generated, current) {
  // If there is no generated snapshot, nothing can be stale — there is nothing
  // to compare the current state against. This is the Mode A guard: no
  // generation fingerprint means no stale slots, regardless of what the current
  // blueprint looks like.
  if (!generated || typeof generated !== 'object') return [];
  const stale = [];
  for (const [key, fp] of Object.entries(current || {})) {
    if (generated[key] !== fp) stale.push(key);
  }
  return stale;
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

export default { slotFingerprint, paperFingerprints, staleSlots, liveTotals };
