// Render a /api/questions/generate result file through the new exam-format
// builder. Usage:
//   node scripts/render-result.mjs <result.json> [--out out.pdf] [--blueprint <bp.json>]
// When a blueprint file is supplied it is passed to the layout builder, so the
// rendered PDF follows the LOCKED blueprint structure (sections/order/numbers).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocDefinition } from '../client/src/services/paperPdf.js';
import liberation from '../client/src/fonts/LiberationSerif.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const inFile = path.resolve(process.argv[2] || 'uploads/gen-result.json');
const outFlag = process.argv.find((a) => a.startsWith('--out='));
const outFile = outFlag ? outFlag.split('=')[1] : path.join(__dirname, '..', 'uploads', 'English_Class4_QuestionPaper_v2.pdf');
const bpFlag = process.argv.find((a) => a.startsWith('--blueprint='));
const blueprint = bpFlag ? JSON.parse(fs.readFileSync(bpFlag.split('=')[1], 'utf8')) : null;

const pdfMake = require('pdfmake/build/pdfmake.js');
if (typeof pdfMake.addFontContainer === 'function') pdfMake.addFontContainer(liberation);
else {
  pdfMake.vfs = { ...(pdfMake.vfs || {}), ...liberation.vfs };
  pdfMake.fonts = { ...(pdfMake.fonts || {}), ...liberation.fonts };
}

const result = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const data = result.data || result;
const questions = (data.questions || []).map((q) => {
  const { status, validation, similarity, embedding, ...rest } = q || {};
  return rest; // keep only student-facing fields
});

const doc = buildDocDefinition({
  questions,
  blueprint,
  settings: { class: data.requirements?.class ?? '4' },
  subject: data.requirements?.subject ?? 'English',
  format: {
    schoolName: 'ARMY PUBLIC SCHOOL SHILLONG',
    examTitle: 'ANNUAL EXAMINATION (2022-23)',
    session: '',
    timeAllowed: '2hrs 30mins',
    maximumMarks: '80',
    instructions: [
      'Read the question paper thoroughly before answering.',
      'Answer all the questions.',
      'Write only the answers. Number the answers correctly.',
    ],
  },
});

const gen = pdfMake.createPdf(doc);
const buffer = typeof gen.getBuffer().then === 'function' ? await gen.getBuffer() : await new Promise((r) => gen.getBuffer(r));
fs.writeFileSync(outFile, buffer);
console.log(`Wrote ${outFile} (${buffer.length} bytes) — ${questions.length} question(s)`);
