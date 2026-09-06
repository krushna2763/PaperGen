/**
 * e2e-reference-computer.mjs — REAL end-to-end proof of the REFERENCE PAPER
 * ANALYZER pipeline on a Computer-Class-3-style reference (the exact structure
 * the task mandates). The backend must be running with the latest code.
 *
 *   text fixture
 *     → POST /papers/extract-questions      (Reference Paper Analyzer → spec)
 *     → source-hash reuse + embed/index     (Qdrant content for question-level RAG)
 *     → POST /questions/generate (Medium)   (real Gemini: per-slot pattern + topics)
 *     → per-slot conformance vs the spec    (counts, types, per-part marks, options)
 *     → render the accepted paper to PDF    (same blueprint/template pipeline)
 *     → Easy/Hard runs when quota allows    (structure must NOT move)
 *
 * NOTE: no Computer Class-3 PDF exists among the uploaded files, so this uses a
 * faithful synthetic fixture whose TEXT is analyzed exactly like a real upload
 * would be (zero hard-coding — every value is DISCOVERED from the text).
 *
 * Usage:  node scripts/e2e-reference-computer.mjs [medium|all]
 * (all = also attempt Easy + Hard real runs; quota permitting)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'uploads');
const API = 'http://localhost:5000/api';

async function api(pathname, body) {
  const res = await fetch(API + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${pathname} → ${res.status}: ${json.message || JSON.stringify(json).slice(0, 240)}`);
  return json;
}

const FIXTURE = `ARMY PUBLIC SCHOOL SHILLONG
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

const SUBJECT = 'Computer'; // retrieval/index key (short form)
const CLASS = '3';

console.log('── 1) Reference Paper Analyzer: extract-questions → canonical Reference Paper Specification ──');
const extract = await api('/papers/extract-questions', { text: FIXTURE });
const spec = extract.data.blueprint;
if (!spec?.specVersion || !spec?.analyzer) {
  console.error('  Spec missing analyzer markers — the backend is running old code. Restart the server.');
  process.exit(1);
}
console.log(`   analyzer=${spec.analyzer.determinism}  spec=${spec.specVersion}`);
console.log(`   ${spec.totalQuestions} slots / ${spec.totalMarks} marks / subject ${spec.paper.subject} / class ${spec.paper.class} / sections=${(spec.sections || []).length}`);
console.log('\n  SLOT | type | items | marks | per-part marks | anchors');
for (const s of spec.questions) {
  console.log(`  ${String(s.label).padEnd(5)} | ${String(s.type).padEnd(18)} | ${String(s.itemCount).padEnd(3)} | ${String(s.markExpression || s.totalMarks || '').padEnd(8)} | ${JSON.stringify(s.itemMarks || []).padEnd(16)} | ${(s.referenceItems || []).length}`);
}

console.log('\n── 2) Source-reuse check + ingest (content for question-level RAG) ──');
const sourceHash = createHash('sha256').update(FIXTURE).digest('hex');
const check = await api('/papers/check-indexed', { sourceHash });
console.log(`   indexed=${check.data.indexed} (hash ${sourceHash.slice(0, 12)}…)`);
if (!check.data.indexed) {
  const embed = await api('/papers/embed-questions', { questions: extract.data.questions, sourceHash });
  console.log(`   embedded ${embed.data.count} question(s) (${embed.data.embeddingModel})`);
  await api('/papers/index-questions', {
    questions: embed.data.questions,
    sourceDocumentId: `e2e_computer_${sourceHash.slice(0, 12)}`,
    sourceHash, class: CLASS, subject: SUBJECT, fileUrl: null,
  });
  console.log('   indexed under class=3 / Computer');
}

const run = async (difficulty) => {
  console.log(`\n════════ REAL GENERATION: difficulty = ${difficulty} ════════`);
  const gen = await api('/questions/generate', {
    class: CLASS, subject: SUBJECT, difficulty, questionCount: spec.totalQuestions, blueprint: spec,
  });
  const meta = gen.data.meta || {};
  const accepted = gen.data.questions || [];
  console.log(`   → ${accepted.length}/${spec.totalQuestions} accepted, ${(gen.data.rejected || []).length} rejected, rounds=${meta.regenerationRounds ?? 0}`);
  console.log('   ai calls:', JSON.stringify(meta.ai || {}));
  const bv = meta.blueprintValidation;
  console.log(`   blueprint conformance (server deterministic): ${bv ? `${bv.passed}/${bv.totalSlots} passed, ${bv.failed} failed` : 'n/a'}`);
  const fails = bv?.results?.filter((r) => !r.ok) || [];
  for (const f of fails) console.log(`      ✗ ${f.questionNumber}: ${(f.reasons || []).join(' | ')}`);
  return { gen, accepted, meta };
};

const mode = process.argv[2] || 'medium';
const medium = await run('Medium');
fs.writeFileSync(path.join(outDir, 'computer-pattern-medium.json'), JSON.stringify({ data: medium.gen.data, difficulty: 'Medium' }, null, 1));
console.log(`   saved uploads/computer-pattern-medium.json`);

console.log('\n── REFERENCE → PATTERN → GENERATED (Medium; same topic, new wording) ──');
const bySlot = new Map(medium.accepted.map((q) => [q.slotIndex, q]));
for (const slot of spec.questions) {
  const g = bySlot.get(spec.questions.indexOf(slot));
  const brief = (t) => (t && t.length > 120 ? t.slice(0, 120) + '…' : t);
  console.log(`\n• ${slot.label}  type=${slot.type}  marks=${slot.markExpression || slot.totalMarks}  itemMarks=${JSON.stringify(slot.itemMarks || [])}`);
  console.log(`  REFERENCE  → ${(slot.referenceItems || []).slice(0, 2).map(brief).join(' || ')}`);
  if (!g) { console.log('  GENERATED  → (slot missing)'); continue; }
  const parts = g.subParts || [];
  const shown = parts.length ? parts.slice(0, 3) : [{ text: g.text }];
  shown.forEach((p, i) => {
    const m = p.marks != null ? ` (${p.marks}m)` : '';
    const opts = p.options?.length ? `  opts:[${p.options.map(brief).join(' | ')}]` : '';
    console.log(`  GENERATED ${'abcdefghijklmnopqrstuvwxyz'[i]}) ${brief(p.text)}${m}${opts}`);
  });
}

if (mode === 'all') {
  console.log('\n── difficulty ladder: Easy / Hard (structure must stay identical) ──');
  for (const d of ['Easy', 'Hard']) {
    try {
      const r = await run(d);
      fs.writeFileSync(path.join(outDir, `computer-pattern-${d.toLowerCase()}.json`), JSON.stringify({ data: r.gen.data, difficulty: d }, null, 1));
      console.log(`   ${d}: saved uploads/computer-pattern-${d.toLowerCase()}.json`);
    } catch (err) {
      console.log(`   ${d}: skipped → ${err.message.slice(0, 160)}`);
    }
  }
} else {
  console.log('\n  (Easy/Hard real runs skipped — pass "all" to attempt them; quota permitting)');
}

console.log('\n── 3) Render the accepted Medium paper as a student PDF ──');
const pdfMake = require('pdfmake/build/pdfmake.js');
const liberation = (await import('../client/src/fonts/LiberationSerif.js')).default;
if (typeof pdfMake.addFontContainer === 'function') pdfMake.addFontContainer(liberation);
else { pdfMake.vfs = { ...(pdfMake.vfs || {}), ...liberation.vfs }; pdfMake.fonts = { ...(pdfMake.fonts || {}), ...liberation.fonts }; }
const { buildDocDefinition } = await import('../client/src/services/paperPdf.js');
const { DEFAULT_PAPER_FORMAT } = await import('../client/src/services/paperTemplate.js');
const clean = medium.accepted.map((q) => {
  const { status, validation, similarity, embedding, ...rest } = q || {};
  return rest;
});
const format = { ...DEFAULT_PAPER_FORMAT, schoolName: 'ARMY PUBLIC SCHOOL SHILLONG', examTitle: 'ANNUAL EXAMINATION (2024-25)', timeAllowed: '2 Hours 30 Minutes', maximumMarks: '30' };
const doc = buildDocDefinition({ questions: clean, blueprint: spec, settings: { class: '3' }, subject: 'Computer', format });
const genPdf = pdfMake.createPdf(doc);
const buf = typeof genPdf.getBuffer().then === 'function' ? await genPdf.getBuffer() : await new Promise((r) => genPdf.getBuffer(r));
const outPdf = path.join(outDir, 'Computer_pattern_e2e.pdf');
fs.writeFileSync(outPdf, Buffer.from(buf));
console.log(`Wrote ${outPdf} (${buf.length} bytes)`);
