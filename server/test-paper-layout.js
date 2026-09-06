/**
 * test-paper-layout.js
 *
 * Lightweight Node test suite for the client document-model builder
 * (client/src/services/paperLayout.js). No framework — run with:
 *     node test-paper-layout.js    (from server/, or npm run test:layout)
 *
 * The core guarantee under test: THE LOCKED BLUEPRINT IS THE STRUCTURAL
 * SOURCE OF TRUTH for the rendered paper. Question types, marks and
 * difficulty never create, rename, reorder or regroup sections.
 *
 * Covers:
 *   1. Sectioned blueprint (A/B/C mixed types) → blueprint sections, order,
 *      numbers, titles; NO type regrouping.
 *   2. No-section blueprint (EVS shape) → ONE flat numbered list, NO invented
 *      SECTION headings, marks expressions preserved.
 *   3. Free-form fallback (no blueprint) → flat list, no invented sections.
 *   4. Missing blueprint slot → layout warning + no silent substitution.
 *   5. Extra generated question (no matching slot) → warning + never
 *      auto-inserted into a section.
 *   6. Structure preservation: passage + sub-parts stay as one block,
 *      per-part MCQ options survive, MATCH columns and INTERNAL_CHOICE
 *      branches survive structured, blueprint numbering preserved.
 */

import { buildPaperModel, paginatePaper } from '../client/src/services/paperLayout.js';
import { marksLabel } from '../client/src/services/paperTemplate.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function sectionedBlueprint() {
  // Universal mixed-section fixture from the task (Section A/B/C, mixed types)
  const questions = [
    { label: 'Q1', number: 1, type: 'MCQ', totalMarks: 1, itemCount: 1, markExpression: '1X1=1' },
    { label: 'Q2', number: 2, type: 'SHORT_ANSWER', totalMarks: 2, itemCount: 1, markExpression: '2' },
    { label: 'Q3', number: 3, type: 'FILL_IN_THE_BLANK', totalMarks: 3, itemCount: 3, markExpression: '1X3=3' },
    { label: 'Q4', number: 4, type: 'MCQ', totalMarks: 1, itemCount: 1, markExpression: '1X1=1' },
    { label: 'Q5', number: 5, type: 'LONG_ANSWER', totalMarks: 5, itemCount: 1, markExpression: '5' },
  ];
  const sections = [
    { name: 'SECTION A', title: '', questionNumbers: ['Q1', 'Q2'] },
    { name: 'SECTION B', title: '', questionNumbers: ['Q3', 'Q4'] },
    { name: 'SECTION C', title: '', questionNumbers: ['Q5'] },
  ];
  return { questions, sections, totalQuestions: 5, totalMarks: 12 };
}

const flatBlueprint = () => {
  // No-section blueprint (EVS-style): Q1..Q5 with DIFFERENT types.
  const questions = [
    { label: 'Q1', number: 1, type: 'MCQ', totalMarks: 1, itemCount: 1, markExpression: '1X1=1' },
    { label: 'Q2', number: 2, type: 'MATCH_THE_FOLLOWING', totalMarks: 4, itemCount: 4, markExpression: '1X4=4' },
    { label: 'Q3', number: 3, type: 'TRUE_FALSE', totalMarks: 3, itemCount: 3, markExpression: '1X3=3' },
    { label: 'Q4', number: 4, type: 'DIAGRAM', totalMarks: 5, itemCount: 1, markExpression: '5' },
    { label: 'Q5', number: 5, type: 'LONG_ANSWER', totalMarks: 5, itemCount: 1, markExpression: '5' },
  ];
  return { questions, sections: [], totalQuestions: 5, totalMarks: 18 };
};

const settings = { class: '4', difficulty: 'Medium' };
const emptyFormat = {};

