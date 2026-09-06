/**
 * template-analyzer.js
 *
 * UNIVERSAL deterministic "reference paper → visual TEMPLATE" analyzer.
 *
 * Layer separation (never mixed):
 *   RAG       = CONTENT   (academic facts, topics)
 *   BLUEPRINT = STRUCTURE (sections, question numbers, types, marks, counts)
 *   TEMPLATE  = VISUAL    (header block, instruction heading, numbering /
 *                         marks / option label styles, page flow signals)
 *
 * This module derives the TEMPLATE from the already-extracted reference data
 * (cleaned text, per-page text, extracted questions, locked blueprint) with
 * ZERO LLM calls. Whatever cannot be measured deterministically from the text
 * layer (font geometry, exact margins, page size) is deliberately reported as
 * a templateWarnings entry and left to the renderer's measured defaults —
 * never invented and never guessed by Gemini.
 *
 * Everything here is DOCUMENT-DRIVEN: no school/subject/class/section names,
 * mark patterns or option styles are hard-coded. A paper that uses roman
 * numerals, letters or plain digits for numbering, "1x5=5" or "2×4=8" for
 * marks, or "(A) … (D)" for MCQ options is captured exactly as it is.
 */

// ─── Pure detection helpers (exported for tests) ────────────────────────────

/** Trim a line-ish text; keep only non-empty trimmed lines. */
const lines = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * Detect the verbatim heading line of the general-instructions block.
 * Accepts "General Instructions :", "INSTRUCTIONS:", "Instructions", … and
 * keeps the exact punctuation/case the reference uses so the generated paper
 * can reproduce it.
 * @returns {{ heading: string|null, items: string[] }}
 */
export function detectInstructions(text) {
  if (!text || typeof text !== 'string') return { heading: null, items: [] };
  const out = [];
  let heading = null;
  let inBlock = false;
  for (const raw of lines(text)) {
    if (!inBlock) {
      // A standalone heading line ending in "Instructions", e.g.
      // "General Instructions :", "INSTRUCTIONS:", "Instructions".
      const m = raw.match(/^((?:[A-Za-z]+\s+)*Instructions?)\s*[:.]*\s*$/i);
      if (m && m[1].trim().length <= 40) {
        heading = raw; // verbatim, punctuation included
        inBlock = true;
      }
      continue;
    }
    if (/^(?:SECTION|Part)\s/i.test(raw)) break;
    if (/^Q\d/i.test(raw)) break;
    if (/\d+\s*[xX×*]\s*\d+\s*=\s*\d+/.test(raw)) break; // real question line
    const cleaned = raw.replace(/^\s*\(?\d+\)?[.)]?\s*/, '').trim();
    // Extraction artifacts ("[1]", bare numbers, single chars) are not
    // student instructions.
    if (!cleaned || /^\[\d+\]$/.test(cleaned) || /^\d+$/.test(cleaned) || cleaned.length < 3) continue;
    out.push(cleaned);
    if (out.length >= 10) break;
  }
  return { heading, items: out };
}

/**
 * Detect the main-question NUMBERING style from blueprint question labels.
 * @param {Array<string|number>} labels - e.g. ["Q1","Q2",…], ["1.","2.",…], ["I","II",…]
 * @returns {{ style: string, sample: string, confidence: number }}
 */
