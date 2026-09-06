/**
 * Pure-helper tests for the confirm screen. No React, no DOM — run with
 * `node --test`. Covers slot keying, per-item marks resolution, expandability,
 * default assignment, slotUnitMap construction (both forms + uniform-after-
 * expansion), and running totals (null marks, unassigned, ANY_N).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slotKey,
  anyText,
  isApproximate,
  itemLabels,
  itemMarksOf,
  isExpandable,
  isMixed,
  sharedUnit,
  isUnassigned,
  unassignedList,
  defaultAssign,
  buildSlotUnitMap,
  runningTotals,
} from '../src/components/blueprintUnits.js';

const UNITS = [
  { id: '1', label: 'Unit 1', chunkCount: 6 },
  { id: '2', label: 'Unit 2', chunkCount: 4 },
];

// Q1: single-stem 5-mark.            Q10: any-three, 4 items 3/3/2/1, independent.
// Q14: passage, 3 items, NOT independent.   Q20: 3 items, per-item marks unknown.
const BP = {
  totalQuestions: 4,
  sections: [{ name: 'SECTION A' }],
  totalMarks: 30,
  blueprintWarnings: [{ field: 'itemMarks', label: 'Q20', warning: 'Per-item marks incomplete.' }],
  questions: [
    { label: 'Q1', type: 'LONG_ANSWER', itemsIndependent: true, totalMarks: 5, marksComplete: true, optionalRule: null, items: [] },
    { label: 'Q10', type: 'SHORT_ANSWER', itemsIndependent: true, totalMarks: 9, marksComplete: false,
      optionalRule: { kind: 'ANY_N', n: 3 },
      items: [
        { label: 'a', sourceLabel: 'a', marks: 3 },
        { label: 'b', sourceLabel: 'b', marks: 3 },
        { label: 'c', sourceLabel: 'c', marks: 2 },
        { label: 'd', sourceLabel: 'd', marks: 1 },
      ] },
    { label: 'Q14', type: 'PASSAGE', itemsIndependent: false, totalMarks: 5, marksComplete: true, optionalRule: null,
      items: [{ label: 'a', marks: 2 }, { label: 'b', marks: 2 }, { label: 'c', marks: 1 }] },
    { label: 'Q20', type: 'SHORT_ANSWER', itemsIndependent: true, totalMarks: 6, marksComplete: false, optionalRule: null,
      items: [{ label: 'a', marks: null }, { label: 'b', marks: null }, { label: 'c', marks: null }] },
  ],
};
const q = (label) => BP.questions.find((x) => x.label === label);

test('slotKey uses the guaranteed label', () => {
  assert.equal(slotKey(q('Q10'), 1), 'Q10');
  assert.equal(slotKey({ number: 7 }, 0), 'Q7');
  assert.equal(slotKey({}, 4), 'Q5');
});

test('anyText / isApproximate reflect the optional rule', () => {
  assert.equal(anyText(q('Q10')), 'any three');
  assert.equal(isApproximate(q('Q10')), true);
  assert.equal(isApproximate(q('Q1')), false);
});

test('itemMarksOf keeps per-item marks verbatim, never distributes', () => {
  assert.deepEqual(itemMarksOf(q('Q10')).map((x) => x.marks), [3, 3, 2, 1]);
  // unknown per-item marks stay null — NOT 2,2,2
  assert.deepEqual(itemMarksOf(q('Q20')).map((x) => x.marks), [null, null, null]);
  // single-stem question -> one row carrying the total
  assert.deepEqual(itemMarksOf(q('Q1')), [{ label: 'a', marks: 5 }]);
});

test('canonical item labels come from the blueprint, not sourceLabel', () => {
  assert.deepEqual(itemLabels(q('Q10')), ['a', 'b', 'c', 'd']);
});

test('isExpandable: multi-item independent yes; shared-stimulus no; single-item no', () => {
  assert.equal(isExpandable(q('Q10')), true);
  assert.equal(isExpandable(q('Q14')), false); // itemsIndependent === false
  assert.equal(isExpandable(q('Q1')), false); // one item
});

test('defaultAssign spreads round-robin across units; empty units -> all null', () => {
  const a = defaultAssign(BP, UNITS);
  assert.deepEqual(Object.keys(a), ['Q1', 'Q10', 'Q14', 'Q20']);
  assert.deepEqual([a.Q1.unit, a.Q10.unit, a.Q14.unit, a.Q20.unit], ['1', '2', '1', '2']);
  const none = defaultAssign(BP, []);
  assert.ok(Object.values(none).every((x) => x.unit === null));
});

test('isMixed / sharedUnit / isUnassigned', () => {
  assert.equal(isMixed(q('Q10'), { unit: null, items: { a: '1', b: '1', c: '2', d: '2' } }), true);
  assert.equal(isMixed(q('Q10'), { unit: null, items: { a: '1', b: '1', c: '1', d: '1' } }), false);
  assert.equal(sharedUnit(q('Q10'), { unit: null, items: { a: '1', b: '1', c: '1', d: '1' } }), '1');
  assert.equal(sharedUnit(q('Q1'), { unit: '2', items: {} }), '2');
  assert.equal(isUnassigned(q('Q10'), { unit: null, items: { a: '1', b: null, c: '2', d: '2' } }), true);
  assert.equal(isUnassigned(q('Q1'), { unit: null, items: {} }), true);
  assert.equal(isUnassigned(q('Q1'), { unit: '1', items: {} }), false);
});

test('unassignedList names the still-blank questions', () => {
  const a = { Q1: { unit: '1', items: {} }, Q10: { unit: '1', items: {} }, Q14: { unit: null, items: {} } };
  assert.deepEqual(unassignedList(BP, a), ['Q14', 'Q20']);
});

test('buildSlotUnitMap: { unit } for uniform, { items } only for genuinely mixed', () => {
  const a = {
    Q1: { unit: '1', items: {} },
    Q10: { unit: null, items: { a: '1', b: '1', c: '2', d: '2' } }, // mixed
    Q14: { unit: '2', items: {} },
    Q20: { unit: '1', items: {} },
  };
  const map = buildSlotUnitMap(BP, a);
  assert.deepEqual(map.Q1, { unit: '1' });
  assert.deepEqual(map.Q10, { items: { a: '1', b: '1', c: '2', d: '2' } });
  assert.deepEqual(map.Q14, { unit: '2' });
});

test('buildSlotUnitMap: expanded row whose items all resolve to one unit sends { unit }', () => {
  const a = { Q10: { unit: null, items: { a: '2', b: '2', c: '2', d: '2' } } };
  assert.deepEqual(buildSlotUnitMap(BP, a).Q10, { unit: '2' });
});

test('runningTotals: null-mark items excluded (unknownItems); known marks bucketed', () => {
  const a = {
    Q1: { unit: '1', items: {} },                                  // 5 -> u1
    Q10: { unit: null, items: { a: '1', b: '1', c: '2', d: '2' } }, // 3+3 -> u1, 2+1 -> u2 (approx)
    Q14: { unit: '2', items: {} },                                  // 5 -> u2
    Q20: { unit: '1', items: {} },                                  // all null -> unknownItems +3
  };
  const r = runningTotals(BP, a, UNITS);
  assert.equal(r.totals['1'], 5 + 6);
  assert.equal(r.totals['2'], 3 + 5);
  assert.equal(r.unassigned, 0);
  assert.equal(r.unknownItems, 3);
  assert.equal(r.approximate, true); // Q10 is ANY_N and contributed
});

test('runningTotals: an unassigned question with known marks fills the unassigned bucket', () => {
  const a = { Q1: { unit: null, items: {} }, Q10: { unit: null, items: {} }, Q14: { unit: null, items: {} }, Q20: { unit: null, items: {} } };
  const r = runningTotals(BP, a, UNITS);
  assert.equal(r.totals['1'], 0);
  assert.equal(r.unassigned, 5 + 9 + 5); // Q1 + Q10(3+3+2+1) + Q14; Q20 all-null -> unknown
  assert.equal(r.unknownItems, 3);
  assert.equal(r.approximate, false); // nothing contributed to a unit
});
