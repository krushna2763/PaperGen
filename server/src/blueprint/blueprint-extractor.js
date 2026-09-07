/**
 * blueprint-extractor.js
 *
 * UNIVERSAL deterministic conversion of a parsed previous-year paper into a
 * LOCKED blueprint. Input is the already-extracted question array from
 * `question-extractor.js` (plus optional raw text for the paper header), NOT
 * the raw PDF — no LLM calls, no re-parsing of the document.
 *
 * The extractor adapts to the DOCUMENT, never to a subject/class/school:
 *   - papers with or without sections
 *   - any question-numbering style (Q1., 1., 1(a), (i), …)
 *   - any marks style (1x5=5, 2x4=8, 3x3=9, 4+1, bare numbers, or none)
 *   - any question-type mix (MCQ, TRUE_FALSE, MATCH, MAP, DRAWING, PASSAGE,
 *     GRAMMAR, CREATIVE_WRITING, INTERNAL_CHOICE, … or UNKNOWN + warning)
 *
 * When a structural fact cannot be confidently extracted it is left null and
 * surfaced in `blueprintWarnings` — never invented.
 */

import { normalizeBlueprintType } from './blueprint-schema.js';
import { parseMarksExpression, stripMarksExpression, parseOptionalRule } from './blueprint-normalizer.js';
import { detectOptionLabelStyle } from './template-analyzer.js';

// ─── Paper header parsing (from raw text, best-effort) ──────────────────────

const HEADER_PATTERNS = {
  class: /(?:CLASS|CLASS\s*[-:.]?)\s*[-:.]?\s*([IVX]+|\d{1,2})\b/i,
  subject: /(?:SUBJECT|SUBJECT\s*[-:.]?)\s*[-:.]?\s*([A-Za-z][A-Za-z &()-]{2,40})/i,
  duration: /(?:Time(?:\s*Allowed)?|Duration)\s*[-:.]?\s*([0-9]+\s*(?:minutes?|mins?|hours?|hrs?|hr|min)(?:\s*[0-9]+\s*(?:minutes?|mins?|hours?|hrs?|hr|min))?)/i,
  maximumMarks: /(?:Maximum Marks|Max\.?\s*Marks|Total Marks|MM)\s*[-:.]?\s*(\d{1,3})/i,
  session: /\(?\b(?:19|20)\d{2}\s*[-–]\s*\d{2,4}\b\)?/i,
  examTitle: /\b(?:ANNUAL|HALF[- ]?YEARLY|QUARTERLY|FINAL|PRE[- ]?BOARD|BOARD|UNIT|TERM|PERIODIC|SUMMATIVE|FORMATIVE|MODEL|MONTHLY|WEEKLY|SESSIONAL|PRELIMINARY)?\s*(?:EXAMINATION|EXAM\b|TEST|ASSESSMENT)\b/i,
};

const HEADER_FIELD_LINE = /^(?:SUBJECT|CLASS|TIME|MAXIMUM|MAX\.|TOTAL|GENERAL|INSTRUCTIONS?|NOTE|DATE|ROLL|NAME|SECTION|PART)\b/i;

function parsePaperHeader(text) {
  const header = { schoolName: null, examTitle: null, session: null, class: null, subject: null, duration: null, maximumMarks: null };
  if (!text || typeof text !== 'string') return header;

  const mClass = text.match(HEADER_PATTERNS.class);
  if (mClass) header.class = mClass[1].toUpperCase();

  const mSubject = text.match(HEADER_PATTERNS.subject);
  if (mSubject) header.subject = mSubject[1].trim();

  const mDuration = text.match(HEADER_PATTERNS.duration);
  if (mDuration) header.duration = mDuration[1].trim().replace(/\s+/g, ' ');

  const mMarks = text.match(HEADER_PATTERNS.maximumMarks);
  if (mMarks) header.maximumMarks = Number(mMarks[1]);

  // School name / exam title / session come from the leading lines of the paper.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 14)) {
    if (HEADER_FIELD_LINE.test(line)) continue;
    if (/^\d/.test(line)) continue;
    if (HEADER_PATTERNS.examTitle.test(line)) {
      header.examTitle = line;
      if (header.schoolName == null) header.schoolName = line; // no school line before it
      break;
    }
    if (header.schoolName == null && line.length >= 3 && line.length <= 90) {
      header.schoolName = line;
    }
  }
  const mSession = text.match(HEADER_PATTERNS.session);
  if (mSession) header.session = mSession[0].replace(/[()]/g, '');

  return header;
}

