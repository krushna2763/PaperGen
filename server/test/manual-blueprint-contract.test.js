/**
 * RED-FIRST contract tests (task: "a manual blueprint passes blueprint-validator
 * with no change to the validator"; "items[].label is lowercase a/b/c, matching
 * what the extractor emits"; "itemsIndependent is always a boolean, never null";
 * per-item marks survival; slot.difficulty passthrough; blocking validation).
 *
 * The builder under test (`buildManualBlueprint`) does not exist yet — this file
 * MUST fail on first run. It goes green only when the manual builder emits a
 * blueprint that the UNMODIFIED shared normalizer + validator accept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBlueprint } from '../src/blueprint/blueprint-normalizer.js';
import { checkQuestion, validatePaper } from '../src/blueprint/blueprint-validator.js';
import { buildManualBlueprint } from '../src/blueprint/manual-blueprint.js';

// ─── Teacher form payload (Mode B input) ─────────────────────────────────────
const form = {
  paper: { class: '4', subject: 'English', examTitle: 'Unit Test', maximumMarks: 11 },
  sections: [{ name: 'SECTION A', title: 'Grammar', questionNumbers: ['Q1', 'Q2', 'Q3'] }],
  questions: [
    {
      // MCQ: 3 items × 1 mark, 4 options each
      type: 'MCQ',
      section: 'SECTION A',
      itemCount: 3,
      optionCount: 4,
      difficulty: 'Easy',
      topic: 'nouns and their kinds',
      marks: { mode: 'perItem', values: [1, 1, 1] },
    },
    {
      // MATCH: 3 pairs, whole-question marks
      type: 'MATCH',
      section: 'SECTION A',
      itemCount: 3,
      difficulty: 'Medium',
      topic: 'The Tinkling Bells',
      marks: { mode: 'whole', total: 3 },
    },
    {
      // SHORT_ANSWER: non-uniform per-item marks — 1,2,2 = 5
      type: 'SHORT_ANSWER',
      section: 'SECTION A',
      itemCount: 3,
      difficulty: 'Difficult',
      topic: 'nouns and their kinds',
      marks: { mode: 'perItem', values: [1, 2, 2] },
    },
  ],
};

const { blueprint } = buildManualBlueprint(form);

test('RED guard: builder module exists and returns the contract shape', () => {
  assert.ok(blueprint, 'buildManualBlueprint returned nothing');
  assert.equal(blueprint.totalQuestions, 3);
  assert.equal(blueprint.marksComplete, true, 'Mode B always knows its marks');
});

test('manual blueprint passes the UNMODIFIED shared normalizer', () => {
  const normalized = normalizeBlueprint(blueprint);
  assert.ok(normalized, 'normalizeBlueprint rejected the manual blueprint');
  assert.equal(normalized.questions.length, 3);
  assert.equal(normalized.totalMarks, 11); // 3 + 3 + 5
});

test('items[].label is lowercase a/b/c, positional, matching extractor emission', () => {
  const mcq = blueprint.questions[0];
  assert.deepEqual(mcq.items.map((it) => it.label), ['a', 'b', 'c']);
  assert.equal(mcq.items[0].sourceLabel, null, 'builder labels are positional, not recovered');
  for (const q of blueprint.questions) {
    for (const [i, it] of q.items.entries()) {
      assert.equal(it.label, String.fromCharCode(97 + i));
      assert.match(it.label, /^[a-z]$/, `item label not lowercase a-z: ${it.label}`);
    }
  }
});

test('itemsIndependent is always a boolean, never null', () => {
  for (const q of blueprint.questions) {
    assert.equal(typeof q.itemsIndependent, 'boolean');
  }
  // All seven registry types are independent; MATCH stores pairs in itemCount.
  assert.equal(blueprint.questions[1].itemsIndependent, true);
});

test('per-item marks differing within a question survive the builder', () => {
  const sa = blueprint.questions[2];
  assert.deepEqual(sa.items.map((it) => it.marks), [1, 2, 2]);
  assert.equal(sa.totalMarks, 5);
  assert.equal(sa.marksComplete, true);
  assert.deepEqual(sa.itemMarks, [1, 2, 2]);
  assert.equal(sa.marks.perItem, null, 'non-uniform marks must not fake a perItem value');
});

test('MATCH slot mirrors extractor emission: items [], itemCount = pairs, whole marks', () => {
  const match = blueprint.questions[1];
  assert.deepEqual(match.items, []);
  assert.equal(match.itemCount, 3);
  assert.equal(match.totalMarks, 3);
  assert.equal(match.marksComplete, true);
});

test('teacher topic becomes the retrieval topic anchor (referenceItems)', () => {
  const mcq = blueprint.questions[0];
  assert.deepEqual(mcq.referenceItems, ['nouns and their kinds']);
  assert.equal(mcq.items[0].referenceText, 'nouns and their kinds');
  // NO-topic question: anchor arrays stay empty, never padded
  const noTopicForm = structuredClone(form);
  noTopicForm.questions[0].topic = '';
  const { blueprint: bp2 } = buildManualBlueprint(noTopicForm);
  assert.deepEqual(bp2.questions[0].referenceItems, []);
});

test('per-question difficulty rides the slot (new field, both paths)', () => {
  assert.equal(blueprint.questions[0].difficulty, 'Easy');
  assert.equal(blueprint.questions[2].difficulty, 'Difficult');
  // and the shared normalizer must carry it through for BOTH paths
  const normalized = normalizeBlueprint(blueprint);
  assert.equal(normalized.questions[0].difficulty, 'Easy');
  assert.equal(normalized.questions[2].difficulty, 'Difficult');
});

test('manual blueprint slots pass the unmodified validator against a conforming generated paper', () => {
  // Simulate what the generator + normalizeGeneratedQuestion produce for a slot
  // when the slot is authoritative (type/marks from slot, per-part marks stamped).
  const generated = blueprint.questions.map((q) => ({
    text: q.items.length > 0 ? q.instruction : 'Match the columns.',
    type: q.type,
    marks: q.totalMarks,
    section: q.section,
    subParts: q.items.map((it) => ({
      text: `New item on ${it.referenceText}`,
      marks: it.marks,
      ...(q.type === 'MCQ' ? { options: ['x', 'y', 'z', 'w'] } : {}),
    })),
    columns: q.type === 'MATCH_THE_FOLLOWING' ? { left: ['A1', 'A2', 'A3'], right: ['B1', 'B2', 'B3'] } : undefined,
  }));
  const v = validatePaper(generated, blueprint);
  const failed = v.results.filter((r) => !r.ok);
  assert.deepEqual(failed.map((r) => r.reasons), [], `validator rejected: ${JSON.stringify(failed)}`);
  assert.equal(v.ok, true);
});

test('checkQuestion accepts one manual slot directly (no normalizer)', () => {
  const mcqSlot = blueprint.questions[0];
  const g = {
    text: mcqSlot.instruction,
    type: 'MCQ',
    marks: 3,
    section: mcqSlot.section, // the generator stamps sectionName onto every generated question
    subParts: mcqSlot.items.map((it) => ({ text: `new item on ${it.referenceText}`, options: ['x', 'y', 'z', 'w'], marks: it.marks })),
  };
  const c = checkQuestion(g, mcqSlot);
  assert.deepEqual(c.reasons, []);
});

test('blocking validation: unknown type names its slot', () => {
  const bad = structuredClone(form);
  bad.questions[0].type = 'HAUNTED_CROSSWORD';
  const out = buildManualBlueprint(bad, { validate: true, class: '4', subject: 'English' });
  assert.equal(out.ok, false);
  const msgs = out.errors.map((e) => e.message).join(' | ');
  assert.match(msgs, /Q1/);
  assert.match(msgs, /HAUNTED_CROSSWORD/i);
});

test('blocking validation: zero items / <2 options / missing marks name their slot', () => {
  const bad = structuredClone(form);
  bad.questions[2].itemCount = 0;
  bad.questions[0].optionCount = 1;
  bad.questions[2].marks = { mode: 'perItem', values: [null, 2, 2] };
  const out = buildManualBlueprint(bad, { validate: true, class: '4', subject: 'English' });
  const msgs = out.errors.map((e) => e.message).join(' | ');
  assert.match(msgs, /Q3/);
  assert.match(msgs, /at least 1/i);
  assert.match(msgs, /Q1/);
  assert.match(msgs, /at least 2/i);
  assert.match(msgs, /marks/i);
});

test('blocking validation: question outside declared sections names its slot', () => {
  const bad = structuredClone(form);
  bad.questions[2].section = 'SECTION Z';
  const out = buildManualBlueprint(bad, { validate: true, class: '4', subject: 'English' });
  assert.equal(out.ok, false);
  assert.match(out.errors.map((e) => e.message).join(' | '), /Q3/);
  assert.match(out.errors.map((e) => e.message).join(' | '), /SECTION Z/);
});

test('warnings ride blueprintWarnings: marks-sum mismatch and no-topic', () => {
  const warnForm = structuredClone(form);
  warnForm.paper.maximumMarks = 30; // blueprint sums to 11
  warnForm.questions[2].topic = '';
  const { blueprint: bp2, warnings: w } = buildManualBlueprint(warnForm);
  const fields = w.map((x) => x.field);
  assert.ok(fields.includes('marksTotal'), 'expected a marksTotal warning');
  assert.ok(fields.includes('topic'), 'expected a topic warning');
  // And they survive into the blueprint's own warning list (generate-time visibility).
  assert.ok(bp2.blueprintWarnings.some((x) => x.field === 'marksTotal'));
  assert.ok(bp2.blueprintWarnings.some((x) => x.field === 'topic'));
});
