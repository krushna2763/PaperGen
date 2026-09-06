/**
 * Shared test helpers. No network: the Gemini + Qdrant singletons are patched
 * per test via node:test `mock`.
 */
import { mock } from 'node:test';
import { retriever } from '../src/rag/retriever.js';
import { geminiClient } from '../src/services/gemini-client.service.js';

const VEC = () => new Array(8).fill(0.11);

/**
 * Patch the embedding calls and `retriever.search`, recording every filter the
 * agent layer sends to Qdrant.
 * @returns {{ searchCalls: Array<object>, hits: Array<object> }}
 */
export function stubRetrieval({ hits } = {}) {
  const searchCalls = [];
  const rows = hits || [{ text: 'syllabus chunk', score: 0.9, questionNumber: null }];
  mock.method(geminiClient, 'embedContent', async () => VEC());
  mock.method(geminiClient, 'embedBatch', async (texts) => texts.map(() => VEC()));
  mock.method(retriever, 'search', async ({ filter = {} }) => {
    searchCalls.push({ ...filter });
    return rows;
  });
  return { searchCalls, rows };
}

export const sampleSlot = (over = {}) => ({
  number: 10,
  label: 'Q10',
  type: 'SHORT_ANSWER',
  itemsIndependent: true,
  itemCount: 4,
  optionalRule: null,
  referenceItems: ['tense of verbs', 'conjunctions', 'prepositions', 'pronouns'],
  instruction: 'Answer the following',
  items: [
    { label: 'a', referenceText: 'past tense of irregular verbs', marks: 3 },
    { label: 'b', referenceText: 'coordinating conjunctions', marks: 3 },
    { label: 'c', referenceText: 'prepositions of place', marks: 3 },
    { label: 'd', referenceText: 'reflexive pronouns', marks: 3 },
  ],
  ...over,
});