// ─── Student (general) instructions — discovered, kept separate ─────────────

function extractStudentInstructions(text) {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  const lines = text.split('\n');
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!inBlock) {
      if (/^(?:General\s*Instructions?|Instructions?|Note)\s*[:.]?\s*$/i.test(line)) inBlock = true;
      continue;
    }
    if (!line) continue;
    // The instructions block ends at the paper body: a section header, a
    // numbered line that carries a marks expression (a real question), or a
    // bare page number. Numbered short lines like "1. Read the paper …" are
    // instruction items and are collected, not treated as questions.
    if (/^(?:SECTION|Part)\s/i.test(line)) break;
    if (/^Q\d/i.test(line)) break;
    if (/^\d{1,2}\s*$/.test(line)) break;
    const cleaned = line.replace(/^\(?(?:[ivxlc\d]+|[a-z])\)?[.)]?\s*/i, '').trim();
    if (!cleaned) continue;
    if (/\d+\s*[xX×*]\s*\d+\s*=\s*\d+/.test(cleaned)) break; // "2x5=10" → a question, not an instruction
    if (/^\d+$/.test(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= 8) break;
  }
  return out;
}

// ─── Question-type classification (priority ordered) ─────────────────────────

const TYPE_PATTERNS = [
  { type: 'MAP', re: /\bmap\b|mark the following|locate(?: and label)? on|point out on/i },
  { type: 'DIAGRAM', re: /draw a (?:labelled|labeled|neat)?\s*diagram|label the (?:given )?(?:diagram|figure)|diagram of/i },
  { type: 'DRAWING', re: /^draw\b|draw and label|draw the\b/i },
  { type: 'MATCH_THE_FOLLOWING', re: /match the (?:following|columns?)|match the items|match column/i },
  { type: 'TRUE_FALSE', re: /true or false|true\/false|state whether|write t\s*\/\s*f/i },
  { type: 'MCQ', re: /choose the correct|tick the correct|select the correct|multiple choice|\bmcq\b/i },
  // CREATIVE before FILL: a story outline may itself contain blank lines
  // ("____") but "create a story" / "write a story" is unambiguously creative.
  { type: 'CREATIVE_WRITING', re: /write (?:a|an|the|your)?\s*(?:short )?(?:story|essay|paragraph|composition)|compose|create a story|story using the given|story writing|creative writing/i },
  { type: 'FILL_IN_THE_BLANK', re: /fill in the blanks?|fill in the missing|___+|complete the (?:following )?(?:sentences?|words?|passage)/i },
  { type: 'GRAMMAR', re: /\b(?:grammar|conjunction|preposition|tense|noun|pronoun|adjective|adverb|verb|article|punctuat|sentence)\b/i },
  { type: 'DEFINITION', re: /^define\b|define the following|give the (?:meaning|definition)/i },
  { type: 'LETTER', re: /write a (?:formal|informal|letter|letter to)|letter to the (?:editor|principal)/i },
  { type: 'NOTICE', re: /write a notice|notice writing|draft a notice/i },
  { type: 'PASSAGE', re: /read the (?:given )?(?:passage|following)|reference to the context|comprehension/i },
  { type: 'CASE_BASED', re: /case(?: |-)?(?:study|based)/i },
  { type: 'PROOF', re: /^prove\b|prove that/i },
  { type: 'NUMERICAL', re: /^solve\b|solve the (?:following|given)|calculate|find the (?:value|area|perimeter|volume)|evaluate/i },
  { type: 'PROBLEM_SOLVING', re: /word problem|problem based|story sum/i },
  { type: 'EXPLAIN', re: /^explain\b|explain (?:the|why|how)/i },
  { type: 'DIFFERENTIATE', re: /differentiate between|distinguish between|difference between/i },
  { type: 'COMPARE', re: /compare(?: and contrast)?\b/i },
  { type: 'ESSAY', re: /essay on|write an essay|in about \d+ words/i },
  { type: 'APPLICATION', re: /application for|write an application/i },
  { type: 'VERY_SHORT_ANSWER', re: /very short answer|answer in (?:one|a few) (?:word|sentence)|one-word answer/i },
];

