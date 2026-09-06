// Headless validation harness: renders buildDocDefinition() (the exact client
// doc builder) to a PDF so layout can be probed and compared with the
// reference paper. Usage:
//   node scripts/render-paper.mjs [--out path/to/out.pdf]
// The fixture mirrors the reference (ENGLISH.pdf) content where possible.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocDefinition } from '../client/src/services/paperPdf.js';
import liberation from '../client/src/fonts/LiberationSerif.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const outFlag = process.argv.find((a) => a.startsWith('--out='));
const outFile = outFlag ? outFlag.split('=')[1] : path.join(__dirname, '..', 'uploads', '_layout-check.pdf');
const many = process.argv.includes('--many');

const pdfMake = require('pdfmake/build/pdfmake.js');
if (typeof pdfMake.addFontContainer === 'function') {
  pdfMake.addFontContainer(liberation);
} else {
  pdfMake.vfs = { ...(pdfMake.vfs || {}), ...liberation.vfs };
  pdfMake.fonts = { ...(pdfMake.fonts || {}), ...liberation.fonts };
}

const FIXTURE_QUESTIONS = [
  {
    questionId: 'q1',
    type: 'MCQ',
    text: 'Choose the correct option:',
    marks: 5,
    options: ['teacher', 'parents', 'neighbours'],
  },
  {
    questionId: 'q2',
    type: 'SHORT_ANSWER',
    text: 'Fill in the blanks with simple present tense of the verbs given in the brackets:',
    marks: 5,
    subParts: [
      { label: 'a.', text: 'My sister ______________ (play) basketball everyday.' },
      { label: 'b.', text: 'They _________ (talk) too much.' },
      { label: 'c.', text: 'My cousin __________ (live) in Delhi.' },
      { label: 'd.', text: 'I ____________ (get) up early in the morning.' },
      { label: 'e.', text: 'My mother _____________(tell) me stories.' },
    ],
  },
  {
    questionId: 'q3',
    type: 'LONG_ANSWER',
    text: 'Create a story using the given outline. Also give the title and the moral of the story.',
    marks: 5,
    passage:
      'a hot summer day ____ a fox passes by a well _____ sees water in it ______ tries to reach for it _____ falls in _____ cannot come out _____ a goat passes by _____ sees the fox ____ asks him why he is there ______ fox says he is enjoying the cool water _____ invites the goat to jump in _____ goat jumps in _____ fox leaps on goat’s back and jumps out _____ laughs at the stupid goat.',
  },
];

// For --many: pad the fixture with long questions so the paper spans several
// pages (validates footers, auto page-breaks and section-heading placement).
const FIXTURE_MANY = Array.from({ length: 11 }, (_, i) => ({
  questionId: `extra-${i}`,
  type: i % 3 === 0 ? 'SHORT_ANSWER' : i % 3 === 1 ? 'TRUE_FALSE' : 'MCQ',
  text:
    'Explain with reasons how plants living in dry regions (xerophytes) reduce water loss, and compare this with the adaptations shown by water plants (hydrophytes). Give two examples of each.',
  marks: 3,
  options:
    i % 3 === 2
      ? ['they store water in thick stems', 'they open stomata only at night', 'they drop their leaves in summer', 'all of the above']
      : [],
}));

const doc = buildDocDefinition({
  questions: many ? [...FIXTURE_QUESTIONS, ...FIXTURE_MANY] : FIXTURE_QUESTIONS,
  settings: { class: '4' },
  subject: 'English',
  format: {
    schoolName: 'ARMY PUBLIC SCHOOL SHILLONG',
    examTitle: 'ANNUAL EXAMINATION (2022-23)',
    session: '',
    timeAllowed: '2hrs 30mins',
    maximumMarks: '80',
    instructions: [
      'Read the question paper thoroughly before answering.',
      'Answer all the questions.',
      'There are four sections: A- Reading, B- Grammar, C- Literature, D- Creativity.',
      'You can write only the answers. Number the answers correctly.',
    ],
  },
});

async function getBuffer() {
  const gen = pdfMake.createPdf(doc);
  if (typeof gen.getBuffer().then === 'function') return gen.getBuffer(); // promise API
  return new Promise((resolve, reject) => gen.getBuffer(resolve)); // callback API
}

const buffer = await getBuffer();
fs.writeFileSync(outFile, buffer);
console.log(`Wrote ${outFile} (${buffer.length} bytes)`);
