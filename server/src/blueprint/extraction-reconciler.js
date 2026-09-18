/**
 * extraction-reconciler.js
 *
 * PHASE 1 — EXTRACTION RECONCILIATION (deterministic, zero LLM).
 *
 * Sits between question extraction / blueprint extraction and the canonical
 * Reference Paper Specification. It compares every deterministic fact the
 * pipeline recovered (declared item counts, observed items, per-item marks,
 * totals, numbering, options, choice structures, OCR provenance) and emits
 * STRUCTURED, slot-linked diagnostics instead of flat strings. It never
 * invents information: missing facts stay null and are diagnosed.
 *
 * Core semantics (never mixed):
 *   itemCount / marks.itemCount  = DECLARED count printed in the paper
 *                                  (e.g. "1 x 7 = 7" → 7)
 *   subQuestionCount             = OBSERVED count actually recovered
 *   items[]                      = observed items (`recovered: true`) plus,
 *                                  when declared > observed, placeholder slots
 *                                  (`recovered: false`, `referenceText: null`)
 *                                  so the locked structure is preserved
 *                                  without fabricating content.
 *
 * Input  : extractBlueprint() output (+ optional extraction context)
 * Output : { blueprint (same shape + additive fields), diagnostics }
 *          additive fields: diagnostics, extractionMeta, confidence.
 *          The existing blueprintWarnings contract is untouched.
 */

import { parseMarksExpression } from './blueprint-normalizer.js';
import { countMeaningfulChars } from '../document/ocr.js';

/** Canonical diagnostic codes (single source of truth). */
export const DIAGNOSTIC_CODES = Object.freeze([
  'DECLARED_ITEMS_MISMATCH',
  'RECOVERED_ITEMS_EXCEED_DECLARED',
  'ITEM_MARKS_SUM_MISMATCH',
  'PER_ITEM_MARKS_PARTIAL',
  'MARKS_UNKNOWN',
  'TYPE_UNKNOWN',
  'OPTION_COUNT_INCONSISTENT',
  'OPTIONAL_RULE_UNVERIFIABLE',
  'NUMBERING_GAP',
  'DUPLICATE_QUESTION_NUMBER',
  'SECTION_TOTAL_MISMATCH',
  'PAPER_MARKS_TOTAL_MISMATCH',
  'SECTION_LABEL_AMBIGUOUS',
  'CHOICE_STRUCTURE_MISMATCH',
  'OCR_SOURCE',
  'OCR_LOW_TEXT_PAGE',
  'NO_QUESTIONS_EXTRACTED',
]);

/** Severity levels for extraction diagnostics. */
export const SEVERITY = Object.freeze({ ERROR: 'error', WARN: 'warn', INFO: 'info' });

/**
 * Build one structured diagnostic. Only fields that make sense for the code
 * are set — scope/slot/item linkage is included when applicable.
 * @param {Object} d
 * @returns {Object} { scope, slotIndex?, itemIndex?, section?, field, code, severity, message, ...values }
 */
export function makeDiagnostic({ scope = 'paper', slotIndex = null, itemIndex = null, section = null, field = null, code, severity = SEVERITY.WARN, message, ...values }) {
  const diag = { scope, field, code, severity, message };
  if (slotIndex != null) diag.slotIndex = slotIndex;
  if (itemIndex != null) diag.itemIndex = itemIndex;
  if (section != null) diag.section = section;
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined) diag[k] = v;
  }
  return diag;
}

/** Low-text threshold per page (same threshold the OCR fallback uses). */
const LOW_TEXT_PAGE_CHARS = 60;

/** Page whose recovered text carries almost no meaningful characters. */
function isLowTextPage(page) {
  return countMeaningfulChars(String(page?.text || '')) < LOW_TEXT_PAGE_CHARS;
}

/**
 * Re-parse the DECLARED item count from a slot's stored marks expression
 * ("1X7=7" → 7; "5" → 1; "4+1" → 1). Returns null when no expression exists.
 */
function declaredItemCountFromExpression(expression) {
  if (!expression) return null;
  const parsed = parseMarksExpression(String(expression));
  return parsed ? parsed.itemCount : null;
}

/**
 * Reconcile one question slot: declared vs observed items, per-item marks,
 * option consistency, optional rules, choice structure.
 * @returns {{ items: Array, diagnostics: Array<Object> }}
 */
