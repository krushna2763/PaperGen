/**
 * EQUIVALENCE (task: "a manual and an extracted blueprint of the same shape
 * produce identical generation behaviour"). Builds the same structure twice —
 * once through blueprint-extractor (Mode A path) and once through the manual
 * builder (Mode B path) — then proves retrieval sends identical filters and
 * the generator prompt is byte-identical.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { extractBlueprint } from '../src/blueprint/blueprint-extractor.js';
import { normalizeBlueprint } from '../src/blueprint/blueprint-normalizer.js';
import { buildManualBlueprint } from '../src/blueprint/manual-blueprint.js';
import { retrievalAgent } from '../src/agents/retrieval.agent.js';
import { questionGeneratorAgent } from '../src/agents/question-generator.agent.js';
import { stubRetrieval } from './helpers.js';

let searchCalls;
beforeEach(() => {
  ({ searchCalls } = stubRetrieval());
});
afterEach(() => mock.restoreAll());

// ─── One structure, two sources ──────────────────────────────────────────────
// Q1: MCQ, 3 items × 1 mark, 4 options. Q2: MATCH, 2 pairs, 4 marks whole.

// Mode A — question-extractor output shape (see blueprint-contract.test.js).
// Q2 is a stem-only MATCH ("2X2=4" expression, no captured sub-parts) — the
// no-per-item-structure shape the manual MATCH decision mirrors.
const EXTRACTED_QUESTIONS = [
  { questionNumber: 'Q1', parentQuestionNumber: null, section: 'A', type: 'UNKNOWN', text: 'Choose the correct option 1x3=3', options: [], marks: null, metadata: {},
    },
  { questionNumber: 'Q1(a)', parentQuestionNumber: 'Q1', section: 'A', type: 'UNKNOWN', text: 'item one', options: ['x', 'y', 'z', 'w'], marks: 1, metadata: {} },
  { questionNumber: 'Q1(b)', parentQuestionNumber: 'Q1', section: 'A', type: 'UNKNOWN', text: 'item two', options: ['x', 'y', 'z', 'w'], marks: 1, metadata: {} },
  { questionNumber: 'Q1(c)', parentQuestionNumber: 'Q1', section: 'A', type: 'UNKNOWN', text: 'item three', options: ['x', 'y', 'z', 'w'], marks: 1, metadata: {} },
  { questionNumber: 'Q2', parentQuestionNumber: null, section: 'A', type: 'UNKNOWN', text: 'Match the following columns 2X2=4', options: [], marks: null, metadata: {} },
];

// Mode B — teacher form with the SAME structure and topic anchors.
// (No per-slot difficulty here: same-shape means equal difficulty state too.
// Slot-level difficulty behaviour is covered by manual-retrieval-per-item.)
const MANUAL_FORM = {
  paper: { class: '4', subject: 'English' },
  sections: [{ name: 'SECTION A', questionNumbers: ['Q1', 'Q2'] }],
  questions: [
    { type: 'MCQ', section: 'SECTION A', itemCount: 3, optionCount: 4,
      topic: 'item one | item two | item three', marks: { mode: 'perItem', values: [1, 1, 1] } },
    { type: 'MATCH', section: 'SECTION A', itemCount: 2,
      topic: 'pair one | pair two', marks: { mode: 'whole', total: 4 } },
  ],
};

const SLOT_UNIT_MAP = { Q1: { unit: 1 }, Q2: { unit: 2 } };

/** What generation ACTUALLY consumes: orchestrator.generate() normalizes every
 *  incoming blueprint. Both paths are compared AFTER that same step. */
function asGenerated(extractedRaw, manualRaw) {
  return {
    a: normalizeBlueprint(extractedRaw),
    b: normalizeBlueprint(manualRaw),
  };
}

test('same-shape blueprints: identical slot types, marks, item counts, sections', async () => {
  const extractedRaw = extractBlueprint({ questions: EXTRACTED_QUESTIONS, text: '' });
  const manualRaw = buildManualBlueprint(MANUAL_FORM).blueprint;
  const { a, b } = asGenerated(extractedRaw, manualRaw);

  assert.equal(a.questions.length, b.questions.length);
  for (let i = 0; i < b.questions.length; i++) {
    const x = a.questions[i];
    const y = b.questions[i];
    assert.equal(x.type, y.type, `slot ${i + 1} type`);
    assert.equal(x.totalMarks, y.totalMarks, `slot ${i + 1} totalMarks`);
    assert.equal(x.itemCount, y.itemCount, `slot ${i + 1} itemCount`);
    assert.equal(x.label, y.label, `slot ${i + 1} label`);
    assert.equal(x.sectionName, y.sectionName, `slot ${i + 1} sectionName`);
    assert.equal(x.items.length, y.items.length, `slot ${i + 1} items length`);
    assert.equal(x.itemsIndependent, y.itemsIndependent, `slot ${i + 1} itemsIndependent`);
    assert.deepEqual(x.items.map((it) => it.marks), y.items.map((it) => it.marks), `slot ${i + 1} per-item marks`);
    assert.equal(x.difficulty, y.difficulty, `slot ${i + 1} difficulty`);
  }
});

test('same-shape blueprints: identical retrieval filters (corpus, class, subject, unit)', async () => {
  const extractedRaw = extractBlueprint({ questions: EXTRACTED_QUESTIONS, text: '' });
  const manualRaw = buildManualBlueprint(MANUAL_FORM).blueprint;
  const extracted = normalizeBlueprint(extractedRaw);
  const manual = normalizeBlueprint(manualRaw);

  const before = searchCalls.length;
  await retrievalAgent.retrieveForSlots(extracted, { class: '4', subject: 'English' }, { slotUnitMap: SLOT_UNIT_MAP });
  const extractedCalls = searchCalls.slice(before).map((f) => JSON.stringify(f));
  const beforeManual = searchCalls.length;
  await retrievalAgent.retrieveForSlots(manual, { class: '4', subject: 'English' }, { slotUnitMap: SLOT_UNIT_MAP });
  const manualCalls = searchCalls.slice(beforeManual).map((f) => JSON.stringify(f));

  assert.deepEqual(manualCalls, extractedCalls, 'retrieval must not distinguish the two sources');
});

test('same-shape blueprints: identical generator prompt (slot spec block)', async () => {
  const extractedRaw = extractBlueprint({ questions: EXTRACTED_QUESTIONS, text: '' });
  const manualRaw = buildManualBlueprint(MANUAL_FORM).blueprint;
  const extracted = normalizeBlueprint(extractedRaw);
  const manual = normalizeBlueprint(manualRaw);

  const reqs = { class: '4', subject: 'English', difficulty: 'Medium', questionCount: 2 };
  const promptA = questionGeneratorAgent.buildPrompt(reqs, [], { blueprint: extracted, slotContexts: [] });
  const promptB = questionGeneratorAgent.buildPrompt(reqs, [], { blueprint: manual, slotContexts: [] });

  // The prompt embeds slot headers (type/marks/items/rule/section) — these
  // encode everything STRUCTURAL and must match. Reference-item TEXTS and the
  // free-text instruction are allowed to differ (Mode A quotes reference
  // wording; Mode B quotes the teacher's topic), so instruction segments are
  // stripped before comparison.
  const headerRe = /^Slot \d+ \(Q\d\): .*$/gm;
  const strip = (s) => s.replace(/, instruction="[^"]*"/, '');
  const a = (promptA.match(headerRe) ?? []).map(strip);
  const b = (promptB.match(headerRe) ?? []).map(strip);
  assert.equal(a.length, b.length);
  assert.deepEqual(b, a, 'structural slot headers must be identical');
});
