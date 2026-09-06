/**
 * slotUnitMap validation — every failure blocking and slot-specific.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { validateSlotUnitMap } from '../src/blueprint/slot-unit-map.js';
import { qdrantStore } from '../src/rag/qdrant.js';

const BP = {
  paper: { class: '4', subject: 'English' },
  questions: [
    { label: 'Q1', itemsIndependent: true, itemCount: 1, items: [] },
    { label: 'Q10', itemsIndependent: true, itemCount: 4, items: [
      { label: 'a', marks: 3 }, { label: 'b', marks: 3 }, { label: 'c', marks: 3 }, { label: 'd', marks: 3 },
    ] },
    { label: 'Q14', itemsIndependent: false, itemCount: 3, items: [
      { label: 'a', marks: 2 }, { label: 'b', marks: 2 }, { label: 'c', marks: 1 },
    ] },
  ],
};
const ctx = { class: '4', subject: 'English' };
const full = () => ({
  Q1: { unit: 'u1' },
  Q10: { items: { a: 'u1', b: 'u1', c: 'u2', d: 'u2' } },
  Q14: { unit: 'u1' },
});

beforeEach(() => {
  mock.method(qdrantStore, 'unitHasNotes', async ({ unit }) => unit === 'u1' || unit === 'u2');
});
afterEach(() => mock.restoreAll());

test('a complete, valid map passes', async () => {
  const r = await validateSlotUnitMap(full(), BP, ctx);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('rejects a missing slot, naming it', async () => {
  const m = full(); delete m.Q10;
  const r = await validateSlotUnitMap(m, BP, ctx);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.slot === 'Q10' && /missing/i.test(e.message)));
});

test('rejects an unknown slot id', async () => {
  const m = full(); m.Q99 = { unit: 'u1' };
  const r = await validateSlotUnitMap(m, BP, ctx);
  assert.ok(r.errors.some((e) => e.slot === 'Q99' && /unknown/i.test(e.message)));
});

test('rejects a wrong item label', async () => {
  const m = full(); m.Q10 = { items: { a: 'u1', b: 'u1', c: 'u2', e: 'u2' } };
  const r = await validateSlotUnitMap(m, BP, ctx);
  assert.ok(r.errors.some((e) => e.slot === 'Q10' && /item "e"/.test(e.message)));
});

test('rejects per-item assignment when itemsIndependent is false', async () => {
  const m = full(); m.Q14 = { items: { a: 'u1', b: 'u1', c: 'u2' } };
  const r = await validateSlotUnitMap(m, BP, ctx);
  assert.ok(r.errors.some((e) => e.slot === 'Q14' && /itemsIndependent=false/.test(e.message)));
});

test('rejects a unit that has no notes indexed', async () => {
  const m = full(); m.Q1 = { unit: 'u404' };
  const r = await validateSlotUnitMap(m, BP, ctx);
  assert.ok(r.errors.some((e) => /Unit "u404" has no notes/.test(e.message)));
});
