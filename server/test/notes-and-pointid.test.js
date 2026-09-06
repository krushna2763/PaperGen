/**
 * Notes chunking + syllabus point-id safety.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { chunkNotes } from '../src/document/notes-chunker.js';
import { stablePointId } from '../src/rag/qdrant.js';

const NOTES = `Chapter 1 The Living World

${'Plants make their own food through photosynthesis. '.repeat(20)}

Chapter 2 Water

${'Water exists in three states: solid, liquid and gas. '.repeat(20)}
`;

test('chunkNotes splits on chapter boundaries and is deterministic', () => {
  const a = chunkNotes(NOTES);
  const b = chunkNotes(NOTES);
  assert.deepEqual(a, b, 'same input -> same chunks');
  assert.ok(a.length >= 2, 'at least one chunk per chapter');
  a.forEach((c, i) => assert.equal(c.chunkIndex, i));
  assert.ok(a.some((c) => /Living World/.test(c.text)));
  assert.ok(a.some((c) => /Water/.test(c.text)));
});

test('chunkNotes never returns an empty chunk', () => {
  for (const c of chunkNotes(NOTES)) assert.ok(c.text.trim().length > 0);
});

test('stablePointId is deterministic for one key', () => {
  assert.equal(stablePointId('hashX:0'), stablePointId('hashX:0'));
});

test('two different syllabus chunk keys never collide on point id', () => {
  const ids = new Set();
  for (let doc = 0; doc < 50; doc++) {
    for (let chunk = 0; chunk < 40; chunk++) {
      ids.add(stablePointId(`sourcehash-${doc}:${chunk}`));
    }
  }
  assert.equal(ids.size, 50 * 40, 'every (doc, chunk) key produced a unique id');
});

test('point id is a well-formed UUID string', () => {
  assert.match(stablePointId('anything:1'), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// Re-upload short-circuit: identical notes (same content hash) skip ingestion.
test('re-uploading identical notes does not re-ingest', async () => {
  const { qdrantStore } = await import('../src/rag/qdrant.js');
  const { embeddingService } = await import('../src/rag/embeddings.js');
  const { uploadNotes } = await import('../src/controllers/kb.controller.js');

  mock.method(qdrantStore, 'findSyllabusByHash', async () => ({ indexed: true, unit: 'u1', chunkCount: 7 }));
  const embedSpy = mock.method(embeddingService, 'embedQuestions', async () => ({ questions: [] }));
  const upsertSpy = mock.method(qdrantStore, 'upsertSyllabusChunks', async () => ({ indexedCount: 0 }));

  const req = { file: { buffer: Buffer.from('PDF BYTES') }, body: { class: '4', subject: 'English', unit: 'u1' } };
  let body = null;
  const res = { status: () => res, json: (b) => { body = b; return res; } };

  await uploadNotes(req, res, (e) => { throw e; });

  assert.equal(body.data.reused, true);
  assert.equal(embedSpy.mock.calls.length, 0, 'embedding must be skipped');
  assert.equal(upsertSpy.mock.calls.length, 0, 'upsert must be skipped');
  mock.restoreAll();
});
