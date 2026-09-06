/**
 * blueprint-validator.js
 *
 * Compares a GENERATED paper against the EXPECTED (locked) blueprint, slot by
 * slot. Pure JavaScript — no LLM calls. It is the authoritative structural
 * gate: total marks, question type, item/sub-part count and optional-answer
 * rules are checked deterministically so the LLM can never silently redesign
 * the reference structure.
 *
 *   EXPECTED BLUEPRINT  vs  GENERATED PAPER
 *   - total marks per question        (must equal blueprint totalMarks)
 *   - question type                   (must equal blueprint type)
 *   - item / sub-part count           (must equal blueprint itemCount)
 *   - optional-answer rule            (must still read \"any N\" with same N)
 *   - slot presence                   (every blueprint slot must be filled)
 */

import { normalizeBlueprintType, NUMBER_WORDS } from './blueprint-schema.js';

const WORD_FOR_NUMBER = Object.fromEntries(Object.entries(NUMBER_WORDS).map(([w, n]) => [n, w]));

function numberWord(n) {
  return WORD_FOR_NUMBER[n] ?? String(n);
}

/**
 * Find an \"any N\" optional-answer number inside a question's text.
 * @param {string} text
 * @returns {number|null} N found (words or digits), else null
 */
export function findAnyN(text) {
  const m = String(text || '').match(/\bany\s+(?:of\s+)?(?:the\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  return NUMBER_WORDS[raw] ?? Number(raw) ?? null;
}

/**
 * Validate ONE generated question against its expected blueprint slot.
 * @param {Object} generated - { text, type, marks, subParts?, options? }
 * @param {Object} expected - Blueprint question { number, label, type, totalMarks, itemCount, optionalRule }
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkQuestion(generated, expected) {
  const reasons = [];
  const g = generated || {};
  const label = expected?.label || `Q${expected?.number ?? '?'}`;
  const parts = Array.isArray(g.subParts) ? g.subParts : [];
  const textForRule = [g.text, ...parts.map((p) => p?.text)].filter(Boolean).join(' ');

  // 1. Question type
  const gType = normalizeBlueprintType(g.type);
  if (expected?.type && expected.type !== 'UNKNOWN' && gType !== expected.type) {
    reasons.push(`${label} requires type ${expected.type} but generated ${gType}.`);
  }

  // 2. Total marks (blueprint marks are authoritative — never recalculated)
  if (expected?.totalMarks != null) {
    const gMarks = Number(g.marks);
    if (!Number.isFinite(gMarks) || gMarks !== expected.totalMarks) {
      reasons.push(`${label} requires ${expected.totalMarks} total mark(s) but generated ${gMarks}.`);
    }
  }

  // 3. Item / sub-part count (MATCH questions may carry `columns`, and
  //    INTERNAL_CHOICE questions may carry `choices` instead of sub-parts).
  const expectedItems = expected?.itemCount ?? 1;
  const columnItems = Array.isArray(g.columns?.left) ? g.columns.left.length : 0;
  const choiceCount = Array.isArray(g.choices) ? g.choices.length : 0;
  const actualItems = parts.length > 0
    ? parts.length
    : columnItems > 0 ? columnItems : (choiceCount > 0 ? Math.max(1, choiceCount) : (expectedItems === 1 ? 1 : 0));
  if (actualItems !== expectedItems) {
    reasons.push(`${label} requires ${expectedItems} item(s) but generated ${actualItems}.`);
  }

  // 4. Optional-answer rule preserved (\"Answer any four\" stays \"any four\")
  if (expected?.optionalRule?.n) {
    const n = expected.optionalRule.n;
    const found = findAnyN(textForRule);
    if (found !== n) {
      reasons.push(
        `${label} requires optional rule \"any ${numberWord(n)}\" but ` +
        (found == null ? 'none was found.' : `found \"any ${numberWord(found)}\".`)
      );
    }
  }

  // 5. Section preservation (when the reference paper has sections)
  if (expected?.sectionName && g.section !== expected.sectionName) {
    reasons.push(`${label} must stay in ${expected.sectionName} but was placed in ${g.section || 'no section'}.`);
  }

  // 6. QUESTION-PATTERN fidelity (deterministic, when the reference pattern is
  //    known). The reference QUESTION TYPE is never free: an MCQ slot must
  //    actually CONTAIN multiple-choice items, a TRUE_FALSE slot plain
  //    statements, a FILL_IN_THE_BLANK slot sentences with blanks — otherwise
  //    the generated "same type" label would hide a content drift (the bug
  //    this validator exists to kill).
  const expectedType = expected?.type ? normalizeBlueprintType(expected.type) : null;
  const pat = expected?.pattern && typeof expected?.pattern === 'object' ? expected.pattern : null;
  // NOTE: Number(null) === 0 — a missing maxOptionCount must stay null, never 0.
  const rawMax = Number(pat?.maxOptionCount);
  const maxOptions = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : null;
  const perItemOptionCounts = Array.isArray(pat?.optionCounts) && pat.optionCounts.length > 0
    ? pat.optionCounts
    : [];

  // 6a. MCQ slots: every item must carry its own option list; option count
  //     matches the reference per-item count when the extractor recovered it.
  //     Presence/consistency rules apply only when the REFERENCE exposed its
  //     per-item structure (items or option counts). A single-stem MCQ slot
  //     with no recovered item detail is left to the semantic validator — the
  //     reference simply did not give us enough to enforce deterministically.
  const knownOpts = maxOptions != null || perItemOptionCounts.length > 0;
  // Real per-item structure means the reference exposed its individual items
  // (extractor sub-parts). A single fallback stem anchor (length === 1, equal
  // to the slot instruction) is NOT per-item structure.
  const itemCountInSpec = Array.isArray(expected?.items) ? expected.items.length : 0;
  const refItemCount = Array.isArray(expected?.referenceItems) ? expected.referenceItems.length : 0;
  const hasRefItems = itemCountInSpec > 0
    || (refItemCount > 1)
    || (refItemCount === 1 && String(expected?.referenceItems?.[0] || '') !== String(expected?.instruction || expected?.stem || ''));
  if (expectedType === 'MCQ' && (knownOpts || hasRefItems)) {
    const groups = parts.length > 0
      ? parts.map((p) => (Array.isArray(p.options) ? p.options : []))
      : (Array.isArray(g.options) && g.options.length > 0 ? [g.options] : []);
    if (parts.length > 0) {
      groups.forEach((opts, idx) => {
        const expectedN = perItemOptionCounts[idx] ?? maxOptions;
        if (opts.length === 0) {
          reasons.push(`${label} is an MCQ slot — item ${idx + 1} must carry its own options but generated none (an MCQ cannot be a bare statement).`);
        } else if (opts.length < 2) {
          reasons.push(`${label} MCQ item ${idx + 1} needs at least 2 options but generated ${opts.length}.`);
        } else if (expectedN != null && expectedN >= 2 && opts.length !== expectedN) {
          reasons.push(`${label} MCQ item ${idx + 1} requires ${expectedN} options but generated ${opts.length}.`);
        }
      });
      const distinctCounts = new Set(groups.filter((o) => o.length >= 2).map((o) => o.length));
      if (distinctCounts.size > 1) {
        reasons.push(`${label} MCQ items must share the SAME option count but generated mixed counts [${[...distinctCounts].join(', ')}].`);
      }
    } else if (groups.length === 1 && groups[0].length < 2) {
      reasons.push(`${label} is an MCQ slot but the generated question carries no usable options.`);
    }
  }

  // 6b. TRUE_FALSE slots: plain statements, never option lists.
  if (expectedType === 'TRUE_FALSE') {
    parts.forEach((p, idx) => {
      if (Array.isArray(p?.options) && p.options.length >= 2) {
        reasons.push(`${label} is TRUE_FALSE — item ${idx + 1} must be a plain true/false statement without options (${p.options.length} options found).`);
      }
    });
  }

  // 6c. FILL_IN_THE_BLANK slots: when the reference parts literally contain
  //     blanks, the generated parts must too (same construction pattern).
  if (expectedType === 'FILL_IN_THE_BLANK' && parts.length > 0) {
    const refTexts = Array.isArray(expected?.items) && expected.items.length > 0
      ? expected.items.map((it) => it?.referenceText || '')
      : (Array.isArray(expected?.referenceItems) ? expected.referenceItems : []);
    const refText = refTexts.join(' ');
    if (/_{2,}/.test(refText)) {
      parts.forEach((p, idx) => {
        if (!/_{2,}/.test(String(p?.text || ''))) {
          reasons.push(`${label} is a fill-in-the-blank slot — item ${idx + 1} must contain a blank (e.g. ____) to fill.`);
        }
      });
    }
  }

  // 6d. PER-PART MARKS: when the reference carried explicit per-part marks
  //     (e.g. Q4 a=1, b=2, c=2, d=2, e=3) the generated parts must keep the
  //     same marks at the same positions. (Checked only when the part count
  //     already matches — a count mismatch is reported above.)
  const expectedItemMarks = Array.isArray(expected?.itemMarks) && expected.itemMarks.length > 0
    ? expected.itemMarks
    : (Array.isArray(expected?.items)
        ? expected.items.map((it) => it?.marks).filter((m) => Number.isFinite(Number(m)) && Number(m) > 0)
        : []);
  if (expectedItemMarks.length > 0 && parts.length === expectedItemMarks.length) {
    parts.forEach((p, idx) => {
      const want = expectedItemMarks[idx];
      const got = Number(p?.marks);
      if (!Number.isFinite(got) || got <= 0) {
        reasons.push(`${label} part ${idx + 1} must carry its locked ${want} mark(s) but none were set.`);
      } else if (Math.abs(got - want) > 1e-6) {
        reasons.push(`${label} part ${idx + 1} requires ${want} mark(s) but generated ${got}.`);
      }
    });
  }

  const instructionText = String(expected?.instruction || expected?.stem || '');
  const passageSlot =
    (pat?.instructionType === 'passage-comprehension')
    || /(?:read the (?:given )?(?:passage|following)|comprehension|reference to the context|based on the (?:given )?passage)/i.test(instructionText)
    || (expected?.type === 'PASSAGE');
  if (passageSlot && !String(g.passage || '').trim()) {
    reasons.push(`${label} is a passage-based question — the generated question must include its own passage text.`);
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Validate a whole generated question list against the blueprint.
 * Slots are matched by `slotIndex` when present (orchestrator sets it),
 * otherwise by array position.
 * @param {Array<Object>} questions - Generated questions (accepted ones)
 * @param {Object} blueprint - Canonical blueprint
 * @returns {{ ok: boolean, results: Array<Object> }}
 *   results[i] = { slotIndex, questionNumber, expected, generated, ok, reasons }
 */
export function validatePaper(questions, blueprint) {
  const bpQuestions = blueprint?.questions || [];
  const list = Array.isArray(questions) ? questions : [];

  const results = bpQuestions.map((expected, i) => {
    const bySlot = list.find((q) => Number(q?.slotIndex) === i);
    const g = bySlot ?? list[i] ?? null;

    if (!g) {
      return {
        slotIndex: i,
        questionNumber: expected.label || `Q${i + 1}`,
        expected,
        generated: null,
        ok: false,
        reasons: [`${expected.label || `Q${i + 1}`} (slot ${i + 1}) was not generated.`],
      };
    }

    const check = checkQuestion(g, expected);
    return {
      slotIndex: i,
      questionNumber: expected.label || `Q${i + 1}`,
      expected,
      generated: g,
      ok: check.ok,
      reasons: check.reasons,
    };
  });

  // Paper-level: the reference section set must be preserved exactly.
  const expectedSections = (blueprint?.sections || []).map((s) => s.name).filter(Boolean);
  const sectionCheck = { ok: true, expected: expectedSections, generated: null, reasons: [] };
  if (expectedSections.length > 0) {
    const generatedSections = [...new Set(list.map((q) => q.section).filter(Boolean))].sort();
    const expectedSorted = [...new Set(expectedSections)].sort();
    sectionCheck.generated = generatedSections;
    if (JSON.stringify(generatedSections) !== JSON.stringify(expectedSorted)) {
      sectionCheck.ok = false;
      sectionCheck.reasons.push(`Expected sections [${expectedSorted.join(', ')}] but generated paper has [${generatedSections.join(', ') || 'none'}].`);
    }
  }

  return { ok: results.every((r) => r.ok) && sectionCheck.ok, results, sectionCheck };
}

/**
 * Compact conformance summary for meta / logs.
 * @param {Array<Object>} results - validatePaper().results
 * @returns {{ totalSlots: number, passed: number, failed: number }}
 */
export function summarize(results) {
  const failed = (results || []).filter((r) => !r.ok).length;
  return { totalSlots: (results || []).length, passed: (results || []).length - failed, failed };
}

export default { checkQuestion, validatePaper, findAnyN, summarize };