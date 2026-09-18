/**
 * paper-archive-store.js — persistence for finished/in-flight question papers
 * (the "My Papers" screen).
 *
 * There is no MongoDB in this repo. Unlike job-store / template-store (both
 * deliberately in-memory + TTL because their contents are transient), a
 * generated paper is the teacher's work and MUST survive a restart — so this
 * store writes a JSON file on disk. No external service, no new dependency,
 * same "this deployment has no Redis" reasoning taken one step further.
 *
 * The write is a plain sync file replace (write to `.tmp`, then rename) after
 * every mutation. Volume here is tiny (one row per generated paper) so this is
 * more than fast enough and never leaves a half-written file.
 *
 * Record shape:
 *   { id, title, class, subject, totalMarks, source: 'A'|'B',
 *     status: 'in_progress'|'generated'|'draft',
 *     createdAt, updatedAt,           // ISO strings
 *     blueprint, questions, slotUnitMap, rejectedCount }
 *
 * listPapers / stats return LIGHT rows (no blueprint, questions or
 * slotUnitMap); getPaper returns the full record.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'library.json');
const FILE = () => process.env.LIBRARY_FILE || DEFAULT_FILE;

const HEAVY = ['blueprint', 'questions', 'slotUnitMap'];
const STATUSES = new Set(['in_progress', 'generated', 'draft']);

/** id -> full record */
let papers = new Map();

function load() {
  papers = new Map();
  try {
    const raw = readFileSync(FILE(), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) for (const r of arr) if (r && r.id) papers.set(r.id, r);
  } catch {
    // missing / unreadable / bad JSON → start empty
  }
}

function persist() {
  const file = FILE();
  const json = JSON.stringify([...papers.values()], null, 2);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, json, 'utf8');
    try {
      renameSync(tmp, file);
    } catch {
      // Windows rename-over-existing can transiently fail (EPERM/EEXIST while
      // the target is briefly locked by an indexer/AV). Fall back to an
      // in-place write so the on-disk file NEVER diverges from memory, then
      // clear the temp file.
      writeFileSync(file, json, 'utf8');
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  } catch (err) {
    console.error('[Paper Archive] persist failed:', err.message);
  }
}

// Load at import. `_reload()` lets tests point LIBRARY_FILE at a temp path.
load();

function light(r) {
  if (!r) return r;
  const out = {};
  for (const k of Object.keys(r)) if (!HEAVY.includes(k)) out[k] = r[k];
  return out;
}

/** Save a new paper. Returns the LIGHT summary. */
export function savePaper(input = {}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const rec = {
    id,
    title: String(input.title ?? '').trim() || 'Untitled paper',
    class: input.class != null ? String(input.class) : null,
    subject: input.subject != null ? String(input.subject) : null,
    totalMarks: Number.isFinite(Number(input.totalMarks)) ? Number(input.totalMarks) : 0,
    source: input.source === 'B' ? 'B' : 'A',
    status: STATUSES.has(input.status) ? input.status : 'in_progress',
    createdAt: now,
    updatedAt: now,
    blueprint: input.blueprint ?? null,
    questions: Array.isArray(input.questions) ? input.questions : [],
    slotUnitMap: input.slotUnitMap ?? null,
    rejectedCount: Number.isFinite(Number(input.rejectedCount)) ? Number(input.rejectedCount) : 0,
  };
  papers.set(id, rec);
  persist();
  return light(rec);
}

/** A timestamp strictly later than `prevIso` (ISO millisecond resolution ties
 *  otherwise, which breaks "sort by recently updated"). */
function nextStamp(prevIso) {
  const floor = prevIso ? new Date(prevIso).getTime() + 1 : 0;
  return new Date(Math.max(Date.now(), floor)).toISOString();
}

/** Merge fields into a paper. Returns the LIGHT summary, or null if unknown. */
export function patchPaper(id, patch = {}) {
  const rec = papers.get(String(id ?? ''));
  if (!rec) return null;
  // PHASE 3: the staleness snapshot dimensions travel through PATCH too —
  // openArchivedPaper reads the PERSISTED fingerprint/unit/topic snapshots
  // (F2 rule), so dropping them here would resurrect stale flags on reload.
  const allowed = ['title', 'status', 'totalMarks', 'questions', 'slotUnitMap', 'blueprint', 'rejectedCount', 'class', 'subject', 'generatedFingerprint', 'generatedUnitMap', 'generatedTopics'];
  for (const k of allowed) {
    if (!(k in patch)) continue;
    if (k === 'status' && !STATUSES.has(patch.status)) continue;
    rec[k] = patch[k];
  }
  rec.updatedAt = nextStamp(rec.updatedAt);
  persist();
  return light(rec);
}

/** Full record (blueprint + questions + slotUnitMap) as a SNAPSHOT copy, or
 *  null. A copy so a caller mutating the result cannot corrupt the store. */
export function getPaper(id) {
  const rec = papers.get(String(id ?? ''));
  return rec ? structuredClone(rec) : null;
}

export function deletePaper(id) {
  const had = papers.delete(String(id ?? ''));
  if (had) persist();
  return had;
}

/** Copy a paper as a new draft-of-the-same-status row. Returns LIGHT summary. */
export function duplicatePaper(id) {
  const rec = papers.get(String(id ?? ''));
  if (!rec) return null;
  return savePaper({ ...rec, title: `${rec.title} (copy)` });
}

const SORTS = {
  recent: (a, b) => (a.createdAt < b.createdAt ? 1 : -1),
  oldest: (a, b) => (a.createdAt < b.createdAt ? -1 : 1),
  updated: (a, b) => (a.updatedAt < b.updatedAt ? 1 : -1),
  title: (a, b) => String(a.title).localeCompare(String(b.title)),
  marks: (a, b) => (b.totalMarks || 0) - (a.totalMarks || 0),
};

/** Server-side filtered + sorted list of LIGHT rows. */
export function listPapers({ q, class: cls, subject, status, sort } = {}) {
  const needle = String(q ?? '').trim().toLowerCase();
  let rows = [...papers.values()].filter((r) => {
    if (cls != null && String(cls) !== '' && String(r.class) !== String(cls)) return false;
    if (subject != null && String(subject) !== '' && String(r.subject).toLowerCase() !== String(subject).toLowerCase()) return false;
    if (status != null && String(status) !== '' && r.status !== status) return false;
    if (needle) {
      const hay = `${r.title} ${r.subject ?? ''} ${r.class ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  rows.sort(SORTS[sort] || SORTS.recent);
  return rows.map(light);
}

/** Distinct class / subject values across all stored papers (for the filters). */
export function facets() {
  const classes = new Set();
  const subjects = new Set();
  for (const r of papers.values()) {
    if (r.class != null && r.class !== '') classes.add(String(r.class));
    if (r.subject != null && r.subject !== '') subjects.add(String(r.subject));
  }
  return {
    classes: [...classes].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)),
    subjects: [...subjects].sort(),
  };
}

export function stats() {
  let generated = 0;
  let inProgress = 0;
  let draft = 0;
  for (const r of papers.values()) {
    if (r.status === 'generated') generated += 1;
    else if (r.status === 'in_progress') inProgress += 1;
    else if (r.status === 'draft') draft += 1;
  }
  return { total: papers.size, generated, inProgress, draft };
}

/** Test hook — re-read from LIBRARY_FILE (which the test points at a tmp path). */
export function _reload() {
  load();
}

export default {
  savePaper, patchPaper, getPaper, deletePaper, duplicatePaper,
  listPapers, facets, stats, _reload,
};
