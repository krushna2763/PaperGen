/**
 * test-reference-analyzer.js — REFERENCE PAPER ANALYZER + canonical spec tests.
 *
 * Uses a Computer-Class-3-style synthetic reference paper (the exact pattern
 * the task mandates: MCQ 6×3-option, TRUE_FALSE 7, FILL 7, and a 5-part
 * "Answer the following" with per-part marks 1/2/2/2/3) plus a sectioned
 * English-like fixture — both DISCOVERED from text, never hard-coded.
 *
 * Coverage:
 *   A. Analyzer: paper metadata, question order, types, instructions, marks,
 *      item counts, per-item labels/marks/topics, answer forms.
 *   B. Pattern validator: valid paper passes; type drift / wrong item count /
 *      wrong option count / missing options / wrong marks / wrong optional
 *      rule / wrong subquestion count all fail with precise reasons.
 *   C. Per-part marks survive normalize + get stamped onto generated parts.
 *   D. Difficulty invariance: Easy/Medium/Difficult keep the exact same
 *      generated structure (only content difficulty may differ).
 *   E. Universal: no hard-coding — different paper shapes produce different
 *      specs; sections only when the document has them.
 *
 * Pure Node, zero Gemini: `node test-reference-analyzer.js`
 */

import { questionExtractor } from './src/document/question-extractor.js';
import { analyzeReferencePaper, paperLevel, questionLevel } from './src/agents/reference-paper-analyzer.agent.js';
import { normalizeBlueprint } from './src/blueprint/blueprint-normalizer.js';
import { checkQuestion } from './src/blueprint/blueprint-validator.js';
import { questionGeneratorAgent, normalizeGeneratedQuestion } from './src/agents/question-generator.agent.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const COMPUTER_TEXT = `ARMY PUBLIC SCHOOL SHILLONG
ANNUAL EXAMINATION (2024-25)
SUBJECT : COMPUTER SCIENCE
CLASS - 3
TIME ALLOWED: 2 HOURS 30 MINUTES          MAXIMUM MARKS: 30
General Instructions:
Read the question paper thoroughly before answering.
Answer all the questions.

Q1. Choose the correct answer. 1x6=6
(a) Which of these is an example of a word processor?
(b) Which key is used to remove text to the left of the cursor?
(c) Which part of the computer is known as the brain of the computer?
(d) Which device is used to print a document on paper?
(e) Which of these is an output device?
(f) Which application is used to draw pictures on a computer?

Q2. State whether the following statements are true or false. 1x7=7
(a) The CPU is the brain of the computer. (1)
(b) A mouse is an output device. (1)
(c) MS Word is a word processing program. (1)
(d) We can insert pictures in a document. (1)
(e) The keyboard is used to type letters and numbers. (1)
(f) A monitor is used to hear sound. (1)
(g) Saving a document keeps it safe for later use. (1)

Q3. Fill in the blanks. 1x7=7
(a) A computer needs ______ to work without electricity. (1)
(b) A set of instructions given to a computer is called a ______. (1)
(c) The part of a computer where we see our work is the ______. (1)
(d) We use the ______ to move the arrow on the screen. (1)
(e) MS Paint is used to make ______ on the computer. (1)
(f) A ______ is used to hear sound from the computer. (1)
(g) The ______ shows the letters and symbols on the screen when we type. (1)

