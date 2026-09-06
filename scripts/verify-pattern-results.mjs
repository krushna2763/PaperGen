// Offline re-verification of the saved EVS pattern runs (no Gemini).
import { readFileSync } from 'fs';

const bp = JSON.parse(readFileSync('uploads/_evs-extract2.json', 'utf8')).data.blueprint;
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function hasAnyN(text, n) {
  const word = Object.keys(WORDS).find((k) => WORDS[k] === n);
  const patterns = [
    new RegExp(`\\bany\\s+(?:of\\s+)?(?:the\\s+)?${word}\\b`, 'i'),
    new RegExp(`\\bany\\s+${n}\\b`, 'i'),
  ];
  return patterns.some((re) => re.test(text));
}

function conformance(accepted) {
  const bySlot = new Map(accepted.map((q) => [q.slotIndex, q]));
  const rows = [];
  for (let i = 0; i < bp.questions.length; i++) {
    const exp = bp.questions[i];
    const g = bySlot.get(i);
    if (!g) { rows.push({ label: exp.label, ok: false, reason: 'MISSING' }); continue; }
    const problems = [];
    const parts = Array.isArray(g.subParts) ? g.subParts : [];
    const itemCount = parts.length > 0 ? parts.length
      : (Array.isArray(g.columns?.left) ? g.columns.left.length
        : (Array.isArray(g.choices) ? g.choices.length : 1));
    if (itemCount !== exp.itemCount) problems.push(`items ${itemCount} != expected ${exp.itemCount}`);
    if (Number(g.marks) !== exp.totalMarks) problems.push(`marks ${g.marks} != expected ${exp.totalMarks}`);
    if (exp.optionalRule) {
      const combined = [g.text, ...parts.map((p) => p.text)].join(' ');
      if (!hasAnyN(combined, exp.optionalRule.n)) problems.push('optional rule lost');
    }
    const maxOpt = exp.pattern?.maxOptionCount;
    if (maxOpt >= 2) {
      const groups = parts.length ? parts.map((p) => p.options || []) : (g.options ? [g.options] : []);
      groups.forEach((o, ix) => { if (o.length > 0 && o.length !== maxOpt) problems.push(`options item ${ix + 1}: ${o.length} != ${maxOpt}`); });
    }
    if (exp.pattern?.instructionType === 'passage-comprehension' && !String(g.passage || '').trim()) problems.push('passage missing');
    rows.push({ label: exp.label, ok: problems.length === 0, reason: problems.join('; ') || 'OK' });
  }
  return rows;
}

for (const f of ['evs-pattern-medium.json', 'evs-pattern-easy.json', 'evs-pattern-hard.json']) {
  const d = JSON.parse(readFileSync(`uploads/${f}`, 'utf8')).data;
  const rows = conformance(d.questions || []);
  const bad = rows.filter((r) => !r.ok);
  const sum = (d.questions || []).reduce((a, q) => a + Number(q.marks || 0), 0);
  console.log(`${f.padEnd(22)} → ${rows.length - bad.length}/${rows.length} conform | total marks ${sum}${bad.length ? ' | ' + bad.map((b) => `${b.label}(${b.reason})`).join(', ') : ' | ALL SLOTS OK'}`);
}
