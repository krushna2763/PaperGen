/**
 * school-template-store.js — persisted SCHOOL TEMPLATES (visual layer).
 *
 * A SchoolTemplate describes ONLY how the finished paper LOOKS — page geometry,
 * margins, font, the header block (logo + which identity rows are shown),
 * student-information fields, the general-instructions boilerplate, numbering /
 * marks / option label *styles*, footer text and an optional page border.
 *
 * It is the visual counterpart to:
 *   - the BLUEPRINT  (structure: sections, question numbers, types, counts, marks)
 *   - the RAG corpus (content: what the questions are about)
 *
 * DELIBERATELY NOT PERSISTED HERE (would make a template paper-specific or would
 * duplicate the blueprint): sections, questions, question types, item counts,
 * option counts, per-item or total marks, marks totals, optional rules,
 * difficulty, and the per-paper header VALUES examTitle / session /
 * maximumMarks / timeAllowed (only the boolean "show this row" toggles live
 * here — the values are reset per paper by the client's templateToFormat).
 *
 * The sanitizer is a STRICT WHITELIST: the stored object is assembled field by
 * field from known visual keys, so a structural key present on an incoming
 * payload or seed is ignored by construction, never merged.
 *
 * In-memory by design — this deployment has no Redis (same stance as
 * job-store / template-store / embedding-cache). A generous TTL keeps a school's
 * letterhead alive across a term of use; a server restart clears it (acceptable
 * for the prototype — the client can re-seed from the reference paper).
 */
import { randomUUID } from 'crypto';

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days: a school's look is long-lived
const templates = new Map();

const PAGE_SIZES = ['A4', 'Letter', 'Legal'];
const ORIENTATIONS = ['portrait', 'landscape'];
const NUMBERING_STYLES = ['auto', 'q-prefix', 'digit-dot', 'digit-paren', 'paren-both', 'roman', 'letter'];
const MARKS_CASES = ['upper-x', 'lower-x', 'times'];
const OPTION_STYLES = ['roman', 'alpha'];
const BORDER_STYLES = ['none', 'thin', 'double'];
const LOGO_DATA_URI_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;
const MAX_LOGO_CHARS = 1_600_000; // ~1.1 MB decoded — logos are small marks, not photos

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n * 10) / 10));
};
const bool = (v, dflt = false) => (typeof v === 'boolean' ? v : dflt);
const oneOf = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
const str = (v, max) => {
  const s = String(v ?? '').trim();
  return s.length > max ? s.slice(0, max) : s;
};

/** The school-neutral default look. Every stored template is this shape. */
export function defaultSchoolTemplate() {
  return {
    page: {
      size: 'A4',
      orientation: 'portrait',
      // pt; calibrated against real school papers (PAPER_LAYOUT defaults)
      margins: { left: 42, top: 35, right: 38, bottom: 68 },
    },
    font: { family: 'Liberation Serif', bodySizePt: 12 },
    header: {
      logo: { dataUri: null, heightPt: 48 },
      showSchoolName: true,
      showExamTitle: true,
      showSession: true,
      showClass: true,
      showSubject: true,
      showDuration: true,
      showMaximumMarks: true,
      repeatOnLaterPages: false,
    },
    studentInfo: { name: false, rollNumber: false, class: false, section: false, date: false, invigilatorSignature: false },
    instructions: { heading: 'General Instructions :', items: [] },
    numbering: { style: 'auto' },
    marks: { case: null },
    options: { labelStyle: 'roman' },
    footer: { text: '', showPageNumbers: true },
    border: { style: 'none', marginPt: 16 },
  };
}

/**
 * Reduce any object to the visual-only SchoolTemplate shape. Unknown / structural
 * keys are dropped by construction (never merged). Missing keys fall back to the
 * school-neutral default.
 */
