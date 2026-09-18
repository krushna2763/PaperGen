import { orchestrator } from '../agents/orchestrator.agent.js';
import { getJob, createJob, updateSlot, finishJob, getEventsSince, subscribeToJob, cancelJob, TERMINAL_STATUSES } from '../services/job-store.js';
import { validateSlotUnitMap } from '../blueprint/slot-unit-map.js';
import { scheduleGenerationJob } from '../services/generation-worker.js';

/**
 * POST /api/papers/:jobId/generate   { blueprint, difficulty, slotUnitMap, async? }
 *
 * The blueprint and slotUnitMap come from the REQUEST BODY, never a
 * server-side stored copy — the teacher may have corrected a parsing error at
 * the confirm step, and the client is the source of truth. The job store only
 * tracks per-slot progress and has a 30-minute TTL, so its id can expire while
 * a fully prepared paper is still on screen (or long before a paper is
 * reopened from "My Papers"). When the id is unknown, a fresh job is
 * rehydrated from the blueprint in the body rather than stranding the paper.
 * The response carries the id actually used as `jobId` so the client can
 * adopt it for status polling.
 */
export const generatePaper = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const body = req.body || {};
    const { blueprint, difficulty, slotUnitMap } = body;

    // The blueprint MUST arrive in the body — it is what everything else is
    // built from, and what an expired job is rehydrated from.
    if (!blueprint || typeof blueprint !== 'object' || !Array.isArray(blueprint.questions) || blueprint.questions.length === 0) {
      return res.status(400).json({
        success: false,
        message: '"blueprint" must be sent in the request body (with a non-empty questions array). Server-side copies are never used.',
      });
    }

    // SCOPE SOURCE OF TRUTH: the REQUEST's class/subject (the teacher's
    // settings — the same values the notes were uploaded under and the unit
    // list was served for) beat blueprint.paper.*, which carries the reference
    // PDF's printed header ("Class IV", "ENGLISH"). The header is display
    // metadata, not the corpus key — looking notes up under it fails every
    // time the paper's wording differs from the teacher's selection.
    const cls = String(body.class ?? blueprint.paper?.class ?? '').trim();
    const subject = String(body.subject ?? blueprint.paper?.subject ?? '').trim();

    const check = await validateSlotUnitMap(slotUnitMap, blueprint, { class: cls, subject });
    if (!check.ok) {
      return res.status(422).json({
        success: false,
        message: 'slotUnitMap validation failed. Fix the listed slot(s) and resubmit.',
        errors: check.errors,
      });
    }

    // MODE B: ASYNC GENERATION (Phase 2 — M2 / M3)
    // When async === true (strict boolean), validate request, create queued job,
    // schedule background worker, and return 202 Accepted immediately.
    if (body.async === true) {
      const createdJobId = createJob({
        blueprint,
        paperId: jobId || blueprint?.paper?.id,
        metadata: {
          class: cls,
          subject,
          difficulty,
          slotUnitMap,
          blueprint,
          routeJobId: jobId,
        },
      });

      res.status(202).json({
        success: true,
        jobId: createdJobId,
        streamUrl: `/api/papers/${createdJobId}/stream`,
        statusUrl: `/api/papers/${createdJobId}/status`,
      });

      // Schedule background execution via M3 worker
      scheduleGenerationJob(createdJobId);
      return;
    }

    // MODE A: SYNCHRONOUS GENERATION (Default / Backward Compatible)
    let job = getJob(jobId);
    if (!job) {
      const rehydratedId = createJob(blueprint);
      job = getJob(rehydratedId);
      console.log(`[Generate] jobId "${jobId}" expired or unknown — rehydrated from the request blueprint as "${rehydratedId}".`);
    }
    const activeJobId = job.id;

    // Mark every slot in-flight so the first status poll is not a blank spinner.
    for (const s of job.slots) updateSlot(activeJobId, s.slot, { state: 'generating' });

    const result = await orchestrator.generate({
      class: cls,
      subject,
      difficulty,
      questionCount: blueprint.questions.length,
      blueprint,
      slotUnitMap,
      jobId: activeJobId,
    });

    finishJob(activeJobId);

    return res.status(200).json({
      success: true,
      jobId: activeJobId,
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

/** GET /api/papers/:jobId/status  ->  { done, slots: [{ slot, label, state, attempts }], status, progressPercent, currentStage, result?, error? } */
export const jobStatus = (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ done: false, slots: [], error: 'Unknown jobId.' });
  }
  return res.status(200).json({
    done: job.done,
    slots: job.slots,
    status: job.status,
    progressPercent: job.progressPercent,
    currentStage: job.currentStage,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  });
};