/**
 * Classify a question type from its cleaned stem text + marks context.
 * @param {string} stem - Marks expression already stripped
 * @param {number|null} marksPerItem - Marks per item from the expression
 * @param {number|null} totalMarks - Total marks from the expression
 * @returns {string} Canonical blueprint type
 */
export function classifyQuestionType(stem, marksPerItem = null, totalMarks = null) {
  const s = String(stem || '').trim();
  if (!s) return 'UNKNOWN';

  for (const { type, re } of TYPE_PATTERNS) {
    if (re.test(s)) return type;
  }

  // Short-answer vs long-answer is decided by MARKS PER ITEM first (a 5-mark
  // "Name the following" with 1 mark per item is still a short-answer item);
  // total marks only count when per-item marks are unknown.
  const longByMarks = () => {
    if (marksPerItem != null) return marksPerItem >= 4 ? 'LONG_ANSWER' : 'SHORT_ANSWER';
    return totalMarks != null && totalMarks >= 5 ? 'LONG_ANSWER' : 'SHORT_ANSWER';
  };
  if (/^(?:what|which|why|how|who|when|where|name|give|list|state|write|mention)\b/i.test(s)) {
    return longByMarks();
  }
  if (/answer the following|describe|narrate/i.test(s)) {
    return longByMarks();
  }

  return 'UNKNOWN';
}

// ─── Question-construction pattern classification (deterministic) ────────────

/**
 * Canonical instruction TYPE (how the question asks the student to respond).
 * The reference instruction is preserved verbatim in `instruction`; this is a
 * coarse deterministic tag so generation/validation can reason about the
 * pattern ("choose-correct-option", "fill-in-blank", …).
 */
export function classifyInstruction(instruction, type) {
  const s = String(instruction || '').toLowerCase();
  if (/(?:read the (?:given )?(?:passage|following)|comprehension|reference to the context|based on the (?:given )?passage)/.test(s)) return 'passage-comprehension';
  if (/match (?:the )?(?:following|column|columns|items)/.test(s)) return 'match-columns';
  if (/(?:true or false|true\/false|state whether)/.test(s)) return 'true-false';
  if (/(?:choose|tick|select|pick) (?:the )?correct/.test(s)) return 'choose-correct-option';
  if (/(?:fill in the|complete the|__+)/.test(s)) return 'fill-in-blank';
  if (/^define\b|define the following/.test(s)) return 'define-terms';
  if (/(?:draw|label|diagram)/.test(s)) return 'draw-label';
  if (/(?:on a map|map of|locate)/.test(s)) return 'map-pointing';
  if (/(?:answer (?:any|the following|all))/.test(s)) return 'answer-following';
  if (/^name (?:the|any)/.test(s)) return 'name-the-following';
  if (/(?:differentiate|distinguish|difference between)/.test(s)) return 'differentiate';
  if (/(?:compare|contrast)/.test(s)) return 'compare';
  if (/(?:explain|why|how|describe)/.test(s)) return 'explain-reason';
  if (/(?:write a|compose|create a story)/.test(s)) return 'creative-writing';
  if (/(?:solve|calculate|find the|evaluate)/.test(s)) return 'numerical';
  const fallback = {
    MCQ: 'choose-correct-option',
    TRUE_FALSE: 'true-false',
    FILL_IN_THE_BLANK: 'fill-in-blank',
    MATCH_THE_FOLLOWING: 'match-columns',
    PASSAGE: 'passage-comprehension',
    COMPREHENSION: 'passage-comprehension',
    CASE_BASED: 'passage-comprehension',
    MAP: 'map-pointing',
    DIAGRAM: 'draw-label',
    DRAWING: 'draw-label',
    NUMERICAL: 'numerical',
    DEFINITION: 'define-terms',
    CREATIVE_WRITING: 'creative-writing',
    LETTER: 'creative-writing',
    NOTICE: 'creative-writing',
    ESSAY: 'creative-writing',
  };
  return fallback[type] || 'direct-question';
}

