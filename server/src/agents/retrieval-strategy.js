/**
 * retrieval-strategy.js — DETERMINISTIC AGENTIC RETRIEVAL LADDER (Phase 4).
 *
 * Pure, deterministic, NO AI call: builds the rung query strings and judges
 * evidence sufficiency for ONE retrieval task (a blueprint slot, or one of
 * its independent items). retrieval.agent.js is the only caller — it owns
 * the actual Qdrant/hybridSearch calls and the escalation loop; this module
 * never touches the network.
 *
 * Reuses, never duplicates:
 *   - blueprint/question-intent.js's buildQuestionIntent() for the concept/
 *     topic/contentQuery text (the SAME abstraction Target Selector and the
 *     Question Ledger already build on).
 *   - grounding.agent.js's groundUnit()/contentTerms() for the sufficiency
 *     coverage math (the SAME formula that already grounds generated
 *     questions post-generation) — this is the pre-generation question
 *     "does the academic material even contain this concept?", answered
 *     with the identical algorithm, not a second incompatible one.
 *
 * Bounded at env.RETRIEVAL_MAX_STRATEGY_ATTEMPTS (default 3, clamped to the
 * 3 defined rungs) — entirely independent of MAX_RETRIES/slotAttempts, which
 * this module never reads or writes.
 */
import { env } from '../config/env.js';
import { buildQuestionIntent } from '../blueprint/question-intent.js';
import { groundUnit, contentTerms } from './grounding.agent.js';

/** The 3 deterministic rungs, narrowest first. */
export const STRATEGY_RUNGS = ['CONCEPT', 'TOPIC_UNIT', 'UNIT_FALLBACK'];

/** Never more rungs than are defined, never fewer than 1. */
export function maxStrategyAttempts() {
  const configured = Number(env.RETRIEVAL_MAX_STRATEGY_ATTEMPTS);
  const bounded = Number.isFinite(configured) ? configured : STRATEGY_RUNGS.length;
  return Math.max(1, Math.min(STRATEGY_RUNGS.length, bounded));
}

/**
 * Build the bounded rung ladder for ONE retrieval task (a slot, or one item
 * of a slot — same `item` convention as buildQuestionIntent/target-selector).
 * Consecutive rungs with an IDENTICAL query string are collapsed (never
 * issues the same Qdrant search twice) — common for a slot with a single
 * reference item, whose topic anchor equals its own concept.
 * @param {Object} opts
 * @param {Object} opts.slot - locked blueprint slot
 * @param {Object|null} [opts.item] - the slot's items[] entry (MIXED-aware); null for a single-item slot
 * @param {Object} [opts.requirements] - { class, subject, difficulty }
 * @returns {Array<{ rung: number, name: string, query: string }>}
 */
export function buildStrategyQueries({ slot, item = null, requirements = {} }) {
  const intent = buildQuestionIntent(slot, item, requirements);
  const cap = maxStrategyAttempts();

  const concept = intent.contentQuery || intent.concept || null;

  const topicText = String(intent.topic || '').trim();
  const topicUnit = topicText ? `${topicText}`.slice(0, 600) : concept;

  const unitParts = ['Class', requirements.class, requirements.subject];
  if (intent.unit) unitParts.push(String(intent.unit));
  unitParts.push(`${requirements.difficulty || 'Medium'} level questions`);
  const unitFallback = unitParts.filter(Boolean).join(' ');

  const all = [
    { rung: 1, name: 'CONCEPT', query: concept },
    { rung: 2, name: 'TOPIC_UNIT', query: topicUnit },
    { rung: 3, name: 'UNIT_FALLBACK', query: unitFallback },
  ].filter((r) => typeof r.query === 'string' && r.query.trim().length > 0);

  // Collapse a rung that repeats the immediately preceding rung's exact query
  // text — no benefit to re-issuing the same search, and it would otherwise
  // count against the bounded attempt ceiling for nothing.
  const deduped = [];
  for (const r of all) {
    if (deduped.length > 0 && deduped[deduped.length - 1].query === r.query) continue;
    deduped.push(r);
  }

  return deduped.slice(0, cap);
}

/**
 * The effective minTerms floor for THIS subject: never higher than the
 * subject's own content-term count. A concept with fewer terms than the
 * configured MIN_EVIDENCE_TERMS (e.g. a single-word "IaaS") can never
 * mathematically satisfy an unreachable "matched >= 2" floor — that must not
 * silently block a legitimately short, well-covered concept. A concept with
 * ZERO content terms is a different case: it keeps the CONFIGURED floor
 * (deliberately unreachable), because groundUnit() already treats
 * termCount===0 as an automatic failure regardless of minTerms — there is no
 * lexical material to judge sufficiency from, so it must never be silently
 * marked sufficient.
 * @param {string} subject
 * @param {number} [minTerms] - defaults to env.MIN_EVIDENCE_TERMS
 * @returns {number}
 */
export function effectiveMinTerms(subject, minTerms = env.MIN_EVIDENCE_TERMS) {
  const termCount = contentTerms(subject).length;
  if (termCount === 0) return minTerms;
  return Math.min(minTerms, termCount);
}

/**
 * Pre-generation evidence sufficiency for ONE retrieval task: does the
 * retrieved evidence sufficiently cover the concept this slot/item needs?
 * Reuses groundUnit() exactly — same coverage formula, same configured
 * MIN_EVIDENCE_COVERAGE, with the short-concept-safe minTerms floor above.
 * @param {string} subject - the task's concept/content query
 * @param {Array<{text: string}>} chunks - retrieved evidence chunks
 * @param {Object} [opts] - { minCoverage, minTerms } overrides (test-only; unchanged in production)
 * @returns {{ ok: boolean, coverage: number, termCount: number, matchedTerms: string[], unmatchedTerms: string[], chunkCount: number }}
 */
export function evidenceSufficient(subject, chunks, opts = {}) {
  const minCoverage = Number.isFinite(opts.minCoverage) ? opts.minCoverage : env.MIN_EVIDENCE_COVERAGE;
  const minTerms = effectiveMinTerms(subject, Number.isFinite(opts.minTerms) ? opts.minTerms : env.MIN_EVIDENCE_TERMS);
  return groundUnit(subject, chunks, { minCoverage, minTerms });
}

export default { STRATEGY_RUNGS, maxStrategyAttempts, buildStrategyQueries, effectiveMinTerms, evidenceSufficient };
