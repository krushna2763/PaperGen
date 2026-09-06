/**
 * Paper document-model builders.
 *
 * buildPaperModel turns the structured generated questions + the LOCKED
 * blueprint (when present) + teacher settings + paper FORMAT (template) into
 * ONE document model that the on-screen preview, the pdfmake PDF and the
 * print view all render identically.
 *
 * STRUCTURE SOURCE OF TRUTH:
 *   - With a blueprint → the blueprint is AUTHORITATIVE: its `sections`
 *     (existence, order, titles) and its `questions` order (numbering,
 *     placement) decide the layout. Questions are attached to blueprint slots
 *     by slotIndex — never regrouped by question type, marks or difficulty.
 *     When blueprint.sections is empty the paper is ONE FLAT LIST with NO
 *     section headings, regardless of how many question types it mixes.
 *   - Without a blueprint (degenerate free-form fallback) → a flat numbered
 *     list in the given order. Section headings are never invented.
 *
 * The template (`format`) controls ONLY visual styling (header block, marks
 * column, indentation, fonts); it can never add, remove, reorder or rename
 * blueprint sections.
 */

import {
  classLabel,
  marksLabel,
  cleanOptionText,
  applyMarksCase,
} from './paperTemplate.js';

/** Preferred order only used as a last-resort tiebreak (never to create sections). */
const TYPE_ORDER = ['MCQ', 'SHORT_ANSWER', 'LONG_ANSWER', 'TRUE_FALSE', 'FILL_IN_THE_BLANK'];

/** Normalize a raw type value into the internal set. */
function normType(t) {
  const v = String(t || 'SHORT_ANSWER').trim().toUpperCase().replace(/\s+/g, '_');
  if (TYPE_ORDER.includes(v)) return v;
  if (v === 'FILL_IN_THE_BLANKS') return 'FILL_IN_THE_BLANK';
  if (v === 'TRUE_OR_FALSE') return 'TRUE_FALSE';
  return 'SHORT_ANSWER';
}

const ALPHA = 'abcdefghijklmnopqrstuvwxyz'.split('');
const ROMAN_UC = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/** "Q1"/"Q.3"/"1"/"7" → plain display number text like "1.". */
function displayNumberFromLabel(label, index) {
  const m = String(label ?? '').match(/(\d+)/);
  const n = m ? Number(m[1]) : null;
  return (Number.isFinite(n) && n > 0 ? n : index + 1) + '.';
}

/** Sub-part letter label: explicit label wins, else a., b., c. … */
function partLabel(sp, i) {
  const explicit = String(sp?.label ?? '').trim();
  if (explicit) return explicit;
  return `${ALPHA[i] ?? i + 1}.`;
}

/** Choice branch label: A., B., C. … (explicit label wins). */
function choiceLabel(c, i) {
  const explicit = String(c?.label ?? '').trim();
  if (explicit) return explicit;
  return `${ROMAN_UC[i] ?? i + 1}.`;
}

/** Numeric value of a question's marks when finite and positive. */
function numericMarks(q) {
  return Number.isFinite(q?.marks) && q.marks > 0 ? q.marks : null;
}

/**
 * Build the full paper model.
 *
 * @param {Object} args - {
 *   questions: generated/accepted question objects,
 *   blueprint: LOCKED blueprint or null (never null in the normal flow),
 *   settings: { class, difficulty },
 *   subject, format: paper template }
 * @returns {Object} { header, instructions, sections, unsectionedQuestions,
 *   questionCount, totalMarks, blueprintMode, layoutWarnings }
 */
