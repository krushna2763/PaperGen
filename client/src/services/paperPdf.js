/**
 * Real PDF generation with pdfmake (MIT, fully client-side).
 *
 * The document is built from the same structured model as the on-screen
 * preview (paperLayout.buildPaperModel) and styled by the paper TEMPLATE
 * (paperTemplate.PAPER_LAYOUT), so generated papers follow the reference
 * examination format: centered school header, Time / Maximum Marks row,
 * General Instructions, centered SECTION headings, continuously numbered
 * questions with right-aligned marks, MCQ options on their own indented
 * lines and a centered page number in the footer.
 *
 * Font: Liberation Serif (SIL OFL) — metric-compatible with the Times New
 * Roman used by the reference paper. pdfmake + font data are lazy-loaded on
 * first use so the initial page load stays fast.
 */

import { buildPaperModel } from './paperLayout.js';
import { PAPER_LAYOUT, optionLabels } from './paperTemplate.js';

let pdfMakePromise = null;

async function getPdfMake() {
  if (!pdfMakePromise) {
    pdfMakePromise = (async () => {
      const [pdfMakeMod, liberationMod] = await Promise.all([
        import('pdfmake/build/pdfmake.js'),
        import('../fonts/LiberationSerif.js'),
      ]);
      const pdfMake = pdfMakeMod.default ?? pdfMakeMod;
      const liberation = liberationMod.default ?? liberationMod;
      if (liberation && liberation.vfs) {
        if (typeof pdfMake.addFontContainer === 'function') pdfMake.addFontContainer(liberation);
        else {
          pdfMake.vfs = { ...(pdfMake.vfs || {}), ...liberation.vfs };
          pdfMake.fonts = { ...(pdfMake.fonts || {}), ...liberation.fonts };
        }
      }
      return pdfMake;
    })();
  }
  return pdfMakePromise;
}

/**
 * Build the pdfmake document definition for the generated paper.
 * @param {Object} args - { questions, blueprint, settings, subject, format }
 *   blueprint (optional but expected) is the LOCKED structural source: sections
 *   and question order come from it, never from question types.
 * @returns {Object} pdfmake doc definition
 */
export function buildDocDefinition({ questions, blueprint, settings, subject, format = {} }) {
  const model = buildPaperModel({ questions, blueprint, settings, subject, format });
  const L = PAPER_LAYOUT;
  const content = [];

  // ── Page-1 school header block (centered, bold, like the reference) ───────
  for (const line of model.header.titleLines) {
    content.push({ text: line.text, style: 'headerLine' });
  }

  const metaLeft = model.header.timeAllowed ? `Time: ${model.header.timeAllowed}` : '';
  const metaRight = model.header.maximumMarks ? `Maximum Marks: ${model.header.maximumMarks}` : '';
  if (metaLeft || metaRight) {
    content.push({
      columns: [
        { text: metaLeft, width: '50%', fontSize: 12 },
        { text: metaRight, width: '50%', fontSize: 12, alignment: 'right' },
      ],
      columnGap: 0,
      margin: [L.metaRowIndent, L.gapTimeRowTop, L.metaRowIndent + 12, 0],
    });
  }

  // ── General Instructions (verbatim reference heading when detected) ───────
  if (model.instructions.length > 0) {
    content.push({ text: model.instructionsHeading, style: 'instructionsTitle' });
    model.instructions.forEach((inst, i) => {
      content.push({
        columns: [
          { text: `${i + 1}.`, width: 34, fontSize: 12, alignment: 'right', lineHeight: L.lineHeightInstr },
          { text: inst, width: '*', fontSize: 12, lineHeight: L.lineHeightInstr },
        ],
        columnGap: 2,
        margin: [L.instructionIndent, 0, 0, 0],
      });
    });
  }

  // ── Sections & questions ──────────────────────────────────────────────────
  // Structure comes from the LOCKED blueprint (buildPaperModel): blueprint
  // sections in blueprint order; questions whose blueprint had no sections (or
  // that belong to no section) flow after them flat — never regrouped by type.
  const optionStyle = format.mcqOptionLabelStyle === 'alpha' ? 'alpha' : 'roman';
  model.sections.forEach((sec, si) => {
    const head = {
      text: sec.label,
      style: 'sectionTitle',
      _sectionHead: true,
      margin: [0, si === 0 ? 10 : L.gapSectionTop, 0, L.gapSectionBottom],
    };
    sec.questions.forEach((q, qi) => {
      const rows = questionRows(q, L, qi === 0, optionStyle);
      if (qi === 0) {
        // Bind the SECTION heading to its first question block.
        content.push({ stack: [head, ...rows] });
      } else {
        content.push(...rows);
      }
    });
  });
  (model.unsectionedQuestions || []).forEach((q, qi) => {
    content.push(...questionRows(q, L, qi === 0, optionStyle));
  });

  return {
    pageSize: L.pageSize,
    pageMargins: [L.marginLeft, L.marginTop, L.marginRight, L.marginBottom],
    info: {
      title: `${String(subject || 'Question Paper').toUpperCase()} - Question Paper`,
      author: 'PaperGen AI',
      creator: 'PaperGen AI',
    },
    defaultStyle: { font: L.pdfFont, fontSize: L.bodyFontSize },
    styles: {
      headerLine: { bold: true, alignment: 'center', lineHeight: L.lineHeightHeader },
      instructionsTitle: {
        bold: true,
        margin: [0, L.gapInstructionsTop, 0, L.gapInstructionsBottom],
      },
      sectionTitle: { bold: true, alignment: 'center', lineHeight: L.lineHeightHeader },
      passage: { lineHeight: L.lineHeightBody, alignment: 'justify' },
      optionRowText: { lineHeight: L.lineHeightBody },
    },
    footer: (currentPage) => ({
      text: String(currentPage),
      alignment: 'center',
      fontSize: 11,
      margin: [0, 6, 0, 0],
    }),
    pageBreakBefore: (currentNode, followingNodesOnPage) =>
      Boolean(currentNode._sectionHead) && followingNodesOnPage.length === 0,
    content,
  };
}

