/**
 * Standalone HTML renderers for a generated paper.
 *
 *   buildPaperHtml      — the STUDENT-FACING question paper. Questions only,
 *                         blank space for answers. It must never emit an answer,
 *                         a rationale or a marking scheme, whatever the model
 *                         carries. (Guarded by test paperHtml-no-answers.test.js.)
 *   buildAnswerKeyHtml  — the teacher's answer key: same document model, same
 *                         header, same question numbers — plus the answer,
 *                         rationale and (where marks break down) the marking
 *                         scheme for each item. Assembled ONLY from what
 *                         `buildPaperModel` produced (i.e. what generation wrote
 *                         and the teacher edited) — nothing is re-derived here.
 *
 * Both consume `buildPaperModel`, so the two stay structurally consistent.
 */
import { buildPaperModel } from './paperLayout.js';
import { PAPER_LAYOUT, optionLabels } from './paperTemplate.js';

const DEFAULT_SUBJECT = 'General';

export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Student paper (NO answers) ──────────────────────────────────────────── */

/** Figure block for teacher-supplied question / sub-part images (Phase 4). */
function figuresHtml(images, sub = false) {
  return (images || [])
    .map((im) => `<div class="fig${sub ? ' fig-sub' : ''}"><img src="${escapeHtml(im.dataUri)}" alt="${escapeHtml(im.alt || '')}"${im.widthPct ? ` style="width:${im.widthPct}%"` : ''} /></div>`)
    .join('');
}

function paperQuestionHtml(q) {
  const qOptions = (q.options || [])
    .map((opt, oi) => `<div class="opt"><span class="opt-label">${optionLabels(q.options.length)[oi]}</span><span>${escapeHtml(opt)}</span></div>`)
    .join('');
  const parts = (q.subParts || [])
    .map((p) => {
      const partOpts = (p.options || [])
        .map((opt, oi) => `<div class="opt opt-sub"><span class="opt-label">${optionLabels(p.options.length)[oi]}</span><span>${escapeHtml(opt)}</span></div>`)
        .join('');
      return `<div class="part"><span class="part-label">${escapeHtml(p.label)}</span><span>${escapeHtml(p.text)}</span></div>${figuresHtml(p.images, true)}${partOpts}`;
    })
    .join('');
  const passage = q.passage ? `<div class="passage">${escapeHtml(q.passage)}</div>` : '';
  const figures = figuresHtml(q.images);
  const columns = q.columns && q.columns.left.length > 0 && q.columns.right.length > 0
    ? `<div class="match"><div class="match-col">${q.columns.left
        .map((c, i) => `<div class="match-item"><span class="part-label">${String.fromCharCode(97 + (i % 26))})</span><span>${escapeHtml(c)}</span></div>`)
        .join('')}</div><div class="match-col">${q.columns.right
        .map((c, i) => `<div class="match-item"><span class="part-label">${i + 1}.</span><span>${escapeHtml(c)}</span></div>`)
        .join('')}</div></div>`
    : '';
  const choices = (q.choices || [])
    .map((c, ci) => {
      const choiceParts = (c.subParts || [])
        .map((sp) => `<div class="part"><span class="part-label">${escapeHtml(sp.label)}</span><span>${escapeHtml(sp.text)}</span></div>`)
        .join('');
      const orLine = ci < (q.choices || []).length - 1 ? '<div class="or">OR</div>' : '';
      return `<div class="part choice"><span class="part-label">${escapeHtml(c.label)}</span><span>${escapeHtml(c.text)}</span></div>${choiceParts}${orLine}`;
    })
    .join('');
  return `<div class="q"><span class="num">${escapeHtml(q.numberText || '')}</span><span class="qtext">${escapeHtml(q.text)}</span>${q.marksText ? `<span class="marks">${escapeHtml(q.marksText)}</span>` : ''}</div>${passage}${figures}${parts}${qOptions}${columns}${choices}`;
}

/** Logo + centered title block. Logo only renders when a SchoolTemplate carries one. */
function headerHtml(model) {
  const logo = model.header.logo
    ? `<div class="logo"><img src="${escapeHtml(model.header.logo.dataUri)}" alt="" style="height:${Number(model.header.logo.heightPt) || 48}pt" /></div>`
    : '';
  return `
    ${logo}
    <div class="school">${model.header.titleLines.map((l) => `<div>${escapeHtml(l.text)}</div>`).join('')}</div>
    <div class="time-row">
      <span>${model.header.timeAllowed ? `Time: ${escapeHtml(model.header.timeAllowed)}` : ''}</span>
      <span>${model.header.maximumMarks ? `Maximum Marks: ${escapeHtml(model.header.maximumMarks)}` : ''}</span>
    </div>`;
}

/** Student-information blanks (SchoolTemplate only; empty string otherwise). */
function studentInfoHtml(model) {
  const fields = model.header.studentInfoFields || [];
  if (fields.length === 0) return '';
  return `<div class="student-info">${fields
    .map((f) => `<span class="si-field">${escapeHtml(f)}: <span class="si-blank"></span></span>`)
    .join('')}</div>`;
}