export function buildPaperModel({ questions = [], blueprint = null, settings = {}, subject = '', format = {} }) {
  const warnings = [];
  const docClass = String(settings.class ?? '');
  const titleLines = [];

  if (format.schoolName && String(format.schoolName).trim()) {
    titleLines.push({ text: String(format.schoolName).trim(), bold: true });
  }
  const exam = [String(format.examTitle || 'Examination').trim(), String(format.session || '').trim()].filter(Boolean).join(' ');
  if (exam) titleLines.push({ text: exam, bold: true });
  if (subject) titleLines.push({ text: `SUBJECT - ${String(subject).toUpperCase()}`, bold: true });
  titleLines.push({ text: `CLASS - ${classLabel(docClass) || ''}`.replace(/  +/g, ' ').trim(), bold: true });

  const timeAllowed = String(format.timeAllowed || '').trim();
  const maximumMarks = String(format.maximumMarks ?? '').trim() === ''
    ? ''
    : String(format.maximumMarks).trim();

  const instructions = Array.isArray(format.instructions)
    ? format.instructions.map((i) => String(i || '').trim()).filter(Boolean)
    : [];

  const bpQuestions = blueprint && Array.isArray(blueprint.questions) && blueprint.questions.length > 0
    ? blueprint.questions
    : null;
  const bpSections = bpQuestions && Array.isArray(blueprint.sections) ? blueprint.sections : null;
  const blueprintMode = !!bpQuestions;

  const given = Array.isArray(questions) ? questions : [];

  // ── Content model for a single question entry ─────────────────────────────
  const buildEntry = (raw, number, numberText, key) => {
    const type = normType(raw.type);
    let text = String(raw.text || '').trim();
    let options = Array.isArray(raw.options) && raw.options.length > 0
      ? raw.options.map((o, i) => cleanOptionText(o, i)).filter(Boolean)
      : [];

    // MCQs sometimes arrive with options glued into the stem ("… A) x B) y …").
    // Only split when NO structured options exist — never re-derive from text
    // when structured data is already present.
    if (type === 'MCQ' && options.length === 0 && /(?:^|\s)\(?([A-Da-d])\)?[.)]\s/.test(text)) {
      const parts = text.split(/\s+(?:\(?[A-Da-d]\)?[.)])\s+(?=\S)/);
      if (parts.length >= 3) {
        options = parts.slice(1).map((o, i) => cleanOptionText(o, i)).filter(Boolean);
        text = parts[0].trim();
      }
    }

    let subParts = Array.isArray(raw.subParts) && raw.subParts.length > 0
      ? raw.subParts
          .map((sp, i) => ({
            label: partLabel(sp, i),
            text: String(sp?.text ?? '').trim(),
            options: Array.isArray(sp?.options) && sp.options.length > 0
              ? sp.options.map((o, j) => cleanOptionText(o, j)).filter(Boolean)
              : [],
            marks: (() => {
              const m = Number(sp?.marks);
              return Number.isFinite(m) && m > 0 ? m : null;
            })(),
          }))
          .filter((sp) => sp.text)
      : [];
    // MIXED per-part marks (reference Q4 style: 1,2,2,2,3): render each part's
    // own "(N)" annotation the way the reference paper does. Uniform per-part
    // marks stay unannotated (the question line already shows the PxN=M).
    if (subParts.length > 1 && subParts.every((sp) => sp.marks != null)) {
      const distinct = new Set(subParts.map((sp) => sp.marks));
      if (distinct.size > 1) {
        subParts = subParts.map((sp) => ({ ...sp, text: `${sp.text} (${sp.marks})` }));
      }
    }

    // Structured MATCH columns / INTERNAL_CHOICE branches — kept structured,
    // never flattened into a paragraph.
    let columns = null;
    if (raw?.columns && Array.isArray(raw.columns.left) && Array.isArray(raw.columns.right)) {
      const left = raw.columns.left.map((c) => String(c || '').trim()).filter(Boolean);
      const right = raw.columns.right.map((c) => String(c || '').trim()).filter(Boolean);
      if (left.length > 0 && right.length > 0) columns = { left, right };
    }
    const choices = Array.isArray(raw?.choices) && raw.choices.length > 0
      ? raw.choices
          .map((c, i) => {
            const parts = Array.isArray(c?.subParts) && c.subParts.length > 0
              ? c.subParts.map((sp, j) => ({ label: partLabel(sp, j), text: String(sp?.text ?? '').trim() })).filter((p) => p.text)
              : [];
            return { label: choiceLabel(c, i), text: String(c?.text ?? '').trim(), subParts: parts };
          })
          .filter((c) => c.text || c.subParts.length > 0)
      : [];

    return {
      key: key || raw.questionId || `${type}-${number}`,
      type,
      text,
      passage: raw.passage ? String(raw.passage) : '',
      marks: numericMarks(raw),
      marksText: applyMarksCase(marksLabel(raw), format.marksCase),
      difficulty: raw.difficulty,
      options, // pure option text; labels generated at render time
      subParts,
      columns,
      choices,
      number,
      numberText,
    };
  };

  let sections = [];
  let unsectionedQuestions = [];
  let questionCount = 0;
  let assigned = new Set();
  let missingSlots = new Set(); // slots with no generated question (warned once)

  if (blueprintMode) {
    // ── Attach generated questions to blueprint slots by slotIndex ─────────
    const bySlot = new Map();
    let fallbackIdx = 0;
    for (const q of given) {
      let slot = q?.slotIndex;
      if (!Number.isInteger(slot)) {
        // No slot metadata (defensive): sequential fallback. This never happens
        // in blueprint mode from the orchestrator; it only guards degenerate data.
        while (bySlot.has(fallbackIdx)) fallbackIdx++;
        slot = fallbackIdx;
      }
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push(q);
    }

    // Slot number derives from the blueprint question's own number/label, so
    // unusual numbering (1, 2, 3(a)…) is preserved and never recomputed from
    // array positions.
    const slotOf = new Map(bpQuestions.map((bpq, i) => [String(bpq?.label ?? `Q${i + 1}`), i]));

    const buildFromSlot = (slotIdx) => {
      const bpq = bpQuestions[slotIdx];
      if (!bpq) return null;
      const raw = (bySlot.get(slotIdx) || [])[0];
      if (!raw) {
        // Blueprint slot exists but NO generated question arrived for it: the
        // orchestrator reports it in `rejected`; never silently substitute a
        // different question and never render an empty shell.
        if (!missingSlots.has(slotIdx)) {
          missingSlots.add(slotIdx);
          warnings.push({ section: bpq.sectionName ?? null, missingQuestionNumbers: [bpq.label ?? `Q${slotIdx + 1}`] });
        }
        return null;
      }
      const numberText = displayNumberFromLabel(bpq.label, slotIdx);
      const number = parseInt(numberText, 10) || slotIdx + 1;
      // Marks are authoritative in the blueprint: prefer the generated
      // question's own expression, else the locked slot's expression / total.
      const marksAnnotated = { ...raw };
      if (!(marksAnnotated.markExpression || marksAnnotated.marksExpression)) {
        const bpExpr = bpq.markExpression || bpq.marks?.expression || null;
        if (bpExpr) marksAnnotated.markExpression = bpExpr;
        else if (Number.isFinite(bpq.totalMarks)) marksAnnotated.markExpression = String(bpq.totalMarks);
        else if (Number.isFinite(bpq.marks?.total)) marksAnnotated.markExpression = String(bpq.marks.total);
      }
      const entry = buildEntry(marksAnnotated, number, numberText, `slot-${slotIdx}`);
      assigned.add(slotIdx);
      return entry;
    };

    const hasSections = bpSections && bpSections.length > 0;
    if (hasSections) {
      for (const sec of bpSections) {
        const secQs = [];
        const numbers = Array.isArray(sec?.questionNumbers) ? sec.questionNumbers : [];
        const title = String(sec?.title ?? '').trim();
        const name = String(sec?.name ?? '').trim() || (sec?.letter ? `SECTION ${sec.letter}` : '');
        // Heading shows the blueprint's exact name + captured title (e.g.
        // "SECTION A — Reading"). When only a title was captured the title is
        // the heading; never invent wording.
        const label = title ? (name ? `${name} — ${title}` : title) : name;
        for (const qn of numbers) {
          const slotIdx = slotOf.get(String(qn));
          if (slotIdx == null) continue; // defensive; section numbers come from the same blueprint
          const entry = buildFromSlot(slotIdx);
          if (entry) secQs.push(entry);
        }
        // Skip an entirely-empty section heading (its questions were all
        // rejected); missing slots are already reported in layoutWarnings.
        if (secQs.length > 0) sections.push({ name, title, label, questions: secQs });
      }
    }

    // Every remaining slot that exists in the blueprint (and has a question)
    // flows into the flat unsectioned list in blueprint order — keeping order
    // and numbering, without inventing a section heading for them.
    for (let i = 0; i < bpQuestions.length; i++) {
      if (assigned.has(i)) continue;
      if (!bySlot.has(i)) {
        // No generated question for this slot — reported (never substituted).
        if (!missingSlots.has(i)) {
          missingSlots.add(i);
          warnings.push({ section: bpQuestions[i]?.sectionName ?? null, missingQuestionNumbers: [bpQuestions[i]?.label ?? `Q${i + 1}`] });
        }
        continue;
      }
      const entry = buildFromSlot(i);
      if (entry) unsectionedQuestions.push(entry);
    }

    // Extras: generated questions that match NO blueprint slot must never be
    // auto-placed into a section — blueprint validation rejects them. Render
    // them visibly but separated (never numbered into the blueprint sequence).
    for (const q of given) {
      const isPlaced = [...bySlot.entries()].some(([slotIdx, arr]) => arr.includes(q) && assigned.has(slotIdx));
      if (!isPlaced) {
        warnings.push({ section: null, extraQuestionNumbers: [q.questionId || 'unknown'] });
        unsectionedQuestions.push(buildEntry(q, null, '', q.questionId || 'extra'));
      }
    }
  } else {
    // ── Free-form fallback (no blueprint): ONE FLAT LIST, no invented sections.
    given.forEach((raw, i) => {
      unsectionedQuestions.push(buildEntry(raw, i + 1, `${i + 1}.`, raw.questionId || `q-${i + 1}`));
    });
  }

  questionCount = sections.reduce((n, s) => n + s.questions.length, 0) + unsectionedQuestions.length;
  const totalMarks = (questions || []).reduce((acc, q) => acc + (Number.isFinite(q?.marks) ? q.marks : 0), 0);

  return {
    header: { titleLines, timeAllowed, maximumMarks: maximumMarks || (totalMarks > 0 ? String(totalMarks) : '') },
    instructions,
    // Verbatim heading captured from the reference ("General Instructions :"
    // is only the fallback) — preview, PDF and print all render this exact text.
    instructionsHeading: String(format.instructionsHeading || 'General Instructions :').trim(),
    sections,
    unsectionedQuestions,
    questionCount,
    totalMarks,
    blueprintMode,
    layoutWarnings: warnings,
  };
}

