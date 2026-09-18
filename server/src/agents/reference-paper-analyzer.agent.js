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
import { reconcileBlueprint } from '../blueprint/extraction-reconciler.js';
import { validateSpec } from '../blueprint/blueprint-validator.js';
import { associateAssets, attachAssetsToQuestions, validateAssetStructure } from '../blueprint/asset-associator.js';

/** Analyzer capability marker (single source of truth for this module). */
export const ANALYZER_META = {
  role: 'reference-paper-analyzer',
  levels: ['paper', 'question', 'per-item'],
  determinism: 'deterministic (zero LLM)',
  specVersion: 'reference-paper-spec.v1',
};

/**
 * Detect explicit unit and topic markers from reference question text, section, or items.
 * Priority:
 *   1. Explicit Unit/Topic in paper
 *   2. Section/unit context
 *   3. Question text / topicAnchor
 *   4. Image caption text
 */
function resolveQuestionUnitTopic(q, paperText = '') {
  const explicitUnit = q.unit != null && String(q.unit).trim() !== '' ? String(q.unit).trim() : null;
  let unit = explicitUnit;
  let topic = q.topic || null;
  let confidence = 'HIGH';
  let unitSource = explicitUnit ? 'explicit' : null;

  // 1. Explicit Unit in question stem or items
  const combined = [q.instruction, q.stem, ...(q.referenceItems || []), ...(q.items || []).map((it) => it.referenceText || '')]
    .filter(Boolean)
    .join(' ');

  const unitMatch = !explicitUnit
    ? (combined.match(/\b(?:Unit|Chapter)\s*[-:]?\s*(\d+|[IVXLCDM]+)\b/i) ||
       (q.section ? String(q.section).match(/\b(?:Unit|Chapter)\s*[-:]?\s*(\d+|[IVXLCDM]+)\b/i) : null))
    : null;
  if (unitMatch) {
    unit = `Unit ${unitMatch[1]}`;
    unitSource = 'question';
  }

  // 2. Paper-level header/footer context — e.g. a banner line like
  //    "Unit 3 — Question Paper" or "Chapter XII — Practice Worksheet". A locked
  //    slot (IMAGE_BASED / MIXED) that belongs to this paper inherits that unit
  //    unless the question itself carries evidence of a DIFFERENT unit (the
  //    question/section matches above already ran and take precedence). This is
  //    generic: the number comes from the paper's own text, never from config.
  //    Only the HEADER REGION (first 600 chars) is scanned — a stray "Unit"
  //    mention deep inside unrelated question wording must not win.
  if (!unit && paperText) {
    // ONLY locked slots (IMAGE_BASED / MIXED) inherit from the paper header:
    // their unit must come from the reference evidence chain, never from the
    // teacher. Unlocked slots belong to the teacher's round-robin assignment.
    const isLockedSlot = q.type === 'IMAGE_BASED' || q.type === 'MIXED' || q.isLocked === true ||
      (Array.isArray(q.imageAssets) && q.imageAssets.length > 0);
    const paperMatch = isLockedSlot
      ? String(paperText).slice(0, 600).match(/\b(?:Unit|Chapter)\s*[-:.]?\s*(\d+|[IVXLCDM]+)\b/i)
      : null;
    if (paperMatch) {
      unit = `Unit ${paperMatch[1]}`;
      unitSource = 'paper';
      // Less specific than question/section evidence — confidence drops to
      // MEDIUM so downstream consumers can distinguish the two situations.
      if (confidence === 'HIGH') confidence = 'MEDIUM';
    }
  }

  // Topic anchor derivation from reference items or instruction
  if (!topic) {
    if (q.items && q.items.length > 0 && q.items[0].referenceText) {
      topic = q.items[0].referenceText.slice(0, 60);
    } else if (q.instruction) {
      topic = q.instruction.slice(0, 60);
    }
  }

  if (!unit && !topic) {
    confidence = 'LOW';
  }

  return { unit, topic, confidence, unitSource };
}

/**
 * Canonicalize a raw blueprint into the Reference Paper Specification: every
 * question is guaranteed to carry `items` / `itemMarks` arrays, an `index`,
 * and the analyzer meta. Additive only — existing fields are never dropped,
 * so this stays backward-compatible with every consumer (client, validator,
 * renderer).
 *
 * @param {Object} blueprint - extractBlueprint() output
 * @param {string} [paperText] - raw reference-paper text (header region is
 *   used for paper-level unit inheritance; optional for back-compat)
 * @returns {Object} canonical Reference Paper Specification
 */
