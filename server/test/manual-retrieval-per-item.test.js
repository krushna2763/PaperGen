/**
 * RED-FIRST retrieval + difficulty tests for Mode B (task sections 2 + 4):
 *   - a manual blueprint's retrieval filters corpus:'syllabus' and the assigned
 *     unit, per item where items carry their own
 *   - slot.difficulty reaches the generator; paper-level difficulty is used
 *     when the slot carries none
 *   - MATCH (items: []) assigns one unit to the whole question
 *
 * Uses the manual builder's REAL output as the retrieval input — if the manual
 * shape needed any adapter to retrieve, these would fail.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { retrievalAgent } from '../src/agents/retrieval.agent.js';
import { questionGeneratorAgent } from '../src/agents/question-generator.agent.js';
import { geminiClient } from '../src/services/gemini-client.service.js';
import { stubRetrieval } from './helpers.js';
import { buildManualBlueprint } from '../src/blueprint/manual-blueprint.js';

let searchCalls;
beforeEach(() => {
  ({ searchCalls } = stubRetrieval());
});
afterEach(() => mock.restoreAll());

function manualBlueprint() {
  const form = {
    paper: { class: '4', subject: 'English' },
    sections: [],
    questions: [
      {
        type: 'SHORT_ANSWER',
        section: null,
        itemCount: 3,
        topic: 'nouns and their kinds',
        difficulty: 'Easy',
        marks: { mode: 'perItem', values: [1, 2, 2] },
      },
      {
        type: 'MATCH',
        section: null,
        itemCount: 2,
        topic: 'The Tinkling Bells',
        difficulty: 'Medium',
        marks: { mode: 'whole', total: 4 },
      },
    ],
  };
  return buildManualBlueprint(form).blueprint;
}

test('manual blueprint: per-item units retrieve corpus syllabus + own unit per item', async () => {
  const blueprint = manualBlueprint();
  const perSlot = await retrievalAgent.retrieveForSlots(
    blueprint,
    { class: '4', subject: 'English' },
    { slotUnitMap: { Q1: { items: { a: 1, b: 1, c: 2 } }, Q2: { unit: 2 } } }
  );

  // Q1's three items: two searches against unit 1, one against unit 2.
  const unit1Calls = searchCalls.filter((f) => String(f.unit) === '1');
  const unit2Calls = searchCalls.filter((f) => String(f.unit) === '2');
  assert.equal(unit1Calls.length, 2, 'items a,b → unit 1');
  assert.equal(unit2Calls.length, 2, 'item c → unit 2, Q2 (whole) → unit 2');
  assert.ok(searchCalls.every((f) => f.corpus === 'syllabus'), 'every search filters corpus:syllabus');
  assert.ok(searchCalls.every((f) => String(f.class) === '4' && String(f.subject) === 'English'));

  // Per-item results are exposed for the generator (same shape as Mode A).
  assert.ok(perSlot[0].itemResults, 'per-slot result exposes itemResults');
  assert.deepEqual(Object.keys(perSlot[0].itemResults).sort(), ['a', 'b', 'c']);
});

test('manual blueprint: topic anchor drives the slot query (no generic whole-paper query)', async () => {
  const blueprint = manualBlueprint();
  const embedded = [];
  const orig = geminiClient.embedBatch;
  mock.method(geminiClient, 'embedBatch', async (texts) => {
    embedded.push(...texts);
    return texts.map(() => new Array(8).fill(0.11));
  });

  await retrievalAgent.retrieveForSlots(
    blueprint,
    { class: '4', subject: 'English' },
    { slotUnitMap: { Q1: { unit: 1 }, Q2: { unit: 2 } } }
  );

  mock.restoreAll();
  void orig;
  assert.ok(embedded.some((t) => t.includes('nouns and their kinds')), 'Q1 query anchored on teacher topic');
  assert.ok(embedded.some((t) => t.includes('The Tinkling Bells')), 'Q2 query anchored on teacher topic');
});

test('MATCH slot (items: []) carries one unit for the whole question', async () => {
  const before = searchCalls.length; // stubRetrieval accumulates across tests — count the delta
  const blueprint = manualBlueprint();
  await retrievalAgent.retrieveForSlots(
    blueprint,
    { class: '4', subject: 'English' },
    { slotUnitMap: { Q1: { unit: 1 }, Q2: { unit: 2 } } }
  );
  const mine = searchCalls.slice(before);
  // Exactly 2 searches: Q1 whole-question (unit 1) + Q2 whole-question (unit 2).
  assert.equal(mine.length, 2, 'whole-question slots make ONE search each');
  assert.equal(mine.filter((f) => String(f.unit) === '2').length, 1, 'Q2 (whole) searched once against unit 2');
  assert.equal(mine.filter((f) => String(f.unit) === '1').length, 1, 'Q1 (whole) searched once against unit 1');
});

test('slot.difficulty reaches the generator prompt; paper-level used when absent', () => {
  const withDifficulty = manualBlueprint(); // Q1 difficulty Easy, Q2 Medium
  const prompt = questionGeneratorAgent.buildPrompt(
    { class: '4', subject: 'English', difficulty: 'Medium', questionCount: 2 },
    [],
    { blueprint: withDifficulty, slotContexts: [] }
  );
  assert.match(prompt, /Slot 1 \(Q1\)[^\n]*difficulty=Easy/);
  assert.match(prompt, /Slot 2 \(Q2\)[^\n]*difficulty=Medium/);

  // Paper-level fallback: strip slot difficulty → prompt shows the paper value.
  const noSlotDifficulty = structuredClone(withDifficulty);
  delete noSlotDifficulty.questions[0].difficulty;
  delete noSlotDifficulty.questions[1].difficulty;
  const prompt2 = questionGeneratorAgent.buildPrompt(
    { class: '4', subject: 'English', difficulty: 'Difficult', questionCount: 2 },
    [],
    { blueprint: noSlotDifficulty, slotContexts: [] }
  );
  assert.doesNotMatch(prompt2, /difficulty=Easy/);
  assert.doesNotMatch(prompt2, /difficulty=Medium/);
  assert.match(prompt2, /Difficulty: Difficult/);
});

test('generator schema enum stays compatible with registry types (no generator change needed)', async () => {
  // The generator must accept a manual blueprint's types via the widened
  // blueprint enum — proven by building the prompt/schema from a manual
  // blueprint without throwing and without dropping MATCH_THE_FOLLOWING.
  const blueprint = manualBlueprint();
  const prompt = questionGeneratorAgent.buildPrompt(
    { class: '4', subject: 'English', difficulty: 'Medium', questionCount: 2 },
    [],
    { blueprint, slotContexts: [] }
  );
  assert.ok(prompt.includes('MATCH_THE_FOLLOWING'), 'registry MATCH maps to the pipeline type');
  assert.ok(prompt.includes('Slot 1 (Q1)'), 'manual slots formatted like extracted slots');
});
