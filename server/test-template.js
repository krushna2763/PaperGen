/**
 * test-template.js
 *
 * Lightweight Node test suite for the UNIVERSAL Visual TEMPLATE analyzer
 * (reference paper → structured template; zero LLM). No framework — run with:
 *   node test-template.js   (or npm run test:template)
 *
 * Covers:
 *   1. pure detection helpers (instructions heading, numbering style, marks
 *      style, MCQ option-label style, special-structure counts)
 *   2. EVS-style paper (NO sections, Q1..Q11, uppercase-X marks, roman MCQ
 *      options) → flat template, header block, header-repeat signal
 *   3. English-style sectioned paper (SECTION A–D with titles) → sections
 *      preserved, per-section membership untouched
 *   4. template → client paper-format mapping (auto-fill + session split +
 *      duration normalization + option style)
 *   5. no invented values when a structure cannot be detected (warnings)
 */

import { extractBlueprint } from './src/blueprint/blueprint-extractor.js';
import {
  analyzeTemplate,
  detectInstructions,
  detectNumberingStyle,
  detectMarksStyle,
  detectOptionLabelStyle,
  detectSpecialStructures,
} from './src/blueprint/template-analyzer.js';
import { templateToFormat, applyMarksCase } from '../client/src/services/paperTemplate.js';

// NOTE: importing client/src/services/paperTemplate.js works because that module
// is pure (no DOM/browser imports); it stays the shared source for format logic.

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) passed++;
  else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}