function reconcileSlot(q, slotIndex) {
  const diagnostics = [];
  const observedItems = Array.isArray(q.items) ? q.items : [];
  const observed = Number.isFinite(Number(q.subQuestionCount)) ? Number(q.subQuestionCount) : observedItems.length;
  const declared = declaredItemCountFromExpression(q.markExpression ?? q.marks?.expression);
  const hasOptionalRule = Boolean(q.optionalRule?.n);

  // ── Declared vs observed ────────────────────────────────────────────────
  // Padding only happens on PARTIAL recovery (observed > 0): with zero
  // observed decomposition there is no per-item data to anchor placeholders
  // to, and the slot's itemCount already carries the declared structure.
  let items = observedItems.map((it) => ({ ...it, recovered: it?.recovered !== false }));
  if (declared != null && observed > 0 && declared !== observed) {
    if (declared > observed) {
      for (let i = observed; i < declared; i++) {
        items.push({
          label: String.fromCharCode(97 + i),
          sourceLabel: null,
          referenceText: null, // NEVER fabricate reference content
          type: null,          // unknown — the placeholder carries no per-item form
          marks: null,
          optionCount: null,
          recovered: false,
        });
      }
      diagnostics.push(makeDiagnostic({
        scope: 'slot',
        slotIndex,
        field: 'itemCount',
        code: 'DECLARED_ITEMS_MISMATCH',
        severity: SEVERITY.WARN,
        message: `Declared ${declared} items but recovered ${observed}. The ${declared - observed} unrecovered slot(s) are placeholders (recovered: false) — generation fills them, analysis never invents their content.`,
        declared,
        observed,
      }));
    } else if (!hasOptionalRule) {
      // observed > declared with no "any N" rule: over-recovery (glued lines,
      // numbering misreads). The declared count drives the locked structure;
      // the extra recovered items are kept (never destroyed) and diagnosed.
      diagnostics.push(makeDiagnostic({
        scope: 'slot',
        slotIndex,
        field: 'itemCount',
        code: 'RECOVERED_ITEMS_EXCEED_DECLARED',
        severity: SEVERITY.WARN,
        message: `Recovered ${observed} items but the paper declares ${declared}. Extra recovered items are kept but the declared count drives the structure.`,
        declared,
        observed,
      }));
    }
  }

  // ── Per-item marks vs the slot total ────────────────────────────────────
  const knownMarks = items.filter((it) => Number.isFinite(Number(it.marks)) && Number(it.marks) > 0).map((it) => Number(it.marks));
  // NOTE: Number(null) === 0 — a missing total must stay null, never 0.
  const rawTotal = q.totalMarks ?? q.marks?.total ?? null;
  const total = rawTotal != null && Number.isFinite(Number(rawTotal)) && Number(rawTotal) > 0 ? Number(rawTotal) : null;
  if (items.length > 0 && knownMarks.length === items.length && total != null) {
    const sum = knownMarks.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - total) > 1e-6) {
      diagnostics.push(makeDiagnostic({
        scope: 'slot',
        slotIndex,
        field: 'itemMarks',
        code: 'ITEM_MARKS_SUM_MISMATCH',
        severity: SEVERITY.WARN,
        message: `Per-item marks sum to ${sum} but the question total is ${total}.`,
        sum,
        total,
      }));
    }
  } else if (items.length > 0 && knownMarks.length > 0 && knownMarks.length < items.length) {
    diagnostics.push(makeDiagnostic({
      scope: 'slot',
      slotIndex,
      field: 'itemMarks',
      code: 'PER_ITEM_MARKS_PARTIAL',
      severity: SEVERITY.WARN,
      message: `Per-item marks recovered for only ${knownMarks.length} of ${items.length} item(s) — the rest stay unknown.`,
      recoveredCount: knownMarks.length,
      itemCount: items.length,
    }));
  }

  // ── Unknown marks / type ────────────────────────────────────────────────
  if (total == null) {
    diagnostics.push(makeDiagnostic({
      scope: 'slot',
      slotIndex,
      field: 'totalMarks',
      code: 'MARKS_UNKNOWN',
      severity: SEVERITY.WARN,
      message: 'Marks could not be detected for this question — left unknown, never invented.',
    }));
  }
  if (q.type === 'UNKNOWN') {
    diagnostics.push(makeDiagnostic({
      scope: 'slot',
      slotIndex,
      field: 'type',
      code: 'TYPE_UNKNOWN',
      severity: SEVERITY.WARN,
      message: 'Question type could not be confidently detected — preserved as UNKNOWN.',
    }));
  }

  // ── Option-count consistency (MCQ) ─────────────────────────────────────
  const optionCounts = Array.isArray(q.pattern?.optionCounts) ? q.pattern.optionCounts : [];
  // Only a fully-optioned MCQ slot can be "inconsistent" — mixed slots
  // (option-less blank items beside MCQ items) are a legitimate construction.
  if (q.type === 'MCQ' && optionCounts.length > 1 && optionCounts.every((n) => Number(n) >= 2)) {
    const distinct = [...new Set(optionCounts)];
    if (distinct.length > 1) {
      diagnostics.push(makeDiagnostic({
        scope: 'slot',
        slotIndex,
        field: 'pattern.optionCounts',
        code: 'OPTION_COUNT_INCONSISTENT',
        severity: SEVERITY.WARN,
        message: `MCQ items carry inconsistent option counts [${distinct.join(', ')}] — the reference paper itself is inconsistent.`,
        optionCounts,
      }));
    }
  }

  // ── Optional rule satisfiability ────────────────────────────────────────
  if (hasOptionalRule && declared != null && q.optionalRule.n > declared) {
    diagnostics.push(makeDiagnostic({
      scope: 'slot',
      slotIndex,
      field: 'optionalRule',
      code: 'OPTIONAL_RULE_UNVERIFIABLE',
      severity: SEVERITY.WARN,
      message: `Optional rule "any ${q.optionalRule.n}" cannot be satisfied by the declared item count (${declared}).`,
      anyN: q.optionalRule.n,
      declared,
    }));
  }

  // ── Choice structure ────────────────────────────────────────────────────
  if (q.type === 'INTERNAL_CHOICE') {
    const choiceCount = Number.isFinite(Number(q.optionCount)) ? Number(q.optionCount) : 0;
    if (choiceCount < 2) {
      diagnostics.push(makeDiagnostic({
        scope: 'slot',
        slotIndex,
        field: 'choices',
        code: 'CHOICE_STRUCTURE_MISMATCH',
        severity: SEVERITY.WARN,
        message: 'INTERNAL_CHOICE slot without a recovered choice pair — the alternatives were not recoverable from extraction.',
        choiceCount,
      }));
    }
  }

  return { items, diagnostics };
}