/** Expected ANSWER FORM per question type (what a correct response looks like). */
export function classifyAnswerForm(type) {
  const map = {
    MCQ: 'single-correct-option',
    TRUE_FALSE: 'true-false-statement',
    FILL_IN_THE_BLANK: 'word-or-phrase',
    MATCH_THE_FOLLOWING: 'matched-pairs',
    MAP: 'marked-location',
    DIAGRAM: 'diagram-drawing',
    DRAWING: 'diagram-drawing',
    PASSAGE: 'passage-based-answers',
    COMPREHENSION: 'passage-based-answers',
    CASE_BASED: 'case-based-answers',
    NUMERICAL: 'computed-value',
    CREATIVE_WRITING: 'extended-writing',
    LETTER: 'extended-writing',
    NOTICE: 'extended-writing',
    ESSAY: 'extended-writing',
    LONG_ANSWER: 'explanation-points',
    EXPLAIN: 'explanation-points',
    DIFFERENTIATE: 'comparison-points',
    COMPARE: 'comparison-points',
    PROOF: 'proof-steps',
    DEFINITION: 'short-definition',
  };
  return map[type] || 'short-sentence';
}

/**
 * Build the deterministic QUESTION PATTERN for one main question from its
 * observed items: construction/answer-form tags, per-item option counts and
 * the detected MCQ option-label style.
 */
function buildQuestionPattern(main, type, instruction, observedSubParts) {
  const rawItems = observedSubParts.length > 0 ? observedSubParts : (main.question ? [main.question] : []);
  const optionCounts = rawItems
    .map((it) => (Array.isArray(it?.options) && it.options.length > 0 ? it.options.length : 0))
    .filter((n) => n > 0);
  const optionSamples = [];
  for (const it of rawItems) {
    for (const o of Array.isArray(it?.options) ? it.options : []) {
      optionSamples.push(o);
      if (optionSamples.length >= 8) break;
    }
    if (optionSamples.length >= 8) break;
  }
  const optionStyle = detectOptionLabelStyle(optionSamples).style;
  return {
    instructionType: classifyInstruction(instruction, type),
    answerForm: classifyAnswerForm(type),
    layout: observedSubParts.length > 0 ? 'grouped-sub-items' : 'single-item',
    optionCounts, // per-item option counts observed in the reference (MCQ)
    maxOptionCount: optionCounts.length > 0 ? Math.max(...optionCounts) : null,
    optionLabelStyle: optionSamples.length > 0 ? optionStyle : null,
  };
}

/** Clean an observed reference item for topic anchoring (never copied verbatim). */
function cleanReferenceItem(text, maxLen = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
}

// ─── Main-question grouping (with duplicate-label dedup) ────────────────────

/**
 * Group extracted questions into MAIN questions with their sub-parts attached.
 *
 * Extraction artifacts (page numbers parsed as questions, repeated labels)
 * are handled GENERICALLY: when two mains share a label, the richer one wins —
 * "richer" = has a section, carries a marks expression, or has more text.
 * @param {Array<Object>} questions - questionExtractor output shape
 * @returns {Array<{ question: Object, subparts: Array<Object>, number: string, numeric: number|null }>}
 */
function groupMainQuestions(questions) {
  const mains = [];
  const byNumber = new Map();

  // Structural signals dominate: a marks expression is the strongest proof a
  // line is a real main question (passage-tail artifacts never carry one);
  // text length is a weak tiebreaker so long glued passage text cannot win.
  const richness = (q) =>
    (parseMarksExpression(q.text) ? 2 : 0) +
    (Array.isArray(q.subparts) && q.subparts.length > 0 ? 1 : 0) +
    (q.section ? 1 : 0) +
    Math.min(String(q.text || '').length / 60, 0.5);

  for (const q of questions || []) {
    const number = String(q?.questionNumber ?? '').trim();
    const parent = String(q?.parentQuestionNumber ?? '').trim();
    const isSub = parent !== '' || /\([a-zA-Z0-9]+\)/.test(number);

    if (isSub) {
      const parentKey = parent || number.replace(/\(.*\)$/, '');
      let main = byNumber.get(parentKey);
      if (!main) {
        // The parent main was stem-less in the source (e.g. "Q.1" with its
        // parts on the following lines) and never became its own record.
        // Synthesise it so the parts are not orphaned.
        main = {
          question: { questionNumber: parentKey, parentQuestionNumber: null, section: q?.section ?? null, type: 'UNKNOWN', text: '', options: [], marks: null },
          subparts: [],
          number: parentKey,
          numeric: extractQuestionNumber(parentKey),
        };
        mains.push(main);
        byNumber.set(parentKey, main);
      }
      main.subparts.push(q);
      continue;
    }

    const existing = byNumber.get(number);
    if (existing) {
      // Duplicate label: keep the richer main, drop the degenerate one.
      if (richness(q) > richness(existing.question)) {
        existing.question = q;
        existing.subparts = [];
      }
      continue;
    }

    const main = { question: q, subparts: [], number, numeric: extractQuestionNumber(number) };
    mains.push(main);
    byNumber.set(number, main);
  }

  return mains.sort((a, b) => (a.numeric ?? Infinity) - (b.numeric ?? Infinity));
}

