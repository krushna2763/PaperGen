/**
 * slot-unit-map.js
 *
 * The teacher assigns UNITS to blueprint slots (and, where a slot's items are
 * independent, to individual items). They never touch marks, types or counts —
 * those are locked to the reference paper. This module validates a
 * teacher-supplied slotUnitMap against the locked blueprint.
 *
 * slotUnitMap shape:
 *   { "Q1":  { "unit": 1 },
 *     "Q10": { "items": { "a": 1, "b": 1, "c": 2, "d": 2 } } }
 *
 * Every failure names its slot so the caller can regenerate ONE slot rather
 * than the whole paper.
 */
import { qdrantStore } from '../rag/qdrant.js';

/** Stable slot identity — matches the client and the blueprint contract. */
export function slotKeyOf(q, index) {
  if (q && q.label) return String(q.label);
  if (q && q.number != null) return `Q${q.number}`;
  return `Q${index + 1}`;
}

/** Item labels a slot exposes (from the blueprint's canonical items[]). */
function itemLabelsOf(q) {
  const items = Array.isArray(q?.items) ? q.items : [];
  return items.map((it, i) => it?.label || String.fromCharCode(97 + i));
}

/**
 * @param {Object} slotUnitMap
 * @param {Object} blueprint
 * @param {{ class: string, subject: string }} ctx
 * @returns {Promise<{ ok: boolean, errors: Array<{ slot: string|null, message: string }> }>}
 */
export async function validateSlotUnitMap(slotUnitMap, blueprint, ctx = {}) {
  const errors = [];
  if (!slotUnitMap || typeof slotUnitMap !== 'object' || Array.isArray(slotUnitMap)) {
    return { ok: false, errors: [{ slot: null, message: 'slotUnitMap must be an object keyed by slot label.' }] };
  }

  const questions = Array.isArray(blueprint?.questions) ? blueprint.questions : [];
  if (questions.length === 0) {
    return { ok: false, errors: [{ slot: null, message: 'Blueprint has no questions to assign.' }] };
  }

  const keys = questions.map((q, i) => slotKeyOf(q, i));
  const keySet = new Set(keys);
  const referencedUnits = new Set();

  // Unknown slot ids.
  for (const k of Object.keys(slotUnitMap)) {
    if (!keySet.has(k)) errors.push({ slot: k, message: `Unknown slot "${k}" — it is not in the blueprint.` });
  }

  // Per-slot checks. Object keys are unique by nature, so "exactly once"
  // reduces to "present and well-formed".
  questions.forEach((q, i) => {
    const k = keys[i];
    const entry = slotUnitMap[k];

    if (entry == null) {
      errors.push({ slot: k, message: `Slot "${k}" is missing from slotUnitMap — every blueprint slot must be assigned.` });
      return;
    }

    const hasUnit = entry.unit !== undefined && entry.unit !== null && String(entry.unit).trim() !== '';
    const hasItems = entry.items && typeof entry.items === 'object' && Object.keys(entry.items).length > 0;

    if (hasUnit === hasItems) {
      errors.push({ slot: k, message: `Slot "${k}" must carry exactly one of { unit } or { items }.` });
      return;
    }

    // Mode A locking: an IMAGE_BASED/MIXED slot's unit was determined
    // deterministically from the reference paper at analyze time and travels
    // on the blueprint itself (isLocked + detectedUnit). A teacher assigns
    // units — never moves a locked slot to a different one, because that
    // would break the image/topic relationship the reference paper
    // established. Enforced here, not just by a disabled UI field.
    if (q.isLocked && q.detectedUnit && hasUnit && String(entry.unit).trim() !== String(q.detectedUnit).trim()) {
      errors.push({
        slot: k,
        message: `Slot "${k}" is locked to "${q.detectedUnit}" by the reference paper — it cannot be reassigned to "${entry.unit}".`,
      });
      return;
    }

    if (hasItems) {
      if (q.itemsIndependent === false) {
        errors.push({
          slot: k,
          message: `Slot "${k}" has itemsIndependent=false (shared stimulus) — assign one unit to the whole question, not per item.`,
        });
        return;
      }
      const labels = itemLabelsOf(q);
      const labelSet = new Set(labels);
      for (const label of Object.keys(entry.items)) {
        if (!labelSet.has(label)) {
          errors.push({ slot: k, message: `Slot "${k}" has no item "${label}" — expected one of [${labels.join(', ')}].` });
        } else {
          const u = entry.items[label];
          if (u == null || String(u).trim() === '') errors.push({ slot: k, message: `Slot "${k}" item "${label}" is unassigned.` });
          else referencedUnits.add(String(u));
        }
      }
      for (const label of labels) {
        if (!(label in entry.items)) errors.push({ slot: k, message: `Slot "${k}" item "${label}" is missing from the assignment.` });
      }
    } else {
      referencedUnits.add(String(entry.unit));
    }
  });

  // Every referenced unit must have notes indexed for this class + subject.
  const { class: cls, subject } = ctx;
  await Promise.all(
    [...referencedUnits].map(async (unit) => {
      const has = await qdrantStore.unitHasNotes({ class: cls, subject, unit });
      if (!has) {
        errors.push({ slot: null, message: `Unit "${unit}" has no notes indexed for Class ${cls} / ${subject}. Upload notes for it or reassign the slots that use it.` });
      }
    })
  );

  return { ok: errors.length === 0, errors };
}

export default { validateSlotUnitMap, slotKeyOf };
