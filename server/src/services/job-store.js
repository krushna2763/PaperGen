/**
 * job-store.js
 *
 * Process-local store for generation-job PROGRESS only. It never holds the
 * authoritative blueprint or slotUnitMap — those live client-side until posted
 * to /generate, and the generate handler passes them straight through from the
 * request body. This store exists solely so GET /papers/:jobId/status can
 * report per-slot progress while the pipeline runs.
 *
 * Deliberately in-memory (matches the embedding cache / no-Redis stance). Jobs
 * expire after TTL_MS so a long-lived server does not leak.
 */
import { randomUUID } from 'crypto';

const TTL_MS = 30 * 60 * 1000;
const jobs = new Map();

/** Register a job from a blueprint; returns its id. */
export function createJob(blueprint) {
  const id = randomUUID();
  const slots = (Array.isArray(blueprint?.questions) ? blueprint.questions : []).map((q, i) => ({
    slot: i,
    label: q?.label || `Q${i + 1}`,
    state: 'pending',
    attempts: 0,
  }));
  jobs.set(id, { id, slots, done: false, createdAt: Date.now() });
  return id;
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

/** Patch one slot by numeric index or by label. No-op for unknown jobs/slots. */
export function updateSlot(id, slot, patch) {
  const job = jobs.get(id);
  if (!job) return;
  const s = job.slots.find((x) => x.slot === slot || x.label === slot);
  if (s) Object.assign(s, patch);
}

/** Patch several slots at once. */
export function markSlots(id, slotsOrLabels, patch) {
  for (const key of slotsOrLabels || []) updateSlot(id, key, patch);
}

export function finishJob(id) {
  const job = jobs.get(id);
  if (job) job.done = true;
}

// Periodic sweep of expired jobs (unref so it never keeps the process alive).
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of jobs) if (now - v.createdAt > TTL_MS) jobs.delete(k);
}, TTL_MS);
if (typeof sweep.unref === 'function') sweep.unref();

export default { createJob, getJob, updateSlot, markSlots, finishJob };