// ─── 1. Sectioned blueprint is authoritative ────────────────────────────────
{
  const bp = sectionedBlueprint();
  // Generated questions deliberately arrive in a DIFFERENT type-interleaved
  // order with slotIndex set — the blueprint must win.
  const generated = [
    { questionId: 'g1', slotIndex: 0, type: 'MCQ', text: 'Q1 stem', marks: 1, options: ['A', 'B', 'C'] },
    { questionId: 'g4', slotIndex: 3, type: 'MCQ', text: 'Q4 stem', marks: 1, options: ['D', 'E'] },
    { questionId: 'g2', slotIndex: 1, type: 'SHORT_ANSWER', text: 'Q2 stem', marks: 2 },
    { questionId: 'g5', slotIndex: 4, type: 'LONG_ANSWER', text: 'Q5 stem', marks: 5 },
    { questionId: 'g3', slotIndex: 2, type: 'FILL_IN_THE_BLANK', text: 'Q3 stem', marks: 3, subParts: [
      { text: 'p1' }, { text: 'p2' }, { text: 'p3' },
    ] },
  ];
  const model = buildPaperModel({ questions: generated, blueprint: bp, settings, subject: 'EVS', format: emptyFormat });

  assert(model.blueprintMode === true, 'sectioned blueprint → blueprintMode true');
  assert(model.sections.length === 3, `3 blueprint sections, got ${model.sections.length}`);
  assert(model.unsectionedQuestions.length === 0, 'no unsectioned questions in a fully-sectioned blueprint');
  const byLabel = Object.fromEntries(model.sections.map((s) => [s.label, s.questions]));
  assert(byLabel['SECTION A'] && byLabel['SECTION A'].length === 2, 'SECTION A holds Q1+Q2');
  assert(byLabel['SECTION B'] && byLabel['SECTION B'].length === 2, 'SECTION B holds Q3+Q4');
  assert(byLabel['SECTION C'] && byLabel['SECTION C'].length === 1, 'SECTION C holds Q5');
  assert(byLabel['SECTION A'][0].numberText === '1.', 'Q1 shows 1.');
  assert(byLabel['SECTION A'][1].numberText === '2.', 'Q2 shows 2. (no renumber by type)');
  assert(byLabel['SECTION C'][0].numberText === '5.', 'Q5 shows 5.');
  assert(byLabel['SECTION A'][0].marksText === '1X1=1', 'marks expression preserved on Q1');
  // Type mixture inside a blueprint section is FINE — sections come from blueprint.
  assert(byLabel['SECTION A'][0].type === 'MCQ' && byLabel['SECTION A'][1].type === 'SHORT_ANSWER', 'mixed types coexist in SECTION A');
}

// ─── 2. No-section blueprint (EVS shape) → flat, no invented headings ───────
{
  const bp = flatBlueprint();
  const generated = [
    { questionId: 'g1', slotIndex: 0, type: 'MCQ', text: 'Pick one', marks: 1, options: ['x', 'y', 'z', 'w'] },
    { questionId: 'g2', slotIndex: 1, type: 'MATCH_THE_FOLLOWING', text: 'Match', marks: 4, columns: { left: ['a1', 'a2', 'a3', 'a4'], right: ['b1', 'b2', 'b3', 'b4'] } },
    { questionId: 'g3', slotIndex: 2, type: 'TRUE_FALSE', text: 'T or F', marks: 3, subParts: [{ text: 's1' }, { text: 's2' }, { text: 's3' }] },
    { questionId: 'g4', slotIndex: 3, type: 'DIAGRAM', text: 'Draw', marks: 5 },
    { questionId: 'g5', slotIndex: 4, type: 'LONG_ANSWER', text: 'Long', marks: 5, choices: [{ text: 'Choice A' }, { text: 'Choice B' }] },
  ];
  const model = buildPaperModel({ questions: generated, blueprint: bp, settings, subject: 'EVS', format: emptyFormat });

  assert(model.sections.length === 0, 'no sections for sectionless blueprint');
  assert(model.unsectionedQuestions.length === 5, 'all 5 questions flat');
  const order = model.unsectionedQuestions.map((q) => q.numberText).join(' ');
  assert(order === '1. 2. 3. 4. 5.', `flat order 1..5, got: ${order}`);
  assert(model.unsectionedQuestions.every((q) => !q._sectionLabel), 'no invented section headings');
  // MCQ options survive structured on Q1.
  assert(model.unsectionedQuestions[0].options.length === 4, 'MCQ options preserved (not rebuilt from text)');
  // MATCH columns survive structured on Q2.
  assert(model.unsectionedQuestions[1].columns && model.unsectionedQuestions[1].columns.left.length === 4, 'MATCH columns preserved structured');
  // per-part TRUE/FALSE items.
  assert(model.unsectionedQuestions[2].subParts.length === 3, 'TRUE_FALSE sub-parts preserved');
  // INTERNAL_CHOICE OR branches survive.
  assert(model.unsectionedQuestions[4].choices.length === 2, 'INTERNAL_CHOICE branches preserved');
}