/* ─────────────────────────── Preview pagination ────────────────────────────
 * Roughly mimics the PDF page flow so the on-screen preview looks like the
 * final document: header/instructions occupy page 1, then items flow with the
 * same spacing budgets, and a section heading is never left as the last thing
 * on a page.
 */

const PREVIEW = {
  widthPx: 640,
  padPx: 46, // visual page padding approximating A4 margins (1:1 pt→px scale would be 42…, keep close)
  bodyFontPx: 12,
  bodyLinePx: 20,
  headerLinePx: 14,
  sectionHeadPx: 34,
  blockGapPx: 21,
  marksColPx: 96,
};

function estLines(text, widthPx) {
  if (!text) return 0;
  const perLine = Math.max(20, Math.floor(widthPx / 5.9)); // ~12 px serif char width
  return Math.max(1, Math.ceil(String(text).length / perLine));
}

/** Approximate cost (px) of one model question on the preview page. */
function questionCost(q, textWidth) {
  let cost = estLines(q.text, textWidth) * PREVIEW.bodyLinePx;
  if (q.passage) cost += estLines(q.passage, textWidth) * PREVIEW.bodyLinePx;
  cost += q.options.length * PREVIEW.bodyLinePx;
  for (const sp of q.subParts) {
    cost += estLines(sp.text, textWidth) * PREVIEW.bodyLinePx;
    cost += sp.options.length * PREVIEW.bodyLinePx;
  }
  if (q.columns) {
    const n = Math.max(q.columns.left.length, q.columns.right.length);
    cost += (n + 1) * PREVIEW.bodyLinePx; // header + rows
  }
  for (const c of q.choices) {
    cost += (estLines(c.text, textWidth) + 1 /* OR */) * PREVIEW.bodyLinePx;
    cost += c.subParts.length * PREVIEW.bodyLinePx;
  }
  cost += PREVIEW.blockGapPx;
  return cost;
}