export function detectNumberingStyle(labels) {
  const list = (labels || []).map((l) => String(l ?? '').trim()).filter(Boolean);
  if (list.length === 0) return { style: 'unknown', sample: null, confidence: 0 };
  const styleOf = (label) => {
    if (/^Q\.?\.?\s*\d+/i.test(label)) return 'q-prefix';
    if (/^\(?[IVXLC]{1,4}\)?[.)]?$/.test(label)) return 'roman';
    if (/^\(?[A-H]\)?[.)]?$/.test(label)) return 'letter';
    if (/^\d+\.$/.test(label)) return 'digit-dot';
    if (/^\d+\)$/.test(label)) return 'digit-paren';
    if (/^\d+$/.test(label)) return 'digit-plain';
    return 'unknown';
  };
  const counts = {};
  for (const l of list) {
    const s = styleOf(l);
    counts[s] = (counts[s] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [style, n] = entries[0];
  const known = list.length - (counts.unknown || 0);
  return {
    style,
    sample: list.find((l) => styleOf(l) === style) ?? list[0],
    confidence: known > 0 ? n / known : 0,
  };
}

/** Pull the verbatim marks sub-string ("1x3=3", "2×4=8", "4+1") from a stem. */
function rawMarksSubstring(text) {
  const t = String(text || '');
  const m = t.match(/(?:^|[^\d])(\d+\s*[xX×]\s*\d+\s*=\s*\d+|\d+\s*[xX×]\s*\d+|\d+\s*\+\s*\d+)/);
  return m ? m[1].replace(/\s+/g, '') : null;
}

/**
 * Detect the marks-expression STYLE used by the reference (structural, e.g.
 * "1X5=5" vs "1x5=5" vs "2×4=8" vs a bare "5" or the additive "4+1").
 *
 * The blueprint normalizes expressions to uppercase "X"; to preserve the
 * reference's actual case/style, verbatim sub-strings are also pulled from
 * the raw question stems (passed as `rawTexts`).
 * @param {Array<string|null>} expressions - normalized markExpression samples
 * @param {Array<string|null>} [rawTexts]   - raw question stems (verbatim style)
 * @returns {{ style: string, equation: boolean, sample: string|null, confidence: number }}
 */
export function detectMarksStyle(expressions, rawTexts = []) {
  const raw = (rawTexts || [])
    .map((t) => rawMarksSubstring(t))
    .filter(Boolean);
  // The blueprint NORMALIZES expressions ("1x5=5" -> "1X5=5"), so it cannot
  // vote on the reference's verbatim case. Verbatim raw stems decide the
  // style whenever they exist; normalized expressions only supply the
  // plus/plain shapes when no raw expression was found.
  const list = (raw.length > 0 ? raw : (expressions || []).map((e) => String(e ?? '').trim())).filter(Boolean);
  if (list.length === 0) return { style: 'unknown', equation: false, sample: null, confidence: 0 };
  const equation = [...raw, ...(expressions || [])].some((e) => /[xX×]\s*\d+\s*=\s*\d+/.test(String(e || '')));
  const styleOf = (expr) => {
    if (/×/.test(expr)) return 'times';
    if (/[xX]\s*\d/.test(expr)) {
      const m = expr.match(/^(\d+)\s*([xX])\s*\d+/);
      if (m) return m[2] === 'X' ? 'upper-x' : 'lower-x';
      return /[A-Z]/.test(expr.match(/[xX]/)?.[0] ?? '') ? 'upper-x' : 'lower-x';
    }
    if (/\+/.test(expr)) return 'plus';
    return 'plain';
  };
  const counts = {};
  for (const e of list) counts[styleOf(e)] = (counts[styleOf(e)] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [style, n] = entries[0];
  return {
    style,
    equation,
    sample: list.find((e) => styleOf(e) === style) ?? list[0],
    confidence: n / list.length,
  };
}

/**
 * Detect the MCQ option LABEL style from raw extracted option strings.
 * @param {Array<string>} optionSamples - raw option text (may carry "i)", "a)", "(A)" prefixes)
 * @returns {{ style: string, sample: string|null, confidence: number }}
 */
export function detectOptionLabelStyle(optionSamples) {
  const list = (optionSamples || []).map((o) => String(o ?? '').trim()).filter(Boolean);
  if (list.length === 0) return { style: 'unknown', sample: null, confidence: 0 };
  const styleOf = (opt) => {
    const lead = opt.match(/^(\s*\(?\s*)([ivxlcIVXLCa-dA-D]{1,5})\s*\)?\s*[.)]\s*/);
    if (!lead) return 'plain';
    const tok = lead[2];
    if (/^[ivxlc]+$/.test(tok)) return 'roman-lower';
    if (/^[IVXLC]+$/.test(tok)) return 'roman-upper';
    if (/^[A-D]+$/.test(tok)) return 'alpha-upper';
    if (/^[a-d]+$/.test(tok)) return 'alpha-lower';
    return 'plain';
  };
  const counts = {};
  for (const o of list) counts[styleOf(o)] = (counts[styleOf(o)] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [style, n] = entries[0];
  return {
    style,
    sample: list.find((o) => styleOf(o) === style) ?? list[0],
    confidence: n / list.length,
  };
}

/**
 * Count structurally significant question shapes in the locked blueprint.
 * @param {Array<Object>} bpQuestions - blueprint.questions
 */
export function detectSpecialStructures(bpQuestions = []) {
  const count = (t) => bpQuestions.filter((q) => q?.type === t).length;
  return {
    passages: count('PASSAGE'),
    comprehension: count('CASE_BASED') + count('PASSAGE'),
    match: count('MATCH_THE_FOLLOWING'),
    internalChoices: count('INTERNAL_CHOICE'),
    diagrams: count('DIAGRAM') + count('DRAWING'),
    maps: count('MAP'),
    mcq: count('MCQ'),
  };
}

// ─── Paper-header signals from per-page text (best effort, low confidence) ──

/** Whether a page starts with the school-name header (repeated running header). */
function detectHeaderRepeat(schoolName, pages) {
  if (!schoolName || !Array.isArray(pages) || pages.length < 2) return false;
  const target = String(schoolName).trim().toLowerCase();
  let laterPages = 0;
  let withHeader = 0;
  for (const page of pages.slice(1)) {
    const firstLine = lines(page?.text)[0];
    if (!firstLine) continue;
    laterPages++;
    if (firstLine.toLowerCase() === target || firstLine.toLowerCase().startsWith(target.slice(0, 12))) withHeader++;
  }
  return laterPages > 0 && withHeader / laterPages >= 0.5;
}

/** Whether most pages end with a bare small number (a centered page number). */
function detectPageNumbers(pages) {
  if (!Array.isArray(pages) || pages.length < 2) return null;
  const endings = pages.map((p) => lines(p?.text).pop()).filter((l) => l && /^\d{1,3}$/.test(l));
  return endings.length / pages.length >= 0.7;
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Analyze the uploaded reference paper into a UNIVERSAL visual TEMPLATE.
 * Deterministic (no Gemini). Inputs come from the existing pipeline:
 *   text       - cleaned whole-paper text
 *   pages      - per-page cleaned text (pdf-parser shape)
 *   questions  - raw questionExtractor output (for MCQ option samples)
 *   blueprint  - the locked blueprint (paper header, labels, marks, sections)
 * @returns {Object} template document (see header docs for the shape)
 */
export function analyzeTemplate({ text = '', pages = [], questions = [], blueprint = null } = {}) {
  const warnings = [];
  const paper = blueprint?.paper || {};

  // ── Header block ──────────────────────────────────────────────────────────
  const schoolName = String(paper.schoolName ?? '').trim() || null;
  const examTitle = String(paper.examTitle ?? '').trim() || null;
  const session = String(paper.session ?? '').trim() || null;
  const docClass = String(paper.class ?? '').trim() || null;
  const subject = String(paper.subject ?? '').trim() || null;
  const duration = String(paper.duration ?? '').trim() || null;
  const maximumMarks = Number.isFinite(paper.maximumMarks) ? paper.maximumMarks : null;

  // ── Instructions block (verbatim heading + items) ─────────────────────────
  const { heading: instructionsHeading, items: instructionItems } = detectInstructions(text);
  if (!instructionsHeading && blueprint?.studentInstructions?.length > 0) {
    warnings.push({ field: 'instructions', warning: 'Instruction heading line could not be matched verbatim — the renderer default will be used.' });
  }

  // ── Sections (mirror of the locked blueprint — structure, not style) ──────
  const bpSections = Array.isArray(blueprint?.sections) ? blueprint.sections : [];
  const sectioned = bpSections.length > 0;

  // ── Numbering / marks from blueprint question labels + expressions ────────
  // Marks style is read from the RAW stems when available (the blueprint
  // normalizes "1x5=5" to "1X5=5", losing the reference's actual case).
  const labels = (blueprint?.questions || []).map((q) => q?.label ?? q?.number).filter((v) => v != null);
  const numbering = detectNumberingStyle(labels);
  const rawTexts = (questions || []).map((q) => q?.text);
  const marks = detectMarksStyle(
    (blueprint?.questions || []).map((q) => q?.markExpression ?? q?.marks?.expression),
    rawTexts,
  );

  // ── MCQ option label style from raw extracted options ─────────────────────
  const optionSamples = [];
  for (const q of questions || []) {
    if (Array.isArray(q?.options)) {
      for (const o of q.options) {
        optionSamples.push(o);
        if (optionSamples.length >= 24) break;
      }
    }
    if (optionSamples.length >= 24) break;
  }
  const options = detectOptionLabelStyle(optionSamples);
  if ((blueprint?.questions || []).some((q) => q?.type === 'MCQ') && options.style === 'unknown') {
    warnings.push({ field: 'options', warning: 'MCQ option labels could not be detected from the text layer — the renderer default (i), ii)…) is used.' });
  }

  // ── Special structures (passages / matching / internal choice / diagrams) ─
  const special = detectSpecialStructures(blueprint?.questions);

  // ── Page-flow signals (best effort from per-page text) ────────────────────
  const headerRepeated = detectHeaderRepeat(schoolName, pages);
  const pageNumbersDetected = detectPageNumbers(pages);

  if (!text && !Array.isArray(questions)) {
    warnings.push({ field: 'template', warning: 'No reference text was available — template reflects blueprint data only.' });
  }
  if (!sectioned) {
    warnings.push({ field: 'sections', warning: 'Reference has no section boundaries — the generated paper will render one continuous block.' });
  }
  if (!numbering.sample || numbering.confidence < 0.5) {
    warnings.push({ field: 'numbering', warning: `Main-question numbering style is ambiguous (${numbering.style}).` });
  }
  if (!marks.sample || marks.confidence < 0.5) {
    warnings.push({ field: 'marks', warning: 'Marks-expression style could not be confidently detected.' });
  }

  return {
    source: 'reference', // derived from the uploaded reference paper
    paper: {
      schoolName,
      examTitle,
      session,
      class: docClass,
      subject,
      duration,
      maximumMarks,
    },
    header: {
      present: {
        schoolName: !!schoolName,
        examTitle: !!examTitle,
        session: !!session,
        class: !!docClass,
        subject: !!subject,
        time: !!duration,
        maximumMarks: Number.isFinite(maximumMarks),
      },
      schoolName,
      examTitle,
      session,
      class: docClass,
      subject,
      duration,
      maximumMarks,
      repeatedOnLaterPages: headerRepeated,
    },
    instructions: {
      heading: instructionsHeading,
      items: instructionItems.length > 0
        ? instructionItems
        : (Array.isArray(blueprint?.studentInstructions) ? blueprint.studentInstructions : []).filter(
            (i) => i && !/^\[\d+\]$/.test(String(i).trim()) && String(i).trim().length >= 3,
          ),
    },
    sections: {
      present: sectioned,
      count: bpSections.length,
      names: bpSections.map((s) => s.name).filter(Boolean),
      titles: bpSections.map((s) => s.title).filter(Boolean),
    },
    numbering,
    marks,
    options,
    special,
    page: {
      pageCount: Array.isArray(pages) && pages.length > 0 ? pages.length : null,
      size: 'A4', // pdf-parse exposes no geometry; renderer uses A4 defaults
      orientation: 'portrait',
      headerRepeated,
      pageNumbersDetected,
    },
    typography: {
      measurable: false,
      note: 'Font geometry/margins are not recoverable from the text layer — the renderer applies its measured A4 defaults (calibrated against real school papers).',
    },
    templateWarnings: warnings,
  };
}

export default { analyzeTemplate, detectInstructions, detectNumberingStyle, detectMarksStyle, detectOptionLabelStyle, detectSpecialStructures };
