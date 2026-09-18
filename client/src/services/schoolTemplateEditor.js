/**
 * schoolTemplateEditor.js — pure state / transform helpers for the visual
 * School Template Editor.
 *
 * The editor edits ONLY the visual SchoolTemplate shape persisted by the
 * server (`server/src/services/school-template-store.js`). It never touches
 * question structure: no counts, types, marks, sections, difficulty, units or
 * RAG content live here or in anything this module produces.
 *
 * Kept framework-free so it is unit-testable without a DOM: the React
 * component is a thin shell over these functions + `buildPaperHtml`.
 */

/** The school-neutral default look — mirrors `defaultSchoolTemplate()` on the server. */
export function editorDefault() {
  return {
    page: { size: 'A4', orientation: 'portrait', margins: { left: 42, top: 35, right: 38, bottom: 68 } },
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

/* ── Option lists the UI renders (only backend-supported values) ─────────── */

export const PAGE_SIZES = ['A4', 'Letter', 'Legal'];
export const ORIENTATIONS = ['portrait', 'landscape'];

export const NUMBERING_OPTIONS = [
  { value: 'auto', label: '1.  (default)' },
  { value: 'digit-dot', label: '1.' },
  { value: 'q-prefix', label: 'Q1.' },
  { value: 'digit-paren', label: '1)' },
  { value: 'paren-both', label: '(1)' },
  { value: 'letter', label: 'A.  B.  C.' },
  { value: 'roman', label: 'I.  II.  III.' },
];

export const MARKS_OPTIONS = [
  { value: '', label: 'As written' },
  { value: 'lower-x', label: '1x5=5' },
  { value: 'upper-x', label: '1X5=5' },
  { value: 'times', label: '1×5=5' },
];

export const OPTION_LABEL_OPTIONS = [
  { value: 'roman', label: 'i)  ii)  iii)' },
  { value: 'alpha', label: 'a)  b)  c)' },
];

export const BORDER_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'thin', label: 'Thin' },
  { value: 'double', label: 'Double' },
];

/** Header identity rows the teacher can hide. */
export const HEADER_TOGGLES = [
  { key: 'showSchoolName', label: 'School name' },
  { key: 'showExamTitle', label: 'Exam title' },
  { key: 'showClass', label: 'Class' },
  { key: 'showSubject', label: 'Subject' },
  { key: 'showSession', label: 'Session' },
  { key: 'showDuration', label: 'Duration' },
  { key: 'showMaximumMarks', label: 'Maximum marks' },
];

/** Student-information blanks the teacher can print (all off by default). */
export const STUDENT_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'rollNumber', label: 'Roll No.' },
  { key: 'class', label: 'Class' },
  { key: 'section', label: 'Section' },
  { key: 'date', label: 'Date' },
  { key: 'invigilatorSignature', label: "Invigilator's Signature" },
];

export const FONT_FAMILIES = ['Liberation Serif', 'Times New Roman', 'Georgia', 'Arial', 'Helvetica'];

/* ── Load / persist transforms ─────────────────────────────────────────── */

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Merge a STORED visual onto the default so a template saved before a field
 * existed still opens, WITHOUT letting a default overwrite a stored value.
 * Every scalar the stored object provides wins; only genuinely-absent keys
 * fall back. (Task §12.)
 */
export function visualFromStored(stored) {
  const base = editorDefault();
  const merge = (d, s) => {
    if (!isObj(s)) return d;
    const out = Array.isArray(d) ? [...d] : { ...d };
    for (const k of Object.keys(s)) {
      out[k] = isObj(d?.[k]) && isObj(s[k]) ? merge(d[k], s[k]) : s[k];
    }
    return out;
  };
  return merge(base, stored);
}

/** The object sent to POST/PUT /api/school-templates (a clean deep copy). */
export function editorStateToVisual(state) {
  return JSON.parse(JSON.stringify(visualFromStored(state)));
}

/** Compact row for the Templates list. */
export function templateListRow(record) {
  const v = record?.visual ?? {};
  return {
    id: record?.id ?? null,
    name: record?.name ?? '(untitled)',
    schoolName: record?.schoolName ?? '',
    pageSize: v.page?.size ?? 'A4',
    orientation: v.page?.orientation ?? 'portrait',
    hasLogo: !!v.header?.logo?.dataUri,
    updatedAt: record?.updatedAt ?? record?.createdAt ?? null,
  };
}

/* ── Live preview: reuse the production renderer, never a second layout ── */

/**
 * Sample paper content for the PREVIEW ONLY. `__sample` marks it so it can
 * never be mistaken for real generated questions (see `isSampleContent`).
 * Structure here is fixed sample data — it is not editable in this screen and
 * is not part of the SchoolTemplate.
 */
