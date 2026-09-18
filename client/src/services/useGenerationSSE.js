/**
 * useGenerationSSE.js
 *
 * Real-time Server-Sent Events (SSE) telemetry hook and state reducer for PaperGen AI.
 * Milestone M6 & M7:
 *  - M6: Real-time telemetry consumption (/api/papers/:jobId/stream), 7-stage timeline,
 *        monotonic progress, slot progression, sanitized logs, completion flow.
 *  - M7: Production cancellation controls, SSE disconnect detection, controlled
 *        reconnection with backoff, missed-event recovery via lastEventId, browser
 *        refresh recovery, and terminal-state lifecycle handling.
 *
 * Invariants:
 *  - Single EventSource per active job at any given time.
 *  - Closes EventSource on complete, error, cancelled, unmount, or job change.
 *  - Monotonic progress percentage: Math.max(current, target), never regresses.
 *  - M1/M5 backend is the authoritative source of truth.
 *  - Cancellation is idempotent and prevents additional generation work.
 *  - Sensitive data redacted: prompts, rawResponse, reasoning, stack, API keys, paths.
 */
import { useEffect, useReducer, useRef, useCallback } from 'react';
import { paperService } from './api.js';

export const CANONICAL_STAGES = [
  { key: 'blueprint_verification', label: 'Blueprint Verification', defaultPercent: 10 },
  { key: 'rag_retrieval', label: 'RAG Retrieval', defaultPercent: 25 },
  { key: 'image_grounding', label: 'Image Grounding', defaultPercent: 40 },
  { key: 'slot_generation', label: 'Slot Generation', defaultPercent: 60 },
  { key: 'quality_validation', label: 'Quality Validation', defaultPercent: 80 },
  { key: 'targeted_regeneration', label: 'Targeted Regeneration', defaultPercent: 85 },
  { key: 'paper_assembled', label: 'Paper Assembled', defaultPercent: 95 },
];

