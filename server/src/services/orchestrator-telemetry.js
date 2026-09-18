/**
 * orchestrator-telemetry.js
 *
 * Real-time generation telemetry service for LangGraph and orchestrator pipeline.
 * Milestone M5: Emits structured stage, slot_progress, log, complete, error,
 * and cancelled events to the M1 Job Store.
 *
 * Invariants:
 *  - Single source of truth: Writes exclusively through M1 jobStore (emitJobEvent / updateJob)
 *  - Best-effort: Telemetry failure NEVER breaks paper generation
 *  - Safe no-op: When jobId is missing or unknown, all functions return null safely
 *  - Monotonic progress: Progress percentage never regresses
 *  - Sanitized: Redacts API keys, secrets, prompts, stack traces, and local paths
 *  - Zero additional AI/vector calls: Purely observational metadata
 */
import { getJob, updateJob, emitJobEvent, VALID_STAGES, STAGE_PROGRESS } from './job-store.js';

/**
 * Redact sensitive information (API keys, authorization tokens, absolute local filesystem paths,
 * raw prompts, stack traces) from telemetry payloads.
 *
 * @param {*} data
 * @returns {Object}
 */
export function sanitizeTelemetryData(data) {
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object') {
    return { value: String(data) };
  }
  try {
    const str = JSON.stringify(data);
    const sanitized = str
      .replace(/(?:sk-[a-zA-Z0-9_-]{20,}|AIza[a-zA-Z0-9_-]{30,}|eyJ[a-zA-Z0-9_-]{30,})/g, '[REDACTED_SECRET]')
      .replace(/[A-Za-z]:\\[^:\s"'\n]+/g, '[REDACTED_PATH]');
    const parsed = JSON.parse(sanitized);

    // Explicitly delete sensitive internal fields if present
    delete parsed.prompt;
    delete parsed.prompts;
    delete parsed.rawResponse;
    delete parsed.chainOfThought;
    delete parsed.reasoning;
    delete parsed.stack;
    delete parsed.apiKey;
    delete parsed.token;

    return parsed;
  } catch {
    return { message: 'Sanitization fallback' };
  }
}

/**
 * Emit a structured telemetry event for a job.
 * Updates job currentStage / progressPercent where applicable and appends event to Job Store.
 * Safe no-op if jobId is null or unknown.
 *
 * @param {string|null} jobId
 * @param {string} type - Event type (stage, slot_progress, log, complete, error, cancelled)
 * @param {Object} data - Event data payload
 * @returns {Object|null}
 */
export function emitTelemetryEvent(jobId, type, data = {}) {
  if (!jobId) return null;

  try {
    const job = getJob(jobId);
    if (!job) return null;

    // Do not emit non-cancellation events for already cancelled jobs
    if (job.status === 'cancelled' && type !== 'cancelled') {
      return null;
    }

    const sanitizedData = sanitizeTelemetryData(data);

    // Progress monotonic guard: never let progress decrease
    const currentProgress = typeof job.progressPercent === 'number' ? job.progressPercent : 0;

    if (type === 'stage') {
      const stage = sanitizedData.stage;
      const targetProgress = sanitizedData.progressPercent != null
        ? Number(sanitizedData.progressPercent)
        : (STAGE_PROGRESS[stage] ?? currentProgress);

      const monotonicProgress = Math.max(currentProgress, targetProgress);
      sanitizedData.progressPercent = monotonicProgress;

      if (stage && VALID_STAGES.has(stage)) {
        updateJob(jobId, {
          currentStage: stage,
          progressPercent: monotonicProgress,
          message: sanitizedData.message || job.message,
        });
      }
    } else if (type === 'slot_progress') {
      if (sanitizedData.progressPercent != null) {
        sanitizedData.progressPercent = Math.max(0, Math.min(100, Number(sanitizedData.progressPercent)));
      }
    } else if (type === 'complete') {
      sanitizedData.progressPercent = 100;
      updateJob(jobId, {
        currentStage: 'completed',
        progressPercent: 100,
        message: sanitizedData.message || 'Generation completed.',
      });
    } else if (type === 'error') {
      sanitizedData.progressPercent = 100;
      updateJob(jobId, {
        currentStage: 'failed',
        progressPercent: 100,
        message: sanitizedData.message || 'Generation failed.',
      });
    }

    return emitJobEvent(jobId, type, sanitizedData);
  } catch (err) {
    // Best-effort invariant: Telemetry failure must never break generation
    console.warn(`[Telemetry] Failed to emit ${type} for job ${jobId}:`, err?.message || err);
    return null;
  }
}

/**
 * Emit a pipeline stage transition event.
 *
 * @param {string|null} jobId
 * @param {string} stage - One of VALID_STAGES
 * @param {Object} [options]
 * @param {number} [options.progressPercent]
 * @param {string} [options.message]
 * @param {Object} [options.extra]
 * @returns {Object|null}
 */
export function emitStageEvent(jobId, stage, options = {}) {
  if (!jobId) return null;
  const progressPercent = options.progressPercent ?? STAGE_PROGRESS[stage] ?? 0;
  return emitTelemetryEvent(jobId, 'stage', {
    stage,
    progressPercent,
    message: options.message || `Stage: ${stage}`,
    ...(options.extra || {}),
  });
}

/**
 * Emit a slot progress update event.
 *
 * @param {string|null} jobId
 * @param {Object} params
 * @param {number} params.slotIndex
 * @param {string} [params.questionNumber]
 * @param {string} params.status - 'generating' | 'completed' | 'regenerating' | 'failed'
 * @param {number} [params.progressPercent]
 * @param {number} [params.attempt]
 * @param {string[]} [params.reasons]
 * @returns {Object|null}
 */
export function emitSlotProgress(jobId, { slotIndex, questionNumber, status, progressPercent, attempt, reasons } = {}) {
  if (!jobId) return null;
  return emitTelemetryEvent(jobId, 'slot_progress', {
    slotIndex: Number(slotIndex),
    questionNumber: String(questionNumber || `Q${Number(slotIndex) + 1}`),
    status: String(status || 'generating'),
    ...(progressPercent != null ? { progressPercent: Number(progressPercent) } : {}),
    ...(attempt != null ? { attempt: Number(attempt) } : {}),
    ...(Array.isArray(reasons) && reasons.length > 0 ? { reasons: reasons.slice(0, 3) } : {}),
  });
}

/**
 * Emit a targeted regeneration stage event.
 * Reports only failed/non-conforming slots. Accepted slots are NEVER reported as regenerating.
 *
 * @param {string|null} jobId
 * @param {Object} params
 * @param {number[]} params.failedSlots - Array of numeric slot indices
 * @param {number} [params.attempt]
 * @param {string} [params.message]
 * @returns {Object|null}
 */
export function emitRegenerationStage(jobId, { failedSlots = [], attempt, message } = {}) {
  if (!jobId) return null;
  const slotList = (Array.isArray(failedSlots) ? failedSlots : []).map(Number);
  return emitTelemetryEvent(jobId, 'stage', {
    stage: 'targeted_regeneration',
    progressPercent: 85,
    message: message || `Regenerating failed question(s) for slot(s): ${slotList.map((s) => `Q${s + 1}`).join(', ')}`,
    failedSlots: slotList,
    ...(attempt != null ? { attempt: Number(attempt) } : {}),
  });
}

/**
 * Emit a diagnostic log event.
 *
 * @param {string|null} jobId
 * @param {string} level - 'info' | 'warn' | 'error'
 * @param {string} message
 * @param {Object} [extra]
 * @returns {Object|null}
 */
export function emitLogEvent(jobId, level, message, extra = {}) {
  if (!jobId) return null;
  return emitTelemetryEvent(jobId, 'log', {
    level: String(level || 'info'),
    message: String(message || ''),
    ...(extra && typeof extra === 'object' ? extra : {}),
  });
}

/**
 * Emit completion event.
 * Does not expose the full paper payload over telemetry.
 *
 * @param {string|null} jobId
 * @param {Object} [summary]
 * @returns {Object|null}
 */
export function emitComplete(jobId, summary = {}) {
  if (!jobId) return null;
  return emitTelemetryEvent(jobId, 'complete', {
    jobId: String(jobId),
    status: 'completed',
    progressPercent: 100,
    message: summary.message || 'Paper generation completed successfully.',
    totalAccepted: summary.totalAccepted,
    totalRejected: summary.totalRejected,
  });
}

/**
 * Emit error event.
 *
 * @param {string|null} jobId
 * @param {Error|Object|string} error
 * @returns {Object|null}
 */
export function emitError(jobId, error = {}) {
  if (!jobId) return null;
  const message = typeof error === 'string' ? error : (error?.message || 'Paper generation failed.');
  return emitTelemetryEvent(jobId, 'error', {
    jobId: String(jobId),
    status: 'failed',
    progressPercent: 100,
    message,
    code: error?.code || 'GENERATION_FAILED',
  });
}

/**
 * Emit cancellation event.
 *
 * @param {string|null} jobId
 * @param {Object} [options]
 * @returns {Object|null}
 */
export function emitCancelled(jobId, options = {}) {
  if (!jobId) return null;
  return emitTelemetryEvent(jobId, 'cancelled', {
    jobId: String(jobId),
    status: 'cancelled',
    progressPercent: options.progressPercent ?? 100,
    message: options.message || 'Paper generation cancelled.',
  });
}

export default {
  emitTelemetryEvent,
  emitStageEvent,
  emitSlotProgress,
  emitRegenerationStage,
  emitLogEvent,
  emitComplete,
  emitError,
  emitCancelled,
  sanitizeTelemetryData,
};
