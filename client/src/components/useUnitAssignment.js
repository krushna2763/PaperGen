/**
 * useUnitAssignment — the per-question / per-item unit assignment state.
 *
 * Lifted verbatim from ConfirmScreen so the Mode A screen (GeneratePaperA) and
 * the Mode B confirm screen share ONE implementation. It is state orchestration
 * only; every rule lives in the pure, tested helpers in blueprintUnits.js,
 * which are imported unchanged.
 *
 * Returns the assignment map, the expanded-row set, the three mutators, the
 * live per-unit totals, and `buildMap()` for the generate call.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  slotKey,
  itemLabels,
  defaultAssign,
  mergeInitialAssign,
  buildSlotUnitMap,
  runningTotals,
  unassignedList,
} from './blueprintUnits.js';

/**
 * @param {Object} blueprint
 * @param {Array<Object>} units - the GLOBAL indexed-unit pool (used for
 *   locked-slot evidence checks — see defaultAssign — and as the fallback
 *   round-robin/selectable pool for callers with no separate session scope,
 *   e.g. Mode B's ConfirmScreen).
 * @param {Object|null} [initialAssign]
 * @param {Array<Object>|null} [dropdownUnits] - Generate Paper's (Mode A)
 *   CURRENT-SESSION selectable unit pool (see blueprintUnits.js's
 *   deriveSessionUnits) — what UNLOCKED slots round-robin across and what
 *   the teacher can actually pick from the dropdown. Defaults to `units`
 *   when omitted, so every other caller's behavior is unchanged.
 */
export function useUnitAssignment(blueprint, units, initialAssign = null, dropdownUnits = null) {
  const questions = blueprint?.questions || [];
  const roundRobinUnits = dropdownUnits ?? units;

  const coerceId = (raw) => {
    const hit = roundRobinUnits.find((u) => String(u.id) === String(raw));
    return hit ? hit.id : null;
  };

  // A slot is reference-locked when the analyzer stamped isLocked + a
  // detectedUnit — its unit is authoritative and must never be overridden by
  // a restored/merged assignment or a manual edit (the UI also disables the
  // control for these rows; this is the belt-and-suspenders state guard).
  const lockedKeys = useMemo(() => {
    const s = new Set();
    (blueprint?.questions || []).forEach((q, i) => {
      if (q?.isLocked && q?.detectedUnit != null) s.add(slotKey(q, i));
    });
    return s;
  }, [blueprint]);

  // Assignment state — re-seeded when a different blueprint arrives; edits
  // within one blueprint (one jobId) are preserved. The FIRST seed already
  // uses whatever session units exist at mount; a session-units change
  // alone (e.g. the teacher's first upload, with the SAME blueprint/jobId)
  // deliberately does not force a re-seed — it only updates which options
  // the (still-unassigned) dropdown now offers, so it never stomps a
  // manual edit the teacher already made.
  const [assign, setAssign] = useState(() => defaultAssign(blueprint, units, { dropdownUnits: roundRobinUnits }));
  const [expanded, setExpanded] = useState(() => new Set());
  const seededFor = useRef(null);
  useEffect(() => {
    const stamp =
      blueprint?.jobId ||
      JSON.stringify(questions.map((q, i) => slotKey(q, i))) + '|' + units.map((u) => u.id).join(',');
    if (seededFor.current === stamp) return;
    seededFor.current = stamp;
    // Mode B handoff: the builder's pre-assignments win (except on a
    // reference-locked slot, which mergeInitialAssign never touches — see
    // blueprintUnits.js).
    setAssign((prev) => {
      const base = defaultAssign(blueprint, units, { dropdownUnits: roundRobinUnits });
      if (prev && Object.keys(prev).length > 0 && initialAssign == null) return prev;
      return mergeInitialAssign(blueprint, base, initialAssign, units);
    });
    setExpanded(new Set());
  }, [blueprint, units, roundRobinUnits]); // eslint-disable-line react-hooks/exhaustive-deps

  const setQ = (key, updater) =>
    setAssign((m) => ({ ...m, [key]: updater(m[key] || { unit: null, items: {} }) }));

  const seedItems = (q, unit) => Object.fromEntries(itemLabels(q).map((l) => [l, unit ?? null]));

  const assignWholeQuestion = (q, key, rawVal) => {
    if (lockedKeys.has(key)) return; // reference-locked — immutable regardless of caller
    const v = rawVal === '' ? null : coerceId(rawVal);
    setQ(key, () => ({ unit: v, items: expanded.has(key) ? seedItems(q, v) : {} }));
  };

  const assignItem = (q, key, label, rawVal) => {
    if (lockedKeys.has(key)) return; // reference-locked — immutable regardless of caller
    const v = rawVal === '' ? null : coerceId(rawVal);
    setQ(key, (a) => {
      const items = { ...seedItems(q, a.unit), ...a.items, [label]: v };
      const vals = itemLabels(q).map((l) => items[l]);
      const uniform = vals.every((x) => x != null) && new Set(vals).size === 1;
      return { unit: uniform ? vals[0] : a.unit, items };
    });
  };

  const toggleExpand = (q, key) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
    setQ(key, (a) => (Object.keys(a.items).length ? a : { ...a, items: seedItems(q, a.unit) }));
  };

  const { totals, unassigned, unknownItems, approximate } = useMemo(
    () => runningTotals(blueprint, assign, units),
    [blueprint, assign, units]
  );
  const unassignedKeys = useMemo(() => unassignedList(blueprint, assign), [blueprint, assign]);
  const maxBar = Math.max(1, unassigned, ...Object.values(totals));

  return {
    assign,
    expanded,
    assignWholeQuestion,
    assignItem,
    toggleExpand,
    totals,
    unassigned,
    unknownItems,
    approximate,
    maxBar,
    unassignedKeys,
    buildMap: () => buildSlotUnitMap(blueprint, assign),
  };
}
