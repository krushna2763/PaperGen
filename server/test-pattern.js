/**
 * test-pattern.js — QUESTION-PATTERN FIDELITY (offline; zero Gemini calls).
 *
 * Verifies that each reference question becomes a LOCKED SLOT carrying not
 * just type/marks/section but the actual QUESTION PATTERN:
 *   - construction tags (instructionType / answerForm / layout)
 *   - per-item option counts + option label style (MCQ)
 *   - reference item texts as TOPIC ANCHORS (never copied, only anchored)
 * …and that generation/validation consume that pattern:
 *   - per-slot RAG query built from the slot's topic anchors
 *   - generation prompt carries reference anchors + per-slot RAG context
 *   - deterministic pattern validator (option count, passage requirement)
 *   - difficulty only changes the difficulty line, never the slot structure
 *
 * Run:  node test-pattern.js   (or npm run test:pattern)
 */

import { extractBlueprint } from './src/blueprint/blueprint-extractor.js';
import { normalizeBlueprint } from './src/blueprint/blueprint-normalizer.js';
import { checkQuestion } from './src/blueprint/blueprint-validator.js';
import { retrievalAgent } from './src/agents/retrieval.agent.js';
import { questionGeneratorAgent } from './src/agents/question-generator.agent.js';

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, label) { if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); } }
function assertEq(actual, expected, label) {
  const ok = actual === expected || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else { failed++; failures.push(label); console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}
function section(title) { console.log(`\n== ${title}`); }

// EVS-like reference (mirrors the uploaded EVS paper): MCQ with 4-option items,
// passage slot, answer-any-four, single draw item.
const TEXT = `ARMY PUBLIC SCHOOL SHILLONG
ANNUAL EXAMINATION (2022-23)
SUBJECT - ENVIRONMENTAL STUDIES
CLASS - IV

Time: 2hrs 30mins        Maximum Marks: 80

General Instructions :
1. Read the question paper thoroughly before answering.

Q1. On a Map of India mark the following 1X5=5
Q2. Choose the correct option: 1X7=7`;
const QUESTIONS = [
  { questionNumber: 'Q1', section: null, type: 'MCQ', text: 'On a Map of India mark the following 1X5=5', options: [], marks: null },
  { questionNumber: 'Q2', section: null, type: 'MCQ', text: 'Choose the correct option: 1X7=7', options: [], marks: null },
  { questionNumber: 'Q2(a)', parentQuestionNumber: 'Q2', section: null, type: 'MCQ', text: 'Which liquid present in the mouth digests carbohydrates?', options: ['a) Saliva', 'b) Bile', 'c) Hydrochloric acid', 'd) Gastric juice'], marks: null },
  { questionNumber: 'Q2(b)', parentQuestionNumber: 'Q2', section: null, type: 'MCQ', text: 'A doctor gives a glucose drip to a patient experiencing:', options: ['a) Severe weakness and dehydration', 'b) High fever with chills', 'c) Bone injury from a fall', 'd) Skin irritation'], marks: null },
  { questionNumber: 'Q8', section: null, type: 'PASSAGE', text: 'Read the passage about traditional water storage and answer the following questions: 2X4=8', options: [], marks: null },
  { questionNumber: 'Q8(a)', parentQuestionNumber: 'Q8', section: null, type: 'SHORT_ANSWER', text: 'How is rainwater directed into the storage structure?', options: [], marks: 2 },
  { questionNumber: 'Q8(b)', parentQuestionNumber: 'Q8', section: null, type: 'SHORT_ANSWER', text: 'Why is rainwater harvesting important in dry regions?', options: [], marks: 2 },
  { questionNumber: 'Q9', section: null, type: 'SHORT_ANSWER', text: 'Answer the following questions: (Any two) 3X4=12', options: [], marks: null },
  { questionNumber: 'Q9(a)', parentQuestionNumber: 'Q9', section: null, type: 'SHORT_ANSWER', text: 'Why should we eat a balanced diet?', options: [], marks: null },
  { questionNumber: 'Q9(b)', parentQuestionNumber: 'Q9', section: null, type: 'SHORT_ANSWER', text: 'Describe the 3 Rs of waste management.', options: [], marks: null },
  { questionNumber: 'Q9(c)', parentQuestionNumber: 'Q9', section: null, type: 'SHORT_ANSWER', text: 'Why is recycling good for our environment?', options: [], marks: null },
  { questionNumber: 'Q11', section: null, type: 'CREATIVE_WRITING', text: 'Draw and colour your favourite transport. 4+1', options: [], marks: null },
];

// ─────────────────────────────────────────────────────────────────────────────
section('1. QUESTION PATTERN extraction from reference');
const bp = extractBlueprint({ questions: QUESTIONS, text: TEXT });
const byLabel = new Map(bp.questions.map((q) => [q.label, q]));
const q2 = byLabel.get('Q2');
assertEq(q2.pattern.instructionType, 'choose-correct-option', 'Q2 construction = choose-correct-option');
assertEq(q2.pattern.answerForm, 'single-correct-option', 'Q2 answer form');
assertEq(q2.pattern.layout, 'grouped-sub-items', 'Q2 grouped sub-items');
assertEq(q2.pattern.optionCounts, [4, 4], 'Q2 per-item option counts [4,4]');
assertEq(q2.pattern.maxOptionCount, 4, 'Q2 max option count 4');
assertEq(q2.pattern.optionLabelStyle, 'alpha-lower', 'Q2 option label style lower-alpha');
assertEq(q2.referenceItems.length, 2, 'Q2 topic anchors (2 reference items)');
assert(q2.referenceItems[0].includes('digests carbohydrates'), 'Q2 anchor keeps the concept, not only the stem');
const q1 = byLabel.get('Q1');
assertEq(q1.pattern.instructionType, 'map-pointing', 'Q1 construction map-pointing');
assertEq(q1.pattern.answerForm, 'marked-location', 'Q1 answer form');
assertEq(q1.pattern.layout, 'single-item', 'Q1 single item (no sub-parts)');
assertEq(q1.referenceItems.length, 1, 'Q1 falls back to its own stem as topic anchor');
const q8 = byLabel.get('Q8');
assertEq(q8.type, 'PASSAGE', 'Q8 passage type');
assertEq(q8.pattern.instructionType, 'passage-comprehension', 'Q8 passage-comprehension');
assertEq(q8.itemCount, 2, 'Q8 exactly 2 sub-questions');
assertEq(q8.referenceItems.length, 2, 'Q8 two topic anchors');
const q9 = byLabel.get('Q9');
assertEq(q9.pattern.instructionType, 'answer-following', 'Q9 answer-following');
assertEq(q9.itemCount, 3, 'Q9 offers 3 (any two)');
assertEq(q9.referenceItems.length, 3, 'Q9 three anchors');
const q11 = byLabel.get('Q11');
assertEq(q11.pattern.answerForm, 'diagram-drawing', 'Q11 draw answer form');
assertEq(q11.pattern.instructionType, 'draw-label', 'Q11 draw-label construction');

section('2. Normalizer keeps pattern + anchors');
const norm = normalizeBlueprint(bp);
const n2 = norm.questions[1];
assertEq(n2.label, 'Q2', 'normalized keeps Q2');
assertEq(n2.pattern.maxOptionCount, 4, 'normalizer keeps maxOptionCount');
assertEq(n2.referenceItems.length, 2, 'normalizer keeps reference items');
assertEq(norm.questions[0].pattern.layout, 'single-item', 'normalizer keeps single-item layout');

section('3. Deterministic PATTERN VALIDATOR (option count + passage)');
const expectedQ2 = norm.questions.find((q) => q.label === 'Q2');
const good = { type: 'MCQ', marks: 7, text: 'Choose the correct option:', subParts: [
  { text: 'Which gas do plants take in during the day?', options: ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Hydrogen'] },
  { text: 'Which vitamin keeps our eyes healthy?', options: ['A', 'B', 'C', 'D'] },
] };
assertEq(checkQuestion(good, expectedQ2).ok, true, 'Q2 pattern pass: 4 options per item');
const badOpts = { type: 'MCQ', marks: 7, text: 'Choose the correct option:', subParts: [
  { text: 'Which gas do plants take in?', options: ['Oxygen', 'Carbon dioxide', 'Nitrogen'] },
  { text: 'Which vitamin keeps eyes healthy?', options: ['A', 'B', 'C', 'D'] },
] };
const badRes = checkQuestion(badOpts, expectedQ2);
assertEq(badRes.ok, false, 'Q2 pattern fail: 3 options instead of 4');
assert(badRes.reasons.some((r) => r.includes('requires 4 options but generated 3')), 'failure reason names the option mismatch');
const expectedQ8 = norm.questions.find((q) => q.label === 'Q8');
const passageMissing = { type: 'PASSAGE', marks: 8, text: 'Answer the following:', subParts: [{ text: 'How is rainwater stored?', options: [] }, { text: 'Why is it important?', options: [] }] };
const pm = checkQuestion(passageMissing, expectedQ8);
assertEq(pm.ok, false, 'Q8 passage slot fails without a passage');
assert(pm.reasons.some((r) => /passage\b/i.test(r)), 'reason names the missing passage');
// The reference Q8 parts carry per-part marks (2 each, from "2X4=8") — the
// generated parts must carry the same per-part marks (marks are structural).
const passageOK = { type: 'PASSAGE', marks: 8, text: 'Answer the following:', passage: 'Villagers built a small tank that collects rainwater from their rooftops. During summer the stored water helps them water the kitchen garden and keep animals healthy.', subParts: [{ text: 'How is rainwater stored in the structure?', options: [], marks: 2 }, { text: 'Why is rainwater harvesting useful in dry regions?', options: [], marks: 2 }] };
assertEq(checkQuestion(passageOK, expectedQ8).ok, true, 'Q8 passage slot passes with its own new passage + per-part marks');
const partMarksMissing = checkQuestion({ ...passageOK, subParts: passageOK.subParts.map(({ marks, ...p }) => p) }, expectedQ8);
assertEq(partMarksMissing.ok, false, 'Q8 per-part marks are enforced (parts without their locked marks fail)');
assert(partMarksMissing.reasons.some((r) => /must carry its locked 2 mark/.test(r)), 'reason names the missing per-part marks');

section('4. QUESTION-LEVEL RAG queries (topic anchors → query)');
const q = retrievalAgent.buildSlotQuery(byLabel.get('Q2'), { class: '4', subject: 'EVS' });
assert(q && q.includes('digests carbohydrates'), 'slot query carries the concept anchor');
assert(q.startsWith('Class 4 EVS'), 'slot query is class/subject scoped');
assertEq(retrievalAgent.buildSlotQuery({ instruction: 'Answer all', referenceItems: [] }, { class: '4', subject: 'EVS' }), 'Class 4 EVS: Answer all', 'slot query falls back to instruction');
assertEq(retrievalAgent.buildSlotQuery({}, { class: '4', subject: 'EVS' }), null, 'no anchor → null query');

section('5. Generation prompt: per-slot pattern + topic anchors + slot RAG context');
const requirements = { class: '4', subject: 'EVS', difficulty: 'Medium', questionCount: bp.totalQuestions };
const slotContexts = norm.questions.map((s, i) => ({
  slotIndex: i,
  query: 'x',
  results: [{ text: `context for ${s.label} — ${s.referenceItems[0] || s.label}` }],
}));
const prompt = questionGeneratorAgent.buildPrompt(requirements, [], { blueprint: norm, slotContexts });
assert(prompt.includes('LOCKED BLUEPRINT (FROZEN STRUCTURE)'), 'blueprint block present');
assert(prompt.includes('Reference items IN ORDER — generate one NEW sub-part per line on the SAME concept'), 'per-slot topic anchors present');
assert(prompt.includes('Slot RAG context (concept reference only)'), 'per-slot RAG context present');
assert(prompt.includes('context for Q2'), 'Q2-specific RAG context attached');
assert(prompt.includes('perItemOptions=4'), 'MCQ option count in slot spec');
assert(prompt.includes('instruction="Choose the correct option: 1X7=7"'.replace(' 1X7=7', '')), 'instruction pattern kept');
assert(!prompt.includes('(no retrieved context available)'), 'no generic empty-context block when per-slot contexts exist');
// free-form fallback still renders the global context block
const fallbackPrompt = questionGeneratorAgent.buildPrompt(requirements, [{ text: 'some concept' }], {});
assert(fallbackPrompt.includes('RETRIEVED CONTEXT (previous-year questions'), 'free-form keeps global RETRIEVED CONTEXT');

section('6. DIFFICULTY changes cognition only — never the locked slot structure');
const stripDifficulty = (p) => p.replace(/- Difficulty: \w+/g, '- Difficulty: X');
const pEasy = questionGeneratorAgent.buildPrompt({ ...requirements, difficulty: 'Easy' }, [], { blueprint: norm, slotContexts });
const pHard = questionGeneratorAgent.buildPrompt({ ...requirements, difficulty: 'Hard' }, [], { blueprint: norm, slotContexts });
assert(stripDifficulty(pEasy) === stripDifficulty(pHard), 'Easy vs Hard prompts identical apart from the difficulty value (same slots, same marks, same anchors)');
assert(pEasy.includes('- Difficulty: Easy'), 'Easy prompt difficulty labelled');
assert(pHard.includes('- Difficulty: Hard'), 'Hard prompt difficulty labelled');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
