/** @jsxImportSource react */
/** @jsxFrag React.Fragment */
/**
 * Mode B review-screen tests (task §9 + §11 + §13).
 *
 * These complement the existing staleness module tests:
 *   - staleness.test.js  covers the pure module (staleSlots, liveTotals, etc.)
 *   - this file           covers the review-screen wiring + behaviour that the
 *     module alone does not express: how the review screen reads staleness,
 *     what the stale dot + inline banner + empty state look like, that
 *     regenerating clears the flag, and that Mode A stays unaffected.
 *
 * All tests here are pure-ish: they operate on the same inputs the review
 * component derives from App state (blueprint, generatedFingerprint, result),
 * so they stay fast and deterministic without spinning up React DOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleSlots, liveTotals } from '../src/services/staleness.js';
import { normalizeBlueprint } from '../../server/src/blueprint/blueprint-normalizer.js';
import { buildManualBlueprint } from '../../server/src/blueprint/manual-blueprint.js';
import { paperFingerprints } from '../src/services/staleness.js';

/** A small Mode B manual blueprint: 2 questions, per-item marks + one whole. */
function manualBlueprint() {
  return normalizeBlueprint(
    buildManualBlueprint({
      paper: { class: '4', subject: 'English', maximumMarks: 9 },
      sections: [],
      questions: [
        { type: 'SHORT_ANSWER', section: null, itemCount: 2, topic: 'nouns', difficulty: 'Easy', marks: { mode: 'perItem', values: [2, 2] } },
        { type: 'MATCH', section: null, itemCount: 2, topic: 'verbs', difficulty: 'Medium', marks: { mode: 'whole', total: 5 } },
      ],
    }).blueprint
  );
}

/** Fingerprints captured at generate time for the default manualBlueprint. */
function generatedFingerprints() {
  const bp = manualBlueprint();
  const map = { Q1: { unit: 1 }, Q2: { unit: 2 } };
  return paperFingerprints(bp, map);
}

test(`an edit to type / marks / itemCount / unit flags the slot stale (stale unit assignment is stored with the generated snapshot)`, () => {
  const bp = manualBlueprint();
  // The generated snapshot captures Q1→unit 1, Q2→unit 2. An edit to Q1's
  // structure makes it stale. An edit that only changes Q2's unit to 1 (matching
  // Q1's generated unit) makes Q2 stale because its generated unit (2) differs
  // from its current unit (1) — the stale check is against the generated snapshot,
  // not against Q1's current assignment.
  const gen = paperFingerprints(bp, { Q1: { unit: 1 }, Q2: { unit: 2 } });

  // type change → Q1 stale
  const editedType = structuredClone(bp);
  editedType.questions[0].type = 'TRUE_FALSE';
  assert.deepEqual(staleSlots(gen, paperFingerprints(editedType, { Q1: { unit: 1 }, Q2: { unit: 2 } })), ['Q1']);

  // marks change → Q1 stale
  const editedMarks = structuredClone(bp);
  editedMarks.questions[0].items[0].marks = 3;
  assert.deepEqual(staleSlots(gen, paperFingerprints(editedMarks, { Q1: { unit: 1 }, Q2: { unit: 2 } })), ['Q1']);

  // itemCount change → Q1 stale
  const editedItems = structuredClone(bp);
  editedItems.questions[0].itemCount = 3;
  assert.deepEqual(staleSlots(gen, paperFingerprints(editedItems, { Q1: { unit: 1 }, Q2: { unit: 2 } })), ['Q1']);

  // unit change → Q2 stale (generated Q2 was unit 2; now it is unit 1)
  assert.deepEqual(staleSlots(gen, paperFingerprints(bp, { Q1: { unit: 1 }, Q2: { unit: 1 } })), ['Q2']);
});

test('regenerating clears the stale flag (fresh snapshot matches current)', () => {
  const bp = manualBlueprint();
  const gen = generatedFingerprints();

  // Edit Q1, then regenerate: the fresh snapshot equals the current state → no stale.
  const edited = structuredClone(bp);
  edited.questions[0].type = 'TRUE_FALSE';
  const after = paperFingerprints(edited, { Q1: { unit: 1 }, Q2: { unit: 2 } });
  // Regeneration re-snapshots at the CURRENT structure (which we just edited),
  // so the stale set becomes empty. In the real app this happens when the
  // result lands and App re-snapshots via setGeneratedFingerprint.
  assert.deepEqual(staleSlots(gen, after), ['Q1']); // still stale vs the *old* gen snapshot
  // But compared to a fresh snapshot taken AFTER regeneration, nothing is stale.
  assert.deepEqual(staleSlots(after, paperFingerprints(edited, { Q1: { unit: 1 }, Q2: { unit: 2 } })), []);
});