/**
 * pdfmake rows for one question: number + stem + right-aligned marks line,
 * optional passage paragraph, lettered sub-parts (each with its own indented
 * MCQ options when present), structured MATCH columns and INTERNAL_CHOICE
 * "OR" branches. All content arrives structured from the document model — no
 * flattening or regrouping happens here.
 * @param {boolean} [firstInSection] - skip the extra top gap (already given by the section head).
 * @param {string} [optionStyle] - 'roman' (i), ii)…) or 'alpha' (a), b)…) labels.
 */
function questionRows(q, L, firstInSection = false, optionStyle = 'roman') {
  const rows = [];
  const top = firstInSection ? 0 : L.gapStemTop;
  const bodyLH = L.lineHeightBody;
  const indent = L.questionIndent; // x of the question text column

  rows.push({
    columns: [
      { text: q.numberText, width: 24 },
      { text: q.text, width: '*', lineHeight: bodyLH, alignment: 'justify' },
      ...(q.marksText ? [{ text: q.marksText, width: 40, alignment: 'right' }] : []),
    ],
    columnGap: 2,
    margin: [0, top, 0, 0],
  });

  if (q.passage) {
    rows.push({ text: q.passage, style: 'passage', margin: [indent, 0, 0, 0] });
  }

  for (const part of q.subParts) {
    rows.push({
      columns: [
        { text: part.label, width: 26 },
        { text: part.text, width: '*', lineHeight: bodyLH },
      ],
      columnGap: 2,
      margin: [0, 0, 0, part.options.length > 0 ? 2 : 0],
    });
    if (part.options.length > 0) {
      const labels = optionLabels(part.options.length, optionStyle);
      part.options.forEach((opt, oi) => {
        rows.push({
          columns: [
            { text: '', width: indent - 2 },
            { text: labels[oi], width: 26 },
            { text: opt, width: '*', lineHeight: bodyLH },
          ],
          columnGap: 2,
        });
      });
    }
  }

  if (q.options.length > 0) {
    const labels = optionLabels(q.options.length, optionStyle);
    q.options.forEach((opt, i) => {
      rows.push({
        columns: [
          { text: '', width: indent - 2 },
          { text: labels[i], width: 26 },
          { text: opt, width: '*', lineHeight: bodyLH },
        ],
        columnGap: 2,
      });
    });
  }

  // MATCH_THE_FOLLOWING — structured two-column layout (never a paragraph).
  if (q.columns && q.columns.left.length > 0 && q.columns.right.length > 0) {
    const leftItems = q.columns.left.map((c, i) => ({
      text: `${String.fromCharCode(97 + (i % 26))})  ${c}`,
      lineHeight: bodyLH,
      margin: [0, 0, 10, 2],
    }));
    const rightItems = q.columns.right.map((c, i) => ({
      text: `${i + 1}.  ${c}`,
      lineHeight: bodyLH,
      margin: [0, 0, 0, 2],
    }));
    rows.push({
      columns: [
        { width: '50%', stack: leftItems, margin: [indent, 4, 0, 0] },
        { width: '50%', stack: rightItems, margin: [indent / 2, 4, 0, 0] },
      ],
    });
  }

  // INTERNAL_CHOICE — each branch kept separate with an explicit OR line.
  if (q.choices.length > 0) {
    q.choices.forEach((choice, ci) => {
      rows.push({
        columns: [
          { text: choice.label, width: 26 },
          { text: choice.text, width: '*', lineHeight: bodyLH },
        ],
        columnGap: 2,
        margin: [indent - 22, 0, 0, 0],
      });
      for (const sp of choice.subParts) {
        rows.push({
          columns: [
            { text: '', width: indent - 2 },
            { text: sp.label, width: 26 },
            { text: sp.text, width: '*', lineHeight: bodyLH },
          ],
          columnGap: 2,
        });
      }
      if (ci < q.choices.length - 1) {
        rows.push({ text: 'OR', style: 'optionRowText', margin: [indent + 20, 2, 0, 2], italics: true });
      }
    });
  }

  return rows;
}

/** Render the paper to a real PDF Blob. */
export async function createPaperPdfBlob({ questions, blueprint, settings, subject, format }) {
  const pdfMake = await getPdfMake();
  const doc = pdfMake.createPdf(buildDocDefinition({ questions, blueprint, settings, subject, format }));
  const blob = await doc.getBlob();
  return blob;
}

/** Sensible file name for the generated PDF. */
export function paperFileName(subject, settings) {
  const safeSubject = String(subject || 'Question Paper').replace(/[^\w]+/g, '_');
  return `${safeSubject}_Class${settings.class}_QuestionPaper.pdf`;
}

export default { buildDocDefinition, createPaperPdfBlob, paperFileName };