export function buildCanonicalSpec(blueprint, paperText = '') {
  if (!blueprint || typeof blueprint !== 'object') return blueprint;

  const questions = (Array.isArray(blueprint.questions) ? blueprint.questions : [])
    .map((q, i) => {
      const isMixedType = q.type === 'MIXED';
      const isImageType = q.type === 'IMAGE_BASED' || (Array.isArray(q.imageAssets) && q.imageAssets.length > 0);
      const { unit, topic, confidence, unitSource } = resolveQuestionUnitTopic(q, paperText || blueprint.text || blueprint.paperText || '');

      return {
        ...q,
        index: i,
        type: isImageType ? 'IMAGE_BASED' : q.type,
        isLocked: isImageType || isMixedType || Boolean(q.isLocked),
        lockedFields: isImageType || isMixedType
          ? ['unit', 'topic', 'marks', 'type', 'items', 'options', 'layout']
          : q.lockedFields || [],
        detectedUnit: unit || q.unit || null,
        // Where the unit evidence came from: 'explicit' | 'question' |
        // 'section' | 'paper' — lets the client explain the inheritance and
        // lets tests assert the source without hard-coding any unit number.
        detectedUnitSource: unitSource,
        detectedTopic: topic || q.topic || null,
        topicConfidence: confidence,
        reviewRequired: confidence === 'LOW' && isImageType,
        items: Array.isArray(q.items) ? q.items : [],
        itemMarks: Array.isArray(q.itemMarks)
          ? q.itemMarks
          : (Array.isArray(q.items)
              ? q.items.map((it) => it?.marks).filter((m) => Number.isFinite(Number(m)) && Number(m) > 0)
              : []),
      };
    });

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
    // ADDITIVE (Phase 1): diagnostic summary + deterministic confidence.
    diagnosticCounts: (Array.isArray(spec?.diagnostics) ? spec.diagnostics : []).reduce(
      (acc, d) => ({ ...acc, [d.severity]: (acc[d.severity] ?? 0) + 1 }),
      {}
    ),
    confidence: spec?.confidence ?? null,
    // ADDITIVE (asset phase): image/table summary for diagnostics/logging.
    assetCounts: (Array.isArray(spec?.assets) ? spec.assets : []).reduce(
      (acc, a) => ({ ...acc, [a.type]: (acc[a.type] ?? 0) + 1 }),
      {}
    ),
    unassociatedAssets: (Array.isArray(spec?.assets) ? spec.assets : []).filter((a) => a.associatedQuestion == null).length,
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
    cognitiveOperation: q.cognitiveOperation ?? null,
    itemCount: items.length > 0 ? items.length : q.itemCount ?? 1,
    // OBSERVED (recovered) count — strictly separate from DECLARED itemCount.
    subQuestionCount: q.subQuestionCount ?? 0,
    perItem: items.map((it) => ({
      label: it.label,
      marks: it.marks,
      optionCount: it.optionCount,
      topicAnchor: it.referenceText,
      recovered: it.recovered !== false,
    })),
    topicAnchors: (q.referenceItems || []).slice(0, 12),
  };
}

/**
 * Analyze an already-extracted reference paper into the canonical
 * Reference Paper Specification.
 *
 * @param {Object} args - { questions: questionExtractor output, text?: raw text,
 *   extraction?: context, structuredDoc?: Docling StructuredDocument }
 * @returns {Object} canonical Reference Paper Specification
 */
export function analyzeReferencePaper({ questions = [], text = '', extraction = null, structuredDoc = null } = {}) {
  const raw = extractBlueprint({ questions, text });
  // PHASE 1 — extraction reconciliation: declared-vs-observed item padding,
  // structured slot-linked diagnostics, extraction metadata and deterministic
  // confidence. Pure and additive; blueprintWarnings stay untouched.
  const { blueprint: reconciled } = reconcileBlueprint(raw, { text, ...(extraction || {}) });
  const spec = buildCanonicalSpec(reconciled, text);

  // ASSET PHASE (additive): when a Docling StructuredDocument accompanies the
  // extraction, images/tables are associated with questions/sub-questions from
  // deterministic spatial + reading-order evidence. Anything ambiguous stays
  // null with a warning — never guessed. Without a structuredDoc nothing
  // changes (legacy text-only behavior is bit-for-bit identical).
  if (structuredDoc && typeof structuredDoc === 'object') {
    try {
      const { assets, diagnostics: assetDiags } = associateAssets({ doc: structuredDoc, questions: spec.questions });
      attachAssetsToQuestions(spec.questions, assets, structuredDoc);
      assetDiags.push(...validateAssetStructure(structuredDoc, assets));
      spec.assets = assets;
      spec.diagnostics = [...(Array.isArray(spec.diagnostics) ? spec.diagnostics : []), ...assetDiags];
    } catch (err) {
      // Asset analysis is additive intelligence — a failure must never break
      // the structural blueprint (same non-fatal contract as the analyzer).
      console.warn('[Reference Paper Analyzer] asset association failed (non-fatal):', err?.message ?? err);
    }
  }

  // Analyze-time specification validation (structural integrity only — not a
  // generated-content validator). Attached additively as `specValidation`.
  spec.specValidation = validateSpec(spec);
  return spec;
}

/**
 * Run the analyzer + a concise structural summary for logs/diagnostics.
 * @param {Object} args - same as analyzeReferencePaper
 * @returns {{ spec: Object, summary: Object, ok: boolean, warnings: Array }}
 */
export function runReferenceAnalysis({ questions = [], text = '', extraction = null, structuredDoc = null } = {}) {
  const spec = analyzeReferencePaper({ questions, text, extraction, structuredDoc });
  const summary = paperLevel(spec);
  const warnings = Array.isArray(spec.blueprintWarnings) ? spec.blueprintWarnings : [];
  return {
    spec,
    summary,
    ok: (spec.questions || []).length > 0,
    warnings,
    // ADDITIVE (Phase 1): structured diagnostics + spec validation result.
    diagnostics: Array.isArray(spec.diagnostics) ? spec.diagnostics : [],
    specValidation: spec.specValidation ?? null,
    // ADDITIVE (asset phase): extracted image/table assets with their
    // question/item associations (empty array for text-only papers).
    assets: Array.isArray(spec.assets) ? spec.assets : [],
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
