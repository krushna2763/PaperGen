/**
 * generation-worker.js
 *
 * Background worker service for executing generation jobs asynchronously.
 * Milestone M3: Wraps the existing orchestrator pipeline without duplicating
 * any generation, planning, RAG, GraphRAG, or validation logic.
 */
import { getJob, updateJob, updateSlot, finishJob, attachAbortController } from './job-store.js';
import { orchestrator } from '../agents/orchestrator.agent.js';

/**
 * Sanitize an error object so internal prompts, credentials, API keys, and
 * full stack traces are not leaked into the job store or client-facing responses.
 *
 * @param {Error|Object|string} error
 * @returns {{ code: string, message: string }}
 */
export function sanitizeError(error) {
  if (!error) {
    return { code: 'UNKNOWN_ERROR', message: 'Unknown error occurred.' };
  }
  let message = typeof error === 'string' ? error : (error.message || 'Paper generation failed.');

  // Strip any accidental API keys, tokens, or hashes
  message = message.replace(/(?:sk-[a-zA-Z0-9_-]{20,}|AIza[a-zA-Z0-9_-]{30,}|eyJ[a-zA-Z0-9_-]{30,})/g, '[REDACTED_SECRET]');
  // Strip absolute local filesystem paths
  message = message.replace(/[A-Za-z]:\\[^:\s"'\n]+/g, '[REDACTED_PATH]');

  return {
    code: error.code || 'GENERATION_FAILED',
    message,
  };
}

/**
 * Execute a single generation job through the existing pipeline.
 *
 * @param {string} jobId
 * @returns {Promise<Object|null>} The final job state or null if not found
 */
export async function runGenerationJob(jobId) {
  const job = getJob(jobId);
  if (!job) return null;

  // 1. Claim job: Only "queued" jobs can be claimed and executed.
  // Prevents duplicate execution if invoked multiple times or already terminal.
  if (job.status !== 'queued') {
    return job;
  }

  // 2. Setup AbortController and transition to running
  const controller = new AbortController();
  attachAbortController(jobId, controller);

  updateJob(jobId, {
    status: 'running',
    currentStage: 'running',
    message: 'Generating paper in background...',
  });

  // Preserve existing slot tracking by marking slots in-flight
  for (const s of (job.slots || [])) {
    updateSlot(jobId, s.slot, { state: 'generating' });
  }

  // Check for early cancellation before invoking orchestrator
  if (controller.signal.aborted || getJob(jobId)?.status === 'cancelled') {
    return getJob(jobId);
  }

  // 3. Validate generation payload
  const metadata = job.metadata || {};
  const blueprint = metadata.blueprint;

  if (!blueprint || typeof blueprint !== 'object' || !Array.isArray(blueprint.questions) || blueprint.questions.length === 0) {
    updateJob(jobId, {
      status: 'failed',
      currentStage: 'failed',
      message: 'Job is missing required blueprint data.',
      error: {
        code: 'INVALID_METADATA',
        message: 'Job is missing required blueprint data.',
      },
    });
    return getJob(jobId);
  }

  // 4. Execute existing orchestrator pipeline
  try {
    const result = await orchestrator.generate({
      class: metadata.class ?? '',
      subject: metadata.subject ?? '',
      difficulty: metadata.difficulty,
      questionCount: blueprint.questions.length,
      blueprint,
      slotUnitMap: metadata.slotUnitMap,
      jobId,
    });

    // 5. Post-generation cancellation check
    const postCheck = getJob(jobId);
    if (!postCheck || postCheck.status === 'cancelled' || controller.signal.aborted || result === null) {
      return postCheck;
    }

    // 6. Complete job and store result
    finishJob(jobId);

    const message = result?.rejected && result.rejected.length > 0
      ? `Generated ${result.questions?.length ?? 0} question(s); ${result.rejected.length} rejected after validation.`
      : `Generated ${result?.questions?.length ?? 0} question(s) successfully.`;

    updateJob(jobId, {
      status: 'completed',
      currentStage: 'completed',
      message,
      result,
    });

    return getJob(jobId);
  } catch (error) {
    // 7. Error handling: Respect cancellation vs real failure
    const errorCheck = getJob(jobId);
    if (!errorCheck || errorCheck.status === 'cancelled' || controller.signal.aborted || error?.isCancellation || error.name === 'AbortError') {
      return errorCheck;
    }

    updateJob(jobId, {
      status: 'failed',
      currentStage: 'failed',
      message: 'Paper generation failed.',
      error: sanitizeError(error),
    });

    return getJob(jobId);
  }
}

/**
 * Safely schedule a generation job to run asynchronously in the background.
 * Ensures the scheduling returns immediately without unhandled promise rejections.
 *
 * @param {string} jobId
 */
export function scheduleGenerationJob(jobId) {
  setImmediate(() => {
    runGenerationJob(jobId).catch((err) => {
      console.error(`[Generation Worker] Uncaught background error for job ${jobId}:`, err?.message || err);
    });
  });
}

export default {
  runGenerationJob,
  scheduleGenerationJob,
  sanitizeError,
};