/**
 * POST /api/papers/:jobId/regenerate-slot  { blueprint, slotIndex, class?, subject?,
 *   difficulty?, slotUnitMap?, notes?, failureReasons?, existingQuestion?, teacherEdits? }
 *
 * PHASE 5 — Teacher Review: regenerate ONE blueprint slot through the same
 * Phase 4 regeneration path (targeted prompt → normalization → deterministic
 * validators → bounded retries). No other slot is retrieved for, generated, or
 * validated — the client keeps every other question exactly as the teacher left
 * it. The jobId is advisory (the blueprint travels in the body, like generate).
 * Response: { success, jobId, data: { question, slotIndex, attempts, accepted, reasons } }
 */
export const regenerateSlot = async (req, res, next) => {
  try {
    const body = req.body || {};
    const { blueprint, slotIndex } = body;

    if (!blueprint || typeof blueprint !== 'object' || !Array.isArray(blueprint.questions) || blueprint.questions.length === 0) {
      return res.status(400).json({
        success: false,
        message: '"blueprint" must be sent in the request body (with a non-empty questions array).',
      });
    }
    if (!Number.isInteger(Number(slotIndex)) || Number(slotIndex) < 0 || Number(slotIndex) >= blueprint.questions.length) {
      return res.status(400).json({ success: false, message: `"slotIndex" must be between 0 and ${blueprint.questions.length - 1}.` });
    }

    // Same scope rules as generate: the REQUEST's class/subject beat the
    // blueprint header, and an unknown/expired jobId is rehydrated.
    const cls = String(body.class ?? blueprint.paper?.class ?? '').trim();
    const subject = String(body.subject ?? blueprint.paper?.subject ?? '').trim();
    let activeJobId = req.params.jobId;
    if (!getJob(activeJobId)) activeJobId = createJob(blueprint);

    const out = await orchestrator.regenerateSlot({
      class: cls,
      subject,
      difficulty: body.difficulty,
      blueprint,
      slotIndex: Number(slotIndex),
      slotUnitMap: body.slotUnitMap ?? undefined,
      notes: body.notes,
      failureReasons: body.failureReasons,
      existingQuestion: body.existingQuestion,
      teacherEdits: body.teacherEdits === true,
    });

    updateSlot(activeJobId, Number(slotIndex), { state: out.accepted ? 'accepted' : 'failed', attempts: out.attempts });

    return res.status(200).json({
      success: true,
      jobId: activeJobId,
      message: out.accepted
        ? 'Question regenerated and validated.'
        : 'Regeneration could not produce a fully valid question — review the reasons.',
      data: { ...out, slotIndex: Number(slotIndex) },
    });
  } catch (error) {
    console.error('[Regenerate Slot] Error:', error.message);
    next(error);
  }
};

/**
 * POST /api/papers/:jobId/generate-answer  { blueprint, slotIndex, question,
 *   class?, subject?, difficulty?, slotUnitMap?, notes? }
 *
 * PHASE 6 — Dedicated Answer Key: regenerate ONLY the answers of ONE question.
 * The question itself is frozen — the orchestrator's answer path never rewrites
 * it (the response schema physically excludes stem/item text), and the client
 * keeps its teacher-edited question exactly as-is. jobId is advisory, like
 * regenerateSlot. Response: { success, jobId, data: { answers, accepted, reasons } }
 */
