/**
 * e2e-template.mjs — UNIVERSAL reference → TEMPLATE → PDF end-to-end proof.
 *
 * Renders the generated paper through the SAME model the browser uses
 * (paperLayout.buildPaperModel → paperPdf.buildDocDefinition) with the paper
 * FORMAT auto-filled from the server's deterministic template analyzer
 * (templateToFormat). Zero hard-coded school/header values — the uploaded
 * reference supplies its own template.
 *
 * Usage (backend must be running on :5000):
 *   node scripts/e2e-template.mjs evs          # render-only from saved files (0 Gemini)
 *   node scripts/e2e-template.mjs english      # full live E2E (extract → generate → render)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocDefinition } from '../client/src/services/paperPdf.js';
import { DEFAULT_PAPER_FORMAT, templateToFormat } from '../client/src/services/paperTemplate.js';
import { pdfParser } from '../server/src/document/pdf-parser.js';
import liberation from '../client/src/fonts/LiberationSerif.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfMake = require('pdfmake/build/pdfmake.js');
if (typeof pdfMake.addFontContainer === 'function') pdfMake.addFontContainer(liberation);
else { pdfMake.vfs = { ...(pdfMake.vfs || {}), ...liberation.vfs }; pdfMake.fonts = { ...(pdfMake.fonts || {}), ...liberation.fonts }; }

const API = 'http://localhost:5000/api';
const EN_URL = 'https://res.cloudinary.com/darkgddmf/raw/upload/paper_setting_ai/papers/ENGLISH_1788527122184-1839';

async function api(pathname, body) {
  const res = await fetch(API + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${pathname} → ${res.status}: ${json.message || JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/** pdfmake 0.3: getBuffer() may be promise- or callback-style. */
async function getBuffer(gen) {
  return typeof gen.getBuffer().then === 'function' ? await gen.getBuffer() : await new Promise((r) => gen.getBuffer(r));
}

async function verifyPdf(buffer, expectations, label) {
  const parsed = await pdfParser.parseBuffer(Buffer.from(buffer));
  const text = parsed.text;
  const ok = [];
  for (const [needle, mustExist] of Object.entries(expectations)) {
    const found = text.includes(needle);
    ok.push(`${mustExist === false ? 'absent ' : 'present'} ${JSON.stringify(needle)} → ${found === mustExist ? 'PASS' : 'FAIL'}`);
  }
  console.log(`\n── ${label} PDF verification (${parsed.pageCount} page(s)) ──`);
  console.log(ok.join('\n'));
  const failed = ok.filter((l) => l.includes('FAIL'));
  if (failed.length > 0) throw new Error('Verification FAILED:\n' + failed.join('\n'));
  return text;
}

const mode = process.argv[2] || 'evs';
const outDir = path.join(__dirname, '..', 'uploads');

