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
  const st = model.schoolTemplate; // resolved VISUAL template or null (Phase 3)
  const content = [];

  // ── Optional school logo (SchoolTemplate only) ──────────────────────────
  if (model.header.logo?.dataUri) {
    content.push({ image: model.header.logo.dataUri, height: Number(model.header.logo.heightPt) || 48, alignment: 'center', margin: [0, 0, 0, 4] });
  }

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

  // ── Student-information blanks (SchoolTemplate only) ────────────────────
  if ((model.header.studentInfoFields || []).length > 0) {
    content.push({
      columns: model.header.studentInfoFields.map((f) => ({
        text: [{ text: `${f}: ` }, { text: '______________', color: '#555' }],
        width: 'auto',
        fontSize: 11,
      })),
      columnGap: 18,
      margin: [L.metaRowIndent, 10, L.metaRowIndent, 0],
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
  const optionStyle = (st?.options?.labelStyle || format.mcqOptionLabelStyle) === 'alpha' ? 'alpha' : 'roman';
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
    // Page geometry: SchoolTemplate overrides the calibrated A4 defaults when
    // present; otherwise byte-identical to before.
    pageSize: st?.page?.size ? String(st.page.size).toUpperCase() : L.pageSize,
    ...(st?.page?.orientation === 'landscape' ? { pageOrientation: 'landscape' } : {}),
    pageMargins: st?.page?.margins
      ? [st.page.margins.left, st.page.margins.top, st.page.margins.right, st.page.margins.bottom]
      : [L.marginLeft, L.marginTop, L.marginRight, L.marginBottom],
    info: {
      title: `${String(subject || 'Question Paper').toUpperCase()} - Question Paper`,
      author: 'PaperGen AI',
      creator: 'PaperGen AI',
    },
    // Font FAMILY stays Liberation Serif (the only embedded VFS font); a
    // template may still change the body point size.
    defaultStyle: { font: L.pdfFont, fontSize: st?.font?.bodySizePt || L.bodyFontSize },
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
    // Running header on pages 2+ (SchoolTemplate `repeatOnLaterPages`).
    ...(st?.header?.repeatOnLaterPages && model.header.titleLines[0]?.text
      ? {
        header: (currentPage) =>
          currentPage > 1
            ? { text: model.header.titleLines[0].text, alignment: 'center', fontSize: 10, color: '#333', margin: [0, 10, 0, 0] }
            : null,
      }
      : {}),
    footer: footerFn(st, L),
    // Optional page border (SchoolTemplate `border`).
    ...(st?.border && st.border.style !== 'none' ? { background: borderFn(st.border) } : {}),
    pageBreakBefore: (currentNode, followingNodesOnPage) =>
      Boolean(currentNode._sectionHead) && followingNodesOnPage.length === 0,
    content,
  };
}

/**
 * Footer factory. No template -> the historical centered page number. A
 * template may add footer text and/or suppress the page number.
 */
function footerFn(st, L) {
  const text = st?.footer?.text || '';
  const showNum = !st || st.footer?.showPageNumbers !== false;
  return (currentPage) => {
    if (text && showNum) {
      return {
        columns: [
          { text, fontSize: 10, alignment: 'left', margin: [L.marginLeft, 6, 0, 0] },
          { text: String(currentPage), fontSize: 11, alignment: 'right', margin: [0, 6, L.marginRight, 0] },
        ],
      };
    }
    if (text) return { text, fontSize: 10, alignment: 'center', margin: [0, 6, 0, 0] };
    if (showNum) return { text: String(currentPage), alignment: 'center', fontSize: 11, margin: [0, 6, 0, 0] };
    return '';
  };
}

/** Page-border background factory (thin | double). */
function borderFn(border) {
  const m = Number(border.marginPt) || 16;
  return (currentPage, pageSize) => {
    const rects = [
      { type: 'rect', x: m, y: m, w: pageSize.width - 2 * m, h: pageSize.height - 2 * m, lineWidth: border.style === 'double' ? 1.4 : 0.75, lineColor: '#111' },
    ];
    if (border.style === 'double') {
      const i = m + 3;
      rects.push({ type: 'rect', x: i, y: i, w: pageSize.width - 2 * i, h: pageSize.height - 2 * i, lineWidth: 0.6, lineColor: '#111' });
    }
    return { canvas: rects };
  };
}

/**
 * pdfmake nodes for a list of teacher-supplied images (Phase 4). Bounded by a
 * fit box so an oversized upload can never overflow the text column; a
 * `widthPct` (1–100) sizes it against the usable A4 width instead.
 */
function imageNodes(images, indent) {
  return (images || []).map((im) => ({
    image: im.dataUri,
    ...(im.widthPct ? { width: Math.round((im.widthPct / 100) * 460) } : { fit: [430, 260] }),
    margin: [indent, 4, 0, 6],
  }));
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

  // Question-level figures (teacher-supplied pixels) — between stem and sub-parts.
  for (const node of imageNodes(q.images, indent)) rows.push(node);

  for (const part of q.subParts) {
    rows.push({
      columns: [
        { text: part.label, width: 26 },
        { text: part.text, width: '*', lineHeight: bodyLH },
      ],
      columnGap: 2,
      margin: [0, 0, 0, part.options.length > 0 ? 2 : 0],
    });
    // Sub-question figures, indented under the item.
    for (const node of imageNodes(part.images, indent + 20)) rows.push(node);
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

/* ── Answer key: its own document, SAME paper model, SAME header ──────────────
 * Question numbers + answers + the marking scheme where marks break down.
 * Assembled only from what buildPaperModel carries (generation + teacher edits).
 */
function answerRows(q, L) {
  const rows = [];
  const label = q.label || q.numberText || '';
  rows.push({
    columns: [
      { text: label, width: 40, bold: true },
      { text: q.text || '', width: '*', bold: true },
    ],
    columnGap: 4,
    margin: [0, L.gapStemTop / 2, 0, 2],
  });
  // Figures on the key too — the teacher marks against the same diagram.
  for (const node of imageNodes(q.images, 34)) rows.push(node);

  const one = (prefix, answer, rationale, scheme, keyMarks) => {
    const km = Number(keyMarks);
    const marksTag = Number.isFinite(km) && km > 0 ? `  [${km} mark${km === 1 ? '' : 's'}]` : '';
    rows.push({
      columns: [
        { text: prefix || '', width: 24 },
        {
          width: '*',
          stack: [
            { text: [{ text: 'Answer: ', bold: true }, { text: String(answer || '').trim() || '— not provided —' }, { text: marksTag, color: '#555', fontSize: 10.5 }] },
            ...(rationale ? [{ text: String(rationale), italics: true, fontSize: 11, color: '#444' }] : []),
            ...((Array.isArray(scheme) ? scheme : [])
              .filter((s) => String(s?.point ?? '').trim())
              .map((s) => {
                const m = Number(s?.marks);
                const suffix = Number.isFinite(m) && m > 0 ? `  (${m})` : '';
                return { text: `• ${String(s.point)}${suffix}`, fontSize: 11, margin: [10, 0, 0, 0] };
              })),
          ],
        },
      ],
      columnGap: 4,
      margin: [34, 1, 0, 1],
    });
  };

  if (Array.isArray(q.subParts) && q.subParts.length > 0) {
    q.subParts.forEach((sp) => one(sp.label, sp.answer, sp.rationale, sp.markingScheme, sp.keyMarks));
  } else {
    one('', q.answer, q.rationale, q.markingScheme, q.keyMarks);
  }

  // MATCH — the whole-question pairing key ("a → 2") rendered as a column.
  if (Array.isArray(q.answerPairs) && q.answerPairs.length > 0) {
    rows.push({
      columns: [
        {
          width: '100%',
          stack: q.answerPairs.map((p, i) => ({
            text: `${String.fromCharCode(97 + (i % 26))})  ${p.left}  →  ${p.right}`,
            fontSize: 11,
            margin: [0, 0, 8, 1],
          })),
          margin: [34, 2, 0, 2],
        },
      ],
    });
  }

  // INTERNAL_CHOICE — BOTH OR branches keep their own answer (never one).
  if (Array.isArray(q.choices) && q.choices.length > 0) {
    q.choices.forEach((c) => {
      rows.push({ text: `${c.label}. ${c.text}`, fontSize: 11, margin: [34, 2, 0, 0] });
      one('', c.answer, c.rationale, null, null);
      rows.push({ text: 'OR', italics: true, fontSize: 11, color: '#555', margin: [34, 1, 0, 1] });
    });
    rows.pop(); // no OR line after the last branch
  }

  return rows;
}

export function buildAnswerKeyDocDefinition({ questions, blueprint, settings, subject, format = {} }) {
  const model = buildPaperModel({ questions, blueprint, settings, subject, format });
  const L = PAPER_LAYOUT;
  const st = model.schoolTemplate; // resolved VISUAL template or null
  const content = [];
  // School identity (logo + title lines) matches the student paper; the answer
  // key never carries the student-information blanks.
  if (model.header.logo?.dataUri) {
    content.push({ image: model.header.logo.dataUri, height: Number(model.header.logo.heightPt) || 48, alignment: 'center', margin: [0, 0, 0, 4] });
  }
  for (const line of model.header.titleLines) content.push({ text: line.text, style: 'headerLine' });
  content.push({ text: 'ANSWER KEY', bold: true, alignment: 'center', characterSpacing: 1, margin: [0, 8, 0, 4] });

  model.sections.forEach((sec) => {
    content.push({ text: sec.label, style: 'sectionTitle', margin: [0, L.gapSectionTop, 0, 6] });
    sec.questions.forEach((q) => content.push(...answerRows(q, L)));
  });
  (model.unsectionedQuestions || []).forEach((q) => content.push(...answerRows(q, L)));

  return {
    pageSize: st?.page?.size ? String(st.page.size).toUpperCase() : L.pageSize,
    ...(st?.page?.orientation === 'landscape' ? { pageOrientation: 'landscape' } : {}),
    pageMargins: st?.page?.margins
      ? [st.page.margins.left, st.page.margins.top, st.page.margins.right, st.page.margins.bottom]
      : [L.marginLeft, L.marginTop, L.marginRight, L.marginBottom],
    info: {
      title: `${String(subject || 'Question Paper').toUpperCase()} - Answer Key`,
      author: 'PaperGen AI', creator: 'PaperGen AI',
    },
    defaultStyle: { font: L.pdfFont, fontSize: st?.font?.bodySizePt || L.bodyFontSize },
    styles: {
      headerLine: { bold: true, alignment: 'center', lineHeight: L.lineHeightHeader },
      sectionTitle: { bold: true, alignment: 'center', lineHeight: L.lineHeightHeader },
    },
    ...(st?.header?.repeatOnLaterPages && model.header.titleLines[0]?.text
      ? {
        header: (currentPage) =>
          currentPage > 1
            ? { text: model.header.titleLines[0].text, alignment: 'center', fontSize: 10, color: '#333', margin: [0, 10, 0, 0] }
            : null,
      }
      : {}),
    footer: footerFn(st, L),
    ...(st?.border && st.border.style !== 'none' ? { background: borderFn(st.border) } : {}),
    content,
  };
}

export async function createAnswerKeyPdfBlob({ questions, blueprint, settings, subject, format }) {
  const pdfMake = await getPdfMake();
  const doc = pdfMake.createPdf(buildAnswerKeyDocDefinition({ questions, blueprint, settings, subject, format }));
  return doc.getBlob();
}

/** Sensible file name for the generated PDF. */
export function paperFileName(subject, settings) {
  const safeSubject = String(subject || 'Question Paper').replace(/[^\w]+/g, '_');
  return `${safeSubject}_Class${settings.class}_QuestionPaper.pdf`;
}

export function answerKeyFileName(subject, settings) {
  const safeSubject = String(subject || 'Question Paper').replace(/[^\w]+/g, '_');
  return `${safeSubject}_Class${settings.class}_AnswerKey.pdf`;
}

export default {
  buildDocDefinition, createPaperPdfBlob, paperFileName,
  buildAnswerKeyDocDefinition, createAnswerKeyPdfBlob, answerKeyFileName,
};
