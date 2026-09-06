/**
 * e2e-pattern.mjs — QUESTION-PATTERN FIDELITY end-to-end proof on the real EVS
 * reference paper (zero hard-coding; patterns are DISCOVERED from the PDF).
 *
 * Flow: extract (blueprint now carries per-slot pattern + topic anchors)
 *   → per-slot pattern table
 *   → generate (question-level RAG + per-slot pattern specs)
 *   → deterministic per-slot conformance check (counts/options/passage)
 *   → reference → pattern → topic → generated → validation examples
 *   → Easy/Medium/Hard difficulty runs (format identical)
 *   → render the Medium PDF via the template (flat Q1…Q11, no leakage)
 *
 * Usage (backend running):  node scripts/e2e-pattern.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocDefinition } from '../client/src/services/paperPdf.js';
import { DEFAULT_PAPER_FORMAT, templateToFormat } from '../client/src/services/paperTemplate.js';
import liberation from '../client/src/fonts/LiberationSerif.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfMake = require('pdfmake/build/pdfmake.js');
if (typeof pdfMake.addFontContainer === 'function') pdfMake.addFontContainer(liberation);
else { pdfMake.vfs = { ...(pdfMake.vfs || {}), ...liberation.vfs }; pdfMake.fonts = { ...(pdfMake.fonts || {}), ...liberation.fonts }; }

const API = 'http://localhost:5000/api';
const EVS_URL = 'https://res.cloudinary.com/darkgddmf/raw/upload/paper_setting_ai/papers/EVS_1788534490236-9262';

async function api(pathname, body) {
  const res = await fetch(API + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${pathname} → ${res.status}: ${json.message || JSON.stringify(json).slice(0, 200)}`);
  return json;
}

const outDir = path.join(__dirname, '..', 'uploads');

console.log('── 1) extract-questions (real EVS reference; deterministic pattern analysis) ──');
const extract = await api('/papers/extract-questions', { fileUrl: EVS_URL });
const bp = extract.data.blueprint;
const template = extract.data.template;
const { paper } = bp;
// The teacher-chosen subject label for retrieval must match what was indexed
// (the store holds the short form "EVS"), while the reference paper header
// keeps the full subject name.
const SUBJECT_FOR_RETRIEVAL = 'EVS';
console.log(`   ${bp.totalQuestions} slots / ${bp.totalMarks ?? '?'} marks / subject ${paper.subject} / class ${paper.class}`);
console.log('\n── per-slot QUESTION PATTERNS (discovered, not hard-coded) ──');
console.log('SLOT | type | items | optRule | marks | construction | answerForm | opt/item | anchors');
for (const s of bp.questions) {
  const p = s.pattern || {};
  console.log(
    `${String(s.label).padEnd(4)} | ${String(s.type).padEnd(10)} | ${String(s.itemCount).padEnd(3)} | ` +
    `${(s.optionalRule ? `any ${s.optionalRule.n}` : '-').padEnd(7)} | ${String(s.markExpression ?? '').padEnd(7)} | ` +
    `${String(p.instructionType ?? '-').padEnd(20)} | ${String(p.answerForm ?? '-').padEnd(20)} | ` +
    `${s.type === 'MCQ' && p.maxOptionCount ? p.maxOptionCount + '/item' : '-'} | ${(s.referenceItems || []).length}`
  );
}

console.log('\n── 1b) source reuse check + ingest (only when this PDF is new) ──');
const pdfRes = await fetch(EVS_URL);
const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
const { createHash } = require('node:crypto');
const sourceHash = createHash('sha256').update(pdfBuf).digest('hex');
const check = await api('/papers/check-indexed', { sourceHash });
console.log(`   indexed=${check.data.indexed} (hash ${sourceHash.slice(0, 12)}…)`);
if (!check.data.indexed) {
  const embed = await api('/papers/embed-questions', { questions: extract.data.questions, fileUrl: EVS_URL, sourceHash });
  console.log(`   embedded ${embed.data.count} (model ${embed.data.embeddingModel})`);
  await api('/papers/index-questions', {
    questions: embed.data.questions,
    sourceDocumentId: `e2e_evs_${sourceHash.slice(0, 12)}`,
    sourceHash, class: '4', subject: SUBJECT_FOR_RETRIEVAL, fileUrl: EVS_URL,
  });
  console.log('   indexed under class=4');
}

// ── helper: deterministic per-slot conformance ──
function conformance(accepted, bpx) {
  const bySlot = new Map(accepted.map((q) => [q.slotIndex, q]));
  const rows = [];
  for (let i = 0; i < bpx.length; i++) {
    const exp = bpx[i];
    const g = bySlot.get(i);
    if (!g) { rows.push({ label: exp.label, ok: false, reason: 'MISSING' }); continue; }
    const problems = [];
    const parts = Array.isArray(g.subParts) ? g.subParts : [];
    const itemCount = parts.length > 0 ? parts.length : (Array.isArray(g.columns?.left) ? g.columns.left.length : (Array.isArray(g.choices) ? g.choices.length : 1));
    if (itemCount !== exp.itemCount) problems.push(`items ${itemCount}≠${exp.itemCount}`);
    if (Number(g.marks) !== exp.totalMarks) problems.push(`marks ${g.marks}≠${exp.totalMarks}`);
    if (exp.optionalRule) {
      const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
      const word = Object.keys(WORDS).find((k) => WORDS[k] === exp.optionalRule.n);
      const combined = [g.text, ...parts.map((p) => p.text)].join(' ');
      const ok = word
        ? new RegExp(`any\\s+(?:of\\s+)?(?:the\\s+)?${word}\\b`, 'i').test(combined) || new RegExp(`any\\s+${exp.optionalRule.n}\\b`, 'i').test(combined)
        : new RegExp(`any\\s+${exp.optionalRule.n}\\b`, 'i').test(combined);
      if (!ok) problems.push('optional rule lost');
    }
    const maxOpt = exp.pattern?.maxOptionCount;
    if (maxOpt >= 2) {
      const groups = parts.length ? parts.map((p) => p.options || []) : (g.options ? [g.options] : []);
      groups.forEach((o, ix) => { if (o.length > 0 && o.length !== maxOpt) problems.push(`opt${ix + 1}:${o.length}≠${maxOpt}`); });
    }
    if (exp.pattern?.instructionType === 'passage-comprehension' && !String(g.passage || '').trim()) problems.push('passage missing');
    rows.push({ label: exp.label, ok: problems.length === 0, reason: problems.join('; ') || 'OK' });
  }
  return rows;
}

const run = async (difficulty) => {
  console.log(`\n════════ run: difficulty = ${difficulty} ════════`);
  let gen;
  let cls = '4';
  for (const attempt of ['4', paper.class]) {
    try {
      gen = await api('/questions/generate', {
        class: attempt, subject: SUBJECT_FOR_RETRIEVAL, difficulty, questionCount: bp.totalQuestions, blueprint: bp,
      });
      cls = attempt;
      break;
    } catch (err) {
      if (err.message.includes('No previous questions found') && attempt !== paper.class) continue;
      throw err;
    }
  }
  const accepted = gen.data.questions || [];
  const meta = gen.data.meta || {};
  console.log(`   class=${cls} → ${accepted.length}/${bp.totalQuestions} accepted, ${(gen.data.rejected || []).length} rejected, rounds=${meta.regenerationRounds ?? 0}`);
  console.log('   ai calls:', JSON.stringify(meta.ai || {}));
  console.log('   blueprint validation:', JSON.stringify(meta.blueprintValidation?.summary || meta.blueprintValidation ? { totalSlots: meta.blueprintValidation?.totalSlots, passed: meta.blueprintValidation?.passed, failed: meta.blueprintValidation?.failed } : 'n/a'));
  const conf = conformance(accepted, bp.questions);
  const bad = conf.filter((r) => !r.ok);
  console.log('   deterministic per-slot conformance:', `${conf.length - bad.length}/${conf.length} OK`);
  bad.forEach((r) => console.log(`      ✗ ${r.label}: ${r.reason}`));
  return { gen, accepted, cls };
};

const medium = await run('Medium');
fs.writeFileSync(path.join(outDir, 'evs-pattern-medium.json'), JSON.stringify({ data: medium.gen.data, difficulty: 'Medium' }, null, 1));

console.log('\n── REFERENCE → PATTERN → TOPIC → GENERATED → VALIDATION (Medium) ──');
const bpq = bp.questions;
const bySlot = new Map(medium.accepted.map((q) => [q.slotIndex, q]));
for (const showLabel of ['Q2', 'Q8', 'Q9', 'Q11']) {
  const slot = bpq.find((s) => s.label === showLabel);
  if (!slot) continue;
  const g = bySlot.get(bpq.indexOf(slot));
  console.log(`\n• ${showLabel}  type=${slot.type}  marks=${slot.markExpression}  pattern=${slot.pattern?.instructionType} / ${slot.pattern?.answerForm}`);
  console.log(`  REFERENCE topic anchors: ${(slot.referenceItems || []).slice(0, 3).join('  ||  ')}`);
  if (!g) { console.log('  GENERATED: (slot missing after retries)'); continue; }
  const parts = g.subParts || [];
  const brief = (t) => (t.length > 130 ? t.slice(0, 130) + '…' : t);
  console.log(`  GENERATED stem: ${brief(g.text)}`);
  if (g.passage) console.log(`  GENERATED passage: ${brief(g.passage)}`);
  (parts.length ? parts.slice(0, 3) : [{ text: g.text, options: g.options }]).forEach((p, i) => {
    const opts = p.options && p.options.length ? `  [${p.options.map(brief).join(' | ')}]` : '';
    console.log(`    ${'abcdefghijklmnopqrstuvwxyz'[i]}) ${brief(p.text)}${opts}`);
  });
  const exp = bp.questions[bpq.indexOf(slot)];
  const oks = medium.gen.data.meta?.blueprintValidation?.results?.filter((r) => String(r.questionNumber) === String(showLabel));
  console.log(`  VALIDATION: ${oks && oks[0] ? (oks[0].ok ? 'PASS' : 'FAIL: ' + oks[0].reasons.join(' | ')) : '(see blueprintValidation summary)'}`);
}

// ── Difficulty runs (Easy / Hard) — format must stay identical ──
console.log('\n── difficulty ladder: Easy / Hard (structure must NOT move) ──');
for (const d of ['Easy', 'Hard']) {
  try {
    const r = await run(d);
    fs.writeFileSync(path.join(outDir, `evs-pattern-${d.toLowerCase()}.json`), JSON.stringify({ data: r.gen.data, difficulty: d }, null, 1));
  } catch (err) {
    console.log(`   ${d}: skipped → ${err.message.slice(0, 120)}`);
  }
}

// ── Render the Medium paper via the template (student-facing PDF) ──
console.log('\n── render Medium result as a student PDF (template-driven format) ──');
const clean = medium.accepted.map((q) => {
  const { status, validation, similarity, embedding, ...rest } = q || {};
  return rest;
});
const format = templateToFormat(template, { ...DEFAULT_PAPER_FORMAT });
const doc = buildDocDefinition({ questions: clean, blueprint: bp, settings: { class: paper.class }, subject: paper.subject, format });
const genPdf = pdfMake.createPdf(doc);
const buf = typeof genPdf.getBuffer().then === 'function' ? await genPdf.getBuffer() : await new Promise((r) => genPdf.getBuffer(r));
const outPdf = path.join(outDir, 'EVS_pattern_e2e.pdf');
fs.writeFileSync(outPdf, Buffer.from(buf));
console.log(`Wrote ${outPdf} (${buf.length} bytes)`);
