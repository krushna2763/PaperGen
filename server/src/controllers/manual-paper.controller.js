/**
 * manual-paper.controller.js — POST /api/papers/manual (Mode B entry point).
 *
 * Teacher-defined structure → contract-compliant blueprint → the SAME job
 * shape POST /papers/analyze returns, so the client reaches the existing
 * confirm and generate steps with NO changes. Generation continues to use
 * POST /papers/:jobId/generate unmodified (no pipeline fork).
 *
 * Blocking validation (422, every error names its slot):
 *   - registry question type
 *   - itemCount >= registry minimum
 *   - option-bearing types carry optionCount >= 2
 *   - every item has marks (never auto-distributed)
 *   - sections complete — no question outside a declared section
 *   - every referenced unit has notes (only when a slotUnitMap accompanies
 *     the blueprint; otherwise the confirm screen + generate enforce it, as
 *     in Mode A — one rule, one validator, no duplication)
 *
 * Non-blocking warnings ride blueprintWarnings: marks-sum vs declared total,
 * unmatched topic coverage, no-topic questions.
 */
import { buildManualBlueprint, unitErrorsFor, attachTopicCoverage } from '../blueprint/manual-blueprint.js';
import { checkBlueprintShape } from '../blueprint/blueprint-schema.js';
import { qdrantStore } from '../rag/qdrant.js';
import { deriveAvailableUnits } from '../blueprint/available-units.js';
import { createJob } from '../services/job-store.js';

/** 422 body in the established slot-named error shape. */
function validationResponse(res, errors, warnings = []) {
  return res.status(422).json({
    success: false,
    message: 'Manual blueprint validation failed. Fix the listed slot(s) and resubmit.',
    errors,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

export const createManualPaper = async (req, res, next) => {
  try {
    const body = req.body || {};
    const form = body.blueprint ?? body; // accept { blueprint } or the raw form

    const cls = String(form?.paper?.class ?? body.class ?? '').trim();
    const subject = String(form?.paper?.subject ?? body.subject ?? '').trim();

    // 1) Build + sync-validate (registry, counts, options, marks, sections).
    //    builder output survives the UNMODIFIED normalizer — the contract proof.
    let built;
    try {
      built = buildManualBlueprint(form, { validate: true });
    } catch (err) {
      return res.status(err.status || 400).json({ success: false, message: err.message });
    }
    if (!built.ok) {
      return validationResponse(res, built.errors, built.warnings);
    }
    const blueprint = built.blueprint;

    // 2) Async blocking checks: referenced units (only when slotUnitMap sent).
    const unitErrors = await unitErrorsFor(blueprint, {
      class: cls,
      subject,
      slotUnitMap: body.slotUnitMap ?? form.slotUnitMap ?? null,
    });
    if (unitErrors.length > 0) {
      return validationResponse(res, unitErrors, built.warnings);
    }

    // 3) Shape gate — the same lenient check orchestrator applies to Mode A.
    const shape = checkBlueprintShape(blueprint);
    if (!shape.ok) {
      return validationResponse(
        res,
        shape.reasons.map((r) => ({ slot: null, message: r })),
        built.warnings
      );
    }

    // 4) Non-blocking: topic coverage warnings (advisory, never a block).
    let coverageWarnings = [];
    try {
      coverageWarnings = await attachTopicCoverage(blueprint, { class: cls, subject });
      blueprint.blueprintWarnings.push(...coverageWarnings);
    } catch (err) {
      console.warn('[Manual Controller] topic coverage skipped (non-fatal):', err.message);
    }

    // 5) Job + availableUnits — the EXACT analyze response shape.
    const unitsWithNotes = await qdrantStore.listUnitsWithNotes({ class: cls, subject });
    const availableUnits = deriveAvailableUnits({ unitsWithNotes });
    const jobId = createJob(blueprint);

    console.log(
      `[Manual Controller] manual: job ${jobId} — ${blueprint.questions.length} slot(s), ` +
      `${(blueprint.sections || []).length} section(s), ${availableUnits.length} syllabus unit(s) with notes` +
      `${coverageWarnings.length > 0 ? `, ${coverageWarnings.length} topic warning(s)` : ''}.`
    );

    return res.status(200).json({ jobId, blueprint, availableUnits });
  } catch (error) {
    console.error('[Manual Controller] Error:', error);
    next(error);
  }
};

export default { createManualPaper };
