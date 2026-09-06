/**
 * availableUnits comes from the SYLLABUS NOTES corpus, never from reference
 * paper sections. A section is a locked part of the paper; a unit is a syllabus
 * chapter the teacher assigns and that /kb/notes tags. Deriving units from
 * sections gives a different, broken feature per subject.
 */
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAvailableUnits } from '../src/blueprint/available-units.js';
import { analyzePaper } from '../src/controllers/paper.controller.js';
import { storageService } from '../src/services/storage.service.js';
import { pdfParser } from '../src/document/pdf-parser.js';
import { questionExtractor } from '../src/document/question-extractor.js';
import { qdrantStore } from '../src/rag/qdrant.js';

// ─── pure helper ────────────────────────────────────────────────────────────
test('deriveAvailableUnits passes notes units through; empty in → empty out', () => {
  assert.deepEqual(deriveAvailableUnits({ unitsWithNotes: [] }), []);
  assert.deepEqual(deriveAvailableUnits({}), []);
  assert.deepEqual(
    deriveAvailableUnits({ unitsWithNotes: [{ id: 1, label: 'Unit 1', chunkCount: 4 }] }),
    [{ id: '1', label: 'Unit 1', chunkCount: 4 }]
  );
});

test('deriveAvailableUnits can never emit a section-derived id', () => {
  const out = deriveAvailableUnits({ unitsWithNotes: [{ id: 'Unit 1', chunkCount: 2 }, { id: 'Unit 2', chunkCount: 1 }] });
  assert.ok(out.every((u) => !u.id.startsWith('section:')));
});

// ─── analyze wiring ─────────────────────────────────────────────────────────
const mainQ = (num, section, text) => ({ questionNumber: num, parentQuestionNumber: null, section, type: 'UNKNOWN', text, options: [], marks: 3, metadata: {} });

const SECTIONED = [
  mainQ('Q1', 'A', 'Read the passage and answer 3'),
  mainQ('Q2', 'A', 'Define the underlined word 3'),
  mainQ('Q3', 'B', 'Fill in the blanks with correct tense 3'),
  mainQ('Q4', 'B', 'Join the sentences using conjunctions 3'),
];
const FLAT = [
  mainQ('Q1', null, 'Name the parts of a computer 3'),
  mainQ('Q2', null, 'What is an input device 3'),
  mainQ('Q3', null, 'Explain how a mouse works 3'),
];

const NOTES_ENGLISH = [
  { id: '1', label: 'Unit 1', chunkCount: 6 },
  { id: '2', label: 'Unit 2', chunkCount: 4 },
];

function stubPipeline({ questions, sections }) {
  mock.method(storageService, 'downloadFileBuffer', async () => Buffer.from('%PDF-1.4 fake'));
  mock.method(pdfParser, 'parseBuffer', async () => ({ text: 'CLASS IV\nSUBJECT ENGLISH\n', pages: [] }));
  mock.method(questionExtractor, 'extract', () => ({ questions, count: questions.length, sections, warnings: [] }));
  mock.method(qdrantStore, 'listUnitsWithNotes', async ({ subject }) => (subject === 'English' ? [...NOTES_ENGLISH] : []));
  mock.method(qdrantStore, 'unitHasNotes', async ({ subject, unit }) => subject === 'English' && (unit === '1' || unit === '2'));
}
const run = async (body) => {
  let out = null;
  const res = { status: () => res, json: (b) => { out = b; return res; } };
  await analyzePaper({ body }, res, (e) => { throw e; });
  return out;
};

afterEach(() => mock.restoreAll());

test('sectioned paper: availableUnits are notes units, no section ids; sections still in blueprint', async () => {
  stubPipeline({ questions: SECTIONED, sections: ['A', 'B'] });
  const r = await run({ fileUrl: 'http://x/p.pdf', class: '4', subject: 'English' });

  assert.deepEqual(r.availableUnits.map((u) => u.id).sort(), ['1', '2']);
  assert.ok(r.availableUnits.every((u) => !u.id.startsWith('section:')));
  assert.ok(r.availableUnits.every((u) => Number.isFinite(u.chunkCount)));
  assert.equal(r.blueprint.sections.length, 2, 'sections are still extracted and locked in the blueprint');
});

test('every availableUnits id passes unitHasNotes', async () => {
  stubPipeline({ questions: SECTIONED, sections: ['A', 'B'] });
  const r = await run({ fileUrl: 'http://x/p.pdf', class: '4', subject: 'English' });
  for (const u of r.availableUnits) {
    assert.equal(await qdrantStore.unitHasNotes({ class: '4', subject: 'English', unit: u.id }), true);
  }
});

test('no notes indexed → availableUnits is empty (client prompts for upload)', async () => {
  stubPipeline({ questions: FLAT, sections: [] });
  const r = await run({ fileUrl: 'http://x/p.pdf', class: '4', subject: 'Computer' });
  assert.deepEqual(r.availableUnits, []);
});

test('sectioned and flat papers with the same notes return identical availableUnits', async () => {
  stubPipeline({ questions: SECTIONED, sections: ['A', 'B'] });
  const sectioned = await run({ fileUrl: 'http://x/s.pdf', class: '4', subject: 'English' });
  mock.restoreAll();
  stubPipeline({ questions: FLAT, sections: [] });
  const flat = await run({ fileUrl: 'http://x/f.pdf', class: '4', subject: 'English' });

  assert.deepEqual(sectioned.availableUnits, flat.availableUnits);
  assert.equal(sectioned.blueprint.sections.length, 2);
  assert.equal(flat.blueprint.sections.length, 0);
});

test('units are scoped to subject: one subject\'s units do not leak into another', async () => {
  stubPipeline({ questions: SECTIONED, sections: ['A', 'B'] });
  const english = await run({ fileUrl: 'http://x/e.pdf', class: '4', subject: 'English' });
  const science = await run({ fileUrl: 'http://x/sc.pdf', class: '4', subject: 'Science' });

  assert.deepEqual(english.availableUnits.map((u) => u.id).sort(), ['1', '2']);
  assert.deepEqual(science.availableUnits, []);
});