export const generateAnswer = async (req, res, next) => {
  try {
    const body = req.body || {};
    const { blueprint, slotIndex, question } = body;

    if (!blueprint || typeof blueprint !== 'object' || !Array.isArray(blueprint.questions) || blueprint.questions.length === 0) {
      return res.status(400).json({ success: false, message: '"blueprint" must be sent in the request body (with a non-empty questions array).' });
    }
    if (!Number.isInteger(Number(slotIndex)) || Number(slotIndex) < 0 || Number(slotIndex) >= blueprint.questions.length) {
      return res.status(400).json({ success: false, message: `"slotIndex" must be between 0 and ${blueprint.questions.length - 1}.` });
    }
    if (!question || typeof question !== 'object' || !String(question.text ?? '').trim()) {
      return res.status(400).json({ success: false, message: '"question" (the current teacher-approved question) is required to regenerate its answer.' });
    }

    let activeJobId = req.params.jobId;
    if (!getJob(activeJobId)) activeJobId = createJob(blueprint);

    const out = await orchestrator.generateAnswer({
      class: String(body.class ?? blueprint.paper?.class ?? '').trim(),
      subject: String(body.subject ?? blueprint.paper?.subject ?? '').trim(),
      difficulty: body.difficulty,
      blueprint,
      slotIndex: Number(slotIndex),
      question,
      slotUnitMap: body.slotUnitMap ?? undefined,
      notes: body.notes,
    });

    return res.status(200).json({
      success: out.accepted,
      jobId: activeJobId,
      message: out.accepted ? 'Answer regenerated.' : 'Answer generation returned no usable key.',
      data: out,
    });
  } catch (error) {
    console.error('[Generate Answer] Error:', error.message);
    next(error);
  }
};

/**
 * Format an SSE event according to the standard text/event-stream specification.
 *
 * @param {Object} options
 * @param {number|string} [options.id]
 * @param {string} [options.event]
 * @param {*} options.data
 * @returns {string}
 */
export function formatSseEvent({ id, event, data } = {}) {
  let message = '';
  if (id !== undefined && id !== null) {
    message += `id: ${id}\n`;
  }
  if (event) {
    message += `event: ${event}\n`;
  }
  const payload = typeof data === 'string' ? data : JSON.stringify(data ?? {});
  const lines = payload.split(/\r?\n/);
  for (const line of lines) {
    message += `data: ${line}\n`;
  }
  message += '\n';
  return message;
}

/**
 * Redact sensitive information (API keys, authorization tokens, absolute local filesystem paths)
 * from stream payloads.
 *
 * @param {*} data
 * @returns {*}
 */
