/**
 * measure-latency.mjs
 *
 * Measures the REAL end-to-end generation flow end-to-end through the live
 * backend, mirroring the client flow exactly:
 *
 *   upload → extract-questions → check-indexed (source reuse)
 *   → [embed + index only if NOT already indexed] → generate
 *
 * Prints stage timings + Gemini call counters from meta.timing / meta.ai.
 * No secrets are printed. The PDF is downloaded once from Cloudinary if
 * needed (deterministic pipeline, no Gemini).
 *
 * Usage:
 *   node scripts/measure-latency.mjs <publicId-or-cloudinary-url> [class] [subject] [count] [noBlueprint]
 *
 * Examples:
 *   node scripts/measure-latency.mjs EVS_1788534490236-9262 4 EVS
 *   node scripts/measure-latency.mjs EVS_1788534490236-9262 4 EVS 5 noblueprint
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const BASE = 'http://localhost:5000/api';
const [, , target, cls = '4', subject = 'EVS', countArg, mode] = process.argv;
const useBlueprint = mode !== 'noblueprint';

if (!target) {
  console.error('Usage: node scripts/measure-latency.mjs <publicId> [class] [subject]');
  process.exit(1);
}

// Cloudinary raw PDFs live under raw/upload/paper_setting_ai/papers/<publicId>.
// The publicId may already include the full path; accept either form.
const normalized = target.includes('/') ? target : `paper_setting_ai/papers/${target}`;
const fileUrl = /^https?:/.test(target)
  ? target
  : `https://res.cloudinary.com/darkgddmf/raw/upload/${normalized}`;

const t = {};
const stage = (name) => {
  t[name] = Date.now();
  console.log(`\n── ${name} ──`);
};
const elapsed = (name) => {
  const ms = Date.now() - t[name];
  console.log(`   ${name}: ${ms}ms`);
  return ms;
};

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${json.message || JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// ─── 1) Extract (this also computes the blueprint; downloads PDF once) ─────
stage('extract-questions');
const extract = await api('/papers/extract-questions', { fileUrl });
const extractMs = elapsed('extract-questions');
const questions = extract.data.questions;
const bp = extract.data.blueprint;
console.log(`   → ${questions.length} questions, blueprint: ${bp?.totalQuestions ?? 'none'} Q / ${bp?.totalMarks ?? '?'} marks`);

// ─── 2) Source reuse check (needs the actual PDF bytes for a real SHA-256) ─
// The browser computes SHA-256 of the local file; here we hash the downloaded
// PDF so the server's Qdrant payload lookup is exercised for real.
stage('download + hash (source reuse check)');
const pdfRes = await fetch(fileUrl);
const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
const sourceHash = pdfRes.headers.get('content-type')?.includes('pdf') || pdfBuf.slice(0, 5).toString().includes('%PDF')
  ? require('crypto').createHash('sha256').update(pdfBuf).digest('hex')
  : null;
console.log(`   pdf ${pdfBuf.length} bytes, sha256=${sourceHash ? sourceHash.slice(0, 16) + '…' : '(n/a)'}`);
const check = await api('/papers/check-indexed', { sourceHash });
console.log(`   indexed=${check.data.indexed} sourceDocumentId=${check.data.sourceDocumentId}`);

// ─── 3) Embed + index (skipped when already indexed) ────────────────────────
let embedMs = 0;
let indexMs = 0;
if (check.data.indexed) {
  console.log('\n── embed-questions (SKIPPED — source reuse) ──');
  console.log('── index-questions (SKIPPED — source reuse) ──');
} else {
  stage('embed-questions');
  const embed = await api('/papers/embed-questions', { questions, fileUrl, sourceHash });
  embedMs = elapsed('embed-questions');
  stage('index-questions');
  const idx = await api('/papers/index-questions', {
    questions: embed.data.questions,
    sourceDocumentId: `paper_${require('crypto').randomUUID().slice(0, 12)}`,
    sourceHash,
    class: cls,
    subject,
    fileUrl,
  });
  indexMs = elapsed('index-questions');
  console.log(`   → indexed ${idx.data.indexedCount} (skipped ${idx.data.skippedCount})`);
}

// ─── 4) Generation (the LangGraph pipeline; meta carries timings) ───────────
stage('generate');
const reqCount = countArg ? parseInt(countArg, 10) : (useBlueprint ? bp?.totalQuestions ?? 5 : 5);
const gen = await api('/questions/generate', {
  class: cls,
  subject,
  difficulty: 'Medium',
  questionCount: reqCount,
  ...(useBlueprint && bp && Array.isArray(bp.questions) && bp.questions.length > 0 ? { blueprint: bp } : {}),
});
const genMs = elapsed('generate');
console.log(`   → ${gen.data.questions.length} accepted, ${gen.data.rejected.length} rejected`);

// ─── Report ─────────────────────────────────────────────────────────────────
const m = gen.data.meta || {};
const timing = m.timing || {};
const ai = m.ai || {};
console.log('\n════════════════════════════════════════════');
console.log('LATENCY REPORT');
console.log('════════════════════════════════════════════');
console.log(`extractMs        : ${extractMs}`);
console.log(`embedMs          : ${embedMs || 0}${check.data.indexed ? ' (reused)' : ''}`);
console.log(`indexMs          : ${indexMs || 0}${check.data.indexed ? ' (reused)' : ''}`);
console.log(`generationMs     : ${genMs}`);
console.log(`totalMs          : ${extractMs + embedMs + indexMs + genMs}`);
console.log('── pipeline stages (from meta.timing) ──');
for (const [k, v] of Object.entries(timing)) console.log(`   ${k.padEnd(16)}: ${v}ms`);
console.log('── ai counters (from meta.ai) ──');
for (const [k, v] of Object.entries(ai)) console.log(`   ${k.padEnd(20)}: ${v}`);
console.log(`blueprintMode    : ${m.blueprintMode ?? false}`);
console.log(`questionCount    : ${m.totalQuestionsRequested}`);