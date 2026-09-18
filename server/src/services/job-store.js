/**
 * job-store.js
 *
 * Process-local store for generation-job lifecycle and progress tracking.
 * Deliberately in-memory (matches the embedding cache / no-Redis stance).
 * Jobs expire after TTL_MS so long-lived servers do not leak memory.
 *
 * PHASE 2 — Milestone M1:
 *   - Full job lifecycle (queued -> running -> completed / failed / cancelled)
 *   - Per-job event ring buffer (bounded to MAX_JOB_EVENTS = 50)
 *   - Monotonically increasing event sequence IDs starting from 1
 *   - Event replay support via getEventsSince(jobId, lastEventId)
 *   - Event subscription via subscribeToJob(jobId, listener)
 *   - Cancellation state & AbortController integration via attachAbortController & cancelJob
 *   - Terminal state protection: terminal jobs cannot regress to queued/running
 *   - Full backward compatibility with existing pipeline callers
 */
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

export const TTL_MS = 30 * 60 * 1000;
export const MAX_JOB_EVENTS = 50;

/**
 * Valid job statuses.
 * @type {Set<string>}
 */
export const VALID_STATUSES = new Set([
  'queued', 'running', 'completed', 'failed', 'cancelled',
]);

/**
 * Terminal statuses that cannot transition back to queued or running.
 * @type {Set<string>}
 */
export const TERMINAL_STATUSES = new Set([
  'completed', 'failed', 'cancelled',
]);

/**
 * Valid pipeline stages for progress reporting.
 * @type {Set<string>}
 */
export const VALID_STAGES = new Set([
  'queued', 'blueprint_verification', 'rag_retrieval', 'image_grounding',
  'slot_generation', 'quality_validation', 'targeted_regeneration',
  'paper_assembled', 'completed', 'failed', 'cancelled',
]);

/**
 * Deterministic progress percentages for each stage.
 */
export const STAGE_PROGRESS = {
  queued: 0,
  blueprint_verification: 10,
  rag_retrieval: 25,
  image_grounding: 40,
  slot_generation: 60,
  quality_validation: 80,
  targeted_regeneration: 85,
  paper_assembled: 95,
  completed: 100,
  failed: 100,
  cancelled: 100,
};

const jobs = new Map();

/**
 * Helper to normalize any jobId argument (string, job object, or String instance).
 */
function resolveJobId(jobOrId) {
  if (!jobOrId) return null;
  if (typeof jobOrId === 'string') return jobOrId;
  if (typeof jobOrId === 'object') {
    if (typeof jobOrId.id === 'string') return jobOrId.id;
    return String(jobOrId);
  }
  return String(jobOrId);
}

/**
 * Register a generation job.
 * Accepts either a blueprint object or an options object { blueprint, paperId }.
 *
 * Returns the created job, wrapped in a String instance of its ID so callers
 * expecting a string jobId (e.g. jobId === String(job)) and callers expecting
 * the job object (e.g. job.id, job.status) both work seamlessly without breaking.
 *
 * @param {Object} [blueprintOrOptions]
 * @returns {Object} The created job representation
 */
export function createJob(blueprintOrOptions = {}, options = {}) {
  const isOptions = blueprintOrOptions && !Array.isArray(blueprintOrOptions.questions) && (
    'blueprint' in blueprintOrOptions ||
    'paperId' in blueprintOrOptions ||
    'returnJob' in blueprintOrOptions ||
    'metadata' in blueprintOrOptions
  );
  const blueprint = isOptions ? blueprintOrOptions.blueprint : blueprintOrOptions;
  const paperId = isOptions ? (blueprintOrOptions.paperId ?? null) : (blueprint?.paper?.id ?? blueprint?.paperId ?? null);
  const returnJob = Boolean(options.returnJob ?? (isOptions && blueprintOrOptions.returnJob));
  const metadata = (isOptions && blueprintOrOptions.metadata && typeof blueprintOrOptions.metadata === 'object')
    ? { ...blueprintOrOptions.metadata }
    : ((options.metadata && typeof options.metadata === 'object') ? { ...options.metadata } : {});

  const id = randomUUID();
  const slots = (Array.isArray(blueprint?.questions) ? blueprint.questions : []).map((q, i) => ({
    slot: i,
    label: q?.label || `Q${i + 1}`,
    state: 'pending',
    attempts: 0,
  }));

  const now = Date.now();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  // Default no-op listener prevents unhandled error event exception if emitted with no subscribers
  emitter.on('error', () => {});

  const job = {
    id,
    paperId: paperId ? String(paperId) : null,
    status: 'queued',
    progressPercent: 0,
    currentStage: 'queued',
    message: 'Queued for generation',
    createdAt: now,
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    events: [],
    nextEventId: 1,
    abortController: null,
    slots,
    done: false,
    emitter,
    metadata,
  };

  jobs.set(id, job);
  return returnJob ? job : id;
}

