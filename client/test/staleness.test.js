/**
 * Staleness tracking tests (task §11 + §13):
 *   a structural edit flags the slot · regenerating clears the flag ·
 *   totals recompute after an edit · a manual blueprint's shape drives it all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotFingerprint, paperFingerprints, staleSlots, liveTotals } from '../src/services/staleness.js';
import { normalizeBlueprint } from '../../server/src/blueprint/blueprint-normalizer.js';
import { buildManualBlueprint } from '../../server/src/blueprint/manual-blueprint.js';

const manualBp = () =>
  buildManualBlueprint({
    paper: { class: '4', subject: 'English', maximumMarks: 9 },
    sections: [],
    questions: [
      { type: 'SHORT_ANSWER', section: null, itemCount: 2, topic: 'nouns', difficulty: 'Easy', marks: { mode: 'perItem', values: [2, 2] } },
      { type: 'MATCH', section: null, itemCount: 2, topic: 'verbs', difficulty: 'Medium', marks: { mode: 'whole', total: 5 } },
    ],
  }).blueprint;

test('a structural edit (type/marks/itemCount/unit) flags that slot stale', () => {
  const bp = normalizeBlueprint(manualBp());
  const map = { Q1: { unit: 1 }, Q2: { unit: 2 } };
  const generated = paperFingerprints(bp, map);

  // No edits → nothing stale.
  assert.deepEqual(staleSlots(generated, paperFingerprints(bp, map)), []);

  // Type change on Q1 → Q1 stale, Q2 untouched.
  const editedType = structuredClone(bp);
  editedType.questions[0].type = 'TRUE_FALSE';
  assert.deepEqual(staleSlots(generated, paperFingerprints(editedType, map)), ['Q1']);

  // Per-item marks change on Q1 → Q1 stale.
  const editedMarks = structuredClone(bp);
  editedMarks.questions[0].items[0].marks = 3;
  assert.deepEqual(staleSlots(generated, paperFingerprints(editedMarks, map)), ['Q1']);

  // Unit change on Q2 → Q2 stale only.
  assert.deepEqual(staleSlots(generated, paperFingerprints(bp, { Q1: { unit: 1 }, Q2: { unit: 1 } })), ['Q2']);
});

test('per-item unit changes flag the slot (items assignment respected)', () => {
  const bp = normalizeBlueprint(manualBp());
  const map = { Q1: { items: { a: 1, b: 2 } }, Q2: { unit: 2 } };
  const generated = paperFingerprints(bp, map);
  assert.deepEqual(staleSlots(generated, paperFingerprints(bp, map)), []);
  const moved = { Q1: { items: { a: 1, b: 1 } }, Q2: { unit: 2 } };
  assert.deepEqual(staleSlots(generated, paperFingerprints(bp, moved)), ['Q1']);
});

test('regenerating clears the flag (fresh snapshot equals current)', () => {
  const bp = normalizeBlueprint(manualBp());
  const before = paperFingerprints(bp, { Q1: { unit: 1 }, Q2: { unit: 2 } });
  const edited = structuredClone(bp);
  edited.questions[0].difficulty = 'Difficult'; // NOT structural → not stale
  const after = paperFingerprints(edited, { Q1: { unit: 1 }, Q2: { unit: 2 } });
  // Difficulty is not part of the fingerprint: an edit that only changes it
  // does not invalidate generated content. (Structural edits do — test above.)
  assert.deepEqual(staleSlots(before, after), []);
  // And a regeneration simply re-snapshots: stale = [] again.
  assert.deepEqual(staleSlots(after, paperFingerprints(edited, { Q1: { unit: 1 }, Q2: { unit: 2 } })), []);
});

test('totals recompute after an edit and drift is detected against the declared total', () => {
  const bp = normalizeBlueprint(manualBp());
  const t1 = liveTotals(bp);
  assert.equal(t1.total, 9);
  assert.equal(t1.drifted, false);

  const edited = structuredClone(bp);
  edited.questions[0].items[0].marks = 3; // 3+2+5 = 10 now
  const t2 = liveTotals(edited);
  assert.equal(t2.total, 10);
  assert.equal(t2.drifted, true);
  assert.equal(t2.declared, 9);
});

test('slotFingerprint is stable across key order and null-safe', () => {
  const a = slotFingerprint({ type: 'MCQ', totalMarks: 3, itemCount: 2, items: [{ label: 'a', marks: 1 }, { label: 'b', marks: 2 }] }, { unit: 1 });
  const b = slotFingerprint({ itemCount: 2, type: 'MCQ', items: [{ marks: 1, label: 'a' }, { marks: 2, label: 'b' }], totalMarks: 3 }, { unit: 1 });
  assert.equal(a, b);
  assert.equal(typeof slotFingerprint(null, null), 'string');
});