export const SAMPLE_PREVIEW = Object.freeze({
  __sample: true,
  subject: 'Science',
  settings: { class: '5', difficulty: 'Medium' },
  blueprint: {
    paper: { schoolName: 'GREENWOOD PUBLIC SCHOOL', class: '5' },
    sections: [],
    totalMarks: 10,
    questions: [
      { label: 'Q1', number: 1, type: 'MIXED', totalMarks: 4, itemCount: 3, markExpression: '4' },
      { label: 'Q2', number: 2, type: 'SHORT_ANSWER', totalMarks: 3, itemCount: 1, markExpression: '3' },
      { label: 'Q3', number: 3, type: 'MCQ', totalMarks: 3, itemCount: 1, markExpression: '3' },
    ],
  },
  questions: [
    {
      questionId: 'sample-1', slotIndex: 0, type: 'MIXED', marks: 4,
      text: 'Fill in the blanks and choose the correct answer:',
      subParts: [
        { label: 'a', type: 'FILL_IN_THE_BLANK', text: 'Water boils at ______ degrees Celsius.' },
        { label: 'b', type: 'FILL_IN_THE_BLANK', text: 'The nearest star to Earth is the ______.' },
        { label: 'c', type: 'MCQ', text: 'Which gas do plants release during photosynthesis?', options: ['Carbon dioxide', 'Oxygen', 'Nitrogen'] },
      ],
    },
    { questionId: 'sample-2', slotIndex: 1, type: 'SHORT_ANSWER', marks: 3, text: 'Name three states of matter and give one example of each.' },
    {
      questionId: 'sample-3', slotIndex: 2, type: 'MCQ', marks: 3,
      text: 'Which of these is a renewable source of energy?',
      options: ['Coal', 'Solar', 'Petrol'],
    },
  ],
});

export function isSampleContent(x) {
  return !!(x && x.__sample === true);
}

/**
 * Build the args for `buildPaperHtml` / `buildPaperModel` so the centre preview
 * renders through the EXACT production path with the editor's visual applied.
 * @param {Object} visual - current editor state (visual SchoolTemplate)
 * @param {Object} [opts] - { schoolName, examTitle, session, timeAllowed }
 */
export function previewArgs(visual, opts = {}) {
  const format = {
    schoolName: opts.schoolName || SAMPLE_PREVIEW.blueprint.paper.schoolName,
    examTitle: opts.examTitle || 'Annual Examination',
    session: opts.session || '2024-25',
    timeAllowed: opts.timeAllowed || '2 hours',
    instructionsHeading: visual?.instructions?.heading || 'General Instructions :',
    instructions:
      Array.isArray(visual?.instructions?.items) && visual.instructions.items.length > 0
        ? visual.instructions.items
        : ['Answer all questions.', 'Marks are shown against each question.'],
    mcqOptionLabelStyle: visual?.options?.labelStyle === 'alpha' ? 'alpha' : 'roman',
    marksCase: visual?.marks?.case || null,
    schoolTemplate: editorStateToVisual(visual),
  };
  return {
    questions: SAMPLE_PREVIEW.questions,
    blueprint: SAMPLE_PREVIEW.blueprint,
    settings: SAMPLE_PREVIEW.settings,
    subject: SAMPLE_PREVIEW.subject,
    format,
  };
}

/* ── Logo file handling — reuse the FileReader → data URI pattern ───────── */

export const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
export const LOGO_MAX_BYTES = 1_100_000; // ~1.1 MB; the server also caps this
const LOGO_DATA_URI_RE = /^data:image\/(png|jpe?g|webp|gif);base64,/;

/**
 * Read a File into a validated data URI (or throw). MIME + size checked here;
 * the server's sanitizer re-validates on save.
 * @returns {Promise<string>} data URI
 */
export function readLogoFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file selected.'));
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) return reject(new Error('Logo must be a PNG, JPEG, WebP or GIF image.'));
    if (file.size > LOGO_MAX_BYTES) return reject(new Error('Logo is too large (max ~1 MB). Use a smaller image.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const dataUri = String(reader.result || '');
      if (!LOGO_DATA_URI_RE.test(dataUri)) return reject(new Error('That file is not a supported image.'));
      resolve(dataUri);
    };
    reader.readAsDataURL(file);
  });
}

export default {
  editorDefault,
  visualFromStored,
  editorStateToVisual,
  templateListRow,
  previewArgs,
  isSampleContent,
  readLogoFile,
  SAMPLE_PREVIEW,
  PAGE_SIZES,
  ORIENTATIONS,
  NUMBERING_OPTIONS,
  MARKS_OPTIONS,
  OPTION_LABEL_OPTIONS,
  BORDER_OPTIONS,
  HEADER_TOGGLES,
  STUDENT_FIELDS,
  FONT_FAMILIES,
  LOGO_ACCEPT,
  LOGO_MAX_BYTES,
};
