/**
 * Regression: autonomous-college paper style — bare "Q.1" main-question lines
 * with parts on the following lines ("A. …", "B. …") and bracket-less
 * "Mark = 5" marks. This produced ZERO questions before the extractor fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionExtractor } from '../src/document/question-extractor.js';
import { extractBlueprint } from '../src/blueprint/blueprint-extractor.js';

const TEXT = `G H RAISONI COLLEGE OF ENGINEERING & MANAGEMENT, PUNE
Cloud Computing (23UAMPC3509)
Duration: 1 Hr Maximum Marks: 20
Instructions:
i. Attempt Q.1 or Q.2 & Q.3 or Q.4.
ii. Figures to the right indicate full marks.
Q.1
A. Define the component of cloud computing architecture. Mark = 5
B. Apply cloud application to improve scalability and accessibility in a business environment. Mark =
5
Q.2
A. Discuss security and privacy challenges in cloud computing. Mark = 5
Q.3
A. Describe server, storage, network and desktop virtualization. Mark = 5
B. Analyze the performance of a virtualized environment with multiple virtual machines sharing
resources. Mark = 5
Q.4
A. Summarize the techniques used for measuring and profiling virtualized applications. Mark = 5`;

test('extractor reads bare "Q.N" mains + "A./B." parts + "Mark = 5"', () => {
  const ex = questionExtractor.extract(TEXT, []);
  const subs = ex.questions.filter((q) => q.parentQuestionNumber);
  assert.equal(subs.length, 6, 'six sub-questions across Q1–Q4');
  assert.ok(subs.every((q) => q.marks === 5), 'every part is 5 marks');
  assert.ok(!/mark\s*=/i.test(subs[0].text), 'the "Mark = 5" phrase is stripped from the stem');
});

test('blueprint from that paper: 4 slots, per-item marks, no UNKNOWN types', () => {
  const ex = questionExtractor.extract(TEXT, []);
  const bp = extractBlueprint({ questions: ex.questions, text: TEXT });

  assert.equal(bp.totalQuestions, 4);
  assert.deepEqual(bp.questions.map((q) => q.label), ['Q1', 'Q2', 'Q3', 'Q4']);
  assert.deepEqual(bp.questions.map((q) => q.itemCount), [2, 1, 2, 1]);
  assert.deepEqual(bp.questions.map((q) => q.totalMarks), [10, 5, 10, 5]);
  assert.ok(bp.questions.every((q) => q.type !== 'UNKNOWN'), 'stem-less mains still get a type');
  assert.ok(bp.questions.every((q) => q.marksComplete), 'per-item marks recovered');
  assert.deepEqual(bp.questions[0].items.map((it) => it.marks), [5, 5]);
  assert.ok(bp.questions.every((q) => typeof q.itemsIndependent === 'boolean'));
});