function assertEq(actual, expected, label) {
  const ok = actual === expected || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else { failed++; failures.push(label); console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}
function section(title) { console.log(`\n== ${title}`); }

// ─────────────────────────────────────────────────────────────────────────────
section('1. Pure detection helpers');
const instr = detectInstructions(`ARMY PUBLIC SCHOOL\nTime: 2hrs  Maximum Marks: 80\n\nGeneral Instructions :\n1. Read the question paper thoroughly before answering.\n2. Answer all the questions.\n\nSECTION A\nReading`);
assertEq(instr.heading, 'General Instructions :', 'verbatim GI heading');
assertEq(instr.items, ['Read the question paper thoroughly before answering.', 'Answer all the questions.'], 'GI items extracted, numbering stripped');
const instr2 = detectInstructions('Instructions:\n1. One line.\n[1]\n2. Two lines.\n3. 5\nSECTION B');
assertEq(instr2.items, ['One line.', 'Two lines.'], 'artifacts ([1], bare 5) filtered');
assertEq(instr2.heading, 'Instructions:', 'lowercase heading verbatim');

assertEq(detectNumberingStyle(['Q1', 'Q2', 'Q3', 'Q4']).style, 'q-prefix', 'Q1-style numbering');
assertEq(detectNumberingStyle(['1.', '2.', '3.']).style, 'digit-dot', 'digit-dot numbering');
assertEq(detectNumberingStyle(['1)', '2)']).style, 'digit-paren', 'digit-paren numbering');
assertEq(detectNumberingStyle(['I', 'II', 'III']).style, 'roman', 'roman numbering');
assertEq(detectNumberingStyle(['A', 'B', 'C']).style, 'letter', 'letter numbering');
assertEq(detectNumberingStyle([]).style, 'unknown', 'empty → unknown');

assertEq(detectMarksStyle(['1X5=5', '1X7=7', '2X4=8']).style, 'upper-x', 'uppercase X marks');
assertEq(detectMarksStyle(['1X5=5']).equation, true, 'equation detected');
assertEq(detectMarksStyle(['2x4=8', '3x3=9']).style, 'lower-x', 'lowercase x marks');
assertEq(detectMarksStyle(['2×4=8']).style, 'times', 'times marks');
assertEq(detectMarksStyle(['4+1']).style, 'plus', 'additive 4+1 marks');
assertEq(detectMarksStyle(['5', '3', '8']).style, 'plain', 'bare-number marks');

assertEq(detectOptionLabelStyle(['i) Oxygen', 'ii) Water', 'iii) Air', 'iv) Soil']).style, 'roman-lower', 'roman MCQ options');
assertEq(detectOptionLabelStyle(['a) Apple', 'b) Mango', 'c) Grapes']).style, 'alpha-lower', 'alpha MCQ options');
assertEq(detectOptionLabelStyle(['(A) Yes', '(B) No']).style, 'alpha-upper', 'upper-alpha MCQ options');
assertEq(detectOptionLabelStyle(['Oxygen', 'Water']).style, 'plain', 'bare option text → plain');

assertEq(detectSpecialStructures([
  { type: 'PASSAGE' }, { type: 'MATCH_THE_FOLLOWING' }, { type: 'INTERNAL_CHOICE' },
  { type: 'DIAGRAM' }, { type: 'MCQ' }, { type: 'MCQ' }, { type: 'DRAWING' },
]).match, 1, 'match count');
assertEq(detectSpecialStructures([{ type: 'MCQ' }, { type: 'MCQ' }]).mcq, 2, 'mcq count');

// ─────────────────────────────────────────────────────────────────────────────
section('2. EVS-style paper (NO sections) → flat template + header');
const EVS_TEXT = `ARMY PUBLIC SCHOOL SHILLONG
ANNUAL EXAMINATION (2022-23)
SUBJECT - ENVIRONMENTAL STUDIES
CLASS - IV

Time: 2hrs 30mins        Maximum Marks: 80

General Instructions :
1. Read the question paper thoroughly before answering.
2. Answer all the questions.
3. You can write only the answers. Number the answers correctly.

Q1. On a Map of India mark the following 1X5=5
Q2. Choose the correct option: 1X7=7
Q3. Write True or False for the following: 1X8=8
Q4. Fill in the blanks: 1X7=7
Q5. Match the following column: 1X7=7
Q6. Name the following 1X5=5
Q7. Define the following terms: (Any four) 2X4=8
Q8. Answer the following questions: (Any four) 2X4=8
Q9. Answer the following questions: (Any four) 3X4=12
Q10. Answer the following questions: (Any four) 4X2=8
Q11. Draw and colour your favourite transport. 4+1`;
const EVS_QUESTIONS = [
  { questionNumber: 'Q1', section: null, type: 'MCQ', text: 'On a Map of India mark the following 1X5=5', options: [], marks: null },
  { questionNumber: 'Q2', section: null, type: 'MCQ', text: 'Choose the correct option: 1X7=7', options: ['i) Oxygen', 'ii) Nitrogen', 'iii) Carbon dioxide', 'iv) Water vapour'], marks: null },
  { questionNumber: 'Q3', section: null, type: 'MCQ', text: 'Write True or False for the following: 1X8=8', options: [], marks: null },
  { questionNumber: 'Q4', section: null, type: 'MCQ', text: 'Fill in the blanks: 1X7=7', options: [], marks: null },
  { questionNumber: 'Q5', section: null, type: 'MCQ', text: 'Match the following column: 1X7=7', options: [], marks: null },
  { questionNumber: 'Q6', section: null, type: 'MCQ', text: 'Name the following 1X5=5', options: [], marks: null },
  { questionNumber: 'Q7', section: null, type: 'MCQ', text: 'Define the following terms: (Any four) 2X4=8', options: [], marks: null },
  { questionNumber: 'Q8', section: null, type: 'SHORT_ANSWER', text: 'Answer the following questions: (Any four) 2X4=8', options: [], marks: null },
  { questionNumber: 'Q9', section: null, type: 'SHORT_ANSWER', text: 'Answer the following questions: (Any four) 3X4=12', options: [], marks: null },
  { questionNumber: 'Q10', section: null, type: 'SHORT_ANSWER', text: 'Answer the following questions: (Any four) 4X2=8', options: [], marks: null },
  { questionNumber: 'Q11', section: null, type: 'CREATIVE_WRITING', text: 'Draw and colour your favourite transport. 4+1', options: [], marks: null },
];
const bpEvs = extractBlueprint({ questions: EVS_QUESTIONS, text: EVS_TEXT });
const tplEvs = analyzeTemplate({
  text: EVS_TEXT,
  pages: [
    { pageNumber: 1, text: 'ARMY PUBLIC SCHOOL SHILLONG\nANNUAL EXAMINATION (2022-23)\nTime: 2hrs 30mins Maximum Marks: 80\nGeneral Instructions :\n1. Read the question paper thoroughly.\n2. Answer all the questions.\nQ1. On a Map of India mark the following 1X5=5\nQ2. Choose the correct option: 1X7=7\nQ4. Fill in the blanks: 1X7=7\n1' },
    { pageNumber: 2, text: 'ARMY PUBLIC SCHOOL SHILLONG\nQ5. Match the following column: 1X7=7\nQ6. Name the following 1X5=5\nQ7. Define the following terms: (Any four) 2X4=8\nQ8. Answer the following questions: (Any four) 2X4=8\n2' },
    { pageNumber: 3, text: 'ARMY PUBLIC SCHOOL SHILLONG\nQ9. Answer the following questions: (Any four) 3X4=12\nQ10. Answer the following questions: (Any four) 4X2=8\nQ11. Draw and colour your favourite transport. 4+1\n3' },
  ],
  questions: EVS_QUESTIONS,
  blueprint: bpEvs,
});
assertEq(bpEvs.totalQuestions, 11, 'EVS fixture: 11 questions discovered');
assertEq(bpEvs.totalMarks, 80, 'EVS fixture: 80 marks');
assertEq(tplEvs.sections.present, false, 'EVS template: NO sections');
assertEq(tplEvs.sections.count, 0, 'EVS template: 0 sections');
assertEq(tplEvs.header.present.schoolName, true, 'EVS header: school name present');
assertEq(tplEvs.header.schoolName, 'ARMY PUBLIC SCHOOL SHILLONG', 'EVS header schoolName value');
assertEq(tplEvs.header.examTitle, 'ANNUAL EXAMINATION (2022-23)', 'EVS header examTitle verbatim');
assertEq(tplEvs.header.maximumMarks, 80, 'EVS header 80 marks');
assertEq(tplEvs.numbering.style, 'q-prefix', 'EVS numbering style');
assertEq(tplEvs.marks.style, 'upper-x', 'EVS marks uppercase-X');
assertEq(tplEvs.marks.equation, true, 'EVS marks equations');
assertEq(tplEvs.options.style, 'roman-lower', 'EVS MCQ options roman');
assertEq(tplEvs.special.mcq, 1, 'EVS MCQ count (content-typed: only the "choose the correct option" stem)');
assertEq(tplEvs.instructions.heading, 'General Instructions :', 'EVS GI heading verbatim');
assertEq(tplEvs.instructions.items.length, 3, 'EVS GI items count');
assertEq(tplEvs.page.pageCount, 3, 'EVS page count');
assertEq(tplEvs.page.headerRepeated, true, 'EVS running header repeated on later pages');
assertEq(tplEvs.page.pageNumbersDetected, true, 'EVS trailing page numbers');

// ─────────────────────────────────────────────────────────────────────────────
section('3. English-style sectioned paper → sections preserved, flat only when none');
const EN_TEXT = `ST MARYS CONVENT SCHOOL
ANNUAL EXAMINATION (2024-25)
SUBJECT - ENGLISH
CLASS - III

Time: 2 Hours 30 minutes        Maximum Marks: 80

General Instructions :
1. Read the question paper thoroughly.
2. Write all answers in the space provided.

SECTION A
Reading
SECTION B
Grammar
SECTION C
Literature
SECTION D
Creativity`;
const EN_QUESTIONS = [
  { questionNumber: 'Q1', section: 'A', type: 'PASSAGE', text: 'Read the given passage carefully: 1X5=5', options: [], marks: null },
  { questionNumber: 'Q2', section: 'B', type: 'GRAMMAR', text: 'Fill in the blanks with present tense verbs: 1x3=3', options: [], marks: null },
  { questionNumber: 'Q3', section: 'B', type: 'GRAMMAR', text: 'Fill in the blanks with past tense verbs: 1x4=4', options: [], marks: null },
  { questionNumber: 'Q4', section: 'B', type: 'GRAMMAR', text: 'Underline the adverbs: 1x3=3', options: [], marks: null },
  { questionNumber: 'Q5', section: 'B', type: 'MCQ', text: 'Choose the correct option: 1x4=4', options: ['(A) on', '(B) in', '(C) at', '(D) under'], marks: null },
  { questionNumber: 'Q6', section: 'C', type: 'SHORT_ANSWER', text: 'Answer the following questions: (any 5) 2x5=10', options: [], marks: null },
  { questionNumber: 'Q7', section: 'D', type: 'CREATIVE_WRITING', text: 'Write a short paragraph: 4+1', options: [], marks: null },
];
const bpEn = extractBlueprint({ questions: EN_QUESTIONS, text: EN_TEXT });
const tplEn = analyzeTemplate({ text: EN_TEXT, pages: [{ pageNumber: 1, text: EN_TEXT }], questions: EN_QUESTIONS, blueprint: bpEn });
assertEq(bpEn.totalQuestions, 7, 'EN fixture: 7 questions');
assertEq(tplEn.sections.present, true, 'EN template: sections present');
assertEq(tplEn.sections.count, 4, 'EN template: 4 sections');
assertEq(tplEn.sections.names.join(','), 'SECTION A,SECTION B,SECTION C,SECTION D', 'EN section names/order preserved');
assertEq(tplEn.sections.titles.join(','), 'Reading,Grammar,Literature,Creativity', 'EN section titles preserved');
assertEq(tplEn.header.examTitle, 'ANNUAL EXAMINATION (2024-25)', 'EN exam title');
assertEq(tplEn.marks.style, 'lower-x', 'EN marks lowercase-x');
assertEq(tplEn.options.style, 'alpha-upper', 'EN MCQ options upper-alpha');
assertEq(tplEn.special.passages, 1, 'EN passage detected');

// ─────────────────────────────────────────────────────────────────────────────
section('4. Template → client paper-format mapping (auto-fill)');
const fmt = templateToFormat(tplEvs, { schoolName: '', examTitle: 'Annual Examination', session: '', timeAllowed: '2hrs 30mins', maximumMarks: '', instructions: [], instructionsHeading: 'General Instructions :', mcqOptionLabelStyle: 'roman' });
assertEq(fmt.schoolName, 'ARMY PUBLIC SCHOOL SHILLONG', 'format: schoolName auto-filled');
assertEq(fmt.examTitle, 'ANNUAL EXAMINATION (2022-23)', 'format: embedded session kept verbatim in examTitle');
assertEq(fmt.session, '', 'format: embedded session not duplicated into session field');
assertEq(fmt.timeAllowed, '2hrs 30mins', 'format: duration kept');
assertEq(fmt.maximumMarks, '80', 'format: 80 marks');
assertEq(fmt.instructions.length, 3, 'format: instructions auto-filled');
assertEq(fmt.instructionsHeading, 'General Instructions :', 'format: GI heading verbatim');
assertEq(fmt.mcqOptionLabelStyle, 'roman', 'format: roman option style from template');
assertEq(fmt.marksCase, 'upper-x', 'format: marks case upper-x (EVS reference)');
const fmtEn = templateToFormat(tplEn, { ...fmt });
assertEq(fmtEn.mcqOptionLabelStyle, 'alpha', 'format: alpha option style for EN template');
assertEq(fmtEn.examTitle, 'ANNUAL EXAMINATION (2024-25)', 'format: EN embedded session kept verbatim');
assertEq(fmtEn.marksCase, 'lower-x', 'format: marks case lower-x (EN reference)');
assertEq(applyMarksCase('1X5=5', 'lower-x'), '1x5=5', 'marks display case: upper → lower');
assertEq(applyMarksCase('1x3=3', 'upper-x'), '1X3=3', 'marks display case: lower → upper');
assertEq(applyMarksCase('4+1', 'lower-x'), '4+1', 'marks display case: plus untouched');
assertEq(applyMarksCase('2×4=8', 'times'), '2×4=8', 'marks display case: times untouched by x-case');
// duration normalization ("2Hours 30 minutes" glued by extractor)
const glued = { header: { duration: '2Hours 30 minutes', examTitle: 'X', session: '2024-25' } };
assertEq(templateToFormat(glued, { ...fmt }).timeAllowed, '2 Hours 30 minutes', 'format: glued duration normalized');

// ─────────────────────────────────────────────────────────────────────────────
section('5. No invented values on undetectable structure');
const bare = extractBlueprint({
  questions: [{ questionNumber: '1', section: null, type: 'SHORT_ANSWER', text: 'What is a river? 5', options: [], marks: null }],
  text: 'MY SCHOOL\nTime: 1 Hour Maximum Marks: 20\n\n1. What is a river? 5',
});
const tplBare = analyzeTemplate({ text: 'MY SCHOOL\nTime: 1 Hour Maximum Marks: 20\n\n1. What is a river? 5', questions: [], blueprint: bare });
assertEq(tplBare.sections.present, false, 'no sections → not invented');
assertEq(tplBare.sections.count, 0, 'section count 0');
assert(tplBare.templateWarnings.length >= 0, 'warnings array present');
assertEq(tplBare.header.schoolName, 'MY SCHOOL', 'school name captured when present');
assertEq(tplBare.options.style, 'unknown', 'no MCQ options → unknown, never guessed');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILED:', failures.join(' | '));
  process.exit(1);
}
