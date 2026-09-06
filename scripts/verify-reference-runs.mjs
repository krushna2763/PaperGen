/**
 * verify-reference-runs.mjs — offline structural comparison of the saved
 * Computer Easy/Medium/Hard runs against the reference specification and each
 * other. Zero Gemini. Run: node scripts/verify-reference-runs.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
const spec = JSON.parse(fs.readFileSync(path.join(dir, 'computer-pattern-medium.json'), 'utf8'));
const reference = spec.data.meta?.blueprint ?? null;
if (!reference) { console.error('Saved run has no meta.blueprint — re-run e2e first.'); process.exit(1); }

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++; else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Per-run structural signature: for each slot in blueprint order → the exact
// structural contract that difficulty must never change.
function signature(run) {
  const bpQ = reference.questions;
  const bySlot = new Map((run.data.questions || []).map((q) => [q.slotIndex, q]));
  return bpQ.map((slot, i) => {
    const q = bySlot.get(i);
    if (!q) return { label: slot.label, missing: true };
    const parts = Array.isArray(q.subParts) ? q.subParts : [];
    return {
      label: slot.label,
      type: q.type,                       // locked by the spec
      marks: q.marks,                     // locked total
      itemCount: parts.length || 1,       // locked sub-part count
      perPartMarks: parts.map((p) => p.marks ?? null), // per-part marks (locked)
      optionCounts: parts.map((p) => (Array.isArray(p.options) ? p.options.length : 0)), // MCQ option counts
      hasPassage: Boolean(q.passage),
      optionalRule: q.text.includes('any ') || (slot.optionalRule != null),
    };
  });
}

const runs = {};
for (const d of ['medium', 'easy', 'hard']) {
  const p = path.join(dir, `computer-pattern-${d}.json`);
  if (!fs.existsSync(p)) { console.log(`SKIP ${d} (${p} not found)`); continue; }
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  runs[d] = { data: parsed, sig: signature(parsed) };
}
if (!runs.easy || !runs.hard) { console.log('Easy/Hard files missing — nothing to compare.'); process.exit(0); }

console.log('── Structural contract of every difficulty run vs the Reference Specification ──');
const expSig = signature({ data: { questions: [] } });
// build expected from spec: slot constraints (not the generated content)
const refContract = reference.questions.map((slot) => ({
  label: slot.label, type: slot.type, marks: slot.totalMarks,
  itemCount: slot.itemCount,
  perPartMarks: (slot.itemMarks || []).length === slot.itemCount ? slot.itemMarks : null,
  optionCounts: (slot.pattern?.optionCounts && slot.pattern.optionCounts.length === slot.itemCount) ? slot.pattern.optionCounts : null,
}));

for (const d of ['medium', 'easy', 'hard']) {
  console.log(`\n─ ${d.toUpperCase()} ─`);
  const sig = runs[d].sig;
  for (let i = 0; i < refContract.length; i++) {
    const exp = refContract[i];
    const got = sig[i];
    const tag = got ? `${got.label}: ${got.type} ${got.marks}m ${got.itemCount} items perPart=${JSON.stringify(got.perPartMarks)} opts=${JSON.stringify(got.optionCounts)}` : `missing slot ${i + 1}`;
    console.log(`  ${tag}`);
    if (!got) { check(`slot ${exp.label} present`, false); continue; }
    check(`${exp.label} type=${exp.type}`, got.type === exp.type, `got ${got.type}`);
    check(`${exp.label} total marks=${exp.marks}`, got.marks === exp.marks, `got ${got.marks}`);
    check(`${exp.label} item count=${exp.itemCount}`, got.itemCount === exp.itemCount, `got ${got.itemCount}`);
    if (exp.perPartMarks) check(`${exp.label} per-part marks=${JSON.stringify(exp.perPartMarks)}`, JSON.stringify(got.perPartMarks) === JSON.stringify(exp.perPartMarks), `got ${JSON.stringify(got.perPartMarks)}`);
  }
}

console.log('\n── Difficulty invariance: identical structure across Easy/Medium/Hard ──');
const jsonSig = (s) => JSON.stringify(s.map(({ label, type, marks, itemCount, perPartMarks, optionCounts, hasPassage, optionalRule }) => ({ label, type, marks, itemCount, perPartMarks, optionCounts, hasPassage, optionalRule })));
check('Easy === Medium structure', jsonSig(runs.easy.sig) === jsonSig(runs.medium.sig));
check('Medium === Hard structure', jsonSig(runs.medium.sig) === jsonSig(runs.hard.sig));
check('Easy === Hard structure', jsonSig(runs.easy.sig) === jsonSig(runs.hard.sig));

// Content must actually differ (difficulty changed the cognition, not the shape).
// Read fresh from disk: the difficulty runs are separate generations.
const contentOfFile = (d) => {
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, `computer-pattern-${d}.json`), 'utf8'));
  return JSON.stringify((parsed.data.questions || []).map((q) => ({ text: q.text, parts: (q.subParts || []).map((p) => p.text), options: (q.subParts || []).map((p) => p.options || []) })));
};
check('content differs between Easy and Hard (difficulty is a real knob)', contentOfFile('easy') !== contentOfFile('hard'));

// Every difficulty preserved the specific structures the task demanded:
const q = (r, label) => runs[r].sig.find((s) => s.label === label);
check('Q1 stays MCQ with 6 items in all runs', ['easy', 'medium', 'hard'].every((r) => q(r, 'Q1').type === 'MCQ' && q(r, 'Q1').itemCount === 6));
check('Q2 stays TRUE_FALSE 7 statements (no options) in all runs', ['easy', 'medium', 'hard'].every((r) => q(r, 'Q2').type === 'TRUE_FALSE' && q(r, 'Q2').itemCount === 7 && q(r, 'Q2').optionCounts.every((n) => n === 0)));
check('Q3 stays FILL_IN_THE_BLANK 7 items in all runs', ['easy', 'medium', 'hard'].every((r) => q(r, 'Q3').type === 'FILL_IN_THE_BLANK' && q(r, 'Q3').itemCount === 7));
check('Q4 keeps 5 sub-parts with marks [1,2,2,2,3] in all runs', ['easy', 'medium', 'hard'].every((r) => q(r, 'Q4').itemCount === 5 && JSON.stringify(q(r, 'Q4').perPartMarks) === JSON.stringify([1, 2, 2, 2, 3])));
check('Q1 MCQ items carry the SAME option count within each run', ['easy', 'medium', 'hard'].every((r) => new Set(q(r, 'Q1').optionCounts.filter((n) => n > 0)).size <= 1));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
