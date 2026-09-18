/**
 * GenerationProgressDrawer.jsx
 *
 * Real-time paper generation progress drawer for PaperGen AI.
 * Milestone M6: Consumes useGenerationSSE telemetry state and renders:
 *  - High-level status badge and monotonic progress bar
 *  - Canonical 7-stage pipeline timeline
 *  - Per-slot question generation & validation progression
 *  - Targeted regeneration banner and failure reasons
 *  - Sanitized diagnostic activity logs
 *  - Completion summary and error alert cards
 *
 * Visual design: Clean, professional, school-exam focused, responsive on mobile & desktop.
 * Rule: Displays cancelled status if server emits it, but contains NO cancellation controls.
 */
import { useState, useId, useEffect } from 'react';
import {
  CheckCircle2,
  Circle,
  Loader2,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
  FileText,
  Terminal,
  ChevronDown,
  ChevronUp,
  X,
  Sparkles,
  Check,
} from 'lucide-react';

const STATUS_BADGES = {
  idle: { label: 'Idle', bg: 'bg-gray-100 text-gray-700 border-gray-200' },
  preparing: { label: 'Preparing', bg: 'bg-amber-50 text-amber-700 border-amber-200' },
  generating: { label: 'Generating Questions', bg: 'bg-blue-50 text-blue-700 border-blue-200' },
  validating: { label: 'Validating Quality', bg: 'bg-purple-50 text-purple-700 border-purple-200' },
  regenerating: { label: 'Regenerating Failed Slots', bg: 'bg-orange-50 text-orange-700 border-orange-200' },
  completed: { label: 'Completed', bg: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  failed: { label: 'Generation Failed', bg: 'bg-rose-50 text-rose-700 border-rose-200' },
  cancelled: { label: 'Cancelled', bg: 'bg-slate-100 text-slate-700 border-slate-300' },
};

export default function GenerationProgressDrawer({
  isOpen,
  onClose,
  sseState,
  onViewPaper,
  onCancel,
  isCancelling = false,
}) {
  const [showLogs, setShowLogs] = useState(false);
  const logContentId = useId();

  // Dialog is open → lock page scroll behind it (spec §8).
  useEffect(() => {
    if (!isOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isOpen]);

  if (!isOpen || !sseState) return null;

  const {
    status = 'preparing',
    connectionState = 'connected',
    cancelState = 'idle',
    progressPercent = 0,
    currentMessage,
    stages = [],
    slots = {},
    regenerationInfo,
    logs = [],
    summary,
    error,
  } = sseState;

  const badge = STATUS_BADGES[status] || STATUS_BADGES.generating;
  const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  const slotList = Object.values(slots).sort((a, b) => a.slotIndex - b.slotIndex);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-gray-900/40 p-6 backdrop-blur-sm transition-opacity max-sm:p-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby="generation-drawer-title"
    >
      {/* CENTERED DIALOG (was a right-anchored drawer): the overlay's
          `items-center justify-center` centers it; the width clamp = spec's
          min(900px, 100vw - 48px) (nearly full-width on mobile); `max-h-full`
          + the body's own overflow keep long content inside the viewport. */}
      <div className="flex max-h-full w-[min(900px,calc(100vw-48px))] max-sm:w-[calc(100vw-24px)] min-w-0 flex-col rounded-xl border border-gray-200 bg-white shadow-2xl">
          
          {/* ── Top Header ────────────────────────────────────── */}
          <div className="shrink-0 px-6 py-5 border-b border-gray-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 text-blue-700 border border-blue-200">
                  {status === 'completed' ? (
                    <CheckCircle2 size={20} className="text-emerald-600" />
                  ) : status === 'failed' ? (
                    <AlertCircle size={20} className="text-rose-600" />
                  ) : (
                    <Sparkles size={20} className="animate-pulse text-blue-600" />
                  )}
                </div>
                <div>
                  <h2 id="generation-drawer-title" className="text-[16px] font-bold text-gray-900 leading-tight">
                    Generation Progress
                  </h2>
                  <p className="text-xs text-gray-500">
                    AI-powered multi-stage paper synthesis
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${badge.bg}`}>
                  {!isTerminal && (
                    <span className="w-1.5 h-1.5 rounded-full bg-current mr-1.5 animate-ping" />
                  )}
                  {badge.label}
                </span>

                {isTerminal && (
                  <button
                    type="button"
                    onClick={onClose}
                    className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                    aria-label="Close drawer"
                  >
                    <X size={18} />
                  </button>
                )}
              </div>
            </div>

            {/* ── Reconnection / Recovery Banner (Phase 2 — M7) ──── */}
            {connectionState === 'reconnecting' && (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 border border-amber-200 animate-pulse">
                <Loader2 size={14} className="animate-spin text-amber-600 shrink-0" />
                Connection interrupted. Reconnecting...
              </div>
            )}
            {connectionState === 'recovered' && (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 border border-emerald-200">
                <Check size={14} className="text-emerald-600 shrink-0" />
                Connection restored
              </div>
            )}

            {/* ── Monotonic Progress Bar ─────────────────────────── */}
            <div className="mt-4">
              <div className="flex justify-between items-center text-xs font-medium mb-1.5">
                <span className="text-gray-600 truncate max-w-[80%]">
                  {currentMessage || 'Processing pipeline…'}
                </span>
                <span className="text-blue-700 font-bold ml-2">
                  {Math.round(progressPercent)}%
                </span>
              </div>
              <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden border border-gray-200">
                <div
                  className={`h-full transition-all duration-300 ease-out ${
                    status === 'failed'
                      ? 'bg-rose-500'
                      : status === 'completed'
                      ? 'bg-emerald-600'
                      : 'bg-blue-600'
                  }`}
                  style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }}
                />
              </div>
            </div>
          </div>

          {/* ── Main Scrollable Body ─────────────────────────────── */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-6">

            {/* ── Error Banner (if failed) ───────────────────────── */}
            {status === 'failed' && (
              <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800">
                <div className="flex items-start gap-3">
                  <AlertCircle size={20} className="text-rose-600 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-semibold">Generation could not complete</p>
                    <p className="text-xs mt-1 text-rose-700 leading-relaxed">
                      {error?.message || currentMessage || 'An unexpected error occurred.'}
                    </p>
                    {error?.code && (
                      <span className="inline-block mt-2 px-2 py-0.5 rounded bg-rose-100 text-[11px] font-mono text-rose-800 border border-rose-300">
                        Code: {error.code}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── Cancelled Banner ─────────────────────────────────── */}
            {status === 'cancelled' && (
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-slate-700">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={20} className="text-slate-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold">Generation Cancelled</p>
                    <p className="text-xs mt-1 text-slate-600">
                      {currentMessage || 'The generation task was cancelled.'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* ── Targeted Regeneration Banner ─────────────────────── */}
            {status === 'regenerating' && regenerationInfo && (
              <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900">
                <div className="flex items-start gap-3">
                  <RefreshCw size={18} className="text-amber-600 shrink-0 mt-0.5 animate-spin" />
                  <div>
                    <p className="text-sm font-semibold">
                      Targeted Regeneration in Progress (Attempt {regenerationInfo.attempt || 2})
                    </p>
                    <p className="text-xs mt-1 text-amber-800">
                      Only failed questions are being regenerated: {
                        regenerationInfo.failedSlots?.length > 0
                          ? regenerationInfo.failedSlots.map((s) => `Q${s + 1}`).join(', ')
                          : 'Specific slot(s)'
                      }. Accepted questions remain strictly locked.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* ── Section 1: Stage Timeline ──────────────────────── */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">
                Pipeline Stages
              </h3>
              <div className="space-y-2 rounded-xl border border-gray-200 bg-gray-50/50 p-3">
                {stages.map((stage) => {
                  const isCompleted = stage.status === 'completed';
                  const isActive = stage.status === 'active';

                  return (
                    <div
                      key={stage.key}
                      className={`flex items-center justify-between p-2 rounded-lg transition-colors ${
                        isActive
                          ? 'bg-blue-50/80 border border-blue-200 text-blue-900 font-medium'
                          : isCompleted
                          ? 'text-gray-700'
                          : 'text-gray-400'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full shrink-0">
                          {isCompleted ? (
                            <CheckCircle2 size={16} className="text-emerald-600" />
                          ) : isActive ? (
                            <Loader2 size={16} className="text-blue-600 animate-spin" />
                          ) : (
                            <Circle size={15} className="text-gray-300" />
                          )}
                        </span>
                        <span className="text-xs sm:text-[13px]">{stage.label}</span>
                      </div>

                      <span className="text-[11px] font-medium uppercase tracking-wider">
                        {isCompleted && <span className="text-emerald-700">Done</span>}
                        {isActive && <span className="text-blue-700 font-semibold">Active</span>}
                        {!isCompleted && !isActive && <span className="text-gray-400">Waiting</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Section 2: Question & Slot Progression ──────────── */}
            {slotList.length > 0 && (
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">
                  Question Slots ({slotList.length})
                </h3>
                <div className="grid grid-cols-1 gap-2.5">
                  {slotList.map((slot) => {
                    const isDone = slot.status === 'completed';
                    const isRegen = slot.status === 'regenerating';
                    const isGen = slot.status === 'generating';
                    const isFail = slot.status === 'failed';

                    return (
                      <div
                        key={slot.slotIndex}
                        className={`p-3 rounded-xl border transition-all ${
                          isDone
                            ? 'bg-white border-emerald-200 text-gray-800'
                            : isRegen
                            ? 'bg-amber-50/70 border-amber-300 text-amber-950'
                            : isGen
                            ? 'bg-blue-50/70 border-blue-200 text-blue-950'
                            : isFail
                            ? 'bg-rose-50 border-rose-200 text-rose-900'
                            : 'bg-white border-gray-200 text-gray-500'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2.5">
                            <span
                              className={`flex h-6 w-6 items-center justify-center rounded-lg text-xs font-bold ${
                                isDone
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : isRegen
                                  ? 'bg-amber-200 text-amber-900'
                                  : isGen
                                  ? 'bg-blue-200 text-blue-900'
                                  : 'bg-gray-100 text-gray-600'
                              }`}
                            >
                              {slot.questionNumber}
                            </span>
                            <span className="text-xs font-medium">
                              Question {slot.slotIndex + 1}
                            </span>
                          </div>

                          <div className="flex items-center gap-2">
                            {isDone && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                                <Check size={13} />
                                Accepted
                              </span>
                            )}
                            {isGen && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 bg-blue-100/60 px-2 py-0.5 rounded-md">
                                <Loader2 size={12} className="animate-spin" />
                                Generating
                              </span>
                            )}
                            {isRegen && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-md border border-amber-300">
                                <RefreshCw size={12} className="animate-spin" />
                                Regen #{slot.attempt || 2}
                              </span>
                            )}
                            {isFail && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 bg-rose-100 px-2 py-0.5 rounded-md border border-rose-200">
                                <AlertCircle size={12} />
                                Excluded
                              </span>
                            )}
                            {!isDone && !isGen && !isRegen && !isFail && (
                              <span className="text-[11px] text-gray-400 font-medium">
                                Pending
                              </span>
                            )}
                          </div>
                        </div>

                        {/* If regenerating or failed with reasons, display reasons */}
                        {(isRegen || isFail) && Array.isArray(slot.reasons) && slot.reasons.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-amber-200/60 text-[11px] text-amber-800">
                            <span className="font-semibold">Feedback: </span>
                            {slot.reasons.join(' · ')}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Section 3: Diagnostic Activity Logs ─────────────── */}
            <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <button
                type="button"
                onClick={() => setShowLogs((prev) => !prev)}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 text-xs font-semibold text-gray-700 hover:bg-gray-100 transition-colors"
                aria-expanded={showLogs}
                aria-controls={logContentId}
              >
                <div className="flex items-center gap-2">
                  <Terminal size={14} className="text-gray-500" />
                  <span>Telemetry Activity Log ({logs.length})</span>
                </div>
                {showLogs ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>

              {showLogs && (
                <div id={logContentId} className="p-3 bg-slate-900 text-slate-200 font-mono text-[11.5px] max-h-48 overflow-y-auto space-y-1.5">
                  {logs.length === 0 ? (
                    <p className="text-slate-500 italic">No telemetry messages received yet.</p>
                  ) : (
                    logs.map((log) => (
                      <div key={log.id} className="flex items-start gap-2 leading-tight">
                        <span className="text-slate-500 shrink-0 text-[10px]">
                          [{log.timestamp}]
                        </span>
                        <span
                          className={`font-semibold uppercase text-[10px] px-1 rounded shrink-0 ${
                            log.level === 'warn'
                              ? 'bg-amber-950 text-amber-400 border border-amber-800'
                              : log.level === 'error'
                              ? 'bg-rose-950 text-rose-400 border border-rose-800'
                              : 'bg-slate-800 text-blue-400'
                          }`}
                        >
                          {log.level}
                        </span>
                        <span className="text-slate-300 break-words flex-1">
                          {log.message}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* ── Section 4: Completion Summary ───────────────────── */}
            {status === 'completed' && summary && (
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900">
                <div className="flex items-center gap-2 font-bold text-sm text-emerald-800 mb-1">
                  <CheckCircle2 size={18} className="text-emerald-600" />
                  Paper Generation Complete!
                </div>
                <p className="text-xs text-emerald-700">
                  {summary.message || 'All questions have been assembled and validated.'}
                </p>
                <div className="mt-3 flex gap-3 text-xs font-semibold">
                  <div className="bg-white/80 px-2.5 py-1 rounded border border-emerald-200">
                    Accepted: <span className="text-emerald-700">{summary.totalAccepted ?? slotList.length}</span>
                  </div>
                  {summary.totalRejected > 0 && (
                    <div className="bg-white/80 px-2.5 py-1 rounded border border-emerald-200 text-gray-600">
                      Excluded: <span>{summary.totalRejected}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>

          {/* ── Bottom Action Footer ─────────────────────────────── */}
          <div className="shrink-0 p-5 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
            <div className="text-xs text-gray-500">
              {status === 'completed' ? (
                <span className="text-emerald-700 font-medium">Ready for review</span>
              ) : status === 'failed' ? (
                <span className="text-rose-700 font-medium">Review errors</span>
              ) : status === 'cancelled' ? (
                <span className="text-slate-700 font-medium">Generation Cancelled</span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin text-blue-600" />
                  Synthesizing questions…
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {!isTerminal && onCancel && (
                <button
                  type="button"
                  id="cancel-generation-btn"
                  onClick={onCancel}
                  disabled={cancelState === 'cancelling' || isCancelling}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-200 bg-white hover:bg-rose-50 text-xs sm:text-sm font-medium text-rose-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                  {(cancelState === 'cancelling' || isCancelling) ? (
                    <>
                      <Loader2 size={14} className="animate-spin text-rose-600" />
                      Cancelling…
                    </>
                  ) : (
                    <>
                      <X size={14} />
                      Cancel Generation
                    </>
                  )}
                </button>
              )}

              {status === 'completed' && (
                <button
                  type="button"
                  onClick={onViewPaper}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs sm:text-sm font-semibold transition-colors shadow-sm"
                >
                  <FileText size={16} />
                  Review Paper
                </button>
              )}

              {isTerminal && (
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-xs sm:text-sm font-medium text-gray-700 transition-colors"
                >
                  Close
                </button>
              )}
            </div>
          </div>

      </div>
    </div>
  );
}