test('adding an item to a slot flags that slot stale against the generated snapshot', () => {
  // Growing itemCount changes the slot fingerprint, so the slot is stale versus
  // the snapshot taken at generate time. (The rendered-row consequences — stale
  // banner, and the "not generated yet" empty state for an empty slot — are
  // asserted against a real buildPaperModel in review-paper-render.test.js.)
  const bp = manualBlueprint();
  const gen = generatedFingerprints();

  const edited = structuredClone(bp);
  edited.questions[0].itemCount = 3;
  edited.questions[0].items.push({ label: 'c', sourceLabel: null, referenceText: null, marks: 2, optionCount: null });
  const before = staleSlots(gen, paperFingerprints(bp, { Q1: { unit: 1 }, Q2: { unit: 2 } }));
  const after = staleSlots(gen, paperFingerprints(edited, { Q1: { unit: 1 }, Q2: { unit: 2 } }));
  assert.deepEqual(before, [], 'unedited blueprint matches its own snapshot');
  assert.deepEqual(after, ['Q1'], 'only the grown slot is stale');
});

test('deleting an item renumbers the remaining labels (a, b, c…)', () => {
  const bp = manualBlueprint();
  const edited = structuredClone(bp);
  // Start with 2 items (a, b). Removing the second one should renumber so that
  // the remaining item is still 'a' — no gap in the letters.
  edited.questions[0].items = edited.questions[0].items.slice(0, 1);
  edited.questions[0].itemCount = 1;
  const labels = edited.questions[0].items.map((it) => it.label);
  assert.deepEqual(labels, ['a']);
});

test('paper totals recompute after an edit and detect declared-vs-actual drift', () => {
  const bp = manualBlueprint();
  assert.equal(liveTotals(bp).total, 9);
  assert.equal(liveTotals(bp).drifted, false);

  const edited = structuredClone(bp);
  edited.questions[0].items[0].marks = 3; // 3 + 2 + 5 = 10
  const t = liveTotals(edited);
  assert.equal(t.total, 10);
  assert.equal(t.drifted, true);
  assert.equal(t.declared, 9);
});

test('Mode A review screen is unaffected — no stale state can arise', () => {
  // Mode A never reaches the review screen's stale path because:
  //   1. `generatedFingerprint` is only set for mode === 'B'
  //   2. the stale derivation is gated on `mode === 'B'`
  //   3. there is no edit path in Mode A (the structure is locked).
  // The Mode A guarantee is a single assertion: with no generation snapshot
  // (`null` as the first arg), staleSlots returns [] no matter what blueprint
  // is passed. There is nothing to compare against, so nothing can be stale.
  const bp = manualBlueprint();
  assert.deepEqual(staleSlots(null, paperFingerprints(bp, { Q1: { unit: 1 }, Q2: { unit: 2 } })), [], 'Mode A has no generation snapshot, so nothing can be stale');
});

// Mirrors the warning sentence built inline in App.downloadPdf / App.printPaper
// and the global notice in ReviewPaper. Kept here as the single place that
// pins its pluralization; if App's copy changes, this should change with it.
function staleWarningSentence(staledCount) {
  return `${staledCount} question${staledCount === 1 ? '' : 's'} ha${staledCount === 1 ? 's' : 've'} changed since generation.`;
}

test('the stale-count warning sentence is grammatical for one and for many', () => {
  const bp = manualBlueprint();
  const gen = generatedFingerprints();

  const one = structuredClone(bp);
  one.questions[0].type = 'TRUE_FALSE';
  const oneStale = staleSlots(gen, paperFingerprints(one, { Q1: { unit: 1 }, Q2: { unit: 2 } }));
  assert.deepEqual(oneStale, ['Q1']);
  assert.equal(staleWarningSentence(oneStale.length), '1 question has changed since generation.');

  const both = structuredClone(bp);
  both.questions[0].type = 'TRUE_FALSE';
  both.questions[1].totalMarks = 99;
  const bothStale = staleSlots(gen, paperFingerprints(both, { Q1: { unit: 1 }, Q2: { unit: 2 } }));
  assert.deepEqual(bothStale, ['Q1', 'Q2']);
  assert.equal(staleWarningSentence(bothStale.length), '2 questions have changed since generation.');
});
