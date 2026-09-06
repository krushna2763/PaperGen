/**
 * RED-FIRST (task section 4): when a question's items are assigned to different
 * units, retrieval must fetch EACH item's context from its own unit — while
 * keeping the single batched embedding call.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { retrievalAgent } from '../src/agents/retrieval.agent.js';
import { geminiClient } from '../src/services/gemini-client.service.js';
import { stubRetrieval, sampleSlot } from './helpers.js';

let searchCalls;
beforeEach(() => {
  ({ searchCalls } = stubRetrieval());
});
afterEach(() => mock.restoreAll());

test('per-item units: each item retrieves from its own unit, one batched embed', async () => {
  const blueprint = { questions: [sampleSlot()] }; // Q10, 4 independent items a..d
  const embedBatch = geminiClient.embedBatch.mock;

  const perSlot = await retrievalAgent.retrieveForSlots(
    blueprint,
    { class: '5', subject: 'EVS' },
    { slotUnitMap: { Q10: { items: { a: 1, b: 1, c: 2, d: 2 } } } }
  );

  const units = [...new Set(searchCalls.map((f) => String(f.unit)))].sort();
  assert.deepEqual(units, ['1', '2'], 'both assigned units must be queried');
  assert.ok(searchCalls.some((f) => String(f.unit) === '1'));
  assert.ok(searchCalls.some((f) => String(f.unit) === '2'));
  assert.ok(searchCalls.length >= 4, 'one search per assigned item');

  assert.equal(embedBatch.calls.length, 1, 'item queries are embedded in ONE batch call');

  assert.ok(perSlot[0].itemResults, 'per-slot result exposes itemResults for the generator');
  assert.deepEqual(Object.keys(perSlot[0].itemResults).sort(), ['a', 'b', 'c', 'd']);
});

test('uniform slot still sends a single { unit } search', async () => {
  const blueprint = { questions: [sampleSlot()] };
  await retrievalAgent.retrieveForSlots(
    blueprint,
    { class: '5', subject: 'EVS' },
    { slotUnitMap: { Q10: { unit: 3 } } }
  );
  assert.ok(searchCalls.length >= 1);
  assert.ok(searchCalls.every((f) => String(f.unit) === '3'));
});
