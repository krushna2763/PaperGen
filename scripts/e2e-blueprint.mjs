/**
 * e2e-blueprint.mjs
 *
 * End-to-end regression for the LOCKED Previous-Year Paper Blueprint System,
 * run against the LIVE backend (http://localhost:5000) using the REAL EVS
 * reference PDF (fetched from Cloudinary via its stored publicId).
 *
 * Flow (mirrors the client):
 *   EVS PDF → pdf-parser → question-extractor → extractBlueprint
 *           → POST /api/questions/generate { class, subject, blueprint }
 *           → verify: 11 questions, 80 marks, blueprintValidation ok,
 *                     response shape unchanged, content NOT copied.
 *
 * Run: node scripts/e2e-blueprint.mjs
 */

const API = 'http://localhost:5000/api';

let passed = 0;
let failed = 0;
function check(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`); }
}

const run = async () => {
  // 1) Health
  const health = await fetch(`${API}/health`).then((r) => r.json());
  check(health?.status === 'ok', 'GET /api/health → ok');

  // 2) Reconstruct the EVS reference from Cloudinary (same path as the upload flow)
  const { env } = await import('../server/src/config/env.js');
  const { storageService } = await import('../server/src/services/storage.service.js');
  const { pdfParser } = await import('../server/src/document/pdf-parser.js');
  const { questionExtractor } = await import('../server/src/document/question-extractor.js');
  const { extractBlueprint } = await import('../server/src/blueprint/blueprint-extractor.js');
  const { validatePaper } = await import('../server/src/blueprint/blueprint-validator.js');
  const { normalizeQuestionText } = await import('../server/src/agents/agent-utils.js');

  const url = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/raw/upload/paper_setting_ai/papers/EVS_1788534490236-9262`;
  const buf = await storageService.downloadFileBuffer(url);
  const parsed = await pdfParser.parseBuffer(buf);
  const extracted = questionExtractor.extract(parsed.text, parsed.pages);
  const blueprint = extractBlueprint({ questions: extracted.questions, text: parsed.text });

  console.log(`\n[EVS reference] ${parsed.pageCount} pages → ${extracted.count} questions → blueprint: ${blueprint.totalQuestions} questions / ${blueprint.totalMarks} marks`);
  check(blueprint.totalQuestions === 11, 'blueprint has 11 questions');
  check(blueprint.totalMarks === 80, 'blueprint totals 80 marks');
  check(blueprint.marksComplete === true, 'blueprint marks complete');
  check(blueprint.paper.maximumMarks === 80, 'header Maximum Marks = 80');

  // 3) Live generation with the LOCKED blueprint (class/subject matching the
  //    indexed EVS paper so RAG retrieval finds source context)
  console.log('\n[POST /questions/generate] (blueprint mode — can take a few minutes)');
  const t0 = Date.now();
  const genRes = await fetch(`${API}/questions/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class: '5',
      subject: 'Evs',
      difficulty: 'Medium',
      questionCount: 5, // deliberately incompatible — blueprint must win
      blueprint,
    }),
  });
  const body = await genRes.json();
  const ms = Date.now() - t0;
  console.log(`  → HTTP ${genRes.status} in ${(ms / 1000).toFixed(1)}s`);
  if (genRes.status !== 200) {
    console.error('  response:', JSON.stringify(body).slice(0, 600));
    process.exit(1);
  }

  const data = body.data;
  // 4) Response contract (unchanged shape + additive meta)
  check(body.success === true, 'success flag');
  check(typeof data.requirements === 'object', 'data.requirements present');
  check(typeof data.retrieval === 'object', 'data.retrieval present');
  check(Array.isArray(data.questions), 'data.questions is an array');
  check(Array.isArray(data.rejected), 'data.rejected is an array');
  check(typeof data.meta === 'object', 'data.meta present');

  // 5) Blueprint mode active
  check(data.meta.blueprintMode === true, 'meta.blueprintMode === true');
  check(data.meta.questionCountLockedToBlueprint === true, 'question count was locked to the reference (5 → 11)');
  check(data.meta.blueprint?.totalQuestions === 11, 'meta.blueprint present with 11 questions');

  // 6) Structure preserved
  check(data.questions.length === 11, `generated exactly 11 questions (got ${data.questions.length})`);
  const totalMarks = data.questions.reduce((a, q) => a + (Number(q.marks) || 0), 0);
  check(totalMarks === 80, `generated totals 80 marks (got ${totalMarks})`);
  const bv = data.meta.blueprintValidation;
  check(bv && bv.ok === true, 'blueprintValidation.ok === true');
  check(bv && bv.failed === 0, `blueprintValidation.failed === 0 (got ${bv?.failed})`);

  // 7) Per-slot conformance (types + marks + item counts vs blueprint)
  const slotTypeOk = data.questions.every((q, i) => {
    const exp = blueprint.questions[i];
    return exp && q.type === exp.type;
  });
  check(slotTypeOk, 'every slot type matches the blueprint');

  // 8) Previous questions are NOT copied (normalized exact-content check vs source)
  const sourceTexts = new Set(extracted.questions.map((q) => normalizeQuestionText(q.text)));
  let copied = 0;
  for (const q of data.questions) {
    const full = normalizeQuestionText(q.fullText || q.text);
    if (sourceTexts.has(full)) copied++;
  }
  check(copied === 0, 'no generated question is an exact copy of a source question');

  // 9) No AI-internal instructions leak into generated data
  const qJson = JSON.stringify(data.questions);
  const leaky = /LOCKED BLUEPRINT|FROZEN|Do not copy|Do NOT copy/i.test(qJson);
  check(!leaky, 'generated questions contain no internal AI instructions');

  // 10) Independent re-validation
  const revalidated = validatePaper(data.questions, blueprint);
  check(revalidated.ok === true, 'independent validatePaper() passes');

  const out = 'uploads/gen-evs-blueprint.json';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, JSON.stringify({ blueprint, result: data }, null, 2));
  console.log(`\n[result saved] ${out}`);

  console.log(`\n────────────────────────────────────────`);
  console.log(`e2e-blueprint: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((e) => {
  console.error('E2E failed with exception:', e.message);
  process.exit(1);
});