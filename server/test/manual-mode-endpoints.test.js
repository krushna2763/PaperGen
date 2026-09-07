/**
 * Mode B endpoint-level unit tests (no network):
 *   - templates persist STRUCTURE ONLY and are scoped to class+subject
 *   - the units-if-sent check blocks (naming slots) and passes cleanly
 *   - an unmatched topic yields a WARNING, never an error
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTemplate, saveTemplate, listTemplates, getTemplate, deleteTemplate,
} from '../src/services/template-store.js';
import { unitErrorsFor } from '../src/blueprint/manual-blueprint.js';
import { buildManualBlueprint } from '../src/blueprint/manual-blueprint.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────
const FULL_BLUEPRINT = {
  paper: { class: '4', subject: 'English', examTitle: 'Unit Test', maximumMarks: 11 },
  sections: [{ name: 'SECTION A', title: 'Grammar', questionNumbers: ['Q1', 'Q2'] }],
  questions: [
    { label: 'Q1', type: 'MCQ', itemCount: 3, optionCount: 4, difficulty: 'Easy',
      referenceItems: ['nouns and their kinds'], section: 'SECTION A',
      marks: { perItem: 1, itemCount: 3, total: 3, expression: null },
      totalMarks: 3, marksComplete: true, itemsIndependent: true,
      items: [{ label: 'a', marks: 1 }, { label: 'b', marks: 1 }, { label: 'c', marks: 1 }],
      itemMarks: [1, 1, 1] },
    { label: 'Q2', type: 'MATCH_THE_FOLLOWING', itemCount: 3, difficulty: 'Medium',
      referenceItems: ['The Tinkling Bells'], section: 'SECTION A',
      marks: { perItem: null, itemCount: 3, total: 3, expression: null },
      totalMarks: 3, marksComplete: true, itemsIndependent: true,
      items: [], itemMarks: [] },
    { label: 'Q3', type: 'SHORT_ANSWER', itemCount: 3, difficulty: 'Difficult',
      referenceItems: ['nouns and their kinds'], section: 'SECTION A',
      marks: { perItem: null, itemCount: 3, total: 5, expression: null },
      totalMarks: 5, marksComplete: true, itemsIndependent: true,
      items: [{ label: 'a', marks: 1 }, { label: 'b', marks: 2 }, { label: 'c', marks: 2 }],
      itemMarks: [1, 2, 2] },
  ],
  totalQuestions: 3,
  totalMarks: 11,
  marksComplete: true,
  blueprintWarnings: [],
};

const POISONED = structuredClone(FULL_BLUEPRINT);
POISONED.questions[0].items[0].referenceText = 'leaked topic anchor';
POISONED.questions[1].referenceItems = ['leaked topic'];
POISONED.questions[2].topicMatch = { matched: true, chunkCount: 4 };
POISONED.questions[0].items[0].marks = 99; // will be preserved (marks ARE structure)

// ─── Templates ───────────────────────────────────────────────────────────────
test('template save + reload: same structure, no units/topics/anchors/generated content', () => {
  const { errors, template } = buildTemplate({
    name: 'Unit test — grammar',
    class: '4',
    subject: 'English',
    blueprint: POISONED,
  });
  assert.deepEqual(errors, []);

  const saved = saveTemplate(template);
  const reloaded = getTemplate(saved.id);
  assert.ok(reloaded);

  // Structure survives intact.
  assert.equal(reloaded.blueprint.questions.length, 3);
  assert.deepEqual(reloaded.blueprint.questions[2].items.map((i) => i.marks), [1, 2, 2]);
  assert.equal(reloaded.blueprint.questions[0].type, 'MCQ');
  assert.equal(reloaded.blueprint.questions[0].optionCount, 4);

  // NON-structure was stripped by the sanitizer.
  assert.equal(reloaded.blueprint.questions[1].referenceItems, undefined);
  assert.equal(reloaded.blueprint.questions[0].items[0].referenceText, undefined);
  assert.equal(reloaded.blueprint.questions[2].topicMatch, undefined);
  assert.ok(reloaded.blueprint.questions.every((q) => !('unit' in q)));
  assert.ok(reloaded.blueprint.questions.every((q) => !('topicMatch' in q)));
});

test('templates are scoped to class and subject (taken from blueprint.paper — the source of truth)', () => {
  const bp4 = structuredClone(FULL_BLUEPRINT);
  const bp5 = structuredClone(FULL_BLUEPRINT); bp5.paper.class = '5';
  const bpMaths = structuredClone(FULL_BLUEPRINT); bpMaths.paper.subject = 'Maths';
  const t1 = buildTemplate({ name: 'A', blueprint: bp4 }).template;
  saveTemplate(t1);
  const t2 = buildTemplate({ name: 'B', blueprint: bp5 }).template;
  saveTemplate(t2);
  const t3 = buildTemplate({ name: 'C', blueprint: bpMaths }).template;
  saveTemplate(t3);

  const english4 = listTemplates({ class: '4', subject: 'English' });
  assert.ok(english4.every((t) => t.class === '4' && t.subject === 'English'));
  assert.ok(english4.some((t) => t.id === t1.id));
  assert.ok(!english4.some((t) => t.id === t2.id));
  assert.ok(!english4.some((t) => t.id === t3.id));

  assert.equal(deleteTemplate(t1.id), true);
  assert.equal(getTemplate(t1.id), null);
});

test('template validation rejects missing name / missing paper.class / empty questions', () => {
  assert.ok(buildTemplate({ name: '', blueprint: FULL_BLUEPRINT }).errors.length > 0);
  const noClass = structuredClone(FULL_BLUEPRINT); noClass.paper.class = null;
  assert.ok(buildTemplate({ name: 'X', blueprint: noClass }).errors.length > 0);
  const empty = structuredClone(FULL_BLUEPRINT);
  empty.questions = [];
  assert.ok(buildTemplate({ name: 'X', blueprint: empty }).errors.length > 0);
});

// ─── Units-if-sent blocking check ────────────────────────────────────────────
test('unitErrorsFor blocks a unit with no indexed notes, naming its slot', async () => {
  const { blueprint } = buildManualBlueprint({
    paper: { class: '4', subject: 'English' },
    sections: [],
    questions: [
      { type: 'SHORT_ANSWER', itemCount: 2, topic: 'nouns', marks: { mode: 'perItem', values: [1, 1] } },
    ],
  });
  const { qdrantStore } = await import('../src/rag/qdrant.js');
  const missing = mock.method(qdrantStore, 'unitHasNotes', async () => false);
  try {
    const errors = await unitErrorsFor(blueprint, {
      class: '4', subject: 'English', slotUnitMap: { Q1: { unit: 7 } },
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Q1/);
    assert.match(errors[0].message, /unit "7"/);
    assert.match(errors[0].message, /no notes indexed/);
  } finally {
    missing.mock.restore();
  }
});

test('unitErrorsFor passes when every referenced unit has notes', async () => {
  const { blueprint } = buildManualBlueprint({
    paper: { class: '4', subject: 'English' },
    sections: [],
    questions: [
      { type: 'SHORT_ANSWER', itemCount: 2, topic: 'nouns', marks: { mode: 'perItem', values: [1, 1] } },
      { type: 'MATCH', itemCount: 2, topic: 'The Tinkling Bells', marks: { mode: 'whole', total: 4 } },
    ],
  });
  const { qdrantStore } = await import('../src/rag/qdrant.js');
  const has = mock.method(qdrantStore, 'unitHasNotes', async () => true);
  try {
    const errors = await unitErrorsFor(blueprint, {
      class: '4', subject: 'English', slotUnitMap: { Q1: { items: { a: 1, b: 2 } }, Q2: { unit: 2 } },
    });
    assert.deepEqual(errors, []);
  } finally {
    has.mock.restore();
  }
});

test('unitErrorsFor skips when no slotUnitMap is sent (confirm screen enforces later)', async () => {
  const { blueprint } = buildManualBlueprint({
    paper: { class: '4', subject: 'English' },
    sections: [],
    questions: [
      { type: 'SHORT_ANSWER', itemCount: 1, topic: 'nouns', marks: { mode: 'perItem', values: [2] } },
    ],
  });
  const errors = await unitErrorsFor(blueprint, { class: '4', subject: 'English', slotUnitMap: null });
  assert.deepEqual(errors, []);
});

// ─── Warnings, never errors ──────────────────────────────────────────────────
test('marks-sum mismatch and no-topic are warnings, not blocking errors', () => {
  const out = buildManualBlueprint({
    paper: { class: '4', subject: 'English', maximumMarks: 30 },
    sections: [],
    questions: [
      { type: 'SHORT_ANSWER', itemCount: 2, topic: '', marks: { mode: 'perItem', values: [2, 2] } },
    ],
  });
  assert.equal(out.ok, true, 'warnings must not block');
  const fields = out.warnings.map((w) => w.field);
  assert.ok(fields.includes('marksTotal'));
  assert.ok(fields.includes('topic'));
});
