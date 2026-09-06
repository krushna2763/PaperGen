/**
 * reference-paper-analyzer.agent.js
 *
 * REFERENCE PAPER ANALYZER AGENT — the dedicated FIRST stage of blueprint-mode
 * generation. Its only job is to understand the uploaded reference paper and
 * convert it into a canonical, machine-readable Reference Paper Specification.
 *
 * The Generation Agent never interprets the original PDF structure itself: it
 * receives the locked slots of this specification (types, marks, per-item
 * topics, construction patterns) and only fills them with NEW content.
 *
 * The analyzer is DETERMINISTIC and zero-Gemini (deliberate):
 *   - PDF structure is parsed once by the existing question extractor.
 *   - extractBlueprint() turns the parsed questions into the locked structure.
 *   - buildCanonicalSpec() enriches every question with the per-item spec:
 *     one structured object per reference sub-question ({ label, marks,
 *     referenceText → topic anchor, optionCount }) so per-item marks and the
 *     per-item topic mapping survive end-to-end.
 *
 * Nothing is invented: fields the extractor cannot recover stay null and are
 * surfaced in blueprintWarnings. Semantic topic *judgments* (is the new item
 * on the same concept?) are performed later by the validation agent and by
 * per-slot RAG — never fabricated here.
 *
 * Responsibilities stay separated (never mixed):
 *   - analyzer       : question structure / pattern / topics / marks / order
 *   - template       : fonts / margins / header / page layout (visual)
 *   - RAG            : academic content
 *   - difficulty     : cognitive complexity (content-only knob)
 *   - generator      : NEW content inside the locked specification
 */

import { extractBlueprint } from '../blueprint/blueprint-extractor.js';

/** Analyzer capability marker (single source of truth for this module). */
export const ANALYZER_META = {
  role: 'reference-paper-analyzer',
  levels: ['paper', 'question', 'per-item'],
  determinism: 'deterministic (zero LLM)',
  specVersion: 'reference-paper-spec.v1',
};

/**
 * Canonicalize a raw blueprint into the Reference Paper Specification: every
 * question is guaranteed to carry `items` / `itemMarks` arrays, an `index`,
 * and the analyzer meta. Additive only — existing fields are never dropped,
 * so this stays backward-compatible with every consumer (client, validator,
 * renderer).
 *
 * @param {Object} blueprint - extractBlueprint() output
 * @returns {Object} canonical Reference Paper Specification
 */
export function buildCanonicalSpec(blueprint) {
  if (!blueprint || typeof blueprint !== 'object') return blueprint;

  const questions = (Array.isArray(blueprint.questions) ? blueprint.questions : [])
    .map((q, i) => ({
      ...q,
      index: i,
      items: Array.isArray(q.items) ? q.items : [],
      itemMarks: Array.isArray(q.itemMarks)
        ? q.itemMarks
        : (Array.isArray(q.items)
            ? q.items.map((it) => it?.marks).filter((m) => Number.isFinite(Number(m)) && Number(m) > 0)
            : []),
    }));

  return {
    ...blueprint,
    questions,
    specVersion: ANALYZER_META.specVersion,
    analyzer: { ...ANALYZER_META },
  };
}

/**
 * PAPER LEVEL analysis summary (derived, deterministic — never hard-coded).
 * @param {Object} spec - canonical Reference Paper Specification
 * @returns {Object} { header, studentInstructions, sectionCount, sections,
 *   questionCount, questionLabels, totalMarks, marksComplete, warnings }
 */
export function paperLevel(spec) {
  const questions = Array.isArray(spec?.questions) ? spec.questions : [];
  return {
    header: spec?.paper ?? {},
    studentInstructions: Array.isArray(spec?.studentInstructions) ? spec.studentInstructions : [],
    sectionCount: Array.isArray(spec?.sections) ? spec.sections.length : 0,
    sections: (spec?.sections || []).map((s) => ({
      name: s.name,
      title: s.title,
      questionNumbers: s.questionNumbers,
    })),
    questionCount: questions.length,
    questionLabels: questions.map((q) => q.label),
    totalMarks: spec?.totalMarks ?? null,
    marksComplete: spec?.marksComplete ?? false,
    warnings: Array.isArray(spec?.blueprintWarnings) ? spec.blueprintWarnings : [],
  };
}

/**
 * QUESTION / SUBQUESTION level analysis summary for one slot.
 * @param {Object} q - canonical question from the spec
 * @returns {Object} per-question + per-item structural summary
 */
export function questionLevel(q) {
  if (!q) return null;
  const items = Array.isArray(q.items) ? q.items : [];
  return {
    number: q.number,
    label: q.label,
    section: q.sectionName ?? q.section ?? null,
    type: q.type,
    instruction: q.instruction ?? q.stem ?? null,
    marks: {
      perItem: q.marks?.perItem ?? q.marksPerItem ?? null,
      itemCount: q.itemCount,
      total: q.totalMarks,
      expression: q.markExpression ?? q.marks?.expression ?? null,
    },
    optionalRule: q.optionalRule ?? null,
    construction: q.pattern ?? {},
    itemCount: items.length > 0 ? items.length : q.itemCount ?? 1,
    perItem: items.map((it) => ({
      label: it.label,
      marks: it.marks,
      optionCount: it.optionCount,
      topicAnchor: it.referenceText,
    })),
    topicAnchors: (q.referenceItems || []).slice(0, 12),
  };
}

/**
 * Analyze an already-extracted reference paper into the canonical
 * Reference Paper Specification.
 *
 * @param {Object} args - { questions: questionExtractor output, text?: raw text }
 * @returns {Object} canonical Reference Paper Specification
 */
export function analyzeReferencePaper({ questions = [], text = '' } = {}) {
  const blueprint = extractBlueprint({ questions, text });
  return buildCanonicalSpec(blueprint);
}

/**
 * Run the analyzer + a concise structural summary for logs/diagnostics.
 * @param {Object} args - same as analyzeReferencePaper
 * @returns {{ spec: Object, summary: Object, ok: boolean, warnings: Array }}
 */
export function runReferenceAnalysis({ questions = [], text = '' } = {}) {
  const spec = analyzeReferencePaper({ questions, text });
  const summary = paperLevel(spec);
  const warnings = Array.isArray(spec.blueprintWarnings) ? spec.blueprintWarnings : [];
  return {
    spec,
    summary,
    ok: (spec.questions || []).length > 0,
    warnings,
  };
}

export default {
  ANALYZER_META,
  analyzeReferencePaper,
  buildCanonicalSpec,
  paperLevel,
  questionLevel,
  runReferenceAnalysis,
};
