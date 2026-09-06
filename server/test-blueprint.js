/**
 * test-blueprint.js
 *
 * Lightweight Node test suite for the LOCKED Previous-Year Paper Blueprint
 * System. No framework — run with:  node test-blueprint.js  (or npm run test:blueprint)
 *
 * Covers:
 *   1. marks-expression parsing (1x5=5, 2x4=8, 3x3=9, 4+1, bare 5)
 *   2. optional-rule parsing ("(Any four)", "Attempt any five", "Answer any 2")
 *   3. EVS reference blueprint extraction (11 questions, 80 marks, types,
 *      expressions, sub-question counts, optional rules)
 *   4. header parsing (class / subject / duration / maximum marks)
 *   5. blueprint normalization
 *   6. generated paper PASSES blueprint validation
 *   7. intentionally malformed generated paper FAILS validation (wrong count /
 *      marks / type / optional rule / missing slot)
 *   8. ONLY the failed question is regenerated (blueprintCheckNode)
 *   9. student instructions stay separate from AI instructions
 *  10. previous questions are not copied (normalized content check)
 */

import { extractBlueprint } from './src/blueprint/blueprint-extractor.js';
import { normalizeBlueprint } from './src/blueprint/blueprint-normalizer.js';
import { parseMarksExpression, parseOptionalRule } from './src/blueprint/blueprint-normalizer.js';
import { checkQuestion, validatePaper, findAnyN } from './src/blueprint/blueprint-validator.js';
import { blueprintCheckNode } from './src/agents/orchestrator.agent.js';
import { questionGeneratorAgent, normalizeGeneratedQuestion } from './src/agents/question-generator.agent.js';
import { normalizeQuestionText } from './src/agents/agent-utils.js';

let passed = 0;
let failed = 0;
const failures = [];
const skipped = [];