export const STAGE_PROGRESS_MAP = {
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

/**
 * Redact secrets, tokens, and filesystem paths from display text.
 */
export function sanitizeLogMessage(msg) {
  if (!msg) return '';
  let str = typeof msg === 'string' ? msg : (msg?.message || String(msg));
  str = str.replace(/(?:sk-[a-zA-Z0-9_-]{20,}|AIza[a-zA-Z0-9_-]{20,}|eyJ[a-zA-Z0-9_-]{20,})/g, '[REDACTED_SECRET]');
  str = str.replace(/[A-Za-z]:\\[^:\s"'\n]+/g, '[REDACTED_PATH]');
  return str;
}

/**
 * Initial SSE telemetry state for a job.
 */
export function createInitialSSEState(jobId = null, initialBlueprint = null) {
  const initialSlots = {};
  if (initialBlueprint && Array.isArray(initialBlueprint.questions)) {
    initialBlueprint.questions.forEach((q, idx) => {
      initialSlots[idx] = {
        slotIndex: idx,
        questionNumber: q.label || `Q${idx + 1}`,
        status: 'pending',
        progressPercent: 0,
        attempt: 0,
        reasons: [],
      };
    });
  }

  return {
    jobId,
    status: jobId ? 'preparing' : 'idle', // 'idle' | 'preparing' | 'generating' | 'validating' | 'regenerating' | 'completed' | 'failed' | 'cancelled'
    connectionState: 'connected', // 'connected' | 'disconnected' | 'reconnecting' | 'recovered'
    cancelState: 'idle', // 'idle' | 'cancelling' | 'cancelled'
    lastEventId: 0,
    progressPercent: 0,
    currentStage: null,
    currentMessage: jobId ? 'Connecting to generation stream…' : '',
    stages: CANONICAL_STAGES.map((s) => ({
      key: s.key,
      label: s.label,
      status: 'pending', // 'pending' | 'active' | 'completed'
    })),
    slots: initialSlots,
    regenerationInfo: null, // { failedSlots: [], attempt: 1 }
    logs: [],
    summary: null,
    error: null,
    isStreamClosed: false,
  };
}

/**
 * Pure reducer for SSE telemetry events.
 */
export function sseReducer(state, action) {
  const eventId = Number(action.eventId || action.id || action.payload?.id || 0);
  const nextLastEventId = Math.max(state.lastEventId || 0, eventId);

  switch (action.type) {
    case 'RESET':
      return createInitialSSEState(action.jobId, action.blueprint);

    case 'INIT': {
      const data = action.payload || {};
      const newProgress = Math.max(state.progressPercent, Number(data.progressPercent) || 0);
      const stageKey = data.currentStage;

      // Seed slots from server if provided and our slots are empty
      const mergedSlots = { ...state.slots };
      if (Array.isArray(data.slots) && Object.keys(mergedSlots).length === 0) {
        data.slots.forEach((s) => {
          const idx = s.slot ?? 0;
          mergedSlots[idx] = {
            slotIndex: idx,
            questionNumber: s.label || `Q${idx + 1}`,
            status: s.state || 'pending',
            progressPercent: s.state === 'accepted' ? 100 : 0,
            attempt: s.attempts || 0,
            reasons: [],
          };
        });
      }

      return {
        ...state,
        lastEventId: nextLastEventId,
        progressPercent: newProgress,
        currentStage: stageKey || state.currentStage,
        currentMessage: sanitizeLogMessage(data.message) || state.currentMessage,
        slots: mergedSlots,
      };
    }

    case 'STAGE': {
      const data = action.payload || {};
      const stageKey = data.stage;
      const targetPercent = data.progressPercent != null
        ? Number(data.progressPercent)
        : (STAGE_PROGRESS_MAP[stageKey] ?? state.progressPercent);

      // Monotonic progress: never regress
      const newProgress = Math.max(state.progressPercent, targetPercent);

      // Determine high-level status
      let nextStatus = state.status;
      if (stageKey === 'slot_generation' || stageKey === 'rag_retrieval') nextStatus = 'generating';
      else if (stageKey === 'quality_validation') nextStatus = 'validating';
      else if (stageKey === 'targeted_regeneration') nextStatus = 'regenerating';
      else if (stageKey === 'paper_assembled') nextStatus = 'generating';
      else if (stageKey === 'blueprint_verification') nextStatus = 'preparing';

      // Update canonical stages list
      let activeFound = false;
      const updatedStages = state.stages.map((stage) => {
        if (stage.key === stageKey) {
          activeFound = true;
          return { ...stage, status: 'active' };
        }
        if (!activeFound) {
          return { ...stage, status: 'completed' };
        }
        return { ...stage, status: 'pending' };
      });

      let nextRegenInfo = state.regenerationInfo;
      let nextSlots = state.slots;
      if (stageKey === 'targeted_regeneration') {
        const failedSlots = Array.isArray(data.failedSlots)
          ? data.failedSlots
          : (state.regenerationInfo?.failedSlots || []);
        const attempt = data.attempt || (state.regenerationInfo?.attempt || 1);
        nextRegenInfo = { failedSlots, attempt };

        if (Array.isArray(failedSlots) && failedSlots.length > 0) {
          nextSlots = { ...state.slots };
          failedSlots.forEach((slotIdx) => {
            if (nextSlots[slotIdx] && nextSlots[slotIdx].status !== 'accepted') {
              nextSlots[slotIdx] = {
                ...nextSlots[slotIdx],
                status: 'regenerating',
                attempt,
              };
            }
          });
        }
      }

      return {
        ...state,
        lastEventId: nextLastEventId,
        status: nextStatus,
        currentStage: stageKey,
        progressPercent: newProgress,
        currentMessage: sanitizeLogMessage(data.message) || state.currentMessage,
        stages: updatedStages,
        regenerationInfo: nextRegenInfo,
        slots: nextSlots,
      };
    }

    case 'SLOT_PROGRESS': {
      const data = action.payload || {};
      const slotIndex = data.slotIndex;
      if (slotIndex == null) return state;

      const existingSlot = state.slots[slotIndex] || {
        slotIndex,
        questionNumber: data.questionNumber || `Q${slotIndex + 1}`,
        status: 'pending',
        progressPercent: 0,
        attempt: 0,
        reasons: [],
      };

      // Invariant: locked accepted slots never regress
      if (existingSlot.status === 'accepted' && data.status !== 'accepted') {
        return state;
      }

      const updatedSlot = {
        ...existingSlot,
        questionNumber: data.questionNumber || existingSlot.questionNumber,
        status: data.status || existingSlot.status,
        progressPercent: data.status === 'accepted' ? 100 : (data.progressPercent ?? existingSlot.progressPercent),
        attempt: data.attempt ?? existingSlot.attempt,
        reasons: Array.isArray(data.reasons) ? data.reasons.map(sanitizeLogMessage) : existingSlot.reasons,
      };

      return {
        ...state,
        lastEventId: nextLastEventId,
        slots: {
          ...state.slots,
          [slotIndex]: updatedSlot,
        },
      };
    }

    case 'REGENERATION_STAGE': {
      const data = action.payload || {};
      const failedSlots = Array.isArray(data.failedSlots) ? data.failedSlots : [];
      const attempt = Number(data.attempt) || 1;

      // Mark only failed slots as regenerating; accepted slots remain completed
      const nextSlots = { ...state.slots };
      failedSlots.forEach((idx) => {
        if (nextSlots[idx] && nextSlots[idx].status !== 'accepted') {
          nextSlots[idx] = {
            ...nextSlots[idx],
            status: 'regenerating',
            attempt,
          };
        }
      });

      return {
        ...state,
        lastEventId: nextLastEventId,
        status: 'regenerating',
        currentStage: 'targeted_regeneration',
        regenerationInfo: {
          failedSlots,
          attempt,
        },
        slots: nextSlots,
        currentMessage: sanitizeLogMessage(data.message) || `Regenerating ${failedSlots.length} slot(s) (attempt ${attempt})`,
      };
    }

    case 'LOG': {
      const data = action.payload || {};
      const cleanMessage = sanitizeLogMessage(data.message);
      if (!cleanMessage) return state;

      const logEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toLocaleTimeString(),
        level: data.level || 'info',
        message: cleanMessage,
      };

      return {
        ...state,
        lastEventId: nextLastEventId,
        logs: [...state.logs.slice(-49), logEntry],
      };
    }

    case 'COMPLETE': {
      const data = action.payload || {};
      return {
        ...state,
        lastEventId: nextLastEventId,
        status: 'completed',
        currentStage: 'completed',
        progressPercent: 100,
        connectionState: 'connected',
        currentMessage: sanitizeLogMessage(data.message) || 'Paper generation completed successfully.',
        stages: state.stages.map((s) => ({ ...s, status: 'completed' })),
        summary: {
          totalAccepted: data.totalAccepted,
          totalRejected: data.totalRejected,
          message: sanitizeLogMessage(data.message),
        },
        isStreamClosed: true,
      };
    }

    case 'ERROR': {
      const data = action.payload || {};
      const rawError = data.error || {};
      const errorMsg = sanitizeLogMessage(typeof rawError === 'string' ? rawError : (rawError.message || data.message || 'Paper generation failed.'));
      const errorCode = rawError.code || data.code || 'GENERATION_FAILED';

      return {
        ...state,
        lastEventId: nextLastEventId,
        status: 'failed',
        progressPercent: 100,
        currentStage: 'failed',
        connectionState: 'connected',
        currentMessage: errorMsg,
        error: {
          code: errorCode,
          message: errorMsg,
        },
        isStreamClosed: true,
      };
    }

    case 'CANCELLING':
      return {
        ...state,
        cancelState: 'cancelling',
        currentMessage: 'Cancelling generation…',
      };

    case 'CANCELLED': {
      const data = action.payload || {};
      const message = sanitizeLogMessage(data.message) || 'Paper generation cancelled.';

      return {
        ...state,
        lastEventId: nextLastEventId,
        status: 'cancelled',
        currentStage: 'cancelled',
        cancelState: 'cancelled',
        connectionState: 'connected',
        currentMessage: message,
        isStreamClosed: true,
      };
    }

    case 'RECONNECTING':
      return {
        ...state,
        connectionState: 'reconnecting',
      };

    case 'RECONNECTED':
      return {
        ...state,
        connectionState: 'recovered',
      };

    case 'CONNECTED':
      return {
        ...state,
        connectionState: 'connected',
      };

    case 'DISCONNECTED':
      return {
        ...state,
        connectionState: 'disconnected',
      };

    case 'CLOSE_STREAM':
      return {
        ...state,
        isStreamClosed: true,
      };

    default:
      return state;
  }
}

/**
 * Custom React hook managing the SSE stream lifecycle, reconnection, and cancellation.
 *
 * @param {string|null} jobId
 * @param {Object} [options]
 * @param {Object} [options.blueprint]
 * @param {Function} [options.onComplete]
 * @param {Function} [options.onError]
 * @param {Function} [options.onCancelled]
 * @param {Function} [options.EventSourceConstructor]
 * @param {Function} [options.statusFetcher]
 * @param {Function} [options.cancelHandler]
 * @returns {[Object, { cancel: Function, dispatch: Function }]}
 */
export function useGenerationSSE(jobId, options = {}) {
  const {
    blueprint,
    onComplete,
    onError,
    onCancelled,
    EventSourceConstructor,
    statusFetcher = paperService.status,
    cancelHandler = paperService.cancel,
  } = options;

  const [state, dispatch] = useReducer(sseReducer, createInitialSSEState(jobId, blueprint));

  const callbacksRef = useRef({ onComplete, onError, onCancelled });
  useEffect(() => {
    callbacksRef.current = { onComplete, onError, onCancelled };
  }, [onComplete, onError, onCancelled]);

  const eventSourceRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const recoveryBannerTimerRef = useRef(null);
  const isMountedRef = useRef(true);
  const terminalRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const lastEventIdRef = useRef(0);

  const closeCurrentEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      try {
        eventSourceRef.current.close();
      } catch {
        // Safe no-op
      }
      eventSourceRef.current = null;
    }
  }, []);

  const cancel = useCallback(async (reason = 'Generation cancelled by user') => {
    if (!jobId || terminalRef.current || state.cancelState === 'cancelling') return;

    dispatch({ type: 'CANCELLING' });

    try {
      if (typeof cancelHandler === 'function') {
        await cancelHandler(jobId, reason);
      }
      terminalRef.current = true;
      closeCurrentEventSource();
      dispatch({ type: 'CANCELLED', payload: { jobId, message: reason } });
      callbacksRef.current.onCancelled?.({ jobId, message: reason });
    } catch (err) {
      if (err?.response?.status === 409) {
        const serverStatus = err.response.data?.status;
        if (serverStatus === 'completed') {
          terminalRef.current = true;
          callbacksRef.current.onComplete?.();
          return;
        }
      }
      dispatch({
        type: 'ERROR',
        payload: { message: err?.response?.data?.message || err?.message || 'Failed to cancel generation.' },
      });
    }
  }, [jobId, state.cancelState, cancelHandler, closeCurrentEventSource]);

  useEffect(() => {
    isMountedRef.current = true;
    terminalRef.current = false;
    reconnectAttemptsRef.current = 0;
    lastEventIdRef.current = 0;

    if (!jobId) {
      dispatch({ type: 'RESET', jobId: null, blueprint });
      return;
    }

    dispatch({ type: 'RESET', jobId, blueprint });

    const ES = EventSourceConstructor || globalThis.EventSource;
    if (!ES) {
      console.warn('[useGenerationSSE] EventSource is not available in current environment.');
      return;
    }

    function connect() {
      if (!isMountedRef.current || terminalRef.current) return;

      // Close any existing connection to ensure strictly ONE EventSource
      closeCurrentEventSource();

      const lastId = lastEventIdRef.current;
      const streamUrl = lastId > 0
        ? `/api/papers/${encodeURIComponent(jobId)}/stream?lastEventId=${encodeURIComponent(lastId)}`
        : `/api/papers/${encodeURIComponent(jobId)}/stream`;

      let es = null;
      try {
        es = new ES(streamUrl);
        eventSourceRef.current = es;
      } catch (err) {
        console.error('[useGenerationSSE] Failed to construct EventSource:', err);
        dispatch({
          type: 'ERROR',
          payload: { message: 'Could not connect to progress stream.', code: 'SSE_CONNECT_ERROR' },
        });
        callbacksRef.current.onError?.({ message: 'Could not connect to progress stream.', code: 'SSE_CONNECT_ERROR' });
        return;
      }

      const parseData = (e) => {
        try {
          return JSON.parse(e.data);
        } catch {
          return { message: e.data };
        }
      };

      const recordEventId = (e) => {
        if (e && e.lastEventId) {
          const num = parseInt(e.lastEventId, 10);
          if (!Number.isNaN(num) && num > lastEventIdRef.current) {
            lastEventIdRef.current = num;
          }
        }
      };

      const markActive = () => {
        if (reconnectAttemptsRef.current > 0) {
          reconnectAttemptsRef.current = 0;
          dispatch({ type: 'RECONNECTED' });
          if (recoveryBannerTimerRef.current) clearTimeout(recoveryBannerTimerRef.current);
          recoveryBannerTimerRef.current = setTimeout(() => {
            if (isMountedRef.current) dispatch({ type: 'CONNECTED' });
          }, 3000);
        }
      };

      const handleInit = (e) => {
        recordEventId(e);
        markActive();
        const payload = parseData(e);
        if (payload?.id) lastEventIdRef.current = Math.max(lastEventIdRef.current, payload.id);
        dispatch({ type: 'INIT', payload, eventId: payload?.id });
      };

      const handleStage = (e) => {
        recordEventId(e);
        markActive();
        const payload = parseData(e);
        if (payload?.id) lastEventIdRef.current = Math.max(lastEventIdRef.current, payload.id);
        dispatch({ type: 'STAGE', payload, eventId: payload?.id });
      };

      const handleSlotProgress = (e) => {
        recordEventId(e);
        markActive();
        const payload = parseData(e);
        if (payload?.id) lastEventIdRef.current = Math.max(lastEventIdRef.current, payload.id);
        dispatch({ type: 'SLOT_PROGRESS', payload, eventId: payload?.id });
      };

      const handleRegen = (e) => {
        recordEventId(e);
        markActive();
        const payload = parseData(e);
        if (payload?.id) lastEventIdRef.current = Math.max(lastEventIdRef.current, payload.id);
        dispatch({ type: 'REGENERATION_STAGE', payload, eventId: payload?.id });
      };

      const handleLog = (e) => {
        recordEventId(e);
        markActive();
        const payload = parseData(e);
        if (payload?.id) lastEventIdRef.current = Math.max(lastEventIdRef.current, payload.id);
        dispatch({ type: 'LOG', payload, eventId: payload?.id });
      };

      const handleComplete = (e) => {
        recordEventId(e);
        terminalRef.current = true;
        const payload = parseData(e);
        dispatch({ type: 'COMPLETE', payload });
        closeCurrentEventSource();
        callbacksRef.current.onComplete?.(payload);
      };

      const handleError = async (e) => {
        // If server sent custom SSE event 'error' with payload
        if (e && e.data) {
          terminalRef.current = true;
          const payload = parseData(e);
          dispatch({ type: 'ERROR', payload });
          closeCurrentEventSource();
          callbacksRef.current.onError?.(payload);
          return;
        }

        // Connection-level error/disconnect: initiate controlled reconnection
        if (!isMountedRef.current || terminalRef.current) return;

        closeCurrentEventSource();

        if (reconnectAttemptsRef.current >= 5) {
          terminalRef.current = true;
          const failPayload = { message: 'Connection lost. Could not re-establish progress stream.', code: 'STREAM_LOST' };
          dispatch({ type: 'ERROR', payload: failPayload });
          callbacksRef.current.onError?.(failPayload);
          return;
        }

        reconnectAttemptsRef.current += 1;
        dispatch({ type: 'RECONNECTING' });

        // Check backend job state before reconnecting
        try {
          if (typeof statusFetcher === 'function') {
            const statusRes = await statusFetcher(jobId);
            if (!isMountedRef.current) return;

            if (statusRes && statusRes.status === 'completed') {
              terminalRef.current = true;
              dispatch({ type: 'COMPLETE', payload: statusRes });
              callbacksRef.current.onComplete?.(statusRes);
              return;
            }
            if (statusRes && statusRes.status === 'failed') {
              terminalRef.current = true;
              dispatch({ type: 'ERROR', payload: statusRes });
              callbacksRef.current.onError?.(statusRes);
              return;
            }
            if (statusRes && statusRes.status === 'cancelled') {
              terminalRef.current = true;
              dispatch({ type: 'CANCELLED', payload: statusRes });
              callbacksRef.current.onCancelled?.(statusRes);
              return;
            }
          }
        } catch (err) {
          if (err?.response?.status === 404) {
            terminalRef.current = true;
            const expiredPayload = { message: 'Generation job expired or not found.', code: 'JOB_EXPIRED' };
            dispatch({ type: 'ERROR', payload: expiredPayload });
            callbacksRef.current.onError?.(expiredPayload);
            return;
          }
        }

        // Schedule next reconnect attempt with gentle backoff
        const delay = Math.min(1000 * Math.pow(1.5, reconnectAttemptsRef.current - 1), 5000);
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          if (isMountedRef.current && !terminalRef.current) {
            connect();
          }
        }, delay);
      };

      const handleCancelled = (e) => {
        recordEventId(e);
        terminalRef.current = true;
        const payload = parseData(e);
        dispatch({ type: 'CANCELLED', payload });
        closeCurrentEventSource();
        callbacksRef.current.onCancelled?.(payload);
      };

      es.addEventListener('init', handleInit);
      es.addEventListener('stage', handleStage);
      es.addEventListener('slot_progress', handleSlotProgress);
      es.addEventListener('regeneration', handleRegen);
      es.addEventListener('log', handleLog);
      es.addEventListener('complete', handleComplete);
      es.addEventListener('error', handleError);
      es.addEventListener('cancelled', handleCancelled);
    }

    connect();

    return () => {
      isMountedRef.current = false;
      terminalRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (recoveryBannerTimerRef.current) clearTimeout(recoveryBannerTimerRef.current);
      closeCurrentEventSource();
      dispatch({ type: 'CLOSE_STREAM' });
    };
  }, [jobId, blueprint, EventSourceConstructor, statusFetcher, closeCurrentEventSource]);

  return [state, { cancel, dispatch }];
}

export default useGenerationSSE;