// ─── 3. Free-form (no blueprint) → flat list, never invented sections ───────
{
  const model = buildPaperModel({
    questions: [
      { questionId: 'a', type: 'MCQ', text: 'A?', marks: 1, options: ['1', '2', '3', '4'] },
      { questionId: 'b', type: 'LONG_ANSWER', text: 'B?', marks: 5 },
      { questionId: 'c', type: 'TRUE_FALSE', text: 'C?', marks: 1 },
    ],
    blueprint: null, settings, subject: 'T', format: emptyFormat,
  });
  assert(model.blueprintMode === false, 'free-form → blueprintMode false');
  assert(model.sections.length === 0, 'free-form → no invented sections');
  assert(model.unsectionedQuestions.length === 3, 'free-form → flat 3 questions');
  assert(model.unsectionedQuestions.map((q) => q.numberText).join(' ') === '1. 2. 3.', 'free-form numbered 1..3 in given order');
}

// ─── 4. Missing blueprint slot → warning, no silent substitution ────────────
{
  const bp = flatBlueprint(); // Q1..Q5
  const generated = [
    { questionId: 'g1', slotIndex: 0, type: 'MCQ', text: 'Q1', marks: 1, options: ['a', 'b', 'c'] },
    { questionId: 'g3', slotIndex: 2, type: 'TRUE_FALSE', text: 'Q3', marks: 3, subParts: [{ text: 's1' }, { text: 's2' }, { text: 's3' }] },
    { questionId: 'g5', slotIndex: 4, type: 'LONG_ANSWER', text: 'Q5', marks: 5 },
  ];
  const model = buildPaperModel({ questions: generated, blueprint: bp, settings, subject: 'EVS', format: emptyFormat });
  const rendered = model.unsectionedQuestions.map((q) => q.numberText).join(' ');
  assert(rendered === '1. 3. 5.', `missing slots not substituted: got ${rendered}`);
  const warns = model.layoutWarnings.filter((w) => (w.missingQuestionNumbers || []).length > 0);
  assert(warns.length >= 2, 'layout warnings report missing Q2/Q4');
  assert(model.layoutWarnings.some((w) => (w.missingQuestionNumbers || []).includes('Q2')), 'Q2 reported missing');
  assert(model.layoutWarnings.some((w) => (w.missingQuestionNumbers || []).includes('Q4')), 'Q4 reported missing');
}

// ─── 5. Extra generated question → never auto-placed into a section ─────────
{
  const bp = sectionedBlueprint(); // Q1..Q5 inside A/B/C
  const generated = [
    { questionId: 'g1', slotIndex: 0, type: 'MCQ', text: 'Q1', marks: 1, options: ['a', 'b', 'c'] },
    { questionId: 'extra', slotIndex: 99, type: 'SHORT_ANSWER', text: 'Orphan', marks: 1 },
  ];
  const model = buildPaperModel({ questions: generated, blueprint: bp, settings, subject: 'EVS', format: emptyFormat });
  const inSection = model.sections.flatMap((s) => s.questions);
  assert(inSection.every((q) => q.key !== 'extra'), 'orphan question never inserted into a section');
  const extraWarn = model.layoutWarnings.find((w) => (w.extraQuestionNumbers || []).includes('extra'));
  assert(Boolean(extraWarn), 'extra question reported in layout warnings');
}