if (mode === 'evs') {
  // Render-only: saved real blueprint-mode result + this session's extract.
  const extract = JSON.parse(fs.readFileSync(path.join(outDir, '_evs-extract.json'), 'utf8'));
  const genFile = JSON.parse(fs.readFileSync(path.join(outDir, 'gen-evs-response.json'), 'utf8'));
  const data = genFile.data || genFile;
  const bp = extract.data.blueprint;
  const template = extract.data.template;
  const questions = (data.questions || []).map((q) => {
    const { status, validation, similarity, embedding, ...rest } = q || {};
    return rest;
  });
  const buffer = await getBuffer(pdfMake.createPdf(buildDocDefinition({
    questions, blueprint: bp,
    settings: { class: bp.paper?.class ?? '4' },
    subject: bp.paper?.subject ?? 'EVS',
    format: templateToFormat(template, { ...DEFAULT_PAPER_FORMAT }),
  })));
  const out = path.join(outDir, 'EVS_template_e2e.pdf');
  fs.writeFileSync(out, buffer);
  console.log(`Wrote ${out} (${buffer.length} bytes) — ${questions.length} questions, format auto-filled from reference template`);
  const text = await verifyPdf(buffer, {
    'ARMY PUBLIC SCHOOL SHILLONG': true,
    'ANNUAL EXAMINATION (2022-23)': true,
    'Time: 2 Hours 30 minutes': true,
    'Maximum Marks: 80': true,
    'SECTION A': false, // flat EVS paper — NO invented sections
    'Q11': false,
    '1x': false, // EVS uses uppercase X → converted display stays uppercase
  }, 'EVS');
  const flatOk = !/SECTION [A-E]/.test(text);
  console.log(flatOk ? '✓ flat Q1…Q11 (no SECTION headings anywhere)' : '✗ unexpected SECTION heading found');
  if (!flatOk) process.exitCode = 1;
} else if (mode === 'english') {
  console.log('\n── 1) extract-questions (real ENGLISH.pdf) ──');
  const extract = await api('/papers/extract-questions', { fileUrl: EN_URL });
  const bp = extract.data.blueprint;
  const template = extract.data.template;
  const questions = extract.data.questions;
  const cls = 'IV'; // teacher-selected class (reference is CLASS - IV); index+retrieve stay consistent
  const subject = bp.paper?.subject ?? 'English';
  console.log(`   → ${questions.length} extracted; blueprint ${bp.totalQuestions} Q / ${bp.totalMarks} marks; sections=${template.sections.names.join(',')}`);

  console.log('\n── 2) source reuse check + ingest (only when this exact PDF is new) ──');
  const pdfRes = await fetch(EN_URL);
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  const { createHash } = require('node:crypto');
  const sourceHash = createHash('sha256').update(pdfBuf).digest('hex');
  const check = await api('/papers/check-indexed', { sourceHash });
  console.log(`   indexed=${check.data.indexed} (hash ${sourceHash.slice(0, 12)}…)`);
  if (!check.data.indexed) {
    const embed = await api('/papers/embed-questions', { questions, fileUrl: EN_URL, sourceHash });
    console.log(`   embedded ${embed.data.count} (model ${embed.data.embeddingModel})`);
    await api('/papers/index-questions', {
      questions: embed.data.questions,
      sourceDocumentId: `e2e_en_${sourceHash.slice(0, 12)}`,
      sourceHash, class: cls, subject, fileUrl: EN_URL,
    });
    console.log('   indexed');
  }

  console.log('\n── 3) generate (blueprint mode — NEW questions in locked slots) ──');
  const gen = await api('/questions/generate', {
    class: cls, subject, difficulty: 'Medium',
    questionCount: bp.totalQuestions, blueprint: bp,
  });
  const accepted = (gen.data.questions || []).map((q) => {
    const { status, validation, similarity, embedding, ...rest } = q || {};
    return rest;
  });
  console.log(`   → ${accepted.length} accepted, ${(gen.data.rejected || []).length} rejected, rounds=${gen.data.meta?.blueprintRegenerationRounds ?? gen.data.meta?.regenerationRounds ?? 0}`);

  const buffer = await getBuffer(pdfMake.createPdf(buildDocDefinition({
    questions: accepted, blueprint: bp,
    settings: { class: cls }, subject,
    format: templateToFormat(template, { ...DEFAULT_PAPER_FORMAT }),
  })));
  const out = path.join(outDir, 'ENGLISH_template_e2e.pdf');
  fs.writeFileSync(out, buffer);
  console.log(`Wrote ${out} (${buffer.length} bytes)`);
  const text = await verifyPdf(buffer, {
    'ARMY PUBLIC SCHOOL SHILLONG': true,
    'ANNUAL EXAMINATION (2022-23)': true,
    'Time: 2hrs 30mins': true,
    'Maximum Marks: 80': true,
    'SECTION A — Reading': true,
    'SECTION B — Grammar': true,
    'SECTION C — Literature': true,
    'SECTION D — Creativity': true,
    'SECTION E': false,
  }, 'ENGLISH');
  const exprLower = /\d+\s*x\s*\d+\s*=\s*\d+/.test(text);
  const exprUpper = /\d+\s*X\s*\d+\s*=\s*\d+/.test(text);
  console.log(`mark expression case — lowercase-x present: ${exprLower}, uppercase-X present: ${exprUpper}`);
  if (!exprLower || exprUpper) throw new Error('English mark expressions must render with the reference lowercase-x style');
  const order = [];
  for (const sec of ['SECTION A — Reading', 'SECTION B — Grammar', 'SECTION C — Literature', 'SECTION D — Creativity']) order.push(text.indexOf(sec));
  const sorted = [...order].sort((a, b) => a - b);
  console.log(`✓ section order preserved: ${JSON.stringify(sorted.every((v, i) => v === order[i]))}`);
} else {
  console.error('Usage: node scripts/e2e-template.mjs [evs|english]');
  process.exit(1);
}