export function sanitizeSchoolTemplateVisual(input) {
  const src = input && typeof input === 'object' ? input : {};
  const d = defaultSchoolTemplate();
  const p = src.page && typeof src.page === 'object' ? src.page : {};
  const m = p.margins && typeof p.margins === 'object' ? p.margins : {};
  const f = src.font && typeof src.font === 'object' ? src.font : {};
  const h = src.header && typeof src.header === 'object' ? src.header : {};
  const logo = h.logo && typeof h.logo === 'object' ? h.logo : {};
  const si = src.studentInfo && typeof src.studentInfo === 'object' ? src.studentInfo : {};
  const ins = src.instructions && typeof src.instructions === 'object' ? src.instructions : {};
  const foot = src.footer && typeof src.footer === 'object' ? src.footer : {};
  const bord = src.border && typeof src.border === 'object' ? src.border : {};

  const logoDataUri =
    typeof logo.dataUri === 'string' &&
    logo.dataUri.length <= MAX_LOGO_CHARS &&
    LOGO_DATA_URI_RE.test(logo.dataUri.replace(/\s+/g, ''))
      ? logo.dataUri.replace(/\s+/g, '')
      : null;

  return {
    page: {
      size: oneOf(p.size, PAGE_SIZES, d.page.size),
      orientation: oneOf(p.orientation, ORIENTATIONS, d.page.orientation),
      margins: {
        left: clampNum(m.left, 18, 140, d.page.margins.left),
        top: clampNum(m.top, 18, 140, d.page.margins.top),
        right: clampNum(m.right, 18, 140, d.page.margins.right),
        bottom: clampNum(m.bottom, 18, 160, d.page.margins.bottom),
      },
    },
    font: {
      family: str(f.family, 60) || d.font.family,
      bodySizePt: clampNum(f.bodySizePt, 8, 16, d.font.bodySizePt),
    },
    header: {
      logo: { dataUri: logoDataUri, heightPt: clampNum(logo.heightPt, 12, 120, d.header.logo.heightPt) },
      showSchoolName: bool(h.showSchoolName, d.header.showSchoolName),
      showExamTitle: bool(h.showExamTitle, d.header.showExamTitle),
      showSession: bool(h.showSession, d.header.showSession),
      showClass: bool(h.showClass, d.header.showClass),
      showSubject: bool(h.showSubject, d.header.showSubject),
      showDuration: bool(h.showDuration, d.header.showDuration),
      showMaximumMarks: bool(h.showMaximumMarks, d.header.showMaximumMarks),
      repeatOnLaterPages: bool(h.repeatOnLaterPages, d.header.repeatOnLaterPages),
    },
    studentInfo: {
      name: bool(si.name),
      rollNumber: bool(si.rollNumber),
      class: bool(si.class),
      section: bool(si.section),
      date: bool(si.date),
      invigilatorSignature: bool(si.invigilatorSignature),
    },
    instructions: {
      heading: str(ins.heading, 80) || d.instructions.heading,
      items: Array.isArray(ins.items)
        ? ins.items.map((i) => str(i, 300)).filter(Boolean).slice(0, 10)
        : [],
    },
    numbering: { style: oneOf(src.numbering?.style, NUMBERING_STYLES, d.numbering.style) },
    marks: { case: MARKS_CASES.includes(src.marks?.case) ? src.marks.case : null },
    options: { labelStyle: oneOf(src.options?.labelStyle, OPTION_STYLES, d.options.labelStyle) },
    footer: { text: str(foot.text, 200), showPageNumbers: bool(foot.showPageNumbers, d.footer.showPageNumbers) },
    border: { style: oneOf(bord.style, BORDER_STYLES, d.border.style), marginPt: clampNum(bord.marginPt, 4, 48, d.border.marginPt) },
  };
}

/**
 * Seed a visual SchoolTemplate from the deterministic reference analysis
 * (analyzeTemplate output) and, optionally, the client's current paper `format`.
 * Only visual signals are read; nothing structural is consulted.
 *
 * @param {Object} args
 * @param {Object} [args.template] - analyzeTemplate() output
 * @param {Object} [args.format]   - client DEFAULT_PAPER_FORMAT-shaped object
 * @returns {Object} visual SchoolTemplate shape (pass to buildSchoolTemplate)
 */