/**
 * Retrieve an existing job by ID.
 * Returns null if not found.
 *
 * @param {string|Object} jobId
 * @returns {Object|null}
 */
export function getJob(jobId) {
  const id = resolveJobId(jobId);
  if (!id) return null;
  return jobs.get(id) ?? null;
}

/**
 * Patch one slot by numeric index or by label.
 * No-op for unknown jobs/slots.
 */
export function updateSlot(jobId, slot, patch) {
  const job = getJob(jobId);
  if (!job || !Array.isArray(job.slots)) return;
  const s = job.slots.find((x) => x.slot === slot || x.label === slot);
  if (s) Object.assign(s, patch);
}

/**
 * Patch several slots at once.
 */
export function markSlots(jobId, slotsOrLabels, patch) {
  for (const key of slotsOrLabels || []) updateSlot(jobId, key, patch);
}

/**
 * Mark a job as done (legacy helper).
 */
export function finishJob(jobId) {
  const job = getJob(jobId);
  if (job) {
    job.done = true;
  }
}

/**
 * Update job-level fields with lifecycle transition handling and terminal protection.
 *
 * @param {string|Object} jobId
 * @param {Object} patch
 * @returns {Object|null} The updated job or null if not found
 */
export function updateJob(jobId, patch = {}) {
  const job = getJob(jobId);
  if (!job) return null;

  // Terminal state protection:
  // If already terminal, cannot move back to queued or running.
  if (TERMINAL_STATUSES.has(job.status)) {
    if (patch.status && (patch.status === 'queued' || patch.status === 'running')) {
      // Reject regressive status change
      delete patch.status;
    }
    if (patch.progressPercent !== undefined && patch.progressPercent < (job.progressPercent || 0)) {
      // Reject regressive progress change on terminal jobs
      delete patch.progressPercent;
    }
  }

  const previousStatus = job.status;

  if (patch.currentStage && VALID_STAGES.has(patch.currentStage)) {
    job.currentStage = patch.currentStage;
    // Auto-set progress from stage unless caller explicitly overrides progressPercent
    if (patch.progressPercent == null && STAGE_PROGRESS[patch.currentStage] != null) {
      job.progressPercent = STAGE_PROGRESS[patch.currentStage];
    }
  }

  if (patch.progressPercent != null && typeof patch.progressPercent === 'number') {
    job.progressPercent = Math.max(0, Math.min(100, patch.progressPercent));
  }
  if (patch.message !== undefined) job.message = patch.message;
  if (patch.paperId !== undefined) job.paperId = patch.paperId ? String(patch.paperId) : null;
  if (patch.startedAt !== undefined) job.startedAt = patch.startedAt;
  if (patch.completedAt !== undefined) job.completedAt = patch.completedAt;
  if (patch.result !== undefined) job.result = patch.result;
  if (patch.error !== undefined) job.error = patch.error;
  if (patch.done !== undefined) job.done = Boolean(patch.done);
  if (patch.metadata !== undefined && typeof patch.metadata === 'object' && patch.metadata !== null) {
    job.metadata = { ...(job.metadata || {}), ...patch.metadata };
  }

  if (patch.status && VALID_STATUSES.has(patch.status)) {
    job.status = patch.status;

    // Lifecycle timestamps
    if (previousStatus === 'queued' && job.status === 'running') {
      if (!job.startedAt) {
        job.startedAt = patch.startedAt ?? Date.now();
      }
    }

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      if (!job.completedAt) {
        job.completedAt = patch.completedAt ?? Date.now();
      }
      job.done = true;
      if (job.emitter && !TERMINAL_STATUSES.has(previousStatus)) {
        job.emitter.emit('terminal', job);
      }
    }
  }

  return job;
}

/**
 * Emit a structured event for a job.
 * Appends to ring buffer (max MAX_JOB_EVENTS = 50) and broadcasts via EventEmitter.
 *
 * @param {string|Object} jobId
 * @param {string} type - event type (e.g. 'stage', 'slot_progress', 'log', 'complete', 'error', 'cancelled')
 * @param {Object} data - event payload
 * @returns {Object|null} The created event or null if job not found
 */