/**
 * Base stylesheet. Without a SchoolTemplate the @page / font rules are
 * byte-identical to the historical constant; a template overrides page size,
 * orientation, margins, body font/size and adds an optional per-page border.
 */
function baseCss(model) {
  const st = model.schoolTemplate;
  const pg = st?.page;
  const pageRule = pg
    ? `@page { size: ${pg.size}${pg.orientation === 'landscape' ? ' landscape' : ''}; margin: ${pg.margins.top}pt ${pg.margins.right}pt ${pg.margins.bottom}pt ${pg.margins.left}pt; }`
    : `@page { size: A4; margin: 16mm 13mm 16mm 15mm; }`;
  const fontFamily = st?.font?.family ? `"${st.font.family}", ${PAPER_LAYOUT.serifCss}` : PAPER_LAYOUT.serifCss;
  const fontSize = st?.font?.bodySizePt ? `${st.font.bodySizePt}pt` : '12pt';
  const border = st?.border && st.border.style !== 'none'
    ? `.page-frame { position: fixed; inset: ${st.border.marginPt || 16}pt; pointer-events: none;
         border: ${st.border.style === 'double' ? '3px double' : '1px solid'} #111; }`
    : `.page-frame { display: none; }`;
  const footText = st?.footer?.text ? String(st.footer.text) : '';
  const foot = footText
    ? `.page-foot { position: fixed; left: 0; right: 0; bottom: 6pt; text-align: center; font-size: 9pt; color: #555; }`
    : `.page-foot { display: none; }`;
  return `
  ${pageRule}
  * { box-sizing: border-box; }
  body { font-family: ${fontFamily}; color: #111; margin: 0; font-size: ${fontSize}; line-height: 1.72; }
  .logo { text-align: center; margin-bottom: 4px; }
  .school { text-align: center; font-weight: 700; }
  .time-row { display: flex; justify-content: space-between; margin-top: 14px; }
  .student-info { display: flex; flex-wrap: wrap; gap: 6px 22px; margin-top: 12px; }
  .si-blank { display: inline-block; min-width: 120px; border-bottom: 1px solid #111; }
  .gi-title { font-weight: 700; margin-top: 14px; }
  .gi { display: flex; gap: 8px; line-height: 1.24; margin: 2px 0; }
  .gi-num { width: 26px; text-align: right; }
  .section-title { text-align: center; font-weight: 700; margin: 26px 0 4px; }
  .q { display: flex; align-items: flex-start; margin-top: 20px; }
  .q .num { width: 26px; }
  .q .qtext { flex: 1; }
  .q .marks { margin-left: 12px; }
  .passage { margin: 6px 0 0 26px; text-align: justify; }
  .fig { margin: 8px 0 8px 26px; }
  .fig img { max-width: 100%; height: auto; }
  .fig-sub { margin-left: 46px; }
  .part { display: flex; gap: 6px; margin-left: 0; }
  .part-label { width: 24px; flex-shrink: 0; }
  .opt { display: flex; gap: 6px; margin-left: 46px; }
  .opt-sub { margin-left: 72px; }
  .opt-label { width: 22px; flex-shrink: 0; }
  .match { display: flex; gap: 20px; margin: 6px 0 4px 26px; }
  .match-col { flex: 1; }
  .match-item { display: flex; gap: 6px; }
  .choice { margin-left: 24px; }
  .or { margin: 2px 0 2px 48px; font-style: italic; }
  ${border}
  ${foot}`;
}

/** Fixed-position footer text (SchoolTemplate `footer.text`), print-repeating. */
function footerHtml(model) {
  const t = model.schoolTemplate?.footer?.text;
  return t ? `<div class="page-foot">${escapeHtml(String(t))}</div>` : '';
}

export function buildPaperHtml({ questions, blueprint, settings, subject, format }) {
  const model = buildPaperModel({ questions, blueprint, settings, subject, format });
  const title = String(subject || DEFAULT_SUBJECT).toUpperCase();

  const body =
    model.sections
      .map((sec) => {
        const qs = sec.questions.map(paperQuestionHtml).join('');
        return `<div class="section-title">${escapeHtml(sec.label)}</div>${qs}`;
      })
      .join('')
    + (model.unsectionedQuestions || []).map(paperQuestionHtml).join('');

  const gi = `
    <div class="gi-title">${escapeHtml(model.instructionsHeading || 'General Instructions :')}</div>
    ${model.instructions.map((inst, i) => `<div class="gi"><span class="gi-num">${i + 1}.</span><span>${escapeHtml(inst)}</span></div>`).join('')}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} - Question Paper</title>
<style>${baseCss(model)}</style>
</head>
<body>
<div class="page-frame"></div>
${footerHtml(model)}
${headerHtml(model)}
${studentInfoHtml(model)}
${gi}
${body}
</body>
</html>`;
}

/* ── Answer key (answers + marking scheme, SAME model) ───────────────────── */