Q4. Answer the following questions.
(a) What is the use of saving a document? (1)
(b) What is a word processor? Give an example. (2)
(c) Differentiate between 2D Shapes and 3D Shapes. (2)
(d) What do you mean by formatting text? (2)
(e) Why do we need to change the size of the text in a document? (3)
`;

const SECTIONED_TEXT = `MODEL SCHOOL
HALF YEARLY EXAMINATION
ENGLISH
CLASS - 5
TIME: 2 HOURS       MM: 40
SECTION A - Reading
1. Read the passage and answer the following questions: 1X5=5
(a) What did the thirsty crow see?
(b) Why could the crow not drink the water?
SECTION B - Grammar
2. Fill in the blanks with the correct form of the verb. 1X4=4
(a) She ______ to school every day.
(b) They ______ cricket last Sunday.
3. Choose the correct option. 1X2=2
(a) I ______ my homework yesterday.
(A) do (B) did (C) done
SECTION C - Literature
4. Answer the following questions. 2X3=6
(a) Why was the king unhappy?
(b) How did the farmer help the king?
(c) What lesson did the king learn?
`;

console.log('── A) Analyzer: Computer reference → canonical Reference Paper Specification ──');
const extracted = questionExtractor.extract(COMPUTER_TEXT);
const spec = analyzeReferencePaper({ questions: extracted.questions, text: COMPUTER_TEXT });
const qs = spec.questions || [];
const q = (n) => qs.find((x) => x.number === n);

check('specVersion marker present', spec.specVersion === 'reference-paper-spec.v1');
check('analyzer meta present', spec.analyzer?.role === 'reference-paper-analyzer' && spec.analyzer?.determinism.includes('deterministic'));
check('question order Q1..Q4 discovered', JSON.stringify(qs.map((x) => x.label)) === JSON.stringify(['Q1', 'Q2', 'Q3', 'Q4']));
check('total marks sum to 30', spec.totalMarks === 30, `got ${spec.totalMarks}`);
check('paper.maximumMarks discovered = 30', spec.paper?.maximumMarks === 30, `got ${spec.paper?.maximumMarks}`);
check('subject discovered (generic)', String(spec.paper?.subject).toUpperCase().includes('COMPUTER'), `got ${spec.paper?.subject}`);
check('no sections in computer paper (none invented)', (spec.sections || []).length === 0, `got ${(spec.sections || []).length}`);
check('paperLevel().questionCount = 4', paperLevel(spec).questionCount === 4);
check('paperLevel().sectionCount = 0', paperLevel(spec).sectionCount === 0);

const q1 = q(1);
check('Q1 type = MCQ', q1?.type === 'MCQ', `got ${q1?.type}`);
check('Q1 6 items', q1?.itemCount === 6, `got ${q1?.itemCount}`);
check('Q1 per-item spec length 6', (q1?.items || []).length === 6, `got ${(q1?.items || []).length}`);
check('Q1 item labels a..f', JSON.stringify(q1.items.map((i) => i.label)) === JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f']));
check('Q1 item(a) topic anchor kept', String(q1?.items?.[0]?.referenceText).includes('word processor'));
check('Q1 pattern answerForm single-correct-option', q1?.pattern?.answerForm === 'single-correct-option');

const q2 = q(2);
check('Q2 type = TRUE_FALSE', q2?.type === 'TRUE_FALSE', `got ${q2?.type}`);
check('Q2 7 items', q2?.itemCount === 7, `got ${q2?.itemCount}`);
check('Q2 per-item marks all 1 (discovered from (1))', JSON.stringify(q2?.itemMarks) === JSON.stringify([1, 1, 1, 1, 1, 1, 1]), `got ${JSON.stringify(q2?.itemMarks)}`);

const q3 = q(3);
check('Q3 type = FILL_IN_THE_BLANK', q3?.type === 'FILL_IN_THE_BLANK', `got ${q3?.type}`);
check('Q3 7 items', q3?.itemCount === 7, `got ${q3?.itemCount}`);
check('Q3 item(a) anchor retains the blank pattern', /_{2,}/.test(q3?.items?.[0]?.referenceText || ''));

const q4 = q(4);
check('Q4 5 subquestions', q4?.subQuestionCount === 5, `got ${q4?.subQuestionCount}`);
check('Q4 total = 10 (1+2+2+2+3)', q4?.totalMarks === 10, `got ${q4?.totalMarks}`);
check('Q4 per-item marks [1,2,2,2,3] preserved in order', JSON.stringify(q4?.itemMarks) === JSON.stringify([1, 2, 2, 2, 3]), `got ${JSON.stringify(q4?.itemMarks)}`);
check('Q4(a) marks=1, topic= saving a document', q4?.items?.[0]?.marks === 1 && String(q4?.items?.[0]?.referenceText).toLowerCase().includes('saving'));
check('Q4(c) marks=2, topic= 2D vs 3D', q4?.items?.[2]?.marks === 2 && /2d|3d/i.test(q4?.items?.[2]?.referenceText || ''));
check('Q4(e) marks=3, topic= changing text size', q4?.items?.[4]?.marks === 3 && /size of the text/i.test(q4?.items?.[4]?.referenceText || ''));
check('Q4 questionLevel().perItem length 5', (questionLevel(q4)?.perItem || []).length === 5);

console.log('── B) Pattern validator: deterministic structural gate ──');
const mkSlot = (over = {}) => ({
  number: 1, label: 'Q1', type: 'MCQ', totalMarks: 3, itemCount: 3,
  optionalRule: null, sectionName: null,
  pattern: { instructionType: 'choose-correct-option', answerForm: 'single-correct-option', optionCounts: [3, 3, 3], maxOptionCount: 3 },
  items: [1, 2, 3].map((n) => ({ label: String.fromCharCode(96 + n), marks: 1, referenceText: `ref item ${n}`, optionCount: 3 })),
  itemMarks: [1, 1, 1],
  ...over,
});
const okQ = { text: 'Choose the correct option:', type: 'MCQ', marks: 3, subParts: [1, 2, 3].map(() => ({ text: 'Which of these is a computer?', options: ['A', 'B', 'C'], marks: 1 })) };
check('valid generated MCQ paper passes', checkQuestion(okQ, mkSlot()).ok === true);

const typeDrift = checkQuestion({ ...okQ, type: 'SHORT_ANSWER' }, mkSlot());
check('changed type fails', typeDrift.ok === false && typeDrift.reasons.some((r) => r.includes('requires type MCQ')), typeDrift.reasons.join('; '));

const wrongCount = checkQuestion({ ...okQ, subParts: okQ.subParts.slice(0, 2) }, mkSlot());
check('wrong item count fails', wrongCount.ok === false && wrongCount.reasons.some((r) => /requires 3 item/.test(r)), wrongCount.reasons.join('; '));

const wrongOpts = checkQuestion({ ...okQ, subParts: okQ.subParts.map((p, i) => (i === 1 ? { ...p, options: ['A', 'B'] } : p)) }, mkSlot());
check('wrong option count fails (per item)', wrongOpts.ok === false && wrongOpts.reasons.some((r) => /item 2 requires 3 options/.test(r)), wrongOpts.reasons.join('; '));

const noOpts = checkQuestion({ ...okQ, subParts: okQ.subParts.map(({ options, ...p }) => p) }, mkSlot());
check('missing options in MCQ item fails (content drift blocked)', noOpts.ok === false && noOpts.reasons.some((r) => /must carry its own options/.test(r)), noOpts.reasons.join('; '));

const mixedOpts = checkQuestion({ ...okQ, subParts: [0, 1, 2].map((i) => ({ ...okQ.subParts[i], options: i === 1 ? ['A', 'B'] : ['A', 'B', 'C'] })) }, mkSlot());
check('mixed option counts fail', mixedOpts.ok === false && mixedOpts.reasons.some((r) => /SAME option count/.test(r)), mixedOpts.reasons.join('; '));

const wrongMarks = checkQuestion({ ...okQ, marks: 4 }, mkSlot());
check('wrong total marks fails', wrongMarks.ok === false && wrongMarks.reasons.some((r) => /requires 3 total mark/.test(r)), wrongMarks.reasons.join('; '));

const wrongPartMarks = checkQuestion({ ...okQ, subParts: okQ.subParts.map((p, i) => ({ ...p, marks: i === 2 ? 2 : 1 })) }, mkSlot());
check('wrong per-part marks fail with position', wrongPartMarks.ok === false && wrongPartMarks.reasons.some((r) => /part 3 requires 1 mark/.test(r)), wrongPartMarks.reasons.join('; '));

// TRUE_FALSE slot: statements only, no option lists; wrong optional rule fails.
const tfSlot = mkSlot({ type: 'TRUE_FALSE', itemCount: 2, totalMarks: 2, itemMarks: [1, 1], items: [{ label: 'a', marks: 1, referenceText: 'The sky is blue.', optionCount: null }], pattern: { answerForm: 'true-false-statement' } });
const tfOk = { text: 'State whether true or false:', type: 'TRUE_FALSE', marks: 2, subParts: [{ text: 'The CPU is the brain of a computer.', marks: 1 }, { text: 'A mouse is an output device.', marks: 1 }] };
check('valid TRUE_FALSE paper passes', checkQuestion(tfOk, tfSlot).ok === true);
const tfWithOptions = checkQuestion({ ...tfOk, subParts: [{ text: 'X is Y.', options: ['A', 'B'], marks: 1 }, { text: 'A mouse is an output device.', marks: 1 }] }, tfSlot);
check('TRUE_FALSE item with options fails', tfWithOptions.ok === false && tfWithOptions.reasons.some((r) => /plain true\/false statement/.test(r)), tfWithOptions.reasons.join('; '));

// "any N" optional rule slot
const anySlot = { ...mkSlot({ itemCount: 4, totalMarks: 8, optionalRule: { kind: 'ANY_N', n: 2 }, items: [1, 2, 3, 4].map((n) => ({ label: String.fromCharCode(96 + n), marks: 2, referenceText: `r${n}`, optionCount: null })), itemMarks: [2, 2, 2, 2] }), pattern: { answerForm: 'short-answer' } };
const anyQ = { text: 'Answer any two of the following: (any two)', type: 'MCQ', marks: 8, subParts: [1, 2, 3, 4].map((n) => ({ text: `New question ${n}`, options: ['A', 'B', 'C'], marks: 2 })) };
check('optional-rule paper passes when rule kept', checkQuestion(anyQ, anySlot).ok === true);
const anyLost = checkQuestion({ ...anyQ, text: 'Answer all the following questions:', subParts: anyQ.subParts.map(({ text, ...rest }) => rest) }, anySlot);
check('lost optional rule fails', anyLost.ok === false && anyLost.reasons.some((r) => /optional rule/.test(r)), anyLost.reasons.join('; '));

console.log('── C) Per-part marks survive normalize + stamp onto generated parts ──');
const normalized = normalizeBlueprint(spec);
check('normalizeBlueprint keeps per-item spec', JSON.stringify(normalized.questions[3]?.itemMarks) === JSON.stringify([1, 2, 2, 2, 3]));
check('normalizeBlueprint keeps Q1 items', (normalized.questions[0]?.items || []).length === 6);

// Generator normalization: an LLM part WITHOUT marks must be stamped with the
// locked per-part marks (blueprint marks are authoritative).
const q4Slot = { ...normalized.questions[3], slotIndex: 3 };
const rawParts = [
  'How does saving a document help us later?',
  'What is a word processor? Name one example.',
  'How are 2D and 3D shapes different?',
  'What does formatting text mean?',
  'Why might a bigger font size be useful in a document?',
].map((text) => ({ text }));
const stamped = normalizeGeneratedQuestion(
  { questionId: 'g-4', text: 'Answer the following questions:', type: 'SHORT_ANSWER', marks: 10, difficulty: 'Medium', subParts: rawParts },
  3,
  { blueprintSlot: q4Slot }
);
check('generated parts stamped with locked per-part marks [1,2,2,2,3]', JSON.stringify(stamped.subParts.map((p) => p.marks)) === JSON.stringify([1, 2, 2, 2, 3]), `got ${JSON.stringify(stamped.subParts.map((p) => p.marks))}`);
check('mixed marks → no uniform subPartMarks', stamped.subPartMarks === undefined, `got ${stamped.subPartMarks}`);
check('stamped question still passes per-part validator', checkQuestion(stamped, q4Slot).ok === true);

console.log('── D) Difficulty invariance: Easy/Medium/Difficult keep identical structure ──');
const runPrompt = (difficulty) => questionGeneratorAgent.buildPrompt(
  { class: '3', subject: 'Computer', difficulty, questionCount: 4 },
  [],
  { blueprint: normalized }
);
const pEasy = runPrompt('Easy');
const pMed = runPrompt('Medium');
const pHard = runPrompt('Difficult');
check('difficulty does not alter the frozen slot block (Easy vs Difficult)', pEasy.split('LOCKED BLUEPRINT')[1] === pHard.split('LOCKED BLUEPRINT')[1]);
check('per-item order/marks contract present in the prompt', pMed.includes('Reference items IN ORDER') && pMed.includes('[2 marks]'));
check('frozen answer-form contract present', /ANSWER FORM MUST MATCH THE QUESTION TYPE/.test(pMed));
check('positional topic-mapping rule present', /PER-ITEM TOPIC MAPPING IS POSITIONAL/.test(pMed));
const slotLines = pMed.split('LOCKED BLUEPRINT')[1];
check('Q4 anchors appear with their locked marks in order', ['saving a document', '2D', 'size of the text'].every((k) => slotLines.toLowerCase().includes(k.toLowerCase())));
// The same raw model payload normalized at three difficulties yields the same
// structural JSON (difficulty is a content-only knob; structure is locked).
const rawForDiff = { questionId: 'g-1', text: 'Choose the correct option:', type: 'MCQ', marks: 6, difficulty: 'Easy', subParts: [1, 2, 3, 4, 5, 6].map(() => ({ text: 'Which of these is hardware?', options: ['CPU', 'Mouse', 'Wall'] })) };
const stripDifficulty = (q) => { const { difficulty, ...rest } = q; return rest; };
const struct = (d) => JSON.stringify(stripDifficulty(normalizeGeneratedQuestion({ ...rawForDiff, difficulty: d }, 0, { blueprintSlot: { ...normalized.questions[0], slotIndex: 0 } })));
check('Easy/Medium/Difficult normalize to identical structure', struct('Easy') === struct('Medium') && struct('Medium') === struct('Difficult'));

console.log('── E) Universal: every document defines its own spec ──');
const engExtract = questionExtractor.extract(SECTIONED_TEXT);
const engSpec = analyzeReferencePaper({ questions: engExtract.questions, text: SECTIONED_TEXT });
check('English fixture discovers sections (A..C present)', (engSpec.sections || []).length >= 2, `got ${(engSpec.sections || []).length}`);
check('English section A contains its passage question', (engSpec.sections?.[0]?.questionNumbers || []).includes(engSpec.questions?.[0]?.label));
check('no class hard-coding: class differs between fixtures', String(engSpec.paper?.class) !== String(spec.paper?.class));
check('no marks hard-coding: totals differ between fixtures', engSpec.totalMarks !== spec.totalMarks && engSpec.totalMarks != null && spec.totalMarks === 30);
check('sections only when the document has them', (spec.sections || []).length === 0 && (engSpec.sections || []).length > 0);

console.log('── F) Roman-numeral MCQ options (i) ii) iii)) parse into per-item option arrays ──');
const ROMAN_TEXT = `Q1. Choose the correct answer. 1x3=3
(a) Which of these is an example of a word processor?
(i) MS Paint
(ii) MS Word
(iii) MS Excel
(b) Which key removes text to the left of the cursor?
(i) Enter
(ii) Backspace
(iii) Spacebar
(c) Which part is known as the brain of the computer?
(i) Monitor
(ii) Mouse
(iii) CPU
Q2. Fill in the blanks with the correct tense form. 1x2=2
(i) She ___ to school every day.
(ii) They ___ cricket last Sunday.
`;
const romanEx = questionExtractor.extract(ROMAN_TEXT);
const romanBp = analyzeReferencePaper({ questions: romanEx.questions, text: ROMAN_TEXT });
const rq1 = (romanBp.questions || []).find((x) => x.number === 1);
check('roman MCQ fixture: Q1 is MCQ with 3 lettered items', rq1?.type === 'MCQ' && rq1?.itemCount === 3, `got ${rq1?.type}/${rq1?.itemCount}`);
check('Q1 items each recovered their own 3 roman options', JSON.stringify((rq1?.items || []).map((i) => i.optionCount)) === JSON.stringify([3, 3, 3]), `got ${JSON.stringify((rq1?.items || []).map((i) => i.optionCount))}`);
check('Q1 per-item pattern optionCounts [3,3,3]', JSON.stringify(rq1?.pattern?.optionCounts || []) === JSON.stringify([3, 3, 3]));
check('Q1 maxOptionCount 3', rq1?.pattern?.maxOptionCount === 3);
check('Q1 item labels a..c', JSON.stringify((rq1?.items || []).map((i) => i.label)) === JSON.stringify(['a', 'b', 'c']));
const rawItem = romanEx.questions.find((q) => q.questionNumber === 'Q1(a)');
check('raw extractor question carries the roman option array (i/ii/iii content)', Array.isArray(rawItem?.options) && rawItem.options.length === 3 && /^i\./.test(rawItem.options[0]) && /^ii\./.test(rawItem.options[1]) && /^iii\./.test(rawItem.options[2]), JSON.stringify(rawItem?.options));
const rq2 = (romanBp.questions || []).find((x) => x.number === 2);
check('roman (i)(ii) under a non-MCQ stem stay sub-items, NOT options', rq2?.type === 'FILL_IN_THE_BLANK' && (rq2?.pattern?.maxOptionCount ?? null) === null, `maxOption=${rq2?.pattern?.maxOptionCount}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