function assert(cond, label) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertEq(actual, expected, label) {
  const ok = actual === expected || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

function section(title) {
  console.log(`\n== ${title}`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('1. Marks-expression parsing');
assertEq(parseMarksExpression('On a Map of India mark the following 1x5=5'),
  { expression: '1X5=5', marksPerItem: 1, itemCount: 5, totalMarks: 5 }, '1x5=5');
assertEq(parseMarksExpression('Answer the following questions: (Any two) 4X2=8'),
  { expression: '4X2=8', marksPerItem: 4, itemCount: 2, totalMarks: 8 }, '4X2=8');
assertEq(parseMarksExpression('Differentiate between X and Y 3x3=9'),
  { expression: '3X3=9', marksPerItem: 3, itemCount: 3, totalMarks: 9 }, '3x3=9');
assertEq(parseMarksExpression('Draw 4+1'),
  { expression: '4+1', marksPerItem: 5, itemCount: 1, totalMarks: 5 }, '4+1');
assertEq(parseMarksExpression('Name any two sources of water. 5'),
  { expression: '5', marksPerItem: 5, itemCount: 1, totalMarks: 5 }, 'bare 5');
assertEq(parseMarksExpression('What is photosynthesis?'), null, 'no expression → null');

// ─────────────────────────────────────────────────────────────────────────────
section('2. Optional-rule parsing');
assertEq(parseOptionalRule('Define the following terms: (Any four) 2X4=8'), { kind: 'ANY_N', n: 4 }, '(Any four)');
assertEq(parseOptionalRule('Answer the following questions: (Any two) 4X2=8'), { kind: 'ANY_N', n: 2 }, '(Any two)');
assertEq(parseOptionalRule('Attempt any five of the following:'), { kind: 'ANY_N', n: 5 }, 'Attempt any five');
assertEq(parseOptionalRule('Answer any 2 of the following'), { kind: 'ANY_N', n: 2 }, 'Answer any 2');
assertEq(parseOptionalRule('Solve the following:'), null, 'no rule → null');
assertEq(findAnyN('Answer the following questions: (any four)'), 4, 'findAnyN words');
assertEq(findAnyN('Attempt any 3'), 3, 'findAnyN digits');

// ─────────────────────────────────────────────────────────────────────────────
section('3. EVS reference blueprint extraction');
// The Class IV/V EVS reference: 80 marks, 11 numbered questions. Fixture uses
// the exact shape produced by question-extractor.js (also what Qdrant stores).
const EVS_HEADER = `ARMY PUBLIC SCHOOL SHILLONG
ANNUAL EXAMINATION (2022-23)
SUBJECT - ENVIRONMENTAL STUDIES
CLASS - V

Time: 2hrs 30mins        Maximum Marks: 80

General Instructions :
1. Read the question paper thoroughly before answering.
2. Answer all the questions.`;

const EVS_QUESTIONS = [
  { questionNumber: 'Q1', parentQuestionNumber: null, section: null, type: 'MCQ', text: 'On a Map of India mark the following 1X5=5', options: [], marks: null },
  { questionNumber: 'Q2', parentQuestionNumber: null, section: null, type: 'MCQ', text: 'Choose the correct option: 1X7=7', options: [], marks: null },
  { questionNumber: 'Q3', parentQuestionNumber: null, section: null, type: 'MCQ', text: 'Write True or False for the following: 1X8=8', options: [], marks: null },
  { questionNumber: 'Q4', parentQuestionNumber: null, section: null, type: 'MCQ', text: 'Fill in the blanks: 1X7=7', options: [], marks: null },
  { questionNumber: 'Q5', parentQuestionNumber: null, section: null, type: 'MCQ', text: '. Match the following column: 1X7=7 A B', options: [], marks: null },
  { questionNumber: 'Q6', parentQuestionNumber: null, section: null, type: 'MCQ', text: 'Name the following 1 X5=5', options: [], marks: null },
  { questionNumber: 'Q7', parentQuestionNumber: null, section: null, type: 'MCQ', text: 'Define the following terms: (Any four) 2X4=8', options: [], marks: null },
  { questionNumber: 'Q8', parentQuestionNumber: null, section: null, type: 'SHORT_ANSWER', text: 'Answer the following questions: (Any four) 2X4=8', options: [], marks: null },
  { questionNumber: 'Q8(a)', parentQuestionNumber: 'Q8', section: null, type: 'SHORT_ANSWER', text: 'Why poly bags should be banned?', options: [], marks: null },
  { questionNumber: 'Q8(b)', parentQuestionNumber: 'Q8', section: null, type: 'SHORT_ANSWER', text: 'Write two examples of dairy products that are rich in fats.', options: [], marks: null },
  { questionNumber: 'Q8(c)', parentQuestionNumber: 'Q8', section: null, type: 'SHORT_ANSWER', text: 'List the factors that increase the rate of evaporation.', options: [], marks: null },
  { questionNumber: 'Q8(d)', parentQuestionNumber: 'Q8', section: null, type: 'SHORT_ANSWER', text: 'Name the different types of maps', options: [], marks: null },
  { questionNumber: 'Q8(e)', parentQuestionNumber: 'Q8', section: null, type: 'SHORT_ANSWER', text: 'Why is recycling good for our environment?', options: [], marks: null },
  { questionNumber: 'Q8(f)', parentQuestionNumber: 'Q8', section: null, type: 'SHORT_ANSWER', text: 'What is animal-powered transport?', options: [], marks: null },
  { questionNumber: 'Q9', parentQuestionNumber: null, section: null, type: 'SHORT_ANSWER', text: 'Answer the following questions: (Any four) 3X4=12', options: [], marks: null },
  { questionNumber: 'Q9(a)', parentQuestionNumber: 'Q9', section: null, type: 'SHORT_ANSWER', text: 'Why should we eat a balanced diet every day?', options: [], marks: 3 },
  { questionNumber: 'Q9(b)', parentQuestionNumber: 'Q9', section: null, type: 'SHORT_ANSWER', text: 'Describe the 3 R\'s.', options: [], marks: null },
  { questionNumber: 'Q9(c)', parentQuestionNumber: 'Q9', section: null, type: 'SHORT_ANSWER', text: 'Differentiate between Rain-fed rivers and Snow fed rivers.', options: [], marks: null },
  { questionNumber: 'Q9(d)', parentQuestionNumber: 'Q9', section: null, type: 'SHORT_ANSWER', text: 'Why is the foundation said to be the most important part of a building?', options: [], marks: null },
  { questionNumber: 'Q9(e)', parentQuestionNumber: 'Q9', section: null, type: 'SHORT_ANSWER', text: 'What are the reasons behind the increase in demand for freshwater?', options: [], marks: null },
  { questionNumber: 'Q9(f)', parentQuestionNumber: 'Q9', section: null, type: 'SHORT_ANSWER', text: 'Why are watermark and security threads given on a note?', options: [], marks: null },
  { questionNumber: 'Q10', parentQuestionNumber: null, section: null, type: 'SHORT_ANSWER', text: 'Answer the following questions: (Any two) 4X2=8', options: [], marks: null },
  { questionNumber: 'Q10(a)', parentQuestionNumber: 'Q10', section: null, type: 'SHORT_ANSWER', text: 'Give two examples of evaporation and condensation in daily life.', options: [], marks: null },
  { questionNumber: 'Q10(b)', parentQuestionNumber: 'Q10', section: null, type: 'SHORT_ANSWER', text: 'Which step should be taken to control water pollution.', options: [], marks: null },
  { questionNumber: 'Q10(c)', parentQuestionNumber: 'Q10', section: null, type: 'SHORT_ANSWER', text: 'Differentiate between Public and Private transport.', options: [], marks: null },
  { questionNumber: 'Q11', parentQuestionNumber: null, section: null, type: 'SHORT_ANSWER', text: 'Draw 4+1', options: [], marks: null },
];

const bp = extractBlueprint({ questions: EVS_QUESTIONS, text: EVS_HEADER });

assertEq(bp.totalQuestions, 11, 'EVS blueprint → 11 questions');
assertEq(bp.totalMarks, 80, 'EVS blueprint → 80 total marks');
assertEq(bp.marksComplete, true, 'EVS blueprint marks complete');

// Per-question expectations: [label, type, itemCount, totalMarks, expression, optionalN]
const EVS_EXPECTED = [
  ['Q1', 'MAP', 5, 5, '1X5=5', null],
  ['Q2', 'MCQ', 7, 7, '1X7=7', null],
  ['Q3', 'TRUE_FALSE', 8, 8, '1X8=8', null],
  ['Q4', 'FILL_IN_THE_BLANK', 7, 7, '1X7=7', null],
  ['Q5', 'MATCH_THE_FOLLOWING', 7, 7, '1X7=7', null],
  ['Q6', 'SHORT_ANSWER', 5, 5, '1X5=5', null],
  ['Q7', 'DEFINITION', 4, 8, '2X4=8', 4],
  ['Q8', 'SHORT_ANSWER', 6, 8, '2X4=8', 4],
  ['Q9', 'SHORT_ANSWER', 6, 12, '3X4=12', 4],
  ['Q10', 'LONG_ANSWER', 3, 8, '4X2=8', 2],
  ['Q11', 'DRAWING', 1, 5, '4+1', null],
];

EVS_EXPECTED.forEach(([label, type, itemCount, totalMarks, expr, optN], i) => {
  const q = bp.questions[i];
  assert(q, `blueprint has slot ${i + 1} (${label})`);
  if (!q) return;
  assertEq(q.label, label, `slot ${i + 1} label`);
  assertEq(q.type, type, `slot ${i + 1} (${label}) type`);
  assertEq(q.itemCount, itemCount, `slot ${i + 1} (${label}) itemCount`);
  assertEq(q.totalMarks, totalMarks, `slot ${i + 1} (${label}) totalMarks`);
  assertEq(q.markExpression, expr, `slot ${i + 1} (${label}) markExpression`);
  assertEq(q.optionalRule ? q.optionalRule.n : null, optN, `slot ${i + 1} (${label}) optionalRule`);
});

// ─────────────────────────────────────────────────────────────────────────────
section('4. Paper header parsing');
assertEq(bp.paper.class, 'V', 'header class');
assertEq(bp.paper.subject, 'ENVIRONMENTAL STUDIES', 'header subject');
assertEq(bp.paper.duration, '2hrs 30mins', 'header duration');
assertEq(bp.paper.maximumMarks, 80, 'header maximum marks');

// ─────────────────────────────────────────────────────────────────────────────
section('5. Blueprint normalization');
const normalized = normalizeBlueprint(JSON.parse(JSON.stringify(bp)));
assert(normalized, 'normalizeBlueprint keeps a valid blueprint');
assertEq(normalized.totalQuestions, 11, 'normalized totalQuestions');
assertEq(normalized.totalMarks, 80, 'normalized totalMarks');
assertEq(normalized.questions[6].optionalRule.n, 4, 'normalized optional rule');
assertEq(normalizeBlueprint(null), null, 'null blueprint → null');
assertEq(normalizeBlueprint({ questions: [] }), null, 'empty blueprint → null');

// ─────────────────────────────────────────────────────────────────────────────
section('6. Generated paper PASSES blueprint validation');
// Build a conforming generated paper from the blueprint slots (NEW content).
function makeConforming() {
  const mk = (slot, extraText, subCount) => {
    const subParts = Array.from({ length: subCount }, (_, i) => ({ text: `${extraText} part ${i + 1}` }));
    return {
      questionId: `g-${slot.number}`,
      text: slot.instruction,
      type: slot.type,
      marks: slot.totalMarks,
      difficulty: 'Medium',
      slotIndex: slot.number - 1,
      markExpression: slot.markExpression,
      subParts,
      fullText: [slot.instruction, ...subParts.map((s) => s.text)].join('\n'),
    };
  };
  return bp.questions.map((slot) => mk(slot, 'A brand new scenario about', slot.itemCount));
}
const conforming = makeConforming();
const v1 = validatePaper(conforming, bp);
assertEq(v1.ok, true, 'conforming paper passes');
assertEq(v1.results.length, 11, 'all 11 slots validated');

// checkQuestion on a single conforming slot
const singleOk = checkQuestion(conforming[0], bp.questions[0]);
assertEq(singleOk.ok, true, 'single conforming slot ok');

// ─────────────────────────────────────────────────────────────────────────────
section('7. Malformed generated paper FAILS blueprint validation');
const bad = makeConforming();
bad[1].subParts = bad[1].subParts.slice(0, 5);          // Q2: 7 items → 5
const v2 = validatePaper(bad, bp);
assertEq(v2.ok, false, 'wrong item count fails');
assert(v2.results[1].reasons.some((r) => r.includes('requires 7 item(s) but generated 5')), 'item-count reason exact');

const badMarks = makeConforming();
badMarks[0].marks = 4;                                   // Q1: 5 → 4
assertEq(validatePaper(badMarks, bp).ok, false, 'wrong marks fails');
assert(validatePaper(badMarks, bp).results[0].reasons.some((r) => r.includes('requires 5 total mark(s) but generated 4')), 'marks reason exact');

const badType = makeConforming();
badType[4].type = 'MCQ';                                 // Q5: MATCH → MCQ
assertEq(validatePaper(badType, bp).ok, false, 'wrong type fails');
assert(validatePaper(badType, bp).results[4].reasons.some((r) => r.includes('requires type MATCH_THE_FOLLOWING but generated MCQ')), 'type reason exact');

const noRule = makeConforming();
noRule[6].text = 'Define the following terms:';           // Q7: dropped "(any four)"
assertEq(validatePaper(noRule, bp).ok, false, 'dropped optional rule fails');
assert(validatePaper(noRule, bp).results[6].reasons.some((r) => r.includes('optional rule')), 'optional-rule reason present');

const missingSlot = makeConforming().slice(0, 10);       // only 10 questions
const vMissing = validatePaper(missingSlot, bp);
assertEq(vMissing.ok, false, 'missing slot fails');
assert(vMissing.results[10].reasons.some((r) => r.includes('was not generated')), 'missing-slot reason exact');

// ─────────────────────────────────────────────────────────────────────────────
section('8. Only the failed question is regenerated (blueprintCheckNode)');
// All 11 slots filled with conforming questions; ONLY slot Q2 broken (5 items
// instead of 7) — the node must send exactly that one slot to regeneration.
const allQ = makeConforming().map((q) => ({ ...q, attempts: 1 }));
allQ[1].subParts = allQ[1].subParts.slice(0, 5); // Q2: needs 7 items
const nodeState = {
  blueprint: bp,
  accepted: allQ,
  acceptedVectors: Object.fromEntries(allQ.map((q) => [q.questionId, [1]])),
  rejected: [],
};
const nodeOut = await blueprintCheckNode(nodeState);
assertEq(nodeOut.rejected.length, 1, 'only 1 slot sent to regeneration');
assertEq(nodeOut.rejected[0].slotIndex, 1, 'the failed slot is Q2 (index 1)');
assertEq(nodeOut.rejected[0].reasons[0], 'Q2 requires 7 item(s) but generated 5.', 'exact blueprint failure reason');
assertEq(nodeOut.accepted.length, 10, 'conforming slots kept untouched');
assert(nodeOut.accepted.some((q) => q.questionId === 'g-1'), 'Q1 kept');
assert(nodeOut.accepted.some((q) => q.questionId === 'g-11'), 'Q11 kept');
assert(!('g-2' in nodeOut.acceptedVectors), 'failed slot vector removed from accepted pool');

// Targeted regeneration prompt addresses ONE slot, not the whole paper
const req = { class: '5', subject: 'Evs', difficulty: 'Medium', questionCount: 11 };
const regenPrompt = questionGeneratorAgent.buildPrompt(req, [], {
  regenerate: true,
  failedQuestion: allQ[1],
  failureReasons: ['Q2 requires 7 item(s) but generated 5.'],
  blueprint: bp,
  slotIndex: 1,
});
assert(regenPrompt.includes('Slot 2 (Q2)'), 'regeneration prompt names the exact slot');
assert(regenPrompt.includes('Q2 requires 7 item(s) but generated 5.'), 'regeneration prompt carries the reason');
assert(!regenPrompt.includes('Generate exactly 11'), 'regeneration does not re-run the whole paper');

// ─────────────────────────────────────────────────────────────────────────────
section('9. Student instructions stay separate from AI instructions');
const studentInstructions = [
  'Read the question paper thoroughly before answering.',
  'Answer all the questions.',
  'You can write only the answers. Number the answers correctly.',
];
const genPrompt = questionGeneratorAgent.buildPrompt(req, [], { blueprint: bp });
for (const si of studentInstructions) {
  assert(!genPrompt.includes(si), `AI prompt does not contain student instruction: "${si.slice(0, 30)}…"`);
}
assert(genPrompt.includes('LOCKED BLUEPRINT'), 'AI prompt contains the locked blueprint rules');
assert(genPrompt.includes('FROZEN'), 'AI prompt marks the blueprint as frozen');
assert(genPrompt.includes('Do NOT copy'), 'AI prompt keeps the no-copy rule internal');

const bpJson = JSON.stringify(bp);
assert(!bpJson.includes('LOCKED BLUEPRINT') && !bpJson.includes('FROZEN') && !bpJson.includes('Do not copy'),
  'blueprint data contains no AI-generation instructions');

// Generated questions carry only structural/content fields — never AI instructions
const slotOverride = normalizeGeneratedQuestion(
  { questionId: 'x', text: 'Some new question stem', type: 'MCQ', marks: 3, difficulty: 'Easy' },
  0,
  { blueprintSlot: { ...bp.questions[0], slotIndex: 0 } }
);
assertEq(slotOverride.type, 'MAP', 'blueprint slot overrides LLM type');
assertEq(slotOverride.marks, 5, 'blueprint slot overrides LLM marks (authoritative)');
assertEq(slotOverride.slotIndex, 0, 'slotIndex attached');
assertEq(slotOverride.markExpression, '1X5=5', 'markExpression attached for rendering');
assert(!JSON.stringify(slotOverride).includes('LOCKED BLUEPRINT'), 'generated question has no AI instructions');

// ─────────────────────────────────────────────────────────────────────────────
section('10. Previous questions are not copied');
const sourceTexts = new Set(EVS_QUESTIONS.map((q) => normalizeQuestionText(q.text)));
let copied = 0;
for (const q of conforming) {
  const full = normalizeQuestionText(q.fullText || q.text);
  if (sourceTexts.has(full)) copied++;
}
assertEq(copied, 0, 'no generated question is an exact copy of a source question');

// ─────────────────────────────────────────────────────────────────────────────
section('11. Universal: sections + MCQs + short answers (inline titles)');
const BIO_QUESTIONS = [
  { questionNumber: 'Q1', parentQuestionNumber: null, section: 'A', type: 'MCQ', text: 'Choose the correct option: 1x5=5', options: [], marks: null },
  { questionNumber: 'Q2', parentQuestionNumber: null, section: 'A', type: 'SHORT_ANSWER', text: 'Name the following 2x3=6', options: [], marks: null },
  { questionNumber: 'Q3', parentQuestionNumber: null, section: 'B', type: 'SHORT_ANSWER', text: 'Define the following terms: (Any two) 2x2=4', options: [], marks: null },
];
const BIO_TEXT = `GREEN VALLEY SCHOOL\nANNUAL EXAMINATION (2024-25)\nSUBJECT - SCIENCE\nCLASS - VII\nTime: 3 Hours Maximum Marks: 60\nSECTION A - Biology\nSECTION B - Physics`;
const bpBio = extractBlueprint({ questions: BIO_QUESTIONS, text: BIO_TEXT });
assertEq(bpBio.totalQuestions, 3, 'sections fixture → 3 questions');
assertEq(bpBio.totalMarks, 15, 'sections fixture → 15 marks (5+6+4)');
assertEq(bpBio.sections.length, 2, 'sections fixture → 2 sections');
assertEq(bpBio.sections[0].title, 'Biology', 'inline section title A → Biology');
assertEq(bpBio.sections[1].title, 'Physics', 'inline section title B → Physics');
assertEq(bpBio.questions[0].type, 'MCQ', 'Q1 MCQ');
assertEq(bpBio.questions[1].type, 'SHORT_ANSWER', 'Q2 SHORT_ANSWER');
assertEq(bpBio.questions[2].type, 'DEFINITION', 'Q3 DEFINITION');
assertEq(bpBio.questions[2].optionalRule.n, 2, 'Q3 (Any two)');
assertEq(normalizeBlueprint(bpBio).questions[0].sectionName, 'SECTION A', 'Q1 sectionName via normalize');

// ─────────────────────────────────────────────────────────────────────────────
section('12. Universal: Reading/Grammar/Literature/Writing + (i)(ii)(iii) subquestions');
const RGLW_QUESTIONS = [
  { questionNumber: 'Q1', parentQuestionNumber: null, section: 'A', type: 'SHORT_ANSWER', text: 'Read the given passage and answer the questions that follow: 1x5=5', options: [], marks: null },
  { questionNumber: 'Q2', parentQuestionNumber: null, section: 'B', type: 'SHORT_ANSWER', text: 'Fill in the blanks: 1x4=4', options: [], marks: null },
  { questionNumber: 'Q2(i)', parentQuestionNumber: 'Q2', section: 'B', type: 'SHORT_ANSWER', text: 'She ___ to school.', options: [], marks: null },
  { questionNumber: 'Q2(ii)', parentQuestionNumber: 'Q2', section: 'B', type: 'SHORT_ANSWER', text: 'They ___ playing.', options: [], marks: null },
  { questionNumber: 'Q2(iii)', parentQuestionNumber: 'Q2', section: 'B', type: 'SHORT_ANSWER', text: 'He ___ a book.', options: [], marks: null },
  { questionNumber: 'Q2(iv)', parentQuestionNumber: 'Q2', section: 'B', type: 'SHORT_ANSWER', text: 'We ___ happy.', options: [], marks: null },
  { questionNumber: 'Q3', parentQuestionNumber: null, section: 'C', type: 'SHORT_ANSWER', text: 'Answer the following questions: (any two) 2x2=4', options: [], marks: null },
  { questionNumber: 'Q4', parentQuestionNumber: null, section: 'D', type: 'SHORT_ANSWER', text: 'Write a short paragraph on your favourite festival. 5', options: [], marks: null },
];
const RGLW_TEXT = `ARMY PUBLIC SCHOOL\nANNUAL EXAMINATION (2023-24)\nSUBJECT - ENGLISH\nCLASS - V\nTime: 2 Hours 30 minutes Maximum Marks: 80\nGeneral Instructions:\n1. Read the question paper thoroughly.\n2. Answer all the questions.\nSECTION A\nReading\nSECTION B\nGrammar\nSECTION C\nLiterature\nSECTION D\nWriting`;
const bpRglw = extractBlueprint({ questions: RGLW_QUESTIONS, text: RGLW_TEXT });
assertEq(bpRglw.totalQuestions, 4, 'RGLW fixture → 4 questions');
assertEq(bpRglw.totalMarks, 18, 'RGLW fixture → 18 marks (5+4+4+5)');
assertEq(bpRglw.studentInstructions.length, 2, 'RGLW student instructions discovered');
assertEq(bpRglw.sections.map((s) => s.title).join(','), 'Reading,Grammar,Literature,Writing', 'next-line section titles');
assertEq(bpRglw.questions[1].subQuestionCount, 4, 'Q2 has 4 (i)-(iv) subquestions');
assertEq(bpRglw.questions[1].itemCount, 4, 'Q2 itemCount from observed subquestions');
assertEq(bpRglw.questions[2].optionalRule.n, 2, 'Q3 (any two)');

// ─────────────────────────────────────────────────────────────────────────────
section('13. Universal: no sections, direct Q1-Q5');
const NOSEC_QUESTIONS = [
  { questionNumber: 'Q1', parentQuestionNumber: null, section: null, type: 'SHORT_ANSWER', text: 'What is the capital of India? 2', options: [], marks: null },
  { questionNumber: 'Q2', parentQuestionNumber: null, section: null, type: 'SHORT_ANSWER', text: 'Name the largest planet. 1', options: [], marks: null },
  { questionNumber: 'Q3', parentQuestionNumber: null, section: null, type: 'SHORT_ANSWER', text: 'Solve: 24 ÷ 6 = ? 1x2=2', options: [], marks: null },
];
const bpNoSec = extractBlueprint({ questions: NOSEC_QUESTIONS, text: 'MATHS TEST\nClass 4' });
assertEq(bpNoSec.totalQuestions, 3, 'no-sections fixture → 3 questions');
assertEq(bpNoSec.sections.length, 0, 'no sections detected');
assert(bpNoSec.blueprintWarnings.some((w) => w.field === 'section'), 'section warning emitted');
assertEq(bpNoSec.totalMarks, 5, 'no-sections fixture → 5 marks (2+1+2)');

// ─────────────────────────────────────────────────────────────────────────────
section('14. Universal: internal choice (A. … OR B. …)');
const CHOICE_QUESTIONS = [
  {
    questionNumber: 'Q1', parentQuestionNumber: null, section: null, type: 'SHORT_ANSWER',
    text: 'Answer any one of the following (A or B): 5',
    options: ['A. Write a note on the water cycle.', 'B. Write a note on the nitrogen cycle.'],
    marks: null,
  },
];
const bpChoice = extractBlueprint({ questions: CHOICE_QUESTIONS, text: '' });
assertEq(bpChoice.questions[0].type, 'INTERNAL_CHOICE', 'A-or-B detected as INTERNAL_CHOICE');
assertEq(bpChoice.questions[0].optionCount, 2, 'optionCount recorded');

// ─────────────────────────────────────────────────────────────────────────────
section('15. Universal: varied mark expressions + diagram/numerical types');
const MARKS_QUESTIONS = [
  { questionNumber: 'Q1', parentQuestionNumber: null, section: null, type: 'SHORT_ANSWER', text: 'Solve the following: 2x3=6', options: [], marks: null },
  { questionNumber: 'Q2', parentQuestionNumber: null, section: null, type: 'SHORT_ANSWER', text: 'Answer the following: 10', options: [], marks: null },
  { questionNumber: 'Q3', parentQuestionNumber: null, section: null, type: 'SHORT_ANSWER', text: 'Draw and label the given diagram. 5', options: [], marks: null },
];
const bpMarks = extractBlueprint({ questions: MARKS_QUESTIONS, text: '' });
assertEq(bpMarks.questions[0].type, 'NUMERICAL', 'solve → NUMERICAL');
assertEq(bpMarks.questions[0].markExpression, '2X3=6', '2x3=6 expression');
assertEq(bpMarks.questions[0].totalMarks, 6, '2x3=6 total');
assertEq(bpMarks.questions[1].totalMarks, 10, 'bare 10 marks');
assertEq(bpMarks.questions[2].type, 'DIAGRAM', 'diagram → DIAGRAM');
assertEq(bpMarks.questions[2].totalMarks, 5, 'diagram 5 marks');

// ─────────────────────────────────────────────────────────────────────────────
section('16. Universal: header variants (school/exam/session)');
const HDR_QUESTIONS = [{ questionNumber: 'Q1', parentQuestionNumber: null, section: null, type: 'SHORT_ANSWER', text: 'Name the first president. 1', options: [], marks: null }];
const HDR_TEXT = `DELHI PUBLIC SCHOOL, ROHINI\nHALF YEARLY EXAMINATION (2024-25)\nSUBJECT: SCIENCE\nCLASS: VI\nTime Allowed: 3 Hours Maximum Marks: 80`;
const bpHdr = extractBlueprint({ questions: HDR_QUESTIONS, text: HDR_TEXT });
assertEq(bpHdr.paper.schoolName, 'DELHI PUBLIC SCHOOL, ROHINI', 'schoolName discovered');
assertEq(bpHdr.paper.examTitle, 'HALF YEARLY EXAMINATION (2024-25)', 'examTitle discovered');
assertEq(bpHdr.paper.session, '2024-25', 'session discovered');
assertEq(bpHdr.paper.class, 'VI', 'class VI');
assertEq(bpHdr.paper.subject, 'SCIENCE', 'subject SCIENCE');
assertEq(bpHdr.paper.duration, '3 Hours', 'duration');
assertEq(bpHdr.paper.maximumMarks, 80, 'maximum marks 80');

// ─────────────────────────────────────────────────────────────────────────────
section('17. GOLDEN regression: real ENGLISH.pdf (values DISCOVERED, never hard-coded in logic)');
try {
  const { env } = await import('./src/config/env.js');
  const { storageService } = await import('./src/services/storage.service.js');
  const { pdfParser } = await import('./src/document/pdf-parser.js');
  const { questionExtractor } = await import('./src/document/question-extractor.js');
  const url = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/raw/upload/paper_setting_ai/papers/ENGLISH_1788527122184-1839`;
  const buf = await storageService.downloadFileBuffer(url);
  const parsed = await pdfParser.parseBuffer(buf);
  const ext = questionExtractor.extract(parsed.text, parsed.pages);
  const bpEn = extractBlueprint({ questions: ext.questions, text: parsed.text });
  assertEq(bpEn.totalQuestions, 14, 'ENGLISH golden → 14 questions discovered');
  assertEq(bpEn.totalMarks, 80, 'ENGLISH golden → 80 marks discovered');
  assertEq(bpEn.marksComplete, true, 'ENGLISH golden marks complete');
  assertEq(bpEn.sections.map((s) => s.title).join(','), 'Reading,Grammar,Literature,Creativity', 'ENGLISH golden section titles');
  assertEq(bpEn.paper.schoolName, 'ARMY PUBLIC SCHOOL SHILLONG', 'ENGLISH golden school name');
  assertEq(bpEn.paper.session, '2022-23', 'ENGLISH golden session');
  assertEq(bpEn.studentInstructions.length, 4, 'ENGLISH golden student instructions');
  assertEq(bpEn.questions[0].type, 'PASSAGE', 'ENGLISH golden Q1 PASSAGE');
  assertEq(bpEn.questions[8].optionalRule.n, 5, 'ENGLISH golden Q9 (any 5)');
  assertEq(bpEn.questions[9].markExpression, '3X3=9', 'ENGLISH golden Q10 3x3=9');
  assertEq(bpEn.questions[13].type, 'CREATIVE_WRITING', 'ENGLISH golden Q14 CREATIVE_WRITING');
  console.log('  (fetched real ENGLISH.pdf from Cloudinary for the golden regression)');
} catch (err) {
  console.warn(`  SKIP English golden (cloud fetch failed): ${err.message}`);
  skipped.push('ENGLISH golden (cloud unavailable)');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n────────────────────────────────────────────`);
console.log(`test-blueprint: ${passed} passed, ${failed} failed${skipped.length ? ` (${skipped.length} skipped: ${skipped.join(', ')})` : ''}`);
if (failed > 0) {
  console.error('Failed checks:');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
process.exit(0);