/**
 * Detect printed section-total claims ("SECTION A - READING (10 Marks)") and
 * conflicting duplicate section labels from the raw paper text.
 * @returns {{ totals: Map<string, number>, ambiguous: Array<Object> }}
 */
function scanSectionClaims(text) {
  const totals = new Map();
  const ambiguous = [];
  if (!text || typeof text !== 'string') return { totals, ambiguous };
  const re = /^(?:SECTION|Section|PART|Part)\s+([A-Za-z0-9]+)([^\n]*)$/gm;
  const titlesByKey = new Map();
  let m;
  while ((m = re.exec(text))) {
    const key = String(m[1]).toUpperCase();
    const rest = String(m[2] || '');
    const totalMatch = rest.match(/(\d{1,3})\s*marks?/i);
    if (totalMatch && !totals.has(key)) totals.set(key, Number(totalMatch[1]));
    const title = rest.replace(/\(?\d{1,3}\s*marks?\)?/ig, '').replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').trim();
    if (title) {
      if (!titlesByKey.has(key)) titlesByKey.set(key, new Set());
      titlesByKey.get(key).add(title);
    }
  }
  for (const [key, titles] of titlesByKey) {
    if (titles.size > 1) {
      ambiguous.push(makeDiagnostic({
        scope: 'paper',
        section: key,
        field: 'sections',
        code: 'SECTION_LABEL_AMBIGUOUS',
        severity: SEVERITY.WARN,
        message: `Section label ${key} appears with conflicting titles [${[...titles].join(' | ')}] — section identity is ambiguous.`,
        titles: [...titles],
      }));
    }
  }
  return { totals, ambiguous };
}

/**
 * Build the deterministic extraction-metadata block from the parse context.
 * Only information actually provided by the PDF/OCR layer is exposed — no
 * invented confidence numbers.
 */