// ─── 6. Passage + sub-parts stay one block; per-part MCQ options survive ───
{
  const bp = {
    questions: [
      { label: 'Q1', number: 1, type: 'PASSAGE', totalMarks: 4, itemCount: 4, markExpression: '1X4=4' },
    ],
    sections: [{ name: 'SECTION A', title: 'Reading', questionNumbers: ['Q1'] }],
  };
  const generated = [{
    questionId: 'g1', slotIndex: 0, type: 'PASSAGE', text: 'Answer these:', marks: 4,
    passage: 'Once upon a time there was a very long passage that students must read before they can answer the questions below it.',
    subParts: [
      { text: 'Why one?', options: ['opt1', 'opt2', 'opt3'] },
      { text: 'Why two?' },
    ],
  }];
  const model = buildPaperModel({ questions: generated, blueprint: bp, settings, subject: 'English', format: emptyFormat });
  const q1 = model.sections[0].questions[0];
  assert(Boolean(q1.passage), 'passage kept with its question (single block)');
  assert(q1.subParts.length === 2, 'sub-parts stay attached to passage question');
  assert(q1.subParts[0].options.length === 3, 'per-part MCQ options survive structured');
  assert(q1.subParts[0].label === 'a.' && q1.subParts[1].label === 'b.', `sub-parts lettered a./b., got ${q1.subParts[0].label}/${q1.subParts[1].label}`);
  assert(model.sections[0].label === 'SECTION A — Reading', `section title from blueprint kept: ${model.sections[0].label}`);
}

// ─── 7. marksLabel honors blueprint expression over type-derived math ───────
{
  assert(marksLabel({ markExpression: '4+1', marks: 5 }) === '4+1', '4+1 expression preserved verbatim');
  assert(marksLabel({ marksExpression: '2X4=8', marks: 8 }) === '2X4=8', '2X4=8 extractor spelling preserved');
  assert(marksLabel({ marks: 5 }) === '5', 'plain marks fallback');
  // blueprint slot marks flow into the model when the question lacks an expression
  const bpSlot = { label: 'Q7', number: 7, totalMarks: 8, marks: { expression: '2X4=8' }, type: 'SHORT_ANSWER' };
  const rawQ = { questionId: 'x', slotIndex: 0, type: 'SHORT_ANSWER', text: 'T?', marks: 8 };
  const m = buildPaperModel({
    questions: [rawQ],
    blueprint: { questions: [bpSlot], sections: [] },
    settings, subject: 'T', format: emptyFormat,
  });
  assert(m.unsectionedQuestions[0].marksText === '2X4=8', 'blueprint expression used when question omits one');
}

// ─── 8. paginatePaper consumes unsectioned + sections without crashing ──────
{
  const bp = flatBlueprint();
  const generated = [
    { questionId: 'g1', slotIndex: 0, type: 'MCQ', text: 'Q1 long '.repeat(30), marks: 1, options: ['a', 'b', 'c', 'd'] },
    { questionId: 'g2', slotIndex: 1, type: 'MATCH_THE_FOLLOWING', text: 'Match long '.repeat(20), marks: 4, columns: { left: ['a1', 'a2', 'a3', 'a4'], right: ['b1', 'b2', 'b3', 'b4'] } },
    { questionId: 'g3', slotIndex: 2, type: 'TRUE_FALSE', text: 'TF long '.repeat(20), marks: 3, subParts: [{ text: 'x' }, { text: 'y' }, { text: 'z' }] },
    { questionId: 'g4', slotIndex: 3, type: 'DIAGRAM', text: 'Draw long '.repeat(20), marks: 5 },
    { questionId: 'g5', slotIndex: 4, type: 'LONG_ANSWER', text: 'Long '.repeat(80), marks: 5 },
  ];
  const model = buildPaperModel({ questions: generated, blueprint: bp, settings, subject: 'EVS', format: emptyFormat });
  const pages = paginatePaper(model);
  assert(pages.length >= 1, 'paginatePaper returns ≥1 page');
  const qCount = pages.reduce((n, p) => n + p.items.filter((i) => i.kind === 'q').length, 0);
  assert(qCount === 5, `all 5 questions paginated (got ${qCount})`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n────────────────────────────────────────────`);
console.log(`test-paper-layout: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failed checks:');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
process.exit(0);
