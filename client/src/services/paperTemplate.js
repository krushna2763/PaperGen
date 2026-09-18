/**
 * Dynamic paper TEMPLATE model.
 *
 * A template describes the DOCUMENT (not the content): page geometry, the
 * school header block, Time/Maximum-Marks line, general instructions and the
 * section letters. Question CONTENT is produced by the RAG/agent pipeline and
 * is rendered through this template.
 *
 * The values below are intentionally school-neutral defaults — nothing from
 * the reference paper (school name, session, marks…) is hard-coded. The
 * teacher fills them in the UI and the choice is persisted per
 * (schoolName, subject, class) so each school keeps its own look.
 */

/** Small helpers shared by preview + PDF + print. */
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/** "4" -> "IV", "10" -> "X"; non-numeric input passes through. */
export function classLabel(value) {
  const n = Number(String(value ?? '').trim());
  if (String(value ?? '').trim() !== '' && Number.isFinite(n) && n >= 1 && n <= 12) {
    return ROMAN[Math.floor(n) - 1];
  }
  return String(value ?? '').trim();
}

/** Sum question marks to auto-compute Maximum Marks when not typed by the teacher. */
export function autoMaximumMarks(questions) {
  const sum = (questions || []).reduce((acc, q) => acc + (Number.isFinite(q?.marks) ? q.marks : 0), 0);
  return sum > 0 ? sum : '';
}

/**
 * The marks annotation shown at the right edge of a question line, in the
 * reference style — e.g. "1x5=5" for a five-part 1-mark question or a plain
 * "5" for a single 5-mark question. A marksExpression on the question (from
 * the data) wins; otherwise a uniform sub-part group computes one.
 */
export function marksLabel(question) {
  if (!question) return '';
  // Explicit blueprint/generation mark expression wins verbatim (e.g. "1X5=5",
  // "2X4=8", "4+1") — never recalculate marks from the type. Accept both the
  // extractor spelling (marksExpression) and the generator spelling (markExpression).
  const expr = String(question.markExpression || question.marksExpression || '').trim();
  if (expr) return expr;
  const parts = Array.isArray(question.subParts) && question.subParts.length > 0
    ? question.subParts
    : null;
  const marks = Number(question.marks);
  if (parts && Number.isFinite(marks)) {
    // Explicit per-part marks (reference Q4 style: a=1, b=2, c=2, d=2, e=3).
    // Mixed per-part marks cannot be written as one "PxN=M" expression — show
    // the plain total and let the parts carry their own "(N)" annotations.
    const partMarks = parts.map((p) => {
      const m = Number(p?.marks);
      return Number.isFinite(m) && m > 0 ? m : null;
    });
    const allExplicit = parts.length > 0 && partMarks.length === parts.length && partMarks.every((m) => m != null);
    if (allExplicit) {
      const distinct = new Set(partMarks);
      if (distinct.size > 1) return String(marks);
      const per = partMarks[0];
      if (per > 0 && Math.abs(per * parts.length - marks) < 1e-6) return `${per}x${parts.length}=${marks}`;
    }
    const per = Number.isFinite(question.subPartMarks) && question.subPartMarks > 0
      ? Number(question.subPartMarks)
      : Math.round((marks / parts.length) * 10) / 10;
    if (Number.isFinite(per) && per > 0) return `${per}x${parts.length}=${marks}`;
  }
  return Number.isFinite(marks) && marks > 0 ? String(marks) : '';
}

const ROMAN_LOWER = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];
const ALPHA_LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * Option labels for MCQ options — the reference uses lowercase roman
 * numerals on their own indented lines ("i)", "ii)", "iii)").
 */
export function optionLabels(count, style = 'roman') {
  const seq = style === 'alpha' ? ALPHA_LOWER : ROMAN_LOWER;
  return Array.from({ length: Math.max(0, count) }, (_, i) => `${seq[i] ?? i + 1})`);
}

