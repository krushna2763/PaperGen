/**
 * jobRecovery.js
 *
 * Session-persistent job recovery for PaperGen AI.
 * Milestone M7: Recovers in-flight generation jobs across browser refreshes.
 *
 * Security & Data Invariants:
 *  - Persists strictly minimal identifiers: jobId and timestamp only.
 *  - NEVER persists prompts, raw model responses, reasoning, API keys, or telemetry logs.
 *  - Safe fail-open: sessionStorage errors (e.g. incognito/disabled) do not break execution.
 */

const STORAGE_KEY = 'papergen:activeGenerationJob';

/**
 * Persist the active job ID for refresh recovery.
 *
 * @param {string} jobId
 */
export function saveActiveJob(jobId) {
  if (!jobId || typeof jobId !== 'string') return;
  try {
    const payload = JSON.stringify({
      jobId,
      savedAt: Date.now(),
    });
    sessionStorage.setItem(STORAGE_KEY, payload);
  } catch {
    // Fail-open if sessionStorage is disabled or full
  }
}

/**
 * Retrieve the active job ID from session storage.
 *
 * @returns {string|null}
 */
export function getActiveJob() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.jobId === 'string' && parsed.jobId.trim()) {
      return parsed.jobId.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Clear the active job from session storage once terminal or dismissed.
 */
export function clearActiveJob() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Safe no-op
  }
}

export default {
  saveActiveJob,
  getActiveJob,
  clearActiveJob,
};
