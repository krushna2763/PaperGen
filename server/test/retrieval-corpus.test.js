/**
 * Two corpora must not leak into each other:
 *   - content retrieval sees ONLY corpus:"syllabus"
 *   - source dedup still sees corpus:"past_paper" (no regression)
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { retrievalAgent } from '../src/agents/retrieval.agent.js';
import { similarityAgent } from '../src/agents/similarity.agent.js';
import { stubRetrieval } from './helpers.js';

let searchCalls;
beforeEach(() => {
  ({ searchCalls } = stubRetrieval());
});
afterEach(() => mock.restoreAll());

test('free-form retrieval never queries the past_paper corpus', async () => {
  await retrievalAgent.retrieve({ class: '6', subject: 'Science', difficulty: 'Easy' });
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].corpus, 'syllabus');
  assert.notEqual(searchCalls[0].corpus, 'past_paper');
});

test('slot retrieval never queries the past_paper corpus', async () => {
  const blueprint = { questions: [{ label: 'Q1', referenceItems: ['x'], itemsIndependent: true, items: [] }] };
  await retrievalAgent.retrieveForSlots(blueprint, { class: '6', subject: 'Science' }, { slotUnitMap: { Q1: { unit: 2 } } });
  assert.ok(searchCalls.every((f) => f.corpus === 'syllabus'));
});

test('source dedup still targets the past_paper corpus', async () => {
  // similarityAgent.checkAgainstSource forwards the caller filter to retriever.search.
  await similarityAgent.checkAgainstSource(
    { questionId: 'g-1' },
    [0.1, 0.2, 0.3],
    { filter: { corpus: 'past_paper', class: '6', subject: 'Science' }, topK: 5 }
  );
  const f = searchCalls.at(-1);
  assert.equal(f.corpus, 'past_paper', 'dedup must keep querying the past_paper corpus');
});