export function buildExtractionMeta(context = {}) {
  const ocr = context.ocr && typeof context.ocr === 'object' ? context.ocr : null;
  return {
    extractionMethod: context.extractionMethod ?? null,
    extractionStatus: context.extractionStatus ?? null,
    pageCount: context.pageCount ?? (Array.isArray(context.pages) ? context.pages.length : null),
    characterCount: Number.isFinite(Number(context.characterCount)) ? Number(context.characterCount) : null,
    ocrUsed: context.extractionMethod === 'ocr' || Boolean(ocr),
    ocrPages: ocr ? (ocr.pages ?? null) : null,
    ocrPagesSucceeded: ocr ? (ocr.pagesSucceeded ?? null) : null,
    ocrPagesErrored: ocr ? (ocr.pagesErrored ?? null) : null,
  };
}

/**
 * Deterministic extraction confidence — derived ONLY from diagnostic counts
 * and known-field coverage. No invented numeric score: the basis is exposed
 * so the level is always explainable.
 */
export function deriveConfidence(blueprint, diagnostics, extractionMeta) {
  const questions = Array.isArray(blueprint?.questions) ? blueprint.questions : [];
  const counts = { error: 0, warn: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity] = (counts[d.severity] ?? 0) + 1;
  const basis = {
    questionCount: questions.length,
    slotsWithKnownMarks: questions.filter((q) => Number.isFinite(Number(q.totalMarks)) && Number(q.totalMarks) > 0).length,
    slotsWithKnownType: questions.filter((q) => q.type && q.type !== 'UNKNOWN').length,
    marksComplete: blueprint?.marksComplete === true,
    errorCount: counts.error,
    warnCount: counts.warn,
    infoCount: counts.info,
    ocrUsed: Boolean(extractionMeta?.ocrUsed),
  };
  const level =
    basis.questionCount === 0 || basis.errorCount > 0 ? 'low'
      : (basis.warnCount > 0 || basis.ocrUsed || !basis.marksComplete) ? 'medium'
        : 'high';
  return { level, basis };
}

/**
 * Reconcile a freshly extracted blueprint against its own deterministic facts.
 * Pure: never mutates the input; returns a new blueprint carrying the additive
 * `diagnostics` / `extractionMeta` / `confidence` fields plus padded items.
 *
 * @param {Object} blueprint - extractBlueprint() output
 * @param {Object} [context] - extraction context { text, pages, extractionMethod,
 *                             extractionStatus, pageCount, characterCount, ocr }
 * @returns {{ blueprint: Object, diagnostics: Array<Object> }}
 */