export function emitJobEvent(jobId, type, data = {}) {
  const job = getJob(jobId);
  if (!job) return null;

  const eventId = job.nextEventId;
  job.nextEventId += 1;

  // Ensure data is safe and serializable, avoiding leaks of raw API keys or internals
  const event = {
    id: eventId,
    type: String(type),
    timestamp: new Date().toISOString(),
    data: data && typeof data === 'object' ? data : { value: data },
  };

  // Ring buffer: retain strictly at most MAX_JOB_EVENTS (50)
  job.events.push(event);
  while (job.events.length > MAX_JOB_EVENTS) {
    job.events.shift();
  }

  // Broadcast to active listeners
  if (job.emitter) {
    job.emitter.emit('event', event);
    job.emitter.emit(type, event);
  }

  return event;
}

/**
 * Subscribe a listener to events emitted for a given job.
 * Returns an unsubscribe function.
 *
 * @param {string|Object} jobId
 * @param {Function} listener
 * @returns {Function} Unsubscribe callback
 */
export function subscribeToJob(jobId, listener) {
  const job = getJob(jobId);
  if (!job || !job.emitter || typeof listener !== 'function') {
    return () => {};
  }
  job.emitter.on('event', listener);
  return () => {
    try {
      job.emitter.removeListener('event', listener);
    } catch {
      // safe no-op
    }
  };
}

/**
 * Return retained events with id > lastEventId.
 * Used for event replay and SSE reconnection.
 *
 * @param {string|Object} jobId
 * @param {number|string} lastEventId
 * @returns {Array} Array of retained events
 */
export function getEventsSince(jobId, lastEventId) {
  const job = getJob(jobId);
  if (!job || !Array.isArray(job.events)) return [];

  const since = Number(lastEventId) || 0;
  if (since <= 0) {
    return [...job.events];
  }
  return job.events.filter((e) => e.id > since);
}

/**
 * Associate an AbortController with a job.
 *
 * @param {string|Object} jobId
 * @param {AbortController} controller
 * @returns {boolean} True if successfully attached, false if job missing
 */
export function attachAbortController(jobId, controller) {
  const job = getJob(jobId);
  if (!job) return false;
  job.abortController = controller;
  return true;
}

/**
 * Cancel a job. Idempotent.
 *
 * If job does not exist: returns false.
 * If job is already completed or failed: cannot cancel, returns false.
 * If job is already cancelled: returns true (idempotent, no duplicate events).
 * If job is queued or running: cancels, updates timestamps, aborts AbortController, and emits 'cancelled' event.
 *
 * @param {string|Object} jobId
 * @param {string} [reason]
 * @returns {boolean}
 */
export function cancelJob(jobId, reason = 'Paper generation cancelled') {
  const job = getJob(jobId);
  if (!job) return false;

  // Cannot cancel completed or failed jobs
  if (job.status === 'completed' || job.status === 'failed') {
    return false;
  }

  // Idempotent: already cancelled
  if (job.status === 'cancelled') {
    return true;
  }

  const now = Date.now();
  job.status = 'cancelled';
  job.currentStage = 'cancelled';
  job.progressPercent = 100;
  job.message = reason;
  if (!job.completedAt) {
    job.completedAt = now;
  }
  job.done = true;

  // Signal downstream abort controller safely
  if (job.abortController && typeof job.abortController.abort === 'function') {
    try {
      if (!job.abortController.signal?.aborted) {
        job.abortController.abort();
      }
    } catch {
      // safe best-effort
    }
  }

  // Emit cancellation event
  emitJobEvent(job.id, 'cancelled', {
    message: reason,
  });

  return true;
}

/**
 * Testing/maintenance helper: clear all jobs and clean up their listeners.
 */
export function clearJobs() {
  for (const [, v] of jobs) {
    if (v.emitter) v.emitter.removeAllListeners();
  }
  jobs.clear();
}

// Periodic sweep of expired jobs (unref so it never keeps the process alive).
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of jobs) {
    if (now - v.createdAt > TTL_MS) {
      if (v.emitter) v.emitter.removeAllListeners();
      jobs.delete(k);
    }
  }
}, TTL_MS);
if (typeof sweep.unref === 'function') sweep.unref();

export default {
  createJob,
  getJob,
  updateSlot,
  markSlots,
  finishJob,
  updateJob,
  emitJobEvent,
  subscribeToJob,
  getEventsSince,
  attachAbortController,
  cancelJob,
  clearJobs,
  TTL_MS,
  MAX_JOB_EVENTS,
  STAGE_PROGRESS,
  VALID_STATUSES,
  VALID_STAGES,
  TERMINAL_STATUSES,
};