function markingHtml(scheme) {
  if (!Array.isArray(scheme) || scheme.length === 0) return '';
  const rows = scheme
    .map((s) => {
      const m = Number(s?.marks);
      const marks = Number.isFinite(m) && m > 0 ? ` <span class="ms-marks">(${m})</span>` : '';
      return `<li>${escapeHtml(String(s?.point ?? ''))}${marks}</li>`;
    })
    .join('');
  return `<ul class="ms">${rows}</ul>`;
}

function answerBlock(label, answer, rationale, scheme, keyMarks) {
  const lab = label ? `<span class="ak-label">${escapeHtml(label)}</span>` : '';
  const km = Number(keyMarks);
  const marks = Number.isFinite(km) && km > 0 ? ` <span class="ak-marks">[${km} mark${km === 1 ? '' : 's'}]</span>` : '';
  const ans = `<span class="ak-ans"><b>Answer:</b> ${escapeHtml(String(answer ?? '')) || '<i>— not provided —</i>'}${marks}</span>`;
  const why = rationale ? `<div class="ak-why">${escapeHtml(String(rationale))}</div>` : '';
  return `<div class="ak-item">${lab}<div class="ak-body">${ans}${why}${markingHtml(scheme)}</div></div>`;
}

function answerKeyQuestionHtml(q) {
  const head = `<div class="ak-q"><span class="num">${escapeHtml(q.label || q.numberText || '')}</span><span class="ak-stem">${escapeHtml(q.text || '')}</span></div>`;
  // Figures shown on the key too, so the teacher can mark against the diagram.
  const figures = figuresHtml(q.images);
  // MATCH — the whole-question pairing key: "a → 2" per row.
  let matchHtml = '';
  if (Array.isArray(q.answerPairs) && q.answerPairs.length > 0) {
    matchHtml = `<div class="ak-pairs">${q.answerPairs
      .map((p) => `<div class="ak-pair"><span class="ak-pair-left">${escapeHtml(p.left)}</span><span class="ak-pair-arrow">→</span><span>${escapeHtml(p.right)}</span></div>`)
      .join('')}</div>`;
  }
  let body;
  if (Array.isArray(q.subParts) && q.subParts.length > 0) {
    body = q.subParts.map((sp) => answerBlock(sp.label, sp.answer, sp.rationale, sp.markingScheme, sp.keyMarks)).join('');
  } else {
    body = answerBlock('', q.answer, q.rationale, q.markingScheme, q.keyMarks);
  }
  // INTERNAL_CHOICE — BOTH OR branches keep their own answer (never one).
  let choicesHtml = '';
  if (Array.isArray(q.choices) && q.choices.length > 0) {
    choicesHtml = q.choices
      .map((c) => `<div class="ak-choice"><div class="ak-choice-head">${escapeHtml(c.label || '')}. ${escapeHtml(c.text || '')}</div>${answerBlock('', c.answer, c.rationale, null, null)}</div>`)
      .join(`<div class="or">OR</div>`);
  }
  return head + figures + body + matchHtml + choicesHtml;
}

export function buildAnswerKeyHtml({ questions, blueprint, settings, subject, format }) {
  const model = buildPaperModel({ questions, blueprint, settings, subject, format });
  const title = String(subject || DEFAULT_SUBJECT).toUpperCase();
  const all = [
    ...model.sections.flatMap((sec) => [{ __section: sec.label }, ...sec.questions]),
    ...(model.unsectionedQuestions || []),
  ];
  const body = all
    .map((q) => (q.__section ? `<div class="section-title">${escapeHtml(q.__section)}</div>` : answerKeyQuestionHtml(q)))
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} - Answer Key</title>
<style>${baseCss(model)}
  .doc-title { text-align: center; font-weight: 700; letter-spacing: 1px; margin-top: 10px; }
  .ak-q { display: flex; align-items: flex-start; gap: 8px; margin-top: 16px; font-weight: 700; }
  .ak-q .num { width: 34px; flex-shrink: 0; }
  .ak-item { display: flex; gap: 8px; margin: 4px 0 4px 34px; }
  .ak-label { width: 20px; flex-shrink: 0; }
  .ak-why { color: #444; font-style: italic; font-size: 11pt; }
  .ms { margin: 2px 0 2px 14px; padding-left: 16px; font-size: 11pt; }
  .ms-marks { color: #555; }
  .ak-marks { color: #555; font-weight: 400; font-size: 10.5pt; }
  .ak-pairs { margin: 4px 0 4px 34px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 24px; }
  .ak-pair { display: flex; gap: 6px; }
  .ak-pair-left { min-width: 40px; }
  .ak-pair-arrow { color: #555; }
  .ak-choice { margin: 6px 0 2px 34px; }
  .ak-choice-head { font-weight: 400; }
  .ak-choice .ak-item { margin-left: 0; }
</style>
</head>
<body>
<div class="page-frame"></div>
${footerHtml(model)}
${headerHtml(model)}
<div class="doc-title">ANSWER KEY</div>
${body}
</body>
</html>`;
}

export default { buildPaperHtml, buildAnswerKeyHtml, escapeHtml };
