/**
 * template-store.js — saved paper STRUCTURES (Mode B templates).
 *
 * A template persists structure ONLY: paper details, sections, and each
 * question's type, item count, options and marks (plus per-question
 * difficulty and a custom instruction — both structural in the same sense).
 *
 * Deliberately NEVER persisted: units, topics/topic anchors, slot assignments,
 * generated content, coverage results, job/progress state. The same structure
 * gets reused for a Unit 1-2 test and a five-unit mid-term; baking units or
 * topics in would make templates single-use.
 *
 * In-memory by design (matches job-store / embedding-cache stance — this
 * deployment has no Redis). TTL sweep keeps a long-lived server from leaking.
 */
import { randomUUID } from 'crypto';

const TTL_MS = 24 * 60 * 60 * 1000; // a template survives a working day
const templates = new Map();

/** Strip everything that is not structure. */
function sanitizeBlueprintStructure(blueprint) {
  const src = blueprint && typeof blueprint === 'object' ? blueprint : {};
  return {
    paper: {
      schoolName: src.paper?.schoolName != null ? String(src.paper.schoolName) : null,
      examTitle: src.paper?.examTitle != null ? String(src.paper.examTitle) : null,
      session: src.paper?.session != null ? String(src.paper.session) : null,
      class: src.paper?.class != null ? String(src.paper.class) : null,
      subject: src.paper?.subject != null ? String(src.paper.subject) : null,
      duration: src.paper?.duration != null ? String(src.paper.duration) : null,
      maximumMarks: src.paper?.maximumMarks != null ? Number(src.paper.maximumMarks) : null,
    },
    studentInstructions: Array.isArray(src.studentInstructions)
      ? src.studentInstructions.map((i) => String(i || '').trim()).filter(Boolean).slice(0, 10)
      : [],
    sections: (Array.isArray(src.sections) ? src.sections : []).map((s) => ({
      name: String(s?.name ?? '').trim() || null,
      title: String(s?.title ?? '').trim() || null,
      questionNumbers: Array.isArray(s?.questionNumbers) ? s.questionNumbers.map(String) : [],
    })),
    questions: (Array.isArray(src.questions) ? src.questions : []).map((q) => ({
      type: String(q?.type ?? '').trim() || null,
      itemCount: Number.isFinite(Number(q?.itemCount)) ? Math.round(Number(q.itemCount)) : 1,
      optionCount: Number.isFinite(Number(q?.optionCount)) && Number(q.optionCount) >= 2
        ? Math.round(Number(q.optionCount))
        : null,
      marks: {
        perItem: q?.marks?.perItem != null && Number.isFinite(Number(q.marks.perItem)) ? Number(q.marks.perItem) : null,
        total: q?.marks?.total != null && Number.isFinite(Number(q.marks.total)) ? Number(q.marks.total) : null,
      },
      difficulty: ['Easy', 'Medium', 'Difficult'].includes(q?.difficulty) ? q.difficulty : null,
      instruction: String(q?.instruction ?? '').trim().slice(0, 300) || null,
      optionalRule: q?.optionalRule && Number.isFinite(Number(q.optionalRule.n)) ? { kind: 'ANY_N', n: Number(q.optionalRule.n) } : null,
      section: q?.section != null ? String(q.section).trim() || null : null,
      // PER-ITEM MARKS are structure (1,2,2 is ordinary) — kept verbatim;
      // optionCount per item is structure too. Topic anchors are NOT.
      items: Array.isArray(q?.items)
        ? q.items.map((it) => ({
            marks: it?.marks != null && Number.isFinite(Number(it.marks)) && Number(it.marks) > 0
              ? Math.round(Number(it.marks) * 10) / 10
              : null,
            optionCount: it?.optionCount != null && Number.isFinite(Number(it.optionCount)) && Number(it.optionCount) >= 2
              ? Math.round(Number(it.optionCount))
              : null,
          }))
        : [],
    })),
  };
}

/** Validate a template submission; returns { errors, template|null }. */
export function buildTemplate({ name, class: _cls, subject: _subject, blueprint }) {
  const errors = [];
  const cleanName = String(name ?? '').trim();
  if (!cleanName) errors.push({ message: 'Template "name" is required.' });
  if (cleanName.length > 120) errors.push({ message: 'Template "name" is too long (max 120 chars).' });

  const clean = sanitizeBlueprintStructure(blueprint);
  if (!Array.isArray(clean.questions) || clean.questions.length === 0) {
    errors.push({ message: 'Template blueprint needs at least one question.' });
  }
  if (!clean.paper.class) errors.push({ message: 'Template blueprint paper.class is required (templates are scoped to class and subject).' });
  if (!clean.paper.subject) errors.push({ message: 'Template blueprint paper.subject is required (templates are scoped to class and subject).' });

  if (errors.length > 0) return { errors, template: null };

  const template = {
    id: randomUUID(),
    name: cleanName,
    class: clean.paper.class,
    subject: clean.paper.subject,
    blueprint: clean,
    createdAt: new Date().toISOString(),
  };
  return { errors: [], template };
}

/** Save (idempotent per id — always creates a new version row). */
export function saveTemplate(template) {
  templates.set(template.id, template);
  return template;
}

/** List templates scoped to class+subject (both required; both must match). */
export function listTemplates({ class: cls, subject } = {}) {
  const out = [];
  for (const t of templates.values()) {
    if (cls != null && String(cls) !== t.class) continue;
    if (subject != null && String(subject) !== t.subject) continue;
    out.push(t);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getTemplate(id) {
  return templates.get(String(id ?? '')) ?? null;
}

export function deleteTemplate(id) {
  return templates.delete(String(id ?? ''));
}

// TTL sweep (unref so it never keeps the process alive).
const sweep = setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of templates) {
    if (new Date(v.createdAt).getTime() < cutoff) templates.delete(k);
  }
}, TTL_MS);
if (typeof sweep.unref === 'function') sweep.unref();

export default { buildTemplate, saveTemplate, listTemplates, getTemplate, deleteTemplate };
