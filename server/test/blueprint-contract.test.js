/**
 * Blueprint contract additions (task section 3):
 *   label, itemsIndependent, items[].label  — always present, never null
 *   items[].marks                            — real value or null, NEVER an even guess
 *   marksComplete                            — per question
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBlueprint } from '../src/blueprint/blueprint-extractor.js';

// questionExtractor output shape: main questions + their (a)(b)(c) sub-parts.
const main = (num, text, over = {}) => ({ questionNumber: num, parentQuestionNumber: null, section: null, type: 'UNKNOWN', text, options: [], marks: null, metadata: {}, ...over });
const sub = (parent, letter, text, marks = null) => ({ questionNumber: `${parent}(${letter})`, parentQuestionNumber: parent, section: null, type: 'UNKNOWN', text, options: [], marks, metadata: {} });

const QUESTIONS = [
  // Q1 — grouped, per-item marks recoverable
  main('Q1', 'Answer the following questions 3x4=12'),
  sub('Q1', 'a', 'Explain the water cycle.', 3),
  sub('Q1', 'b', 'Describe the nitrogen cycle.', 3),
  sub('Q1', 'c', 'What is transpiration?', 3),
  sub('Q1', 'd', 'Define condensation.', 3),
  // Q2 — grouped, per-item marks NOT recoverable (only a bare total)
  main('Q2', 'Answer briefly 6'),
  sub('Q2', 'a', 'Name two herbivores.'),
  sub('Q2', 'b', 'Name two carnivores.'),
  sub('Q2', 'c', 'Name two omnivores.'),
  // Q3 — passage-based: items share a stimulus
  main('Q3', 'Read the given passage and answer the questions that follow 5'),
  sub('Q3', 'a', 'Who is the narrator?'),
  sub('Q3', 'b', 'Where does the story take place?'),
];

const bp = extractBlueprint({ questions: QUESTIONS, text: '' });

test('every question has a non-null, non-empty label and a boolean itemsIndependent', () => {
  assert.ok(bp.questions.length >= 3);
  for (const q of bp.questions) {
    assert.ok(typeof q.label === 'string' && q.label.length > 0, `bad label: ${JSON.stringify(q.label)}`);
    assert.equal(typeof q.itemsIndependent, 'boolean', `itemsIndependent not boolean for ${q.label}`);
  }
});

test('every item carries a non-null lowercase-letter label, in order', () => {
  for (const q of bp.questions) {
    q.items.forEach((it, i) => {
      assert.equal(it.label, String.fromCharCode(97 + i), `${q.label} item ${i} label`);
    });
  }
});

test('recoverable per-item marks are kept verbatim; marksComplete true', () => {
  const q1 = bp.questions.find((q) => q.label === 'Q1');
  assert.deepEqual(q1.items.map((it) => it.marks), [3, 3, 3, 3]);
  assert.equal(q1.marksComplete, true);
});

test('unrecoverable per-item marks return null — NOT an evenly-distributed guess', () => {
  const q2 = bp.questions.find((q) => q.label === 'Q2');
  assert.equal(q2.items.length, 3);
  assert.ok(q2.items.every((it) => it.marks === null), `expected all null, got ${JSON.stringify(q2.items.map((i) => i.marks))}`);
  assert.notDeepEqual(q2.items.map((it) => it.marks), [2, 2, 2], 'must not spread the total evenly');
  assert.equal(q2.marksComplete, false);
});

test('passage-based question is itemsIndependent=false', () => {
  const q3 = bp.questions.find((q) => q.label === 'Q3');
  assert.equal(q3.itemsIndependent, false);
});
