/**
 * RED-FIRST (task section 5): the syllabus unit filter must actually restrict
 * retrieval to the slot's assigned unit, and free-form retrieval must target
 * the syllabus corpus instead of the retired `sourceType` filter.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { retrievalAgent } from '../src/agents/retrieval.agent.js';
import { stubRetrieval, sampleSlot } from './helpers.js';

let searchCalls;
beforeEach(() => {
  ({ searchCalls } = stubRetrieval());
});
afterEach(() => mock.restoreAll());

test('free-form retrieval filters corpus:"syllabus", never the retired sourceType', async () => {
  await retrievalAgent.retrieve({ class: '4', subject: 'English', difficulty: 'Medium' });

  assert.equal(searchCalls.length, 1);
  const f = searchCalls[0];
  assert.equal(f.corpus, 'syllabus', 'content retrieval must filter corpus:"syllabus"');
  assert.ok(f.sourceType == null, 'the retired sourceType filter must be gone');
});

test("blueprint slot retrieval sends the slot's assigned unit to Qdrant", async () => {
  const blueprint = { questions: [sampleSlot({ items: [{ label: 'a', marks: 3 }], itemCount: 1 })] };

  await retrievalAgent.retrieveForSlots(
    blueprint,
    { class: '4', subject: 'English' },
    { slotUnitMap: { Q10: { unit: 7 } } }
  );

  assert.ok(searchCalls.length >= 1, 'the slot must trigger at least one search');
  assert.ok(searchCalls.every((f) => f.corpus === 'syllabus'), 'every slot search filters the syllabus corpus');
  assert.ok(searchCalls.some((f) => String(f.unit) === '7'), "the slot's unit must reach the Qdrant filter");
});