export function reconcileBlueprint(blueprint, context = {}) {
  const source = blueprint && typeof blueprint === 'object' ? blueprint : {};
  const questionsIn = Array.isArray(source.questions) ? source.questions : [];
  const diagnostics = [];

  const questions = questionsIn.map((q, slotIndex) => {
    const { items, diagnostics: slotDiags } = reconcileSlot(q, slotIndex);
    diagnostics.push(...slotDiags);
    return { ...q, items };
  });

  // ── Paper-level reconciliation ──────────────────────────────────────────
  if (questions.length === 0) {
    diagnostics.push(makeDiagnostic({
      scope: 'paper',
      field: 'questions',
      code: 'NO_QUESTIONS_EXTRACTED',
      severity: SEVERITY.ERROR,
      message: 'No questions could be extracted from the reference paper — the structure is unusable for generation.',
    }));
  }

  // Numbering: gaps and duplicates over the numeric question labels.
  const numerics = questions
    .map((q) => Number(q.number))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const gaps = [];
  const duplicates = [];
  for (let i = 1; i < numerics.length; i++) {
    const delta = numerics[i] - numerics[i - 1];
    if (delta === 0) duplicates.push(numerics[i]);
    else if (delta > 1) gaps.push(`${numerics[i - 1]} → ${numerics[i]}`);
  }
  if (gaps.length > 0) {
    diagnostics.push(makeDiagnostic({
      scope: 'paper',
      field: 'numbering',
      code: 'NUMBERING_GAP',
      severity: SEVERITY.WARN,
      message: `Question numbering skips: ${gaps.join(', ')}. The gap is preserved, never renumbered.`,
      gaps,
    }));
  }
  if (duplicates.length > 0) {
    diagnostics.push(makeDiagnostic({
      scope: 'paper',
      field: 'numbering',
      code: 'DUPLICATE_QUESTION_NUMBER',
      severity: SEVERITY.WARN,
      message: `Duplicate question number(s) detected: ${[...new Set(duplicates)].join(', ')}.`,
      duplicates: [...new Set(duplicates)],
    }));
  }

  // Paper total vs the sum of question totals (when everything is known).
  // NOTE: Number(null) === 0 — null totals must NOT count as known.
  const allTotalsKnown = questions.length > 0 && questions.every((q) => q.totalMarks != null && Number.isFinite(Number(q.totalMarks)));
  if (allTotalsKnown && Number.isFinite(Number(source.paper?.maximumMarks))) {
    const sum = questions.reduce((acc, q) => acc + Number(q.totalMarks), 0);
    if (sum !== Number(source.paper.maximumMarks)) {
      diagnostics.push(makeDiagnostic({
        scope: 'paper',
        field: 'totalMarks',
        code: 'PAPER_MARKS_TOTAL_MISMATCH',
        severity: SEVERITY.WARN,
        message: `Header declares ${source.paper.maximumMarks} maximum marks but the question totals sum to ${sum}.`,
        declared: Number(source.paper.maximumMarks),
        computed: sum,
      }));
    }
  }

  // Section-total claims and ambiguous section labels from the raw text.
  const { totals: sectionClaims, ambiguous } = scanSectionClaims(context.text);
  diagnostics.push(...ambiguous);
  if (sectionClaims.size > 0 && Array.isArray(source.sections)) {
    // Raw extracted slots carry the bare section key ("A") while sections[].name
    // is "SECTION A" — compare on the stripped key on both sides.
    const sectionKey = (v) => String(v ?? '').replace(/^SECTION\s+/i, '').trim().toUpperCase();
    for (const section of source.sections) {
      const key = sectionKey(section.name);
      const claim = sectionClaims.get(key);
      if (claim == null) continue;
      const slotTotals = questions.filter((q) => sectionKey(q.sectionName) === key || sectionKey(q.section) === key);
      if (slotTotals.length === 0 || !slotTotals.every((q) => q.totalMarks != null && Number.isFinite(Number(q.totalMarks)))) continue;
      const sum = slotTotals.reduce((acc, q) => acc + Number(q.totalMarks), 0);
      if (sum !== claim) {
        diagnostics.push(makeDiagnostic({
          scope: 'section',
          section: key,
          field: 'sectionTotal',
          code: 'SECTION_TOTAL_MISMATCH',
          severity: SEVERITY.WARN,
          message: `Section ${key} claims ${claim} marks but its question totals sum to ${sum}.`,
          declared: claim,
          computed: sum,
        }));
      }
    }
  }

  // ── OCR provenance ──────────────────────────────────────────────────────
  const extractionMeta = buildExtractionMeta(context);
  if (extractionMeta.ocrUsed) {
    diagnostics.push(makeDiagnostic({
      scope: 'paper',
      field: 'extraction',
      code: 'OCR_SOURCE',
      severity: SEVERITY.INFO,
      message: `${extractionMeta.ocrPages ?? '?'} page(s) were recovered via OCR — text provenance is optical, not embedded.`,
      ocrPages: extractionMeta.ocrPages,
    }));
  }
  if (Array.isArray(context.pages)) {
    context.pages.forEach((page, idx) => {
      if (isLowTextPage(page)) {
        diagnostics.push(makeDiagnostic({
          scope: 'paper',
          itemIndex: page?.pageNumber ?? idx + 1,
          field: 'extraction',
          code: 'OCR_LOW_TEXT_PAGE',
          severity: extractionMeta.extractionMethod === 'ocr' ? SEVERITY.INFO : SEVERITY.WARN,
          message: `Page ${page?.pageNumber ?? idx + 1} carries almost no recoverable text (< ${LOW_TEXT_PAGE_CHARS} meaningful characters).`,
        }));
      }
    });
  }

  const reconciled = {
    ...source,
    questions,
    diagnostics,
    extractionMeta,
    confidence: deriveConfidence(source, diagnostics, extractionMeta),
  };
  return { blueprint: reconciled, diagnostics };
}

export default { DIAGNOSTIC_CODES, SEVERITY, makeDiagnostic, reconcileBlueprint, buildExtractionMeta, deriveConfidence };