/** Strip an extracted option prefix like "A. Oxygen" -> "Oxygen". */
export function cleanOptionText(text, _index) {
  const t = String(text || '').trim();
  const cleaned = t.replace(/^\s*(?:\(?([A-Da-d]|[ivxIVX]+)\)?[.)])\s+/, '');
  if (cleaned && cleaned !== t) return cleaned;
  // No letter prefix — leave as-is (generator emits bare option text).
  return t || '';
}

/** Default layout numbers. Kept together so PDF + preview stay in sync. */
export const PAPER_LAYOUT = {
  pageSize: 'A4', // 595.3 x 841.9 pt
  marginLeft: 42, // measured from the reference paper (content starts x≈41.6)
  marginRight: 38, // marks column ends ≈ x557 → right margin ≈ 38
  marginTop: 35, // first header baseline lands ≈ y46.6 (12 pt ascent ≈ 11.7)
  marginBottom: 68, // reserves footer space; page number baseline lands ≈ y790
  bodyFontSize: 12,
  serifCss: '"Times New Roman", "Liberation Serif", Georgia, serif',
  pdfFont: 'Liberation Serif',
  // Line steps in pt measured between baselines on the reference PDF
  // (12 pt Times New Roman). Calibrated against Liberation Serif metrics:
  //   regular factor ≈ 1.108, bold factor ≈ 1.243  (pdfmake line box)
  stepBody: 20.8, // 1.5-line body/answer spacing
  stepHeader: 14.9, // single-spaced header lines
  stepInstr: 14.9, // single-spaced instruction lines
  // pdfmake lineHeight values that reproduce the steps above with the
  // measured Liberation Serif metrics.
  lineHeightHeader: 1.12, // 12 * 1.12 * 1.108 ≈ 14.9
  lineHeightBody: 1.56, // 12 * 1.56 * 1.108 ≈ 20.8
  lineHeightInstr: 1.12, // 12 * 1.12 * 1.108 ≈ 14.9
  // Block gaps (baseline to baseline) added with paragraph margins.
  gapTimeRowTop: 17, // last header line -> Time row (target ~29.8 total)
  gapInstructionsTop: 10, // Time row -> 'General Instructions :' (target ~22.9 total)
  gapInstructionsBottom: 9, // title -> first instruction item
  gapSectionTop: 21, // last content line -> SECTION heading (~41.4 total)
  gapSectionBottom: 27, // SECTION heading -> first stem (~41.4 total)
  gapStemTop: 21, // last line of previous question -> next stem (~41.4 total)
  questionIndent: 26, // number label -> text column (x 41.6 -> 67.7)
  instructionIndent: 30, // extra left inset for the instructions block (x 72)
  metaRowIndent: 30, // text margin -> "Time:" column
};

/** Default template/paper-format (teacher editable; nothing school-specific). */
export const DEFAULT_PAPER_FORMAT = {
  schoolName: '',
  examTitle: 'Annual Examination',
  session: '',
  timeAllowed: '2hrs 30mins',
  maximumMarks: '', // '' => auto-computed from generated question marks
  instructions: [
    'Read the question paper thoroughly before answering.',
    'Answer all the questions.',
    'Write only the answers. Number the answers correctly.',
  ],
  instructionsHeading: 'General Instructions :', // verbatim reference heading when detected
  sectionLabels: [], // optional explicit ["SECTION A", "SECTION B", …]; derived from question types when empty
  mcqOptionLabelStyle: 'roman',
  marksCase: null, // 'upper-x' | 'lower-x' | 'times' | null — display case for mark expressions
};

/**
 * Render a mark expression with the reference's multiplication glyph/case
 * (e.g. "1X5=5" -> "1x5=5" for a lowercase-x reference). The numeric value
 * is never touched — this is display-only fidelity.
 */
