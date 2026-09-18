/**
 * regenResult.js — merge a regeneration response into the current paper result
 * (Mode B, PURE, unit-testable).
 *
 * Why this is a module and not an inline reducer: `POST /papers/:jobId/generate`
 * has no single-slot mode. When the review screen regenerates one stale slot,
 * the server re-runs the WHOLE paper (`questionCount:
 * blueprint.questions.length`) and returns every accepted question, already
 * sorted by `slotIndex`. So the merge is not "splice one question into the old
 * list" — it is "render the fresh paper". The previous reducer took only
 * `data.questions[0]`, reassigned its `slotIndex` to `others.length` (past the
 * end of the paper), and prepended it to the STALE list: the changed slot kept
 * its old content and the regenerated question rendered as an unplaced extra.
 *
 * @param {Object|null} prev - the previous result (not authoritative; kept in
 *   the signature so the caller still reads as a reducer)
 * @param {Object} data - the regeneration response body (orchestrator shape:
 *   `{ questions: [...accepted in slot order], rejected, meta }`)
 * @returns {Object} the result to render
 */
export function mergeRegeneratedResult(prev, data) {
  if (!data || !Array.isArray(data.questions)) return prev ?? data;
  return {
    ...data,
    rejected: (data.rejected || []).filter((r) => r.slotIndex != null),
  };
}

/**
 * Phase 5 review: merge ONE regenerated question into the current result.
 *
 * `POST /papers/:jobId/regenerate-slot` returns a single question for one
 * blueprint slot; every other question on the paper — including teacher-edited
 * ones — must stay EXACTLY as it is. This splice replaces only the entry whose
 * slotIndex matches (questions without a slotIndex fall back to their list
 * position) and drops any rejected entry for the slot. Returns `prev`
 * unchanged when there is nothing to merge.
 *
 * @param {Object|null} prev - current result ({ questions, rejected, ... })
 * @param {Object|null} question - the regenerated question
 * @param {number} slotIndex - the slot the question fills
 * @returns {Object} new result object (prev untouched)
 */
export function mergeRegeneratedSlot(prev, question, slotIndex) {
  if (!prev || !Array.isArray(prev.questions) || !question || !Number.isInteger(slotIndex)) return prev;
  let replaced = false;
  const questions = prev.questions.map((qq, i) => {
    const idx = Number.isInteger(qq?.slotIndex) ? qq.slotIndex : i;
    if (idx !== slotIndex) return qq;
    replaced = true;
    return { ...question, slotIndex };
  });
  if (!replaced) questions.push({ ...question, slotIndex });
  return {
    ...prev,
    questions,
    rejected: (prev.rejected || []).filter((r) => r?.slotIndex !== slotIndex),
  };
}

export default { mergeRegeneratedResult, mergeRegeneratedSlot };
