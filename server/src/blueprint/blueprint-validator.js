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

/**
 * Best-effort type of ONE generated item when the model did not label it.
 * Deterministic: an option list ⇒ MCQ; a literal blank ⇒ FILL_IN_THE_BLANK;
 * a "true/false" answer ⇒ TRUE_FALSE; otherwise fall back by marks.
 */
function inferItemType(part) {
  if (!part || typeof part !== 'object') return null;
  const explicit = normalizeBlueprintType(part.type);
  if (explicit && explicit !== 'UNKNOWN') return explicit;
  if (Array.isArray(part.options) && part.options.length >= 2) return 'MCQ';
  if (/_{2,}/.test(String(part.text || ''))) return 'FILL_IN_THE_BLANK';
  if (/^(true|false)$/i.test(String(part.answer || '').trim())) return 'TRUE_FALSE';
  const m = Number(part.marks);
  if (Number.isFinite(m) && m >= 4) return 'LONG_ANSWER';
  return 'SHORT_ANSWER';
}

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

  // 1. Question type. For a MIXED slot the PARENT type is derived, not
  //    authoritative — its item types are (checked in rule 5b). So a MIXED
  //    slot only fails here if the generation claims a concrete single type
  //    AND actually produced homogeneous items of that type.
  const gType = normalizeBlueprintType(g.type);
  if (expected?.type && expected.type !== 'UNKNOWN' && expected.type !== 'MIXED' && gType !== expected.type) {
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

  // 3b. CONTENT COMPLETENESS (universal): a slot with the right TYPE, marks
  // and item COUNT can still carry an empty or whitespace-only sub-part —
  // "1 item present" says nothing about whether that item actually has
  // text. This must fail here, alongside every other structural rule, so
  // the existing retry/regeneration path handles it exactly like any other
  // rejection — never a candidate that structurally "passes" while reaching
  // the final PDF blank. MATCH (columns) and INTERNAL_CHOICE (choices,
  // checked separately below) don't carry plain subParts and are skipped.
  if (parts.length > 0) {
    parts.forEach((p, i) => {
      if (!String(p?.text ?? '').trim()) {
        reasons.push(`${label} item ${i + 1} has empty or missing text.`);
      }
    });
  } else if (columnItems === 0 && choiceCount === 0 && !String(g.text ?? '').trim()) {
    reasons.push(`${label} has empty or missing question text.`);
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

  // 5b. MIXED slot — item-level structure. items[].type is AUTHORITATIVE:
  //     every generated sub-part must match the reference item's own type,
  //     option count and answer form at the SAME position. This is the only
  //     place a heterogeneous slot ("2 blanks + 2 MCQs") is enforced.
  const mixedExpectedType = expected?.type ? normalizeBlueprintType(expected.type) : null;
  if (mixedExpectedType === 'MIXED') {
    const refItems = Array.isArray(expected?.items) ? expected.items : [];
    if (refItems.length === 0) {
      reasons.push(`${label} is a MIXED slot but its blueprint carries no per-item types to validate against.`);
    } else {
      const n = Math.min(parts.length, refItems.length);
      for (let i = 0; i < n; i++) {
        const want = normalizeBlueprintType(refItems[i]?.type);
        const got = normalizeBlueprintType(parts[i]?.type) !== 'UNKNOWN'
          ? normalizeBlueprintType(parts[i]?.type)
          : inferItemType(parts[i]);
        const optLen = Array.isArray(parts[i]?.options) ? parts[i].options.length : 0;
        const pos = `item ${i + 1}`;
        if (want && want !== 'UNKNOWN' && got && got !== want) {
          reasons.push(`${label} ${pos} must be ${want} (from the reference) but generated ${got}.`);
        }
        if (want === 'MCQ') {
          const wantOpts = Number(refItems[i]?.optionCount);
          if (optLen === 0) {
            reasons.push(`${label} ${pos} is an MCQ item but generated no options.`);
          } else if (optLen < 2) {
            reasons.push(`${label} ${pos} MCQ needs at least 2 options but generated ${optLen}.`);
          } else if (Number.isFinite(wantOpts) && wantOpts >= 2 && optLen !== wantOpts) {
            reasons.push(`${label} ${pos} MCQ requires exactly ${wantOpts} options but generated ${optLen}.`);
          }
        } else if (want && want !== 'UNKNOWN') {
          if (optLen > 0) {
            reasons.push(`${label} ${pos} is a ${want} item — it must not carry an option list.`);
          }
          if (want === 'FILL_IN_THE_BLANK') {
            const refText = String(refItems[i]?.referenceText || refItems[i]?.topicAnchor || '');
            const genText = String(parts[i]?.text || '');
            if (/_{2,}/.test(refText) && genText && !/_{2,}/.test(genText)) {
              reasons.push(`${label} ${pos} is a fill-in-the-blank item — the generated item must contain a blank (e.g. ____).`);
            }
          }
        }
        // Per-item marks (when the reference recovered them).
        const wantMark = Number(refItems[i]?.marks);
        const gotMark = Number(parts[i]?.marks);
        if (Number.isFinite(wantMark) && wantMark > 0 && Number.isFinite(gotMark) && Math.abs(gotMark - wantMark) > 1e-6) {
          reasons.push(`${label} ${pos} requires ${wantMark} mark(s) but generated ${gotMark}.`);
        }
      }
    }
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
      // MIXED slots ("Fill in the blanks and choose the correct answer" —
      // some reference items carry options, some are plain blanks) follow the
      // reference item by item: a position whose reference recovered an option
      // list must generate one (same count); option-less reference positions
      // may be plain blank/word items and are NOT forced to become MCQs.
      const itemsWithOpts = Array.isArray(expected?.items)
        ? expected.items.some((it) => Number(it?.optionCount) > 0)
        : false;
      const refOptionsAt = (idx) => {
        if (perItemOptionCounts.length > 0) {
          const n = Number(perItemOptionCounts[idx]);
          return Number.isFinite(n) && n > 0 ? n : null;
        }
        const fromItem = Number(expected?.items?.[idx]?.optionCount);
        if (Number.isFinite(fromItem) && fromItem > 0) return fromItem;
        // Homogeneous slot fallback: the recovered max applies to every item.
        return maxOptions != null && !itemsWithOpts ? maxOptions : null;
      };
      groups.forEach((opts, idx) => {
        const expectedN = refOptionsAt(idx);
        if (expectedN != null && expectedN >= 2) {
          if (opts.length === 0) {
            reasons.push(`${label} is an MCQ slot — item ${idx + 1} must carry its own options but generated none (an MCQ cannot be a bare statement).`);
          } else if (opts.length < 2) {
            reasons.push(`${label} MCQ item ${idx + 1} needs at least 2 options but generated ${opts.length}.`);
          } else if (opts.length !== expectedN) {
            reasons.push(`${label} MCQ item ${idx + 1} requires ${expectedN} options but generated ${opts.length}.`);
          }
        } else if (opts.length > 0 && opts.length < 2) {
          reasons.push(`${label} MCQ item ${idx + 1} needs at least 2 options but generated ${opts.length}.`);
        } else if (opts.length >= 2) {
          // SYMMETRIC to the check above: this reference position exposed NO
          // options. If the reference item is a typed non-MCQ item (a
          // fill-in-the-blank / word item in a mixed slot), sprouting an option
          // list turns a blank into an MCQ and the "2 blanks + 2 MCQs"
          // construction is lost. Enforced only when the reference gave an
          // explicit per-item type — a genuinely ambiguous slot stays lenient.
          const refItemType = normalizeBlueprintType(expected?.items?.[idx]?.type);
          if (refItemType && refItemType !== 'MCQ') {
            reasons.push(`${label} item ${idx + 1} follows a ${refItemType} reference item (no options) but generated ${opts.length} option(s) — a mixed slot must keep each item in its original form.`);
          }
        }
        // FILL positions must still read as blanks when the reference did.
        const refItemTypeForBlank = normalizeBlueprintType(expected?.items?.[idx]?.type);
        if (refItemTypeForBlank === 'FILL_IN_THE_BLANK') {
          const refText = String(expected?.items?.[idx]?.referenceText || '');
          const genText = String(parts[idx]?.text || '');
          if (/_{2,}/.test(refText) && genText && !/_{2,}/.test(genText)) {
            reasons.push(`${label} item ${idx + 1} is a fill-in-the-blank reference item — the generated item must contain a blank (e.g. ____).`);
          }
        }
      });
      const distinctCounts = new Set(groups.filter((o) => o.length >= 2).map((o) => o.length));
      if (distinctCounts.size > 1 && !itemsWithOpts) {
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

  // 6e. MATCH_THE_FOLLOWING: columns.left and columns.right must have equal length.
  if (expectedType === 'MATCH_THE_FOLLOWING') {
    const left = Array.isArray(g.columns?.left) ? g.columns.left : [];
    const right = Array.isArray(g.columns?.right) ? g.columns.right : [];
    if (left.length > 0 || right.length > 0) {
      if (left.length !== right.length) {
        reasons.push(`${label} is MATCH_THE_FOLLOWING but left column has ${left.length} entries while right has ${right.length}; they must be equal.`);
      }
    }
  }

  // 6f. INTERNAL_CHOICE: every branch/choice must contain valid content.
  if (expectedType === 'INTERNAL_CHOICE') {
    const choices = Array.isArray(g.choices) ? g.choices : [];
    if (choices.length === 0) {
      reasons.push(`${label} is INTERNAL_CHOICE but no choices (OR branches) were generated.`);
    } else {
      choices.forEach((ch, idx) => {
        const chText = String(ch?.text ?? '').trim();
        if (!chText) {
          reasons.push(`${label} INTERNAL_CHOICE branch ${idx + 1} has empty or missing text.`);
        }
        const chParts = Array.isArray(ch?.subParts) ? ch.subParts : [];
        if (chParts.length > 0) {
          chParts.forEach((sp, si) => {
            if (!String(sp?.text ?? '').trim()) {
              reasons.push(`${label} INTERNAL_CHOICE branch ${idx + 1}, sub-part ${si + 1} has empty text.`);
            }
          });
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

// ─── PHASE 1: analyze-time specification validation ─────────────────────────

/**
 * Validate the STRUCTURAL CONSISTENCY of a Reference Paper Specification /
 * blueprint itself (not generated content). Deterministic, zero LLM.
 *
 * This answers: "is the canonical specification internally coherent and can
 * downstream generation trust it?" — numbering, section references, marks
 * consistency, item-count consistency, option/choice structure, integrity.
 *
 * It deliberately does NOT judge generated questions (that is checkQuestion /
 * validatePaper, untouched above), and it never mutates the spec.
 *
 * @param {Object} spec - canonical Reference Paper Specification (or blueprint)
 * @returns {{ ok: boolean, issues: Array<{ code: string, message: string, slotIndex?: number, field?: string }> }}
 */
export function validateSpec(spec) {
  const issues = [];
  const questions = Array.isArray(spec?.questions) ? spec.questions : [];
  const sections = Array.isArray(spec?.sections) ? spec.sections : [];
  const push = (code, message, extra = {}) => issues.push({ code, message, ...extra });

  // 1. Integrity: the specification must describe at least one question.
  if (questions.length === 0) {
    push('SPEC_EMPTY', 'The specification contains no questions — nothing downstream can consume it.');
  }

  // 2. Label uniqueness + numbering continuity (order preserved, gaps kept).
  const labels = questions.map((q) => String(q?.label ?? ''));
  const seenLabels = new Map();
  labels.forEach((label, i) => {
    if (seenLabels.has(label)) {
      push('SPEC_DUPLICATE_LABEL', `Duplicate question label "${label}" (slots ${seenLabels.get(label) + 1} and ${i + 1}).`, { slotIndex: i, field: 'label' });
    } else {
      seenLabels.set(label, i);
    }
  });
  const numerics = questions.map((q) => Number(q?.number)).filter((n) => Number.isFinite(n));
  for (let i = 1; i < numerics.length; i++) {
    if (numerics[i] === numerics[i - 1]) {
      push('SPEC_DUPLICATE_NUMBER', `Questions ${numerics[i - 1]} and ${numerics[i]} share the same number.`, { slotIndex: i, field: 'number' });
    } else if (numerics[i] - numerics[i - 1] > 1) {
      push('SPEC_NUMBERING_GAP', `Question numbering jumps from ${numerics[i - 1]} to ${numerics[i]} — gap preserved, never renumbered.`, { slotIndex: i, field: 'number' });
    }
  }

  // 3. Section references: every question's section must exist, and every
  //    section's questionNumbers must reference existing labels. Raw extracted
  //    slots carry the bare section key ("A") while sections[].name is
  //    "SECTION A" — compare on the stripped key on both sides.
  const sectionKey = (v) => String(v ?? '').replace(/^SECTION\s+/i, '').trim().toUpperCase();
  const sectionKeys = new Set(sections.map((s) => sectionKey(s?.name)).filter(Boolean));
  questions.forEach((q, i) => {
    const name = q?.sectionName ?? q?.section ?? null;
    const key = sectionKey(name);
    if (key && sectionKeys.size > 0 && !sectionKeys.has(key)) {
      push('SPEC_UNKNOWN_SECTION', `Question "${q.label}" references section "${name}" which is not in the section list.`, { slotIndex: i, field: 'section' });
    }
  });
  const labelSet = new Set(labels);
  sections.forEach((s) => {
    for (const num of s?.questionNumbers || []) {
      if (!labelSet.has(String(num))) {
        push('SPEC_SECTION_ORPHAN', `Section "${s.name}" lists question "${num}" which does not exist.`, { field: 'sections' });
      }
    }
  });

  // 4. Marks / item-count consistency (only when both sides are known).
  questions.forEach((q, i) => {
    const itemCount = Number(q?.itemCount);
    if (!Number.isFinite(itemCount) || itemCount < 1) {
      push('SPEC_ITEM_COUNT', `Question "${q.label}" has an invalid itemCount (${q?.itemCount}).`, { slotIndex: i, field: 'itemCount' });
    } else if (Number.isFinite(Number(q?.marks?.itemCount)) && Number(q.marks.itemCount) !== itemCount) {
      push('SPEC_MARKS_ITEM_COUNT_MISMATCH', `Question "${q.label}" marks.itemCount (${q.marks.itemCount}) disagrees with itemCount (${itemCount}).`, { slotIndex: i, field: 'itemCount' });
    }
    const items = Array.isArray(q?.items) ? q.items : [];
    const total = Number(q?.totalMarks ?? q?.marks?.total);
    if (items.length > 0 && items.every((it) => Number.isFinite(Number(it?.marks)) && Number(it.marks) > 0) && Number.isFinite(total)) {
      const sum = items.reduce((acc, it) => acc + Number(it.marks), 0);
      if (Math.abs(sum - total) > 1e-6) {
        push('SPEC_ITEM_MARKS_SUM', `Question "${q.label}" per-item marks sum to ${sum} but its total is ${total}.`, { slotIndex: i, field: 'itemMarks' });
      }
    }
  });

  // 5. Option structure: MCQ slots with recovered per-item counts must agree.
  questions.forEach((q, i) => {
    const counts = Array.isArray(q?.pattern?.optionCounts) ? q.pattern.optionCounts : [];
    // Mixed reference slots (some items with options, some without) are a
    // legitimate construction — per-item rules govern them, not uniformity.
    if (q?.type === 'MCQ' && counts.length > 1 && counts.every((c) => Number(c) >= 2)) {
      const distinct = [...new Set(counts)];
      if (distinct.length > 1) {
        push('SPEC_OPTION_COUNT_INCONSISTENT', `MCQ slot "${q.label}" carries mixed option counts [${distinct.join(', ')}].`, { slotIndex: i, field: 'pattern.optionCounts' });
      }
    }
    if (q?.type === 'INTERNAL_CHOICE') {
      const choiceCount = Number(q?.optionCount);
      if (!Number.isFinite(choiceCount) || choiceCount < 2) {
        push('SPEC_CHOICE_STRUCTURE', `INTERNAL_CHOICE slot "${q.label}" has no recovered choice pair (optionCount ${q?.optionCount ?? 'missing'}).`, { slotIndex: i, field: 'choices' });
      }
    }
    // MIXED integrity: a MIXED slot must expose ≥2 items whose types are not
    // all identical — otherwise it should carry the single homogeneous type.
    if (q?.type === 'MIXED') {
      const its = Array.isArray(q?.items) ? q.items : [];
      const typed = its.map((it) => normalizeBlueprintType(it?.type)).filter((t) => t && t !== 'UNKNOWN');
      if (its.length < 2) {
        push('SPEC_MIXED_ITEMS', `MIXED slot "${q.label}" needs at least 2 items with their own types.`, { slotIndex: i, field: 'items' });
      } else if (new Set(typed).size < 2) {
        push('SPEC_MIXED_HOMOGENEOUS', `MIXED slot "${q.label}" has fewer than 2 distinct item types — it should not be MIXED.`, { slotIndex: i, field: 'type' });
      }
    }
  });

  return { ok: issues.length === 0, issues };
}

export default { checkQuestion, validatePaper, findAnyN, summarize, validateSpec };