export function applyMarksCase(expr, style) {
  const text = String(expr || '');
  if (!style || !text || !/\d\s*[xX×]\s*\d/.test(text)) return text;
  if (style === 'lower-x') return text.replace(/[X×]/g, 'x');
  if (style === 'upper-x') return text.replace(/x/g, 'X');
  if (style === 'times') return text.replace(/[xX]/g, '×');
  return text;
}

/** "2Hours 30 minutes" -> "2 Hours 30 minutes" (extractor glues a digit to a FULL unit word). Conventional abbreviations like "2hrs 30mins" are left untouched. */
export function normalizeDuration(value) {
  return String(value || '')
    .replace(/(\d)(Hours?|Minutes?)/gi, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Apply a server-detected reference TEMPLATE onto the client paper FORMAT.
 *
 * The template (produced by the deterministic template analyzer from the
 * uploaded reference) carries the reference's own header block, verbatim
 * instructions heading + items, numbering/marks/option label styles. Filling
 * the format from it makes the generated PDF mirror the reference's visual
 * template instead of generic defaults — values stay teacher-editable and
 * only detected (non-empty) values override.
 *
 * @param {Object} template - server template document (analyzeTemplate output)
 * @param {Object} current  - current paper format state
 * @returns {Object} updated paper format
 */
export function templateToFormat(template, current = {}) {
  const t = template?.header || {};
  const out = { ...current };

  if (t.schoolName) out.schoolName = String(t.schoolName).trim();

  // The reference's exam-title line may already embed the session
  // ("ANNUAL EXAMINATION (2022-23)"). When it does, keep the line VERBATIM
  // and leave the session field empty so it is never duplicated; when the
  // session is separate, keep both fields (the format composes title + session).
  // PER-PAPER HEADER FIELDS — reset, never inherit.
  // `templateToFormat` runs on every Mode A analyze against a device-global
  // format (localStorage). examTitle / session / timeAllowed / maximumMarks
  // describe THIS reference paper; if the new reference does not carry one,
  // fall back to the neutral default rather than leaving the PREVIOUS
  // reference's value in place (that is how a Unit 3 / 60-mark / "Term
  // Examination-1" header leaked onto a Unit 4 paper). schoolName and the
  // instructions block are school identity and stay sticky.
  const rawTitle = String(t.examTitle || '').trim();
  const sess = String(t.session || '').trim();
  if (rawTitle) {
    if (sess && rawTitle.includes(sess)) {
      out.examTitle = rawTitle; // verbatim, session embedded in the line
      out.session = '';
    } else {
      out.examTitle = rawTitle;
      out.session = sess || '';
    }
  } else {
    out.examTitle = DEFAULT_PAPER_FORMAT.examTitle;
    out.session = DEFAULT_PAPER_FORMAT.session;
  }

  out.timeAllowed = t.duration ? normalizeDuration(t.duration) : DEFAULT_PAPER_FORMAT.timeAllowed;
  out.maximumMarks = Number.isFinite(t.maximumMarks) ? String(t.maximumMarks) : DEFAULT_PAPER_FORMAT.maximumMarks;

  const items = template?.instructions?.items;
  if (Array.isArray(items) && items.length > 0) out.instructions = items;
  if (template?.instructions?.heading) out.instructionsHeading = String(template.instructions.heading).trim();
  if (!out.instructionsHeading) out.instructionsHeading = 'General Instructions :';

  const optStyle = template?.options?.style;
  if (optStyle === 'alpha-lower' || optStyle === 'alpha-upper') out.mcqOptionLabelStyle = 'alpha';
  else if (optStyle === 'roman-lower' || optStyle === 'roman-upper') out.mcqOptionLabelStyle = 'roman';

  // Reference mark-expression case/glyph (display-only; never the numeric value).
  const marksStyle = template?.marks?.style;
  if (marksStyle === 'upper-x' || marksStyle === 'lower-x' || marksStyle === 'times') out.marksCase = marksStyle;

  return out;
}

export default DEFAULT_PAPER_FORMAT;