/**
 * Split a built paper model into visual pages.
 * @param {Object} model - result of buildPaperModel
 * @returns {Array<{ header: boolean, items: Array }>} items: { kind, section } | { kind:'q', q }
 */
export function paginatePaper(model, opts = {}) {
  const { headerLinePx = PREVIEW.headerLinePx } = opts;
  const avail = 860 - 2 * PREVIEW.padPx; // usable preview page height
  const textWidth = PREVIEW.widthPx - 2 * PREVIEW.padPx - PREVIEW.marksColPx;

  const pages = [];
  let page = { header: false, items: [] };
  let used = 0;

  const headerCost = () => {
    if (!model) return 0;
    let h = (model.header.titleLines.length || 0) * headerLinePx + 18;
    if (model.header.timeAllowed || model.header.maximumMarks) h += 20;
    h += (model.instructions.length ? model.instructions.length * headerLinePx + 26 : 0) + 40;
    return h;
  };

  const pushPage = () => {
    pages.push(page);
    page = { header: false, items: [] };
    used = 0;
  };
  const ensure = (cost) => {
    if (used + cost > avail && used > 0) pushPage();
  };

  // Page 1 always carries the full header block.
  page.header = true;
  used = headerCost();

  const flowBlock = (items, isSection) => {
    for (const item of items) {
      const cost = isSection ? PREVIEW.sectionHeadPx : questionCost(item, textWidth);
      // A section heading must not be stranded at the bottom of a page.
      ensure(cost);
      page.items.push(isSection ? { kind: 'section', label: item } : { kind: 'q', q: item });
      used += cost;
    }
  };

  for (const sec of model.sections) {
    flowBlock([sec.label], true);
    flowBlock(sec.questions, false);
  }
  flowBlock(model.unsectionedQuestions || [], false);

  if (page.items.length > 0 || pages.length === 0) pages.push(page);
  return pages;
}

export default { buildPaperModel, paginatePaper };