export function seedFromReference({ template = null, format = null } = {}) {
  const d = defaultSchoolTemplate();
  const t = template && typeof template === 'object' ? template : {};
  const fmt = format && typeof format === 'object' ? format : {};
  const th = t.header && typeof t.header === 'object' ? t.header : {};
  const tp = t.page && typeof t.page === 'object' ? t.page : {};
  const ti = t.instructions && typeof t.instructions === 'object' ? t.instructions : {};

  const numMap = {
    'q-prefix': 'q-prefix',
    'digit-dot': 'digit-dot',
    'digit-paren': 'digit-paren',
    roman: 'roman',
    letter: 'letter',
  };

  const seeded = {
    page: {
      size: oneOf(tp.size, PAGE_SIZES, d.page.size),
      orientation: oneOf(tp.orientation, ORIENTATIONS, d.page.orientation),
      margins: d.page.margins,
    },
    font: d.font,
    header: {
      logo: d.header.logo,
      showSchoolName: th.schoolName != null ? !!th.schoolName : d.header.showSchoolName,
      showExamTitle: th.examTitle != null ? !!th.examTitle : d.header.showExamTitle,
      showSession: !!(th.session || fmt.session),
      showClass: d.header.showClass,
      showSubject: d.header.showSubject,
      showDuration: th.duration != null ? !!th.duration : !!fmt.timeAllowed || d.header.showDuration,
      showMaximumMarks: d.header.showMaximumMarks,
      repeatOnLaterPages: tp.headerRepeated === true,
    },
    studentInfo: d.studentInfo, // not detectable from the reference — teacher enables
    instructions: {
      heading: str(ti.heading || fmt.instructionsHeading, 80) || d.instructions.heading,
      items:
        Array.isArray(ti.items) && ti.items.length > 0
          ? ti.items
          : Array.isArray(fmt.instructions)
            ? fmt.instructions
            : [],
    },
    numbering: { style: numMap[t.numbering?.style] || 'auto' },
    marks: {
      case: MARKS_CASES.includes(t.marks?.style)
        ? t.marks.style
        : MARKS_CASES.includes(fmt.marksCase)
          ? fmt.marksCase
          : null,
    },
    options: {
      labelStyle: String(t.options?.style || '').startsWith('alpha')
        ? 'alpha'
        : String(t.options?.style || '').startsWith('roman')
          ? 'roman'
          : fmt.mcqOptionLabelStyle === 'alpha'
            ? 'alpha'
            : 'roman',
    },
    footer: { text: '', showPageNumbers: tp.pageNumbersDetected !== false },
    border: d.border,
  };

  return sanitizeSchoolTemplateVisual(seeded);
}

/**
 * Validate + assemble a storable SchoolTemplate record.
 * @returns {{ errors: Array<{message:string}>, template: Object|null }}
 */
export function buildSchoolTemplate({ id, name, schoolName, visual, createdAt } = {}) {
  const errors = [];
  const cleanName = String(name ?? '').trim();
  const cleanSchool = String(schoolName ?? '').trim();
  if (!cleanName) errors.push({ message: 'SchoolTemplate "name" is required.' });
  if (cleanName.length > 120) errors.push({ message: 'SchoolTemplate "name" is too long (max 120 chars).' });
  if (!cleanSchool) errors.push({ message: 'SchoolTemplate "schoolName" is required (templates are scoped per school).' });
  if (cleanSchool.length > 160) errors.push({ message: 'SchoolTemplate "schoolName" is too long (max 160 chars).' });
  if (errors.length > 0) return { errors, template: null };

  const now = new Date().toISOString();
  const record = {
    id: id ? String(id) : randomUUID(),
    name: cleanName,
    schoolName: cleanSchool,
    kind: 'school-template',
    visual: sanitizeSchoolTemplateVisual(visual),
    createdAt: createdAt || now,
    updatedAt: now,
  };
  return { errors: [], template: record };
}

export function saveSchoolTemplate(template) {
  templates.set(template.id, template);
  return template;
}

/** List templates for one school (schoolName required; exact, case-insensitive). */
export function listSchoolTemplates({ schoolName } = {}) {
  const key = String(schoolName ?? '').trim().toLowerCase();
  const out = [];
  for (const t of templates.values()) {
    if (key && t.schoolName.toLowerCase() !== key) continue;
    out.push(t);
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getSchoolTemplate(id) {
  return templates.get(String(id ?? '')) ?? null;
}

export function deleteSchoolTemplate(id) {
  return templates.delete(String(id ?? ''));
}

/** Test-only: drop everything (in-memory store has no external reset). */
export function _clearSchoolTemplates() {
  templates.clear();
}

// TTL sweep (unref so it never keeps the process alive).
const sweep = setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of templates) {
    if (new Date(v.updatedAt).getTime() < cutoff) templates.delete(k);
  }
}, 24 * 60 * 60 * 1000);
if (typeof sweep.unref === 'function') sweep.unref();

export default {
  defaultSchoolTemplate,
  sanitizeSchoolTemplateVisual,
  seedFromReference,
  buildSchoolTemplate,
  saveSchoolTemplate,
  listSchoolTemplates,
  getSchoolTemplate,
  deleteSchoolTemplate,
  _clearSchoolTemplates,
};
