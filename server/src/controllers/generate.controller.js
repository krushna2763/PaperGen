import { orchestrator } from '../agents/orchestrator.agent.js';
import { getJob, updateSlot, finishJob } from '../services/job-store.js';
import { validateSlotUnitMap } from '../blueprint/slot-unit-map.js';

/**
 * POST /api/papers/:jobId/generate   { blueprint, difficulty, slotUnitMap }
 *
 * The blueprint and slotUnitMap come from the REQUEST BODY, never a
 * server-side stored copy — the teacher may have corrected a parsing error at
 * the confirm step. The job store is used only for per-slot progress.
 */
export const generatePaper = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const body = req.body || {};
    const { blueprint, difficulty, slotUnitMap } = body;

    const job = getJob(jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: `Unknown jobId "${jobId}". Call POST /api/papers/analyze first.` });
    }

    // The blueprint MUST arrive in the body. (This is also the structural fix
    // for the old App.jsx bug where blueprint was never sent.)
    if (!blueprint || typeof blueprint !== 'object' || !Array.isArray(blueprint.questions) || blueprint.questions.length === 0) {
      return res.status(400).json({
        success: false,
        message: '"blueprint" must be sent in the request body (with a non-empty questions array). Server-side copies are never used.',
      });
    }

    const cls = String(blueprint.paper?.class ?? body.class ?? '').trim();
    const subject = String(blueprint.paper?.subject ?? body.subject ?? '').trim();

    const check = await validateSlotUnitMap(slotUnitMap, blueprint, { class: cls, subject });
    if (!check.ok) {
      return res.status(422).json({
        success: false,
        message: 'slotUnitMap validation failed. Fix the listed slot(s) and resubmit.',
        errors: check.errors,
      });
    }

    // Mark every slot in-flight so the first status poll is not a blank spinner.
    for (const s of job.slots) updateSlot(jobId, s.slot, { state: 'generating' });

    const result = await orchestrator.generate({
      class: cls,
      subject,
      difficulty,
      questionCount: blueprint.questions.length,
      blueprint,
      slotUnitMap,
      jobId,
    });

    finishJob(jobId);

    return res.status(200).json({
      success: true,
      message:
        result.rejected.length > 0
          ? `Generated ${result.questions.length} question(s); ${result.rejected.length} rejected after validation.`
          : `Generated ${result.questions.length} question(s) successfully.`,
      data: result,
    });
  } catch (error) {
    console.error('[Generate Controller] Error:', error.message);
    next(error);
  }
};

/** GET /api/papers/:jobId/status  ->  { done, slots: [{ slot, label, state, attempts }] } */
export const jobStatus = (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ done: false, slots: [], error: 'Unknown jobId.' });
  }
  return res.status(200).json({ done: job.done, slots: job.slots });
};

export default { generatePaper, jobStatus };