/** Extract the leading number from labels like "Q5", "Q.12", "5". */
function extractQuestionNumber(label) {
  const m = String(label || '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// ─── Per-main-question blueprint extraction ──────────────────────────────────

function extractMainQuestion(main, warnings, index = 0) {
  const rawText = String(main.question?.text ?? '').trim();
  const expression = parseMarksExpression(rawText);
  const cleaned = stripMarksExpression(rawText);

  const optionalRule = parseOptionalRule(rawText);
  const instruction = cleaned || rawText;

  const subMarks = main.subparts
    .map((sp) => Number(sp?.marks))
    .filter((m) => Number.isFinite(m) && m > 0);
  const subMarksSum = subMarks.length > 0 ? subMarks.reduce((a, b) => a + b, 0) : null;

  const observedSubParts = main.subparts.length;
  const itemCount = observedSubParts > 0 ? observedSubParts : (expression?.itemCount ?? 1);
  const totalMarks = expression?.totalMarks ?? subMarksSum ?? null;
  const marksPerItem = expression?.marksPerItem
    ?? (totalMarks != null ? totalMarks / itemCount : null);

  // INTERNAL_CHOICE: "A. … OR B. …" — two or three captured options plus a
  // standalone "OR" in the stem is a choice question, not an MCQ. Excludes
  // true/false wording ("True or False") and explicit MCQ wording.
  const optionCount = Array.isArray(main.question?.options) ? main.question.options.length : 0;
  const looksLikeInternalChoice =
    optionCount >= 2 && optionCount <= 3 && /\bOR\b/i.test(cleaned)
    && !/(?:true or false|true\/false)/i.test(cleaned)
    && !/^choose|^tick|^select/i.test(cleaned);

  // Prefer the text-based classification (richer); fall back to the extractor's
  // own label only when the stem does not reveal the type.
  const textType = classifyQuestionType(cleaned, marksPerItem, totalMarks);
  let type = textType !== 'UNKNOWN' ? textType : normalizeBlueprintType(main.question?.type);
  if (looksLikeInternalChoice) type = 'INTERNAL_CHOICE';
  // Stem-less main ("Q.1" with parts on the next lines): classify from the
  // sub-part text, then fall back to answer-length by marks so the slot is
  // never left UNKNOWN when it plainly carries a mark value.
  if (type === 'UNKNOWN' && Array.isArray(main.subparts) && main.subparts.length > 0) {
    const subType = classifyQuestionType(
      main.subparts.map((sp) => String(sp?.text || '')).join(' '),
      marksPerItem,
      totalMarks
    );
    if (subType !== 'UNKNOWN') type = subType;
    else if (marksPerItem != null) type = marksPerItem >= 4 ? 'LONG_ANSWER' : 'SHORT_ANSWER';
    else if (totalMarks != null) type = totalMarks >= 5 ? 'LONG_ANSWER' : 'SHORT_ANSWER';
  }

  if (type === 'UNKNOWN') {
    warnings.push({ field: 'questionType', label: main.number, warning: `Question type could not be confidently detected for "${cleaned.slice(0, 60)}".` });
  }
  if (totalMarks == null) {
    warnings.push({ field: 'marks', label: main.number, warning: `Marks could not be detected for question "${cleaned.slice(0, 60)}".` });
  }

  // TOPIC ANCHORS + CONSTRUCTION PATTERN: the observed reference item texts are
  // kept (short, truncated) so per-slot generation can stay on the SAME topic
  // area and reproduce the same construction — while never copying the text.
  const referenceItems = [];
  const subparts = main.subparts;
  for (const sp of subparts) {
    const clean = cleanReferenceItem(sp?.text);
    if (clean) referenceItems.push(clean);
    if (referenceItems.length >= 12) break;
  }
  if (referenceItems.length === 0) {
    const clean = cleanReferenceItem(cleaned || rawText, 200);
    if (clean) referenceItems.push(clean);
  }
  const pattern = buildQuestionPattern(main, type, instruction, subparts);

  // CANONICAL PER-ITEM SPEC: one structured object per reference sub-question,
  // carrying its own label, marks, topic anchor text and observed option count.
  // The extractor may not always recover every field (scanned PDFs, glued
  // lines) — missing values stay null and are never invented. `referenceItems`
  // above stays for backward compatibility; `items` is the canonical form the
  // Reference Paper Analyzer and the per-item validator consume.
  // CANONICAL PER-ITEM SPEC — one object per observed sub-part, POSITIONALLY
  // labelled a, b, c… (the canonical item key both sides agree on). The raw
  // recovered label is kept as `sourceLabel` for diagnostics only; MCQ option
  // labels (i, ii, iii) never leak into the item label. Per-item marks are
  // carried verbatim where recoverable and left null where not — NEVER
  // distributed evenly from the total, because per-item marks genuinely vary.
  const items = [];
  const itemMarks = [];
  subparts.slice(0, 26).forEach((sp, i) => {
    const rawLabel = String(sp?.questionNumber ?? '').trim();
    const labelM = rawLabel.match(/\(([^)]+)\)\s*$/);
    const sourceLabel = labelM ? labelM[1].toLowerCase() : null;
    const ref = cleanReferenceItem(sp?.text);
    const parsedMark = Number(sp?.marks);
    const mark = Number.isFinite(parsedMark) && parsedMark > 0 ? Math.round(parsedMark * 10) / 10 : null;
    const oc = Array.isArray(sp?.options) && sp.options.length > 0 ? sp.options.length : null;
    items.push({ label: String.fromCharCode(97 + i), sourceLabel, referenceText: ref, marks: mark, optionCount: oc });
    if (mark != null) itemMarks.push(mark);
  });

  // itemsIndependent: false only when the sub-parts share a stimulus
  // (passage / case-based / comprehension). Always a boolean, never null.
  const sharedStimulus =
    type === 'PASSAGE' ||
    type === 'COMPREHENSION' ||
    type === 'CASE_BASED' ||
    pattern?.instructionType === 'passage-comprehension' ||
    Boolean(main.question?.passage);
  const itemsIndependent = !sharedStimulus;

  // marksComplete: the question total AND (for grouped questions) every
  // sub-part's marks are known.
  const perItemComplete = observedSubParts > 0 ? items.every((it) => it.marks != null) : true;
  const marksComplete = totalMarks != null && perItemComplete;
  if (observedSubParts > 0 && !perItemComplete) {
    warnings.push({
      field: 'itemMarks',
      label: main.number,
      warning: `Per-item marks incomplete for "${(cleaned || rawText).slice(0, 60)}" — route to teacher review.`,
    });
  }

  return {
    number: main.numeric,
    // label is the slotUnitMap key — ALWAYS present, positional fallback.
    label: String(main.number || '').trim() || `Q${index + 1}`,
    type,
    itemsIndependent,
    marksComplete,
    stem: cleaned,
    instruction,
    referenceItems,
    pattern,
    marks: {
      perItem: marksPerItem != null ? Math.round(marksPerItem * 10) / 10 : null,
      itemCount,
      total: totalMarks,
      expression: expression?.expression ?? null,
    },
    itemCount,
    marksPerItem,
    totalMarks,
    markExpression: expression?.expression ?? null,
    optionalRule,
    subQuestionCount: observedSubParts,
    optionCount: optionCount > 0 ? optionCount : null,
    // Canonical per-item reference specification (label → marks → topic anchor
    // → observed option count). Grouped questions carry one entry per part;
    // single-stem questions keep an empty array (no per-item data to invent).
    items: observedSubParts > 0 ? items : [],
    itemMarks: observedSubParts > 0 ? itemMarks : [],
    section: main.question?.section ?? null,
  };
}

// ─── Sections (with generic title detection) ────────────────────────────────

/**
 * Detect section titles generically:
 *  1. inline — "SECTION A - BIOLOGY", "PART B : Grammar"
 *  2. next-line — a short standalone word right under the heading
 *  3. instruction mapping — "sections: A-Reading, B- Grammar, C- Literature"
 * @param {string|null} text - Raw paper text (optional)
 * @param {Array<{ name: string, questionNumbers: string[] }>} sections
 * @returns {Array<{ name, title, questionNumbers }>}
 */
function attachSectionTitles(text, sections) {
  const titles = {};

  // A plausible section title: a short line of plain words (no digits, no
  // marks expression, no question wording) — so merged PDF lines like
  // "SECTION A1. Read the given passage …" are never mistaken for titles.
  const plausibleTitle = (t) => /^[A-Za-z][A-Za-z\s&()-]{1,40}$/.test(String(t || '').trim());

  if (text && typeof text === 'string') {
    // Inline + next-line detection. NOTE: only spaces/tabs may separate the
    // heading from an inline title — \s would cross the newline into the body.
    const re = /^(?:SECTION|Section|PART|Part)\s+([A-Za-z0-9]+)[ \t]*[-–—:]?[ \t]*(.*)$/gm;
    let m;
    while ((m = re.exec(text))) {
      const key = String(m[1]).toUpperCase();
      let title = (m[2] || '').trim();
      if (!title && plausibleTitle(text.slice(m.index + m[0].length).split('\n').find((l) => l.trim() !== '') || '')) {
        title = text.slice(m.index + m[0].length).split('\n').find((l) => l.trim() !== '').trim();
      }
      if (plausibleTitle(title) && !titles[key]) titles[key] = title;
    }
    // Instruction mapping: "A-Reading, B- Grammar, C- Literature, D-Creativity"
    const pairRe = /\b([A-Za-z])\s*[-–]\s*([A-Za-z][A-Za-z\s&()-]{1,30}?)(?=\s*[,.;]|\s+[A-Za-z]\s*[-–]|\s*$)/gm;
    let pm;
    while ((pm = pairRe.exec(text))) {
      const key = pm[1].toUpperCase();
      const title = pm[2].trim();
      if (plausibleTitle(title) && !titles[key]) titles[key] = title;
    }
  }

  return sections.map((s) => {
    const key = s.name.replace(/^SECTION\s+/i, '');
    return { ...s, title: titles[key] ?? null };
  });
}

function buildSections(mains) {
  const order = [];
  const byKey = new Map();
  for (const main of mains) {
    const section = main.question?.section;
    if (!section) continue;
    const key = String(section).toUpperCase();
    if (!byKey.has(key)) {
      byKey.set(key, { name: `SECTION ${key}`, title: null, questionNumbers: [] });
      order.push(key);
    }
    byKey.get(key).questionNumbers.push(main.number);
  }
  return order.map((k) => byKey.get(k));
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Build a UNIVERSAL LOCKED blueprint from extracted questions (+ raw text).
 * @param {Object} args - { questions: Array<Object>, text?: string }
 * @returns {Object} Canonical blueprint (see blueprint-schema.js docs)
 */
export function extractBlueprint({ questions = [], text = '' } = {}) {
  const warnings = [];
  const paperHeader = parsePaperHeader(text);
  const mains = groupMainQuestions(questions);

  const bpQuestions = mains.map((m, i) => extractMainQuestion(m, warnings, i));
  let sections = buildSections(mains);
  sections = attachSectionTitles(text, sections);

  if (bpQuestions.length === 0) {
    warnings.push({ field: 'questions', warning: 'No main questions could be identified in the document.' });
  }
  if (sections.length === 0) {
    warnings.push({ field: 'section', warning: 'No section boundaries detected — the paper is treated as one continuous block.' });
  }

  const allMarksKnown = bpQuestions.length > 0 && bpQuestions.every((q) => q.totalMarks != null);
  const knownSum = bpQuestions.reduce((acc, q) => acc + (q.totalMarks ?? 0), 0);

  return {
    paper: {
      schoolName: paperHeader.schoolName,
      examTitle: paperHeader.examTitle,
      session: paperHeader.session,
      class: paperHeader.class,
      subject: paperHeader.subject,
      duration: paperHeader.duration,
      maximumMarks: paperHeader.maximumMarks,
    },
    studentInstructions: extractStudentInstructions(text),
    sections,
    questions: bpQuestions,
    totalQuestions: bpQuestions.length,
    totalMarks: allMarksKnown ? knownSum : null,
    marksComplete: allMarksKnown,
    blueprintWarnings: warnings,
  };
}

export default { extractBlueprint, classifyQuestionType, classifyInstruction, classifyAnswerForm };