export function sanitizeStreamPayload(data) {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') {
    if (typeof data === 'string') {
      return data
        .replace(/(?:sk-[a-zA-Z0-9_-]{20,}|AIza[a-zA-Z0-9_-]{30,}|eyJ[a-zA-Z0-9_-]{30,})/g, '[REDACTED_SECRET]')
        .replace(/[A-Za-z]:\\[^:\s"'\n]+/g, '[REDACTED_PATH]');
    }
    return data;
  }
  try {
    const str = JSON.stringify(data);
    const sanitized = str
      .replace(/(?:sk-[a-zA-Z0-9_-]{20,}|AIza[a-zA-Z0-9_-]{30,}|eyJ[a-zA-Z0-9_-]{30,})/g, '[REDACTED_SECRET]')
      .replace(/[A-Za-z]:\\[^:\s"'\n]+/g, '[REDACTED_PATH]');
    return JSON.parse(sanitized);
  } catch {
    return data;
  }
}

/**
 * GET /api/papers/:jobId/stream
 *
 * Server-Sent Events (SSE) streaming endpoint for generation job progress.
 * Milestone M4:
 *   - Validates jobId and returns 404 if not found
 *   - Sets standard SSE headers (text/event-stream, no-cache, keep-alive, X-Accel-Buffering: no)
 *   - Sends immediate initial state (event: init)
 *   - Supports Last-Event-ID replay from job store event buffer
 *   - Streams live stage, slot_progress, log, complete, error, cancelled events
 *   - Emits 15-second heartbeat comment (:ping\n\n)
 *   - Cleans up subscriptions and heartbeat timer on client disconnect without cancelling job
 *   - Automatically closes stream when job reaches terminal state (completed, failed, cancelled)
 */
export const streamPaperJob = (req, res, options = {}) => {
  const { jobId } = req.params;
  if (!jobId) {
    return res.status(400).json({ success: false, error: 'Job ID is required.' });
  }

  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Unknown jobId.' });
  }

  // 1. Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // 2. Parse Last-Event-ID header safely (supports query param for browser reconnection)
  const rawLastEventId = req.headers?.['last-event-id'] ?? req.query?.lastEventId;
  let lastEventId = null;
  if (rawLastEventId !== undefined && rawLastEventId !== null && rawLastEventId !== '') {
    const parsed = parseInt(rawLastEventId, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      lastEventId = parsed;
    }
  }

  let lastSentEventId = lastEventId ?? 0;

  // 3. Send initial state event immediately
  const initPayload = sanitizeStreamPayload({
    jobId: job.id,
    status: job.status,
    progressPercent: job.progressPercent,
    currentStage: job.currentStage,
    slots: job.slots || [],
    message: job.message || '',
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  });

  res.write(formatSseEvent({
    id: lastSentEventId,
    event: 'init',
    data: initPayload,
  }));
  if (typeof res.flush === 'function') res.flush();

  // 4. Replay missed/buffered events from Job Store
  const replayedEvents = getEventsSince(job.id, lastSentEventId);
  let terminalSentInReplay = false;

  for (const ev of replayedEvents) {
    res.write(formatSseEvent({
      id: ev.id,
      event: ev.type,
      data: sanitizeStreamPayload(ev.data),
    }));
    if (ev.id > lastSentEventId) {
      lastSentEventId = ev.id;
    }
    if (ev.type === 'complete' || ev.type === 'error' || ev.type === 'cancelled') {
      terminalSentInReplay = true;
    }
  }
  if (typeof res.flush === 'function') res.flush();

  // 5. If job is already in a terminal state, finalize and close cleanly
  if (TERMINAL_STATUSES.has(job.status)) {
    if (!terminalSentInReplay) {
      const terminalId = ++lastSentEventId;
      if (job.status === 'completed') {
        res.write(formatSseEvent({
          id: terminalId,
          event: 'complete',
          data: sanitizeStreamPayload({
            jobId: job.id,
            status: 'completed',
            progressPercent: 100,
            message: job.message || 'Generation completed.',
            ...(job.result ? { result: job.result } : {}),
          }),
        }));
      } else if (job.status === 'failed') {
        res.write(formatSseEvent({
          id: terminalId,
          event: 'error',
          data: sanitizeStreamPayload({
            jobId: job.id,
            status: 'failed',
            progressPercent: 100,
            message: job.message || 'Generation failed.',
            error: job.error || { code: 'GENERATION_FAILED', message: job.message || 'Generation failed.' },
          }),
        }));
      } else if (job.status === 'cancelled') {
        res.write(formatSseEvent({
          id: terminalId,
          event: 'cancelled',
          data: sanitizeStreamPayload({
            jobId: job.id,
            status: 'cancelled',
            progressPercent: 100,
            message: job.message || 'Paper generation cancelled',
          }),
        }));
      }
      if (typeof res.flush === 'function') res.flush();
    }
    res.end();
    return;
  }

  // 6. Active job: Setup live subscription and heartbeat
  let closed = false;
  let heartbeatTimer = null;
  let unsubscribe = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (typeof unsubscribe === 'function') {
      unsubscribe();
      unsubscribe = null;
    }
    if (job.emitter && typeof onTerminal === 'function') {
      job.emitter.removeListener('terminal', onTerminal);
    }
    req.removeListener('close', cleanup);
    res.removeListener('close', cleanup);
  };

  const handleEvent = (ev) => {
    if (closed) return;
    if (ev.id && ev.id <= lastSentEventId) return;
    if (ev.id) lastSentEventId = ev.id;

    try {
      res.write(formatSseEvent({
        id: ev.id,
        event: ev.type,
        data: sanitizeStreamPayload(ev.data),
      }));
      if (typeof res.flush === 'function') res.flush();
    } catch {
      cleanup();
      return;
    }

    if (ev.type === 'complete' || ev.type === 'error' || ev.type === 'cancelled') {
      cleanup();
      try {
        res.end();
      } catch {
        // safe best-effort
      }
    }
  };

  const onTerminal = (terminalJob) => {
    if (closed) return;
    const status = terminalJob?.status;
    const terminalId = lastSentEventId + 1;

    if (status === 'completed') {
      handleEvent({
        id: terminalId,
        type: 'complete',
        data: {
          jobId: job.id,
          status: 'completed',
          progressPercent: 100,
          message: terminalJob.message || 'Generation completed.',
          ...(terminalJob.result ? { result: terminalJob.result } : {}),
        },
      });
    } else if (status === 'failed') {
      handleEvent({
        id: terminalId,
        type: 'error',
        data: {
          jobId: job.id,
          status: 'failed',
          progressPercent: 100,
          message: terminalJob.message || 'Generation failed.',
          error: terminalJob.error || { code: 'GENERATION_FAILED', message: terminalJob.message || 'Generation failed.' },
        },
      });
    } else if (status === 'cancelled') {
      handleEvent({
        id: terminalId,
        type: 'cancelled',
        data: {
          jobId: job.id,
          status: 'cancelled',
          progressPercent: 100,
          message: terminalJob.message || 'Paper generation cancelled',
        },
      });
    }
  };

  unsubscribe = subscribeToJob(job.id, handleEvent);
  if (job.emitter) {
    job.emitter.on('terminal', onTerminal);
  }

  // Heartbeat comment ping every 15 seconds (configurable via options for tests)
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15000;
  heartbeatTimer = setInterval(() => {
    if (closed) return;
    try {
      res.write(':ping\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch {
      cleanup();
    }
  }, heartbeatIntervalMs);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }

  req.on('close', cleanup);
  res.on('close', cleanup);
};

/**
 * POST /api/papers/:jobId/cancel
 *
 * Cancel an active generation job.
 * Idempotent.
 *
 * Rules:
 *  - 404 if job does not exist or has expired.
 *  - 409 if job is already completed or failed (cannot cancel terminal work).
 *  - 200 if job is already cancelled (idempotent, no duplicate events).
 *  - 200 if job was queued or running (marks cancelled, aborts downstream controller, emits cancelled event).
 */
export const cancelGeneration = async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!jobId) {
      return res.status(400).json({ success: false, message: 'Job ID is required.' });
    }

    const job = getJob(jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found or expired.' });
    }

    if (job.status === 'completed' || job.status === 'failed') {
      return res.status(409).json({
        success: false,
        message: `Cannot cancel a ${job.status} job.`,
        status: job.status,
        jobId: job.id,
      });
    }

    if (job.status === 'cancelled') {
      return res.status(200).json({
        success: true,
        message: 'Job is already cancelled.',
        status: 'cancelled',
        jobId: job.id,
      });
    }

    const reason = req.body?.reason || 'Paper generation cancelled by user';
    const ok = cancelJob(job.id, reason);

    return res.status(200).json({
      success: ok,
      message: 'Job cancelled successfully.',
      status: 'cancelled',
      jobId: job.id,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to cancel job.',
    });
  }
};

export default { generatePaper, jobStatus, regenerateSlot, generateAnswer, streamPaperJob, cancelGeneration };
