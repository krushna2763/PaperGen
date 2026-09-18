import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { env } from '../config/env.js';
import { retrievalAgent } from './retrieval.agent.js';
import { questionGeneratorAgent, repairMissingRequiredFields } from './question-generator.agent.js';
import { similarityAgent } from './similarity.agent.js';
import { validationAgent } from './validation.agent.js';
import { checkGrounding } from './grounding.agent.js';
import { embeddingService } from '../rag/embeddings.js';
import { runWithConcurrencyLimit, normalizeQuestionText } from './agent-utils.js';
import { checkBlueprintShape } from '../blueprint/blueprint-schema.js';
import { normalizeBlueprint } from '../blueprint/blueprint-normalizer.js';
import { checkQuestion, validatePaper, summarize as summarizeBlueprint } from '../blueprint/blueprint-validator.js';
import { checkAnswers } from '../blueprint/answer-validator.js';
import {
  checkReferenceNovelty,
  referenceItemPairs,
  subPartTexts,
  applyReferenceEmbeddingBackstop,
  slotHasBroadSummaryItem,
} from './reference-novelty.agent.js';
import { runWithStats, getStats, addTiming, bumpAi } from '../services/perf-context.js';
import { updateSlot, getJob } from '../services/job-store.js';
import {
  emitStageEvent,
  emitSlotProgress,
  emitRegenerationStage,
  emitLogEvent,
  emitComplete,
  emitError,
} from '../services/orchestrator-telemetry.js';
import { selectTargetsForPool } from './target-selector.js';
import { selectBestCandidate } from './candidate-selector.js';
import { selectTarget } from './target-selector.js';
import { buildLedger } from './question-ledger.js';
import { buildPlansForSlot } from '../planner/question-planner.js';
import { validatePlansForSlot } from '../planner/question-plan-validator.js';
import { checkCognitiveDemandFidelity } from './cognitive-demand-fidelity.js';
// SEMANTIC IMAGE GROUNDING — reference image → topic/concepts → notes text
// evidence (existing retrieval) → optional notes-image metadata. One vision
// call per reference image; never image-to-image similarity. The retrieval
// agent is injected here (production wiring); tests may inject a stub.
import { buildImageGrounding, checkImageGroundingFidelity, checkVisualEngagement, setImageRetrievalAgent } from '../rag/image-grounding.service.js';
import { retrievalAgent as _groundingRetrievalAgent } from './retrieval.agent.js';

setImageRetrievalAgent(_groundingRetrievalAgent);

/**
 * Orchestrator Agent (RULE 8 — Orchestrator coordinates agents)
 *
 * Latency-optimized LangGraph StateGraph:
 *
 *   START → retrieve → generate → embedGenerated → evaluateBatch
 *                                                   │
 *                       (rejected empty? → blueprintCheck [blueprint mode])
 *                                                   │
 *                                    (rejected empty? → END)
 *                                                   │ rejected
 *                                                   ↓
 *                                             regenerateFailed
 *                                                   ↓
 *                                             embedGenerated → evaluateBatch (loop)
 *
 * Latency strategy (per round, for N questions):
 *   - retrieve       : ONE query embedding + ONE Qdrant search (reused via state)
 *   - generate       : ONE batch LLM call for all N questions (+ bounded refill)
 *   - embedGenerated : ONE batch embedding pass (N vectors, controlled concurrency)
 *   - evaluateBatch  : deterministic local checks → in-memory peer cosine
 *                      (0 calls) → parallel Qdrant source checks (0 LLM calls)
 *                      → ONE batch validation LLM call for all survivors
 *   - blueprintCheck : deterministic structural conformance vs the LOCKED
 *                      blueprint (0 LLM calls) — only in blueprint mode
 *   - regenerateFailed : regenerate ONLY failed questions (parallel, concurrency-limited);
 *                      accepted questions are preserved untouched in state
 *
 * Gemini call count for a 5-question request without retries:
 *   1 (retrieval embed) + 1 (batch generation) + 1 (TRUE batch embed, 5 inputs) + 1 (batch validation)
 *   = 4 calls, versus 8 with the old per-question embedding and 17 before any
 *   optimization. Regeneration rounds add calls ONLY for failed questions.
 *
 * RULE 9:  Agents do not manage unrelated infrastructure.
 * RULE 10: All AI calls go through the centralized Gemini client.
 */

const VALID_DIFFICULTIES = ['Easy', 'Medium', 'Difficult'];
const VALID_TYPES = ['MCQ', 'SHORT_ANSWER', 'LONG_ANSWER', 'TRUE_FALSE', 'FILL_IN_THE_BLANK'];

// A slot correcting AWAY from a broad moral/theme-summary demand must land on
// a genuinely different demand, not just different wording — realistically
// harder than a typical rejection, so it earns a small extra retry budget on
// top of the standard bound. Driven by the reference item's TEXT SHAPE only
// (slotHasBroadSummaryItem) — never by slot label, subject, or specific
// story/unit content, and never in place of the standard bound elsewhere.
const EXTRA_RETRIES_FOR_BROAD_SUMMARY = 2;

/** The retry ceiling for ONE slot — env.MAX_RETRIES, +2 when any of its
 * reference items has the broad moral/theme-summary demand shape. */
function effectiveMaxRetries(slot) {
  return env.MAX_RETRIES + (slotHasBroadSummaryItem(slot) ? EXTRA_RETRIES_FOR_BROAD_SUMMARY : 0);
}

// Phase 2 — CANDIDATE POOL: number of independent candidates requested in
// ONE regeneration call. PHASE 6 raises the pool to 3 candidates (default per
// spec: "Default to 3 candidates"); still ONE LLM call and ONE slotAttempts
// increment regardless of pool size — pooling never adds a retry.
const CANDIDATE_POOL_SIZE = 3;


/**
 * PHASE 6 — per-slot ANSWER-FIRST targets for a whole blueprint: one entry
 * per slot, each { items: [selectTarget(...) per reference item] } so the
 * generator prompt can carry per-item transformation/answer-target directives
 * (MIXED-safe: each item gets its own). Deterministic and cheap — rebuilt per
 * generation call, never cached across requirement changes. Best-effort:
 * returns null on any failure (prompts then render exactly as before).
 * @returns {Array<{ items: Object[] }>|null}
 */
function buildSlotTargets(blueprint, requirements) {
  if (!blueprint || !Array.isArray(blueprint.questions)) return null;
  try {
    return blueprint.questions.map((slot) => {
      const items = Array.isArray(slot?.items) && slot.items.length > 0 ? slot.items : [null];
      return { items: items.map((it) => selectTarget({ slot, item: it, requirements })) };
    });
  } catch (err) {
    console.warn(`[Pipeline] Phase 6 slot targets unavailable (${err.message}) — prompts render without them.`);
    return null;
  }
}

/**
 * ONE regeneration attempt for a slot. Attempt 1 is always the existing
 * single-candidate `regenerate()` call, byte-identical to pre-Phase-2
 * behavior. From attempt 2 onward, target-selector.js builds a small pool of
 * distinct-target candidates, ONE LLM call produces all of them
 * (regeneratePool), and candidate-selector.js pre-screens with the SAME
 * deterministic validators the pipeline already trusts — the winner is
 * handed back in the EXACT shape a single regenerate() call would have
 * returned, so every caller downstream (evaluateBatchNode, blueprintCheckNode)
 * is completely unaware pooling ever happened. Exactly one LLM call and one
 * slotAttempts increment either way — pool size never touches retry budget.
 * @param {Object} opts
 * @returns {Promise<Object>} a normalized candidate question
 */
async function regenerateOneCandidate({ existingQuestion, reasons, requirements, context, blueprint, slotIndex, slotContexts, slotUnitMap = null, attempt, maxAttempts, ledger = [], priorReasons = [] }) {
  const slot = blueprint?.questions?.[slotIndex] ?? null;
  if (attempt >= 2 && slot) {
    const candidateTargets = selectTargetsForPool({ slot, requirements, ledger, poolSize: CANDIDATE_POOL_SIZE });
    const candidates = await questionGeneratorAgent.regeneratePool(existingQuestion, reasons, requirements, context, candidateTargets, {
      blueprint, slotIndex, slotContexts, attempt, maxAttempts, priorReasons,
      slotTargets: buildSlotTargets(blueprint, requirements),
    });
    // PHASE 6 ranking inputs: per-item targets (transformation signal) and a
    // pre-seeded vector map (semantic novelty). Reference texts are embedded
    // HERE — one small batch; candidate vectors ride on the candidates from
    // the embedGenerated pass — so ranking reads both sides without a second
    // full embedding call. Best-effort: any failure degrades to lexical-only.
    let rankingVectors = null;
    let rankingTargets = [];
    try {
      rankingTargets = Array.isArray(slot?.items) && slot.items.length > 0
        ? slot.items.map((it) => selectTarget({ slot, item: it, requirements }))
        : [selectTarget({ slot, item: null, requirements })];
      const refTexts = [...new Set(
        (Array.isArray(slot?.items) ? slot.items : [])
          .map((it) => String(it?.referenceText || it?.topicAnchor || '').trim())
          .filter(Boolean)
      )];
      if (refTexts.length > 0) {
        const refEmbed = await embeddingService.embedQuestions(refTexts.map((text) => ({ text })));
        rankingVectors = new Map(refEmbed.questions.map((q) => [q.text, q.embedding]));
        for (const c of candidates) {
          const cVec = c?.embedding;
          for (const p of (Array.isArray(c?.subParts) ? c.subParts : [])) {
            if (Array.isArray(cVec) && typeof p?.text === 'string' && p.text && !rankingVectors.has(p.text)) {
              rankingVectors.set(p.text, cVec);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[Pipeline] Phase 6 ranking inputs unavailable (${err.message}) — lexical-only ranking.`);
    }
    const { winner } = selectBestCandidate({
      candidates, slot, slotIndex, blueprint,
      slotContexts: slotContexts ?? [],
      slotUnitMap,
      vectorsByText: rankingVectors,
      targets: rankingTargets,
      requirements,
    });
    if (winner) return winner;
    // The model returned zero usable candidates for this call (rare parse/
    // model failure) — this attempt is still SPENT (one real call was made),
    // so surface an honest, empty candidate that the existing structural
    // gate will reject on its own terms, exactly like a malformed single
    // regenerate() response would. Never issues a second call for the same attempt.
    return { questionId: existingQuestion?.questionId, text: '', type: existingQuestion?.type ?? slot.type, marks: slot.totalMarks ?? existingQuestion?.marks, subParts: [] };
  }
  return questionGeneratorAgent.regenerate(existingQuestion, reasons, requirements, context, {
    blueprint, slotIndex, slotContexts, attempt, maxAttempts, priorReasons,
    slotTargets: buildSlotTargets(blueprint, requirements),
  });
}

/**
 * PHASE 10 — INITIAL-PASS CANDIDATE POOL (opt-in, env.MULTI_CANDIDATE_ENABLED).
 * ONE LLM call produces a pool of CANDIDATE_POOL_SIZE candidates for EVERY
 * blueprint slot; candidate-selector.js's SAME deterministic pre-screen used
 * for regeneration picks one winner per slot BEFORE anything downstream
 * (embedGeneratedNode, evaluateBatchNode, blueprintCheckNode) ever runs — so
 * every caller downstream is unaware pooling happened, exactly like a
 * regeneration pool. A slot whose pool came back empty is simply absent from
 * the returned array (the existing missing-slot handling already downstream
 * — generateForSlot refill / failed-slot accounting — takes over from there,
 * unchanged); this function never fabricates a candidate.
 * @param {Object} opts - { requirements, context, blueprint, slotContexts, slotTargets }
 * @returns {Promise<Object[]>} one winning candidate per slot that produced any usable candidate
 */
async function generateInitialPoolWinners({ requirements, context, blueprint, slotContexts, slotTargets }) {
  const poolTargetsBySlot = blueprint.questions.map((slot) =>
    selectTargetsForPool({ slot, requirements, poolSize: CANDIDATE_POOL_SIZE })
  );
  const pools = await questionGeneratorAgent.generateInitialPool(requirements, context, poolTargetsBySlot, {
    blueprint, poolSize: CANDIDATE_POOL_SIZE, slotContexts, slotTargets,
  });

  const winners = [];
  blueprint.questions.forEach((slot, i) => {
    const pool = pools[i] || [];
    if (pool.length === 0) return;
    const rankStart = Date.now();
    const { winner } = selectBestCandidate({
      candidates: pool,
      slot,
      slotIndex: i,
      blueprint,
      slotContexts: slotContexts ?? [],
      targets: Array.isArray(slotTargets?.[i]?.items) ? slotTargets[i].items : [],
      requirements,
    });
    // DIAGNOSTIC (Phase 10 combined-timeout investigation) — counts/durations
    // only. selectBestCandidate is pure/local (no network calls), so this
    // isolates ranking cost from LLM/network cost in the timing breakdown.
    console.log(`[DIAG rank] slot=${slot?.label ?? i} type=${slot?.type ?? '?'} poolReceived=${pool.length} rankDurationMs=${Date.now() - rankStart} wonWinner=${Boolean(winner)}`);
    if (winner) winners.push(winner);
  });
  console.log(`[Pipeline] Phase 10 multi-candidate initial pass: ${winners.length}/${blueprint.questions.length} slot(s) got a pooled winner (pool=${CANDIDATE_POOL_SIZE}).`);
  return winners;
}

/** Deduped union of a slot's older rejection reasons with its newest ones —
 * the running history fed to buildAdaptiveFeedback so a slot correcting
 * TOWARD one extreme (e.g. dropping every reference word) carries a guard
 * against the OPPOSITE extreme it already failed for in an earlier round
 * (e.g. reusing the reference's own wording). Capped so the prompt does not
 * grow unbounded across a slot's retry budget. */
function mergeReasonHistory(prior = [], current = []) {
  const merged = [...(Array.isArray(prior) ? prior : []), ...(Array.isArray(current) ? current : [])];
  return [...new Set(merged)].slice(-12);
}

/** Safe diagnostic (PART 24) — never logs prompt/answer content or secrets. */
function logRetryExhausted(blueprint, slotIndex, attempts, reasons = []) {
  const label = blueprint?.questions?.[slotIndex]?.label ?? (slotIndex != null ? `slot-${slotIndex + 1}` : 'unknown');
  const reasonsText = Array.isArray(reasons) && reasons.length > 0 ? ` Reasons: ${reasons.join(' | ')}` : '';
  console.log(`[regeneration] slot=${label} retry budget exhausted (${attempts} attempt(s) used).${reasonsText}`);
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Normalize and validate teacher requirements with sane defaults.
 * @param {Object} input - Raw request body
 * @returns {Object} Normalized requirements
 */
function normalizeRequirements(input = {}) {
  const docClass = String(input.class ?? '').trim();
  const subject = String(input.subject ?? '').trim();
  const topic = String(input.topic ?? '').trim() || undefined;

  let difficulty = String(input.difficulty ?? 'Medium').trim();
  difficulty = difficulty.charAt(0).toUpperCase() + difficulty.slice(1).toLowerCase();
  if (!VALID_DIFFICULTIES.includes(difficulty)) difficulty = 'Medium';

  let questionCount = parseInt(input.questionCount, 10);
  if (!Number.isFinite(questionCount) || questionCount < 1) questionCount = 5;
  if (questionCount > 20) questionCount = 20;

  let questionType = String(input.questionType ?? '').trim().toUpperCase() || undefined;
  if (questionType && !VALID_TYPES.includes(questionType)) questionType = undefined;

  if (!docClass) throw httpError('"class" is required to generate questions.', 400);
  if (!subject) throw httpError('"subject" is required to generate questions.', 400);

  return { class: docClass, subject, topic, difficulty, questionCount, questionType };
}

// ─── Shared state schema ────────────────────────────────────────────────────
const GenerationState = Annotation.Root({
  requirements: Annotation(),
  blueprint: Annotation(),          // locked previous-year paper blueprint (optional)
  slotUnitMap: Annotation(),        // teacher unit assignment: { [label]: { unit } | { items } }
  jobId: Annotation(),              // progress reporting into the job store (optional)
  retrieval: Annotation(),
  context: Annotation(),
  slotContexts: Annotation(),       // QUESTION-LEVEL RAG: per-slot contexts (blueprint mode)
  candidates: Annotation(),
  rejected: Annotation(),        // pending entries [{ question, slotIndex, reasons, attempts }]
  accepted: Annotation(),        // accepted questions (accumulated; never re-evaluated)
  acceptedVectors: Annotation(), // questionId -> embedding of accepted questions (peer checks)
  failed: Annotation(),          // entries that exhausted MAX_RETRIES
  regenerationRounds: Annotation(),
  // PERSISTENT, PER-SLOT-INDEX regeneration attempt counter (PART 24). A
  // candidate object's own `.attempts` field can go stale or missing — it is
  // replaced wholesale on every regeneration, and blueprintCheckNode's "no
  // candidate for this slot" case has no candidate to read it from at all.
  // `slotAttempts[slotIndex]` is the ONE authoritative count of REAL LLM
  // regeneration calls issued for that slot, incremented exactly once per
  // call (in regenerateFailedNode), and consulted by BOTH gates
  // (evaluateBatchNode + blueprintCheckNode) so MAX_RETRIES is a true global
  // ceiling regardless of which gate rejects the candidate or how many times
  // a slot bounces between them. Keyed by slotIndex (a stable identifier),
  // never by questionId (which a candidate's own regeneration can drift).
  slotAttempts: Annotation(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────
function sourceReason(sourceCheck) {
  return `Too similar to previous paper question "${sourceCheck.matchedQuestion}" (cosine ${sourceCheck.maxSimilarity} >= threshold ${sourceCheck.threshold}).`;
}

function peerReason(peerCheck) {
  return `Too similar to generated question "${peerCheck.matchedWith}" (cosine ${peerCheck.maxSimilarity} >= threshold ${peerCheck.threshold}).`;
}

function validationReasons(validation) {
  return validation.issues.length > 0 ? validation.issues : [validation.reason];
}

/**
 * Reference-embedding backstop (PARTS 15/16 — hybrid mode only): ONE batch
 * embedding of the union of generated sub-part texts + their slots' reference
 * item texts, then a deterministic 0.85-threshold cosine comparison of each
 * sub-part against its POSITIONAL reference item. Catches restatements at
 * 0.91–0.95 cosine that lexical demand cues can miss (real E2E evidence).
 * The embedding cache makes repeated texts (regen rounds) free.
 *
 * @param {Array<{ question: Object, slotIndex: number|null }>} entries
 * @param {Object|null} blueprint - locked blueprint
 * @returns {Promise<{ pass: Array, failed: Array<{ entry: Object, reasons: string[] }> }>}
 */
async function runEmbeddingNoveltyBackstop(entries, blueprint) {
  const failed = [];
  // BUGFIX (candidate-loss): the return value is spread/re-assigned by call
  // sites (`checked.length = 0; checked.push(...backstop.pass)`), so handing
  // back the CALLER'S array by reference made every early return WIPE the
  // caller's list — a slot whose text set is empty (e.g. a single-stem slot
  // with no reference items, the real Unit-I E2E Q3 shape) lost ALL of its
  // candidates silently between batchEmbed and evaluateBatch. Always return a
  // fresh array, never an alias of the input.
  const inputCopy = Array.isArray(entries) ? [...entries] : [];
  if (!blueprint || inputCopy.length === 0) {
    return { pass: inputCopy, failed };
  }

  // Collect the union of texts that need vectors (generated sub-parts and
  // their positional reference items) for slots that actually have pairs.
  const texts = new Set();
  for (const entry of entries) {
    const slot = blueprint.questions?.[entry.slotIndex] ?? null;
    const refs = referenceItemPairs(slot);
    const parts = subPartTexts(entry.question);
    if (refs.length === 0 || parts.length === 0) continue;
    for (const p of parts) texts.add(p.text);
    for (const r of refs) texts.add(r.text);
  }
  if (texts.size === 0) return { pass: inputCopy, failed };

  const embedded = await embeddingService.embedQuestions(Array.from(texts).map((text) => ({ text })));
  const vectorsByText = new Map(embedded.questions.map((q) => [q.text, q.embedding]));

  return applyReferenceEmbeddingBackstop({
    entries,
    blueprint,
    vectorsByText,
    threshold: env.REFERENCE_NOVELTY_EMBEDDING_THRESHOLD,
  });
}

function stripEmbedding(question) {
  if (!question) return question;
  const { embedding: _embedding, ...rest } = question;
  return rest;
}

async function timed(label, fn) {
  const t0 = Date.now();
  const result = await fn();
  const ms = Date.now() - t0;
  console.log(`[Pipeline] ${label}: ${ms}ms`);
  addTiming(label, ms);
  return result;
}

/** Extended type set when a blueprint is locked (blueprint types allowed). */
function validTypesFor(blueprint) {
  if (!blueprint) return undefined;
  return [...new Set([...VALID_TYPES, ...blueprint.questions.map((q) => q.type)])];
}

/** Dedup / duplicate-comparison text source (full content in blueprint mode). */
function dupTextOf(question, useFullText) {
  return normalizeQuestionText(useFullText ? (question.fullText || question.text) : question.text);
}

// ─── Nodes ──────────────────────────────────────────────────────────────────

/**
 * Safe cancellation check for LangGraph orchestration.
 * Throws a CancellationError so the pipeline halts cleanly before starting
 * expensive AI / retrieval / validation operations.
 */
function checkCancellation(jobId) {
  if (!jobId) return;
  const job = getJob(jobId);
  if (job && (job.status === 'cancelled' || job.abortController?.signal?.aborted)) {
    const err = new Error('Paper generation cancelled by user');
    err.isCancellation = true;
    throw err;
  }
}

/**
 * Retrieval Agent node. Free-form mode: ONE query embedding + ONE search.
 * BLUEPRINT mode: QUESTION-LEVEL RAG — one batch embedding of N slot queries
 * (built from each slot's reference items = its topic/concept area) followed
 * by a concurrent per-slot Qdrant search. Per-slot contexts drive generation;
 * the flattened pool is kept for the semantic validation pass.
 */
async function retrieveNode(state) {
  checkCancellation(state?.jobId);
  emitStageEvent(state.jobId, 'rag_retrieval', {
    message: 'Retrieving syllabus and reference question context',
  });
  const blueprint = state.blueprint || null;
  if (blueprint && Array.isArray(blueprint.questions) && blueprint.questions.length > 0) {
    return timed('retrieveSlots', async () => {
      const perSlot = await retrievalAgent.retrieveForSlots(blueprint, state.requirements, {
        slotUnitMap: state.slotUnitMap || {},
      });
      const populated = perSlot.filter((s) => s.results.length > 0);
      if (populated.length === 0) {
        // Fall back to the whole-paper query when nothing was indexed for this
        // class/subject (identical behaviour to free-form mode).
        console.warn('[Pipeline] question-level RAG returned no context — falling back to whole-paper retrieval.');
        const retrieval = await retrievalAgent.retrieve(state.requirements);
        if (!retrieval.results || retrieval.results.length === 0) {
          throw httpError(
            `No previous questions found in the vector store for Class ${state.requirements.class} / ${state.requirements.subject}. Index question papers first.`,
            400
          );
        }
        return { retrieval, context: retrieval.results, slotContexts: perSlot };
      }
      // Flatten (deduped, bounded) into the shared context for semantic validation.
      const seen = new Set();
      const flat = [];
      for (const s of perSlot) {
        for (const hit of s.results) {
          const norm = String(hit.text || '').toLowerCase().replace(/\s+/g, ' ');
          if (seen.has(norm)) continue;
          seen.add(norm);
          flat.push(hit);
          if (flat.length >= 14) break;
        }
        if (flat.length >= 14) break;
      }
      const retrieval = { perSlotContexts: perSlot, results: flat };
      console.log(`[Pipeline] question-level RAG: ${populated.length}/${blueprint.questions.length} slots with context (${flat.length} unique context question(s)).`);
      // SEMANTIC IMAGE GROUNDING (opt-in, IMAGE_BASED slots only) — ONE vision
      // call per reference image, then the SAME topic/concepts are matched in
      // the notes through the existing retrieval stack. The grounding object
      // rides on the slot context so the planner, generator prompt, ranking
      // and the fidelity gate all read the same evidence. Never runs for
      // text-only slots; a failure degrades to no-grounding (never fatal).
      if (env.IMAGE_GROUNDING_ENABLED) {
        await attachImageGrounding(blueprint, perSlot, state);
      }
      return { retrieval, context: flat, slotContexts: perSlot };
    });
  }

  return timed('retrieve', async () => {
    const retrieval = await retrievalAgent.retrieve(state.requirements);

    if (!retrieval.results || retrieval.results.length === 0) {
      throw httpError(
        `No previous questions found in the vector store for Class ${state.requirements.class} / ${state.requirements.subject}. Index question papers first.`,
        400
      );
    }

    return { retrieval, context: retrieval.results };
  });
}

/**
 * SEMANTIC IMAGE GROUNDING — build the ImageGrounding object for every
 * IMAGE_BASED slot that has an actual image asset and attach it to that
 * slot's retrieval context (slotContexts[i].imageGrounding). One vision call
 * per reference image (cached per image); notes text evidence comes through
 * the EXISTING retrieval agent (one extra per-slot retrieval task per image
 * slot). Best-effort by contract: any failure leaves the context without a
 * grounding object and the pipeline continues exactly as before.
 */
async function attachImageGrounding(blueprint, slotContexts, state) {
  const imageSlotIndexes = [];
  blueprint.questions.forEach((slot, i) => {
    // Image-BEARING slot (semantic, label-agnostic): the blueprint normalizer
    // re-derives heterogeneous-item slots to MIXED even when analyze declared
    // IMAGE_BASED and attached the reference image. Ground what carries an
    // image; the type label alone is neither necessary nor sufficient.
    const hasImageAsset = Array.isArray(slot?.imageAssets) && slot.imageAssets.length > 0;
    if (hasImageAsset || String(slot?.type || '').toUpperCase() === 'IMAGE_BASED') {
      imageSlotIndexes.push(i);
    }
  });
  if (imageSlotIndexes.length === 0) return;
  emitStageEvent(state.jobId, 'image_grounding', {
    message: 'Grounding diagram visual concepts and relational anchors',
  });
  for (const i of imageSlotIndexes) {
    const slot = blueprint.questions[i];
    try {
      const grounding = await buildImageGrounding({
        slot,
        blueprint,
        requirements: state.requirements,
        slotUnitMap: state.slotUnitMap || null,
      });
      if (grounding && slotContexts[i]) {
        slotContexts[i].imageGrounding = grounding;
      }
    } catch (err) {
      console.warn(`[Pipeline] image grounding failed for slot ${i + 1} (continuing without it): ${String(err?.message || err).slice(0, 160)}`);
    }
  }
}

/**
 * PHASE 9 — build + validate a deterministic QuestionPlan per blueprint slot
 * and attach it to the index-aligned slot context (the same alignment
 * formatBlueprintSlots already relies on). Validation NEVER repairs a plan:
 * errors are recorded and force reviewRequired, so targeted regeneration
 * receives the same plan plus the failure reason (Phase 9 §16).
 * Planning is deterministic and local — zero LLM calls.
 */
function attachPlansToSlotContexts(blueprint, slotContexts, slotTargets, requirements) {
  const t0 = Date.now();
  let planned = 0;
  let invalid = 0;
  blueprint.questions.forEach((slot, i) => {
    const sc = slotContexts[i];
    if (!sc) return;
    try {
      const { plans } = buildPlansForSlot({
        slot,
        slotTarget: Array.isArray(slotTargets) ? (slotTargets[i] ?? null) : null,
        requirements,
        vectorEvidence: sc.results || [],
        graphEvidence: sc.graphEvidence || [],
        graphRelationships: sc.graphRelationships || [],
        // SEMANTIC IMAGE GROUNDING — the plan's imageRequirement carries the
        // grounded topic/concepts/observation targets + notes evidence.
        imageGrounding: sc.imageGrounding || null,
        slotIndex: i,
        questionNumber: i + 1,
      });
      const plan = plans[0];
      const v = validatePlansForSlot(plans, { slot, requirements });
      if (!v.ok) {
        invalid += 1;
        plan.validatorErrors = v.errors;
        plan.reviewRequired = true;
        plan.plannerWarnings = [...(plan.plannerWarnings || []), ...v.errors.map((e) => `validator: ${e}`)];
      }
      sc.plan = plan;
      planned += 1;
    } catch (err) {
      // Planner fails safely (Phase 9 §29): the slot continues WITHOUT a plan
      // (pre-Phase-9 behavior for that slot) — planning never blocks generation.
      console.warn(`[QUESTION-PLANNER] slot ${i + 1} planning failed — continuing without a plan: ${String(err?.message || err).slice(0, 160)}`);
    }
  });
  console.log(`[QUESTION-PLANNER] planned=${planned}/${blueprint.questions.length} invalid=${invalid} latency=${Date.now() - t0}ms`);
}

/** Generation Agent node: ONE batch LLM call for all candidates (+ bounded refill). */
async function generateNode(state) {
  checkCancellation(state?.jobId);
  emitStageEvent(state.jobId, 'slot_generation', {
    message: 'Generating question candidates across blueprint slots',
  });
  if (state.blueprint?.questions) {
    state.blueprint.questions.forEach((slot, i) => {
      emitSlotProgress(state.jobId, {
        slotIndex: i,
        questionNumber: slot.label || `Q${i + 1}`,
        status: 'generating',
        progressPercent: 60,
      });
    });
  }
  return timed('generateBatch', async () => {
    const requirements = state.requirements;
    const blueprint = state.blueprint || null;
    // PHASE 6 — answer-first directives ride into the INITIAL batch prompt.
    const slotTargets = blueprint ? buildSlotTargets(blueprint, requirements) : null;
    // PHASE 9 — opt-in planning layer: retrieval → QuestionPlan → validate →
    // generate. When disabled, nothing here runs (byte-identical behavior).
    if (env.QUESTION_PLANNER_ENABLED && blueprint && Array.isArray(state.slotContexts)) {
      attachPlansToSlotContexts(blueprint, state.slotContexts, slotTargets, requirements);
    }

    // PHASE 10 — opt-in multi-candidate initial pass. Blueprint mode only
    // (pooling needs slots to pool per). Any failure (bad JSON, schema
    // violation, transient error) falls back to the existing single-candidate
    // generate() call, matching this codebase's fallback-on-failure
    // convention everywhere else. When disabled, this branch never runs —
    // byte-identical to pre-Phase-10 behavior.
    let candidates;
    if (env.MULTI_CANDIDATE_ENABLED && blueprint) {
      try {
        candidates = await generateInitialPoolWinners({ requirements, context: state.context, blueprint, slotContexts: state.slotContexts, slotTargets });
      } catch (err) {
        console.warn(`[Pipeline] Phase 10 multi-candidate initial pass failed (${err.message}) — falling back to single-candidate generate().`);
        candidates = await questionGeneratorAgent.generate(requirements, state.context, { blueprint, slotContexts: state.slotContexts, slotTargets });
      }
    } else {
      candidates = await questionGeneratorAgent.generate(
        requirements,
        state.context,
        blueprint ? { blueprint, slotContexts: state.slotContexts, slotTargets } : {}
      );
    }

    // Refill shortfall (bounded: one extra call) so count matches the requested
    // count when possible (blueprint mode: fills the remaining slots in order).
    if (candidates.length > 0 && candidates.length < requirements.questionCount) {
      const extraCount = requirements.questionCount - candidates.length;
      const extra = await questionGeneratorAgent.generate(requirements, state.context, blueprint
        ? { blueprint, extraCount, startSlotIndex: candidates.length, slotContexts: state.slotContexts, slotTargets }
        : { extraCount });
      candidates = candidates.concat(extra);
    }

    // Deterministic local cleanup: unique ids + normalized exact duplicates (keep first).
    // In blueprint mode, duplicate detection uses FULL content (stem + parts) because
    // two slots may legitimately share a generic stem ("Answer the following questions:").
    const useFullText = !!blueprint;
    const seenIds = new Set();
    const seenTexts = new Set();
    const deduped = [];
    for (const candidate of candidates) {
      const key = dupTextOf(candidate, useFullText);
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
      let id = candidate.questionId || `generated-${deduped.length + 1}`;
      if (seenIds.has(id)) id = `generated-${deduped.length + 1}`;
      seenIds.add(id);
      deduped.push({ ...candidate, questionId: id });
    }
    candidates = deduped;

    // Cap the batch to the requested count — the model may overshoot "exactly N"
    if (candidates.length > requirements.questionCount) {
      candidates = candidates.slice(0, requirements.questionCount);
    }

    if (candidates.length === 0) {
      throw httpError('The generation agent returned no usable questions. Please try again.', 502);
    }

    console.log(`[Pipeline] generateBatch: ${candidates.length} candidate(s) (requested ${requirements.questionCount})${blueprint ? ' [blueprint mode]' : ''}`);
    // The initial batch call IS the first real regeneration attempt for every
    // slot it produced — seed the persistent per-slot counter at 1 so it is
    // the single source of truth from the very start (PART 24).
    const slotAttempts = blueprint
      ? Object.fromEntries(candidates.map((c, i) => [i, 1]))
      : {};
    return {
      candidates,
      slotAttempts,
      rejected: candidates.map((c, i) => ({
        question: c,
        slotIndex: blueprint ? i : undefined,
        reasons: [],
        attempts: 0,
      })),
    };
  });
}

/** Embedding node: ONE batch embedding pass over all pending questions. */
async function embedGeneratedNode(state) {
  const pending = state.rejected ?? [];
  if (pending.length === 0) return { rejected: pending };

  return timed('batchEmbed', async () => {
    // A pending entry can carry a null question when a regeneration CALL failed
    // for a never-generated slot. Never send null to the embedder — pass those
    // entries through untouched so the next evaluate pass settles them (they
    // hit MAX_RETRIES and become terminal REJECTED, never dropped).
    const embeddable = [];
    const embeddableIdx = [];
    pending.forEach((e, i) => {
      if (e.question && String(e.question.text ?? e.question.fullText ?? '').trim()) {
        embeddable.push(e.question);
        embeddableIdx.push(i);
      }
    });

    const result = embeddable.length > 0
      ? await embeddingService.embedQuestions(embeddable, { concurrency: env.AI_EVAL_CONCURRENCY })
      : { questions: [], count: 0, vectorDimension: 0 };

    const embById = new Map(embeddableIdx.map((origIdx, k) => [origIdx, result.questions[k]?.embedding]));
    const rejected = pending.map((entry, i) => (
      embById.has(i)
        ? { ...entry, question: { ...entry.question, embedding: embById.get(i) } }
        : entry
    ));

    console.log(`[Pipeline] batchEmbed: ${result.count} question(s) → ${result.vectorDimension}-d`);
    return { rejected };
  });
}

/**
 * Evaluate node (quality gate): fast deterministic checks → in-memory peer
 * similarity → parallel Qdrant source checks → ONE batch validation LLM call.
 * Splits entries into accepted / still-pending / failed (attempts exhausted).
 */
async function evaluateBatchNode(state) {
  checkCancellation(state?.jobId);
  emitStageEvent(state.jobId, 'quality_validation', {
    message: 'Evaluating question quality, similarity, and curriculum alignment',
  });
  return timed('evaluateBatch', async () => {
    const requirements = state.requirements;
    const blueprint = state.blueprint || null;
    const validTypes = validTypesFor(blueprint);
    const useFullText = !!blueprint;
    // Source-similarity dedup runs ONLY against the past_paper corpus — the
    // syllabus corpus is content to ground in, never a duplication target.
    const filter = { corpus: 'past_paper', class: requirements.class, subject: requirements.subject };
    const pending = state.rejected ?? [];
    const acceptedQuestions = state.accepted ?? [];
    const acceptedVectors = state.acceptedVectors ?? {};

    // 1) Fast deterministic checks (pure JS, no AI calls)
    const seenTexts = new Set(acceptedQuestions.map(q => dupTextOf(q, useFullText)));
    const checked = [];
    const localFailed = [];
    for (const entry of pending) {
      const result = validationAgent.deterministicCheck(entry.question, {
        compareTexts: Array.from(seenTexts),
        validTypes,
        useFullText,
        blueprint,
        slotIndex: entry.slotIndex ?? null,
      });
      seenTexts.add(dupTextOf(entry.question, useFullText));
      if (result.ok) checked.push(entry);
      else localFailed.push({ entry, reasons: result.reasons });
    }

    // 1.5) Per-item topic fidelity: each generated sub-part must stay on the
    //     same concept as its positional reference item (deterministic, no AI).
    //     Only runs in blueprint mode when reference items exist.
    if (blueprint && Array.isArray(blueprint.questions)) {
      const topicChecked = [];
      for (const entry of checked) {
        const slotIdx = entry.slotIndex ?? null;
        const slot = slotIdx != null ? blueprint.questions[slotIdx] : null;
        if (slot && Array.isArray(slot.items) && slot.items.length > 0
            && Array.isArray(entry.question?.subParts) && entry.question.subParts.length > 0) {
          const topicResult = validationAgent.checkPerItemTopicFidelity(entry.question, slot, {
            imageGrounding: state.slotContexts?.[slotIdx]?.imageGrounding ?? null,
          });
          if (topicResult.ok) {
            topicChecked.push(entry);
          } else {
            localFailed.push({ entry, reasons: topicResult.reasons });
          }
        } else {
          topicChecked.push(entry);
        }
      }
      checked.length = 0;
      checked.push(...topicChecked);
    }

    // 1.55) Reference-novelty gate (PARTS 15/16). Deterministic per-item check
    // vs the slot's positional reference items: rejects EXACT_COPY /
    // NEAR_PARAPHRASE / SAME_INFORMATION_DEMAND while passing legitimate
    // same-topic/different-demand questions. Complements — never replaces —
    // the 0.85 embedding threshold. CPU only, and mode-independent: it only
    // needs the blueprint's own reference items, never hybrid retrieval
    // machinery, so it runs in 'legacy' mode too — a teacher must not lose
    // paraphrase protection just because RETRIEVAL_MODE isn't 'hybrid'.
    if (blueprint) {
      const noveltyChecked = [];
      for (const entry of checked) {
        const nResult = checkReferenceNovelty({
          question: entry.question,
          slotIndex: entry.slotIndex ?? null,
          blueprint,
          thresholds: {
            paraphrase: env.REFERENCE_NOVELTY_STEM_OVERLAP_PARAPHRASE,
            demand: env.REFERENCE_NOVELTY_STEM_OVERLAP_DEMAND,
          },
          imageGrounding: entry.slotIndex != null ? state.slotContexts?.[entry.slotIndex]?.imageGrounding ?? null : null,
        });
        if (nResult.ok) {
          noveltyChecked.push(entry);
        } else {
          localFailed.push({ entry, reasons: nResult.reasons });
        }
      }
      checked.length = 0;
      checked.push(...noveltyChecked);
    }

    // 1.57) Reference-embedding backstop: 0.85-threshold cosine of each
    // generated sub-part vs its positional reference item. Catches
    // high-cosine restatements the lexical gate can miss (E2E: 0.91–0.95).
    // Mode-independent for the same reason as 1.55 above.
    // ACCOUNTING ASSERTION: every candidate entering this gate must leave in
    // exactly one of pass/failed — a mismatch now fails LOUDLY instead of
    // silently settling the slot as "was not generated".
    if (blueprint && checked.length > 0) {
      const backstop = await runEmbeddingNoveltyBackstop(checked, blueprint);
      if (backstop.pass.length + backstop.failed.length !== checked.length) {
        throw new Error(
          `[Pipeline] candidate accounting broken in the reference-embedding backstop: ` +
          `in=${checked.length} pass=${backstop.pass.length} failed=${backstop.failed.length}. ` +
          `Refusing to continue with lost candidates.`
        );
      }
      checked.length = 0;
      checked.push(...backstop.pass);
      localFailed.push(...backstop.failed);
    }

    // 1.58) PHASE 11 — cognitive-demand fidelity vs the Question Planner's
    // intended demand (sc.plan). A real, observed gap: a candidate could pass
    // every check above while asking a bare RECALL question in a slot the
    // reference clearly demanded REASONING for. Deterministic, no AI. A true
    // no-op when the planner is disabled or planning failed for this slot
    // (checkCognitiveDemandFidelity returns ok:true when plan is null).
    if (checked.length > 0) {
      const demandChecked = [];
      for (const entry of checked) {
        const plan = state.slotContexts?.[entry.slotIndex]?.plan ?? null;
        const dResult = checkCognitiveDemandFidelity(entry.question, plan);
        if (dResult.ok) {
          demandChecked.push(entry);
        } else {
          localFailed.push({ entry, reasons: dResult.reasons });
        }
      }
      checked.length = 0;
      checked.push(...demandChecked);
    }

    // 1.6) Deterministic evidence grounding (CPU only — no AI, no embedding, no Qdrant)
    // Only runs in blueprint mode when per-slot retrieval contexts exist. In
    // free-form mode (no blueprint), there are no per-slot evidence chunks to
    // ground against, so the check is skipped.
    const hasPerSlotContexts = Array.isArray(state.slotContexts) && state.slotContexts.some(ctx =>
      ctx != null && (Array.isArray(ctx.results) || ctx.itemResults)
    );
    const groundedEntries = [];
    if (hasPerSlotContexts) {
      for (const entry of checked) {
        const gResult = checkGrounding({
          question: entry.question,
          slotIndex: entry.slotIndex ?? null,
          slotContexts: state.slotContexts || [],
          blueprint,
          slotUnitMap: state.slotUnitMap || null,
          imageGrounding: entry.slotIndex != null ? state.slotContexts?.[entry.slotIndex]?.imageGrounding ?? null : null,
        });
        if (gResult.grounded) {
          groundedEntries.push(entry);
        } else {
          localFailed.push({ entry, reasons: gResult.reasons });
        }
      }
    } else {
      groundedEntries.push(...checked);
    }

    // 1.62) SEMANTIC IMAGE GROUNDING FIDELITY (deterministic, no vision) —
    // IMAGE_BASED slots only. A candidate whose content never engages the
    // reference image's grounded topic/concepts (or asserts visual details
    // vision never observed) fails HERE, before any vision call is spent —
    // the targeted regeneration feedback then names the grounded concepts so
    // the retry actually converges on image content. Never weakens the
    // existing image-dependency validator (1.65 below stays the authority);
    // when the flag is off or no grounding exists this is a no-op.
    const groundingChecked = [];
    if (env.IMAGE_GROUNDING_ENABLED && env.IMAGE_GROUNDING_FIDELITY_ENFORCED && blueprint) {
      for (const entry of groundedEntries) {
        const sc = entry.slotIndex != null ? state.slotContexts?.[entry.slotIndex] ?? null : null;
        const grounding = sc?.imageGrounding ?? null;
        // ITEM-LEVEL dependency model: pass the blueprint slot so the gate
        // demands concept engagement only from IMAGE_DEPENDENT parts — an
        // IMAGE_CONTEXTUAL part (topic-grounded by the reference's own
        // relationship with the image) is held to topic grounding, not pixels.
        const entrySlot = entry.slotIndex != null ? blueprint.questions?.[entry.slotIndex] ?? null : null;
        const fResult = checkImageGroundingFidelity(entry.question, grounding, entrySlot);
        // VISUAL ENGAGEMENT (generation-side fix) — closes the gap fResult
        // alone cannot: naming a grounded CONCEPT (e.g. "JVM") satisfies
        // fResult's concept-overlap test even when the question never
        // requires looking at the image ("What is the role of the JVM?").
        // This demands a genuine visual relationship/position/structure on
        // top of concept engagement, for IMAGE_DEPENDENT parts only.
        const veResult = checkVisualEngagement(entry.question, grounding, entrySlot);
        const combinedOk = fResult.ok && veResult.ok;
        if (combinedOk) {
          groundingChecked.push(entry);
        } else {
          localFailed.push({ entry, reasons: [...fResult.reasons, ...veResult.reasons] });
        }
      }
    } else {
      groundingChecked.push(...groundedEntries);
    }

    // 1.65) Image-dependency verification (ONE vision call per IMAGE_BASED
    // survivor — never for any other question type, so this never adds calls
    // to an ordinary paper with no image slot). Extends the existing
    // validation architecture (validationAgent) rather than a separate
    // framework; reuses the same vision route generation already uses
    // (Token Harbor mimo, never Gemini). When image grounding produced
    // evidence for the slot, the vision call ALSO receives the grounded
    // topic/concepts so its verdict is anchored in what the image actually
    // depicts — never a weaker check, a better-informed one.
    const imageCheckedEntries = [];
    if (blueprint) {
      const imageEntries = [];
      const otherEntries = [];
      for (const entry of groundingChecked) {
        const entrySlot = entry.slotIndex != null ? blueprint.questions?.[entry.slotIndex] : null;
        const entryHasImage = Array.isArray(entrySlot?.imageAssets) && entrySlot.imageAssets.length > 0;
        if (entrySlot && (entryHasImage || String(entrySlot.type || '').toUpperCase() === 'IMAGE_BASED')) {
          entry.imageGrounding = state.slotContexts?.[entry.slotIndex]?.imageGrounding ?? null;
          imageEntries.push(entry);
        }
        else otherEntries.push(entry);
      }
      if (imageEntries.length > 0) {
        const imageResults = await runWithConcurrencyLimit(imageEntries, env.AI_EVAL_CONCURRENCY, async (entry) =>
          validationAgent.checkImageDependency({ question: entry.question, slotIndex: entry.slotIndex, blueprint, imageGrounding: entry.imageGrounding }));
        imageEntries.forEach((entry, i) => {
          const r = imageResults[i];
          if (r.ok) imageCheckedEntries.push(entry);
          else localFailed.push({ entry, reasons: r.reasons });
        });
      }
      imageCheckedEntries.push(...otherEntries);
    } else {
      imageCheckedEntries.push(...groundingChecked);
    }

    // 2) In-memory peer duplicate detection (local cosine on batch embeddings, 0 calls)
    const peerDupMap = similarityAgent.findPeerDuplicates(imageCheckedEntries, { acceptedVectors });

    // 3) Source similarity vs previous papers (parallel Qdrant searches, 0 LLM calls)
    const sourceResults = await runWithConcurrencyLimit(imageCheckedEntries, env.AI_EVAL_CONCURRENCY, async (entry) => {
      const vector = entry.question.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        return { questionId: entry.question.questionId, isDuplicate: false, maxSimilarity: 0, threshold: env.SIMILARITY_THRESHOLD, matchedQuestion: null, missingEmbedding: true };
      }
      return similarityAgent.checkAgainstSource(entry.question, vector, { filter, topK: 5 });
    });
    const sourceCheckById = new Map(sourceResults.map(s => [s.questionId, s]));

    // 4) ONE batch LLM validation for survivors only
    const survivors = imageCheckedEntries.filter(entry => {
      const source = sourceCheckById.get(entry.question.questionId);
      return !peerDupMap.has(entry.question.questionId) && !source?.isDuplicate && !source?.missingEmbedding;
    });
    let validationById = new Map();
    if (survivors.length > 0) {
      bumpAi('validationRequests');
      const batchResults = await validationAgent.validateBatch(
        survivors.map(e => e.question),
        requirements,
        state.context
      );
      validationById = new Map(batchResults.map(r => [r.questionId, r]));
    }

    // 5) Assemble outcomes
    const newAccepted = [];
    const stillPending = [];
    const newFailed = [];
    const newAcceptedVectors = { ...acceptedVectors };

    // PART 24: the persistent, slot-index-keyed counter (advanced once per
    // real LLM call in generateNode/regenerateFailedNode) is authoritative
    // whenever a blueprint slot is involved — a candidate's own `.attempts`
    // field is only the fallback for free-form mode (no blueprint slots to
    // key on).
    const slotAttempts = state.slotAttempts ?? {};
    const settle = (entry, reasons) => {
      const attempts = entry.slotIndex != null && slotAttempts[entry.slotIndex] != null
        ? slotAttempts[entry.slotIndex]
        : entry.attempts + 1;
      const questionId = entry.question.questionId;
      const sourceCheck = sourceCheckById.get(questionId) ?? null;
      const peerCheck = peerDupMap.get(questionId) ?? null;
      const validation = validationById.get(questionId) ?? null;

      if (reasons.length === 0) {
        if (state.jobId != null && entry.slotIndex != null) {
          updateSlot(state.jobId, entry.slotIndex, { state: 'accepted', attempts });
          emitSlotProgress(state.jobId, {
            slotIndex: entry.slotIndex,
            questionNumber: blueprint?.questions?.[entry.slotIndex]?.label || `Q${entry.slotIndex + 1}`,
            status: 'completed',
            progressPercent: 100,
            attempt: attempts,
          });
        }
        newAccepted.push({
          ...stripEmbedding(entry.question),
          status: 'accepted',
          attempts,
          validation: {
            reason: validation?.reason ?? 'Passed validation.',
            issues: validation?.issues ?? [],
            difficultyMatch: validation?.difficultyMatch ?? null,
          },
          similarity: {
            sourceMaxSimilarity: sourceCheck?.maxSimilarity ?? 0,
            peerMaxSimilarity: peerCheck?.maxSimilarity ?? 0,
          },
        });
        if (Array.isArray(entry.question.embedding)) {
          newAcceptedVectors[questionId] = entry.question.embedding;
        }
      } else if (attempts >= effectiveMaxRetries(blueprint?.questions?.[entry.slotIndex])) {
        if (state.jobId != null && entry.slotIndex != null) {
          updateSlot(state.jobId, entry.slotIndex, { state: 'failed', attempts });
          emitSlotProgress(state.jobId, {
            slotIndex: entry.slotIndex,
            questionNumber: blueprint?.questions?.[entry.slotIndex]?.label || `Q${entry.slotIndex + 1}`,
            status: 'failed',
            attempt: attempts,
            reasons,
          });
        }
        logRetryExhausted(blueprint, entry.slotIndex, attempts, reasons);
        newFailed.push({ question: stripEmbedding(entry.question), slotIndex: entry.slotIndex, reasons, attempts });
      } else {
        if (state.jobId != null && entry.slotIndex != null) {
          updateSlot(state.jobId, entry.slotIndex, { state: 'generating', attempts });
          emitSlotProgress(state.jobId, {
            slotIndex: entry.slotIndex,
            questionNumber: blueprint?.questions?.[entry.slotIndex]?.label || `Q${entry.slotIndex + 1}`,
            status: 'regenerating',
            attempt: attempts,
            reasons,
          });
        }
        stillPending.push({ ...entry, reasons, attempts });
      }
    };

    for (const entry of imageCheckedEntries) {
      const questionId = entry.question.questionId;
      const sourceCheck = sourceCheckById.get(questionId) ?? null;
      const peerCheck = peerDupMap.get(questionId) ?? null;
      const validation = validationById.get(questionId) ?? null;
      const reasons = [];

      if (sourceCheck?.missingEmbedding) reasons.push('Question could not be embedded for similarity evaluation.');
      else if (peerCheck?.isDuplicate) reasons.push(peerReason(peerCheck));
      else if (sourceCheck?.isDuplicate) reasons.push(sourceReason(sourceCheck));
      else if (validation && !validation.valid) reasons.push(...validationReasons(validation));
      else if (survivors.includes(entry) && !validation) reasons.push('No validation result was returned for this question.');

      settle(entry, reasons);
    }
    for (const { entry, reasons } of localFailed) settle(entry, reasons);

    console.log(
      `[Pipeline] evaluateBatch: ${imageCheckedEntries.length + localFailed.length} evaluated, ` +
      `${newAccepted.length} accepted, ${stillPending.length} pending, ${newFailed.length} failed`
    );
    if (stillPending.length > 0) {
      console.log(`[Pipeline] pending reasons:\n${stillPending
        .map((e) => `  ${e.question.questionId}${e.slotIndex != null ? ` (slot ${e.slotIndex + 1})` : ''}: ${e.reasons.join(' | ')}`)
        .join('\n')}`);
    }

    return {
      accepted: [...acceptedQuestions, ...newAccepted],
      acceptedVectors: newAcceptedVectors,
      rejected: stillPending,
      failed: [...(state.failed ?? []), ...newFailed],
      slotAttempts,
    };
  });
}

/**
 * Blueprint conformance node (blueprint mode only): compares every accepted
 * question against its LOCKED blueprint slot (type, total marks, item count,
 * optional-answer rule). Non-conforming slots move back to `rejected` so only
 * those are regenerated — conforming questions stay untouched.
 */
export async function blueprintCheckNode(state) {
  const blueprint = state.blueprint;
  if (!blueprint) return {};

  const accepted = state.accepted ?? [];
  const acceptedVectors = state.acceptedVectors ?? {};
  const bpQuestions = blueprint.questions;
  const kept = [];
  const newRejected = [];
  // ACCOUNTING INVARIANT: a slot that exhausted its retry budget is TERMINAL —
  // it moves to `failed`, never silently dropped. Every blueprint slot must end
  // in exactly one of accepted / failed (enforced again in generate()).
  const carriedFailed = [];
  const keptVectors = { ...acceptedVectors };

  // Slots already terminal in `failed` from an earlier round — keep as-is.
  const alreadyFailedSlots = new Set((state.failed ?? []).map((e) => e.slotIndex).filter((i) => i != null));

  const bySlot = new Map();
  for (const q of accepted) {
    if (q.slotIndex != null) bySlot.set(q.slotIndex, q);
  }

  // PART 24: the persistent, slot-index-keyed counter is authoritative when
  // present — a candidate's own `.attempts` is only the fallback (kept for
  // callers/tests that invoke this node directly without seeding
  // `slotAttempts`). This is what fixes the real bug: a slot with NO accepted
  // candidate right now (the branch below) has no candidate to read an
  // attempts field from at all, so it used to hard-code 0 — discarding
  // whatever the slot had already spent — regardless of how many real calls
  // preceded it.
  const slotAttemptsIn = state.slotAttempts ?? {};
  const attemptsFor = (i, fallback) => (slotAttemptsIn[i] != null ? slotAttemptsIn[i] : (fallback ?? 0));

  // LAYER 2 — TARGETED STRUCTURAL REPAIR: a SEPARATE, small, bounded budget
  // from slotAttempts/env.MAX_RETRIES (see question-generator.agent.js's
  // repairMissingRequiredFields). Persisted the same way slotAttempts is.
  const repairAttemptsIn = { ...(state.structuralRepairAttempts ?? {}) };

  for (let i = 0; i < bpQuestions.length; i++) {
    const expected = bpQuestions[i];
    const q = bySlot.get(i);

    if (!q) {
      if (alreadyFailedSlots.has(i)) continue; // already terminal in state.failed
      const attempts = attemptsFor(i, 0);
      const reason = `${expected.label || `Q${i + 1}`} (slot ${i + 1}) was not generated.`;
      if (attempts >= effectiveMaxRetries(expected)) {
        // Its budget is already spent (e.g. every attempt failed the CONTENT
        // gate and never produced a conforming candidate) — terminal here
        // too, never re-queued for one more call it isn't entitled to.
        // BUGFIX (stale state): persist the terminal transition — a slot left
        // in 'generating' here is exactly the real E2E `Q3:generating@1`
        // inconsistency observed on the Unit-I paper.
        if (state.jobId != null) {
          updateSlot(state.jobId, i, { state: 'failed', attempts });
          emitSlotProgress(state.jobId, {
            slotIndex: i,
            questionNumber: expected.label || `Q${i + 1}`,
            status: 'failed',
            attempt: attempts,
            reasons: [reason],
          });
        }
        logRetryExhausted(blueprint, i, attempts, [reason]);
        carriedFailed.push({ question: null, slotIndex: i, reasons: [reason], attempts });
        continue;
      }
      newRejected.push({ question: null, slotIndex: i, reasons: [reason], attempts });
      continue;
    }

    // Structural conformance AND the deterministic answer-key checks — a
    // missing or invalid answer fails the slot exactly like a wrong item count.
    const check = checkQuestion(q, expected);
    let answers = checkAnswers(q, expected);
    let candidate = q;

    // LAYER 2 — TARGETED STRUCTURAL REPAIR. Only when the candidate is
    // structurally sound (checkQuestion clean) AND every single answers.reasons
    // entry is accounted for by a PURE required-field omission (never a real
    // content/answer/option problem) — checkMarkingScheme pushes exactly one
    // reason per missingFields entry, so this equality is the precise,
    // non-string-matching test for "nothing here but a bare omission".
    const pureOmission = check.reasons.length === 0
      && answers.missingFields.length > 0
      && answers.reasons.length === answers.missingFields.length;
    if (pureOmission) {
      const repairsUsed = repairAttemptsIn[i] ?? 0;
      if (repairsUsed < env.STRUCTURAL_REPAIR_MAX_ATTEMPTS) {
        repairAttemptsIn[i] = repairsUsed + 1;
        try {
          const repaired = await repairMissingRequiredFields(q, answers.missingFields);
          if (repaired) {
            const recheckQuestion = checkQuestion(repaired, expected);
            const recheckAnswers = checkAnswers(repaired, expected);
            if (recheckQuestion.reasons.length === 0 && recheckAnswers.reasons.length === 0) {
              console.log(`[Pipeline] structural repair: slot ${i + 1} (${expected.label}) — missing ${answers.missingFields.map((m) => m.field).join(', ')} supplied, question/answer/marks unchanged.`);
              candidate = repaired;
              answers = recheckAnswers;
            }
            // else: repair did not fully resolve it — fall through with the
            // ORIGINAL candidate/reasons, exactly as if no repair were attempted.
          }
        } catch (err) {
          console.warn(`[Pipeline] structural repair failed for slot ${i + 1} (${expected.label}): ${String(err?.message || err).slice(0, 160)}`);
        }
      }
    }

    const reasons = [...check.reasons, ...answers.reasons];
    const attempts = attemptsFor(i, q.attempts);
    if (reasons.length === 0) {
      kept.push(candidate);
    } else if (attempts >= effectiveMaxRetries(expected)) {
      // Exhausted its budget and still non-conforming → TERMINAL as REJECTED,
      // carrying the last question + reasons (never dropped from accounting).
      // BUGFIX (stale state): persist the terminal transition here too —
      // every terminally rejected slot must end up explicitly 'failed'.
      if (state.jobId != null) {
        updateSlot(state.jobId, i, { state: 'failed', attempts });
        emitSlotProgress(state.jobId, {
          slotIndex: i,
          questionNumber: expected.label || `Q${i + 1}`,
          status: 'failed',
          attempt: attempts,
          reasons,
        });
      }
      console.warn(`[Pipeline] blueprintCheck: slot ${i + 1} (${expected.label}) exhausted its regeneration budget — recorded as REJECTED.`);
      logRetryExhausted(blueprint, i, attempts, reasons);
      carriedFailed.push({ question: candidate, slotIndex: i, reasons, attempts });
      delete keptVectors[candidate.questionId];
    } else {
      newRejected.push({ question: candidate, slotIndex: i, reasons, attempts });
      if (state.jobId != null) {
        emitSlotProgress(state.jobId, {
          slotIndex: i,
          questionNumber: expected.label || `Q${i + 1}`,
          status: 'regenerating',
          attempt: attempts,
          reasons,
        });
      }
      delete keptVectors[candidate.questionId];
    }
  }

  console.log(`[Pipeline] blueprintCheck: ${kept.length}/${bpQuestions.length} slot(s) conform, ${newRejected.length} to regenerate, ${carriedFailed.length} exhausted → rejected.`);
  return {
    accepted: kept,
    acceptedVectors: keptVectors,
    rejected: newRejected,
    slotAttempts: slotAttemptsIn,
    structuralRepairAttempts: repairAttemptsIn,
    ...(carriedFailed.length > 0 ? { failed: [...(state.failed ?? []), ...carriedFailed] } : {}),
  };
}

/** Regeneration node: regenerate ONLY pending (failed) questions, parallel, concurrency-limited. */
async function regenerateFailedNode(state) {
  checkCancellation(state?.jobId);
  const pending = state.rejected ?? [];
  if (pending.length === 0) return { rejected: [] };

  const failedSlots = pending.map((e) => e.slotIndex).filter((i) => i != null);
  emitRegenerationStage(state.jobId, {
    failedSlots,
    attempt: pending[0]?.attempts ? pending[0].attempts + 1 : 2,
    message: `Regenerating ${pending.length} failed question(s)`,
  });

  const blueprint = state.blueprint || null;
  // The single choke point where a real regeneration LLM call is issued for a
  // slot — advance the PERSISTENT, slot-index-keyed counter here, once per
  // entry, BEFORE the call (PART 24). This is authoritative regardless of
  // whether the entry currently carries a candidate, and survives regardless
  // of which gate (evaluateBatch content checks vs blueprintCheck structural
  // checks) rejected the previous round.
  const slotAttempts = { ...(state.slotAttempts ?? {}) };
  const nextAttemptFor = pending.map((entry) => {
    if (entry.slotIndex == null) return (entry.attempts ?? 0) + 1; // free-form mode: no blueprint slots to key on
    const next = (slotAttempts[entry.slotIndex] ?? entry.attempts ?? 0) + 1;
    slotAttempts[entry.slotIndex] = next;
    return next;
  });

  return timed('regenerateFailed', async () => {
    const slotContexts = state.slotContexts ?? [];
    // Phase 3 — Question Ledger: a PURE view derived from state.accepted (the
    // one authoritative, accumulated list), recomputed fresh for this round.
    // Never a second mutable copy — an accepted slot later replaced or
    // dropped by blueprintCheckNode simply stops appearing here on the very
    // next call, and a rejected/pending candidate can never appear at all
    // because buildLedger only ever reads state.accepted.
    const ledger = buildLedger(state.accepted, blueprint, state.requirements);
    const replacements = await runWithConcurrencyLimit(
      pending,
      env.AI_EVAL_CONCURRENCY,
      async (entry, i) => {
        // QUESTION-LEVEL RAG: regenerate with THIS slot's own context (topic
        // anchors), falling back to the flattened pool.
        const entryContext =
          blueprint && entry.slotIndex != null && Array.isArray(slotContexts[entry.slotIndex]?.results) && slotContexts[entry.slotIndex].results.length > 0
            ? slotContexts[entry.slotIndex].results
            : state.context;
        try {
          // A slot whose question was never produced at all → generate fresh for it.
          if (!entry.question && blueprint && entry.slotIndex != null) {
            return await questionGeneratorAgent.generateForSlot(blueprint, entry.slotIndex, state.requirements, entryContext, {
              slotContexts: state.slotContexts ?? null,
              slotTargets: buildSlotTargets(blueprint, state.requirements),
            });
          }
          return await regenerateOneCandidate({
            existingQuestion: entry.question,
            reasons: entry.reasons,
            requirements: state.requirements,
            context: entryContext,
            blueprint,
            slotIndex: entry.slotIndex,
            slotContexts: state.slotContexts ?? null,
            slotUnitMap: state.slotUnitMap ?? null,
            attempt: nextAttemptFor[i],
            maxAttempts: effectiveMaxRetries(blueprint?.questions?.[entry.slotIndex]),
            ledger,
            priorReasons: entry.priorReasons ?? [],
          });
        } catch (err) {
          // A REGENERATION CALL FAILING (Gemini 5xx/quota/timeout) must NEVER
          // crash the pipeline or make the slot vanish. Return a sentinel; the
          // mapping below keeps the slot's previous state and bumps its attempt
          // count so it settles into a terminal state on the next pass instead
          // of being dropped or overwriting an accepted slot.
          console.warn(`[Pipeline] regenerateFailed: slot ${(entry.slotIndex ?? 0) + 1} regeneration threw — ${err.message}`);
          return { __regenError: String(err.message || 'regeneration failed') };
        }
      }
    );

    const succeeded = replacements.filter((r) => r && !r.__regenError).length;
    console.log(`[Pipeline] regenerateFailed: ${succeeded}/${pending.length} regenerated (${pending.length - succeeded} call failure(s))`);
    bumpAi('regenerationRounds', pending.length);

    const stillPending = [];
    const callFailedTerminal = [];
    pending.forEach((entry, i) => {
      const attempts = nextAttemptFor[i];
      const r = replacements[i];
      if (r && !r.__regenError) {
        stillPending.push({
          ...entry,
          question: r,
          reasons: [],
          attempts,
          priorReasons: mergeReasonHistory(entry.priorReasons, entry.reasons),
        });
        return;
      }
      // The regeneration CALL failed (Gemini 5xx/quota/timeout). The attempt
      // was already consumed above (a real call was made) — record the
      // reason. If the budget is now spent, this slot is TERMINAL as
      // REJECTED right here — carrying the call-failure reason — so it can
      // never be dropped or overwrite an accepted slot.
      const reasons = [...(entry.reasons ?? []), `Regeneration call failed: ${r?.__regenError ?? 'unknown error'}.`];
      if (attempts >= effectiveMaxRetries(blueprint?.questions?.[entry.slotIndex])) {
        if (state.jobId != null && entry.slotIndex != null) {
          updateSlot(state.jobId, entry.slotIndex, { state: 'failed', attempts });
        }
        logRetryExhausted(blueprint, entry.slotIndex, attempts);
        callFailedTerminal.push({ question: entry.question ?? null, slotIndex: entry.slotIndex, reasons, attempts });
      } else {
        stillPending.push({ ...entry, reasons, attempts });
      }
    });

    return {
      rejected: stillPending,
      slotAttempts,
      ...(callFailedTerminal.length > 0 ? { failed: [...(state.failed ?? []), ...callFailedTerminal] } : {}),
      regenerationRounds: (state.regenerationRounds ?? 0) + pending.length,
    };
  });
}

// ─── Graph wiring ───────────────────────────────────────────────────────────
const graph = new StateGraph(GenerationState)
  .addNode('retrieve', retrieveNode)
  .addNode('generate', generateNode)
  .addNode('embedGenerated', embedGeneratedNode)
  .addNode('evaluateBatch', evaluateBatchNode)
  .addNode('blueprintCheck', blueprintCheckNode)
  .addNode('regenerateFailed', regenerateFailedNode)
  .addEdge(START, 'retrieve')
  .addEdge('retrieve', 'generate')
  .addEdge('generate', 'embedGenerated')
  .addEdge('embedGenerated', 'evaluateBatch')
  .addConditionalEdges('evaluateBatch', (state) =>
    state.rejected && state.rejected.length > 0 ? 'regenerateFailed' : (state.blueprint ? 'blueprintCheck' : END))
  .addConditionalEdges('blueprintCheck', (state) =>
    state.rejected && state.rejected.length > 0 ? 'regenerateFailed' : END)
  .addEdge('regenerateFailed', 'embedGenerated')
  .compile();

export const orchestrator = {
  /**
   * PHASE 5 — Teacher Review: regenerate ONE blueprint slot, reusing the exact
   * Phase 4 regeneration path (single-slot prompt → normalization → the same
   * deterministic validators → bounded retry) without touching any other slot.
   * NOT a second paper generator — a corrective agent over the existing seams.
   *
   * @param {Object} input
   *   { class, subject, difficulty, blueprint, slotIndex, slotUnitMap?,
   *     notes?, failureReasons?, existingQuestion?, teacherEdits? }
   *   - notes            : teacher notes for this slot (guide the regen only)
   *   - failureReasons   : stale/structural reasons shown to the model
   *   - existingQuestion : the current question for this slot (context for regen)
   *   - teacherEdits     : true when the slot carries teacher content edits
   * @returns {Promise<{question: Object, attempts: number, accepted: boolean, reasons: string[]}>}
   */
  async regenerateSlot(input = {}) {
    const requirements = normalizeRequirements(input);
    const blueprint = normalizeBlueprint(input.blueprint);
    if (!blueprint) throw httpError('The provided reference blueprint is empty or invalid.', 400);
    const shape = checkBlueprintShape(blueprint);
    if (!shape.ok) throw httpError(`The provided reference blueprint is invalid: ${shape.reasons.join(' ')}`, 400);

    const slotIndex = Number(input.slotIndex);
    const slot = blueprint.questions[slotIndex];
    if (!slot) throw httpError(`Slot index ${input.slotIndex} does not exist in the blueprint.`, 400);

    // Teacher notes are a regeneration hint only — never persisted into the
    // blueprint contract and never rendered on the student paper.
    if (input.notes) slot.teacherNotes = String(input.notes).slice(0, 500);

    const reasons = Array.isArray(input.failureReasons) && input.failureReasons.length > 0
      ? input.failureReasons.map(String).slice(0, 8)
      : ['Structure changed. Regenerate to update the content.'];

    const reqs = { ...requirements, ...(blueprint ? { blueprint } : {}) };

    // QUESTION-LEVEL RAG for this slot ONLY — a one-slot projection keeps
    // retrieveForSlots from building retrieval tasks for every slot (no
    // unnecessary retrieval for accepted slots). Per-item units respected via
    // slotUnitMap; grounding gets slotContexts indexed by the real slotIndex.
    const slotBlueprint = { ...blueprint, questions: [slot] };
    const perSlotSingle = await retrievalAgent.retrieveForSlots(slotBlueprint, reqs, {
      slotUnitMap: input.slotUnitMap && input.slotUnitMap[slot.label] ? { [slot.label]: input.slotUnitMap[slot.label] } : {},
    });
    const slotContext = perSlotSingle[0] ?? { results: [] };
    const slotContexts = [];
    slotContexts[slotIndex] = slotContext;
    const context = slotContext.results?.length ? slotContext.results : [];

    // PHASE 9 (opt-in) — attach a QuestionPlan to this ONE slot's context so
    // the teacher single-slot review path sees the SAME PLAN block the batch
    // pipeline does (regenerateOneCandidate → questionGeneratorAgent.regenerate
    // /generateForSlot → formatSlotSpec → formatPlanBlock all already read
    // slotContexts[slotIndex].plan — this was the only place that never set
    // it). No-op and no behavior change when the flag is off.
    if (env.QUESTION_PLANNER_ENABLED) {
      attachPlansToSlotContexts(blueprint, slotContexts, buildSlotTargets(blueprint, reqs), reqs);
    }

    // Retrieve → generate → validate loop for this one slot (bounded — +2
    // attempts when the slot's own reference asks a broad moral/theme-summary
    // demand, see effectiveMaxRetries).
    let candidate = null;
    let attempts = 0;
    let lastReasons = [];
    let priorReasonsAcc = [];
    const slotMaxRetries = effectiveMaxRetries(slot);
    while (attempts < slotMaxRetries) {
      attempts += 1;
      candidate =
        attempts === 1
          ? input.existingQuestion
            ? // Corrective replacement seeded from the current question + the
              // stale/structural reasons — the same Phase 4 regen prompt path.
              // Teacher notes ride on the seed so the prompt builder can show them.
              await regenerateOneCandidate({
                existingQuestion: { ...input.existingQuestion, ...(slot.teacherNotes ? { teacherNotes: slot.teacherNotes } : {}) },
                reasons, requirements: reqs, context, blueprint, slotIndex, slotContexts,
                slotUnitMap: input.slotUnitMap ?? null, attempt: attempts, maxAttempts: slotMaxRetries,
                priorReasons: priorReasonsAcc,
              })
            : await questionGeneratorAgent.generateForSlot(blueprint, slotIndex, reqs, context, {
              slotContexts,
              slotTargets: buildSlotTargets(blueprint, reqs),
            })
          : // Retry: hand the ACTUAL failure reasons back to the generator,
            // exactly like the pipeline's regeneration prompt does. Pooled
            // from attempt 2 onward (regenerateOneCandidate decides).
            await regenerateOneCandidate({
              existingQuestion: { ...candidate, ...(slot.teacherNotes ? { teacherNotes: slot.teacherNotes } : {}) },
              reasons: lastReasons, requirements: reqs, context, blueprint, slotIndex, slotContexts,
              slotUnitMap: input.slotUnitMap ?? null, attempt: attempts, maxAttempts: slotMaxRetries,
              priorReasons: priorReasonsAcc,
            });

      // Same deterministic gate order as evaluateBatchNode: structure →
      // answer key → per-item topic fidelity → reference-novelty → grounding.
      // No LLM batch here (single slot); semantic validation runs when the
      // full paper re-validates.
      const structure = checkQuestion(candidate, slot);
      const answers = checkAnswers(candidate, slot);
      const topic = validationAgent.checkPerItemTopicFidelity(candidate, slot, {
        imageGrounding: slotContexts?.[slotIndex]?.imageGrounding ?? null,
      });
      // Reference-novelty gate (PARTS 15/16): a targeted replacement must
      // clear the SAME bar as the generate path (mode-independent — see 1.55
      // in evaluateBatchNode), otherwise a paraphrase rejected by generate is
      // laundered back in through regenerate-slot, or slips through entirely
      // when RETRIEVAL_MODE is 'legacy'.
      let novelty = { ok: true, reasons: [] };
      if (blueprint) {
        novelty = checkReferenceNovelty({
          question: candidate,
          slotIndex,
          blueprint,
          thresholds: {
            paraphrase: env.REFERENCE_NOVELTY_STEM_OVERLAP_PARAPHRASE,
            demand: env.REFERENCE_NOVELTY_STEM_OVERLAP_DEMAND,
          },
          imageGrounding: slotContexts?.[slotIndex]?.imageGrounding ?? null,
        });
      }
      // Reference-embedding backstop: a replacement restating the reference
      // item at >= 0.85 cosine is rejected here too (mode-independent, see
      // 1.57 above), with the reason fed back into the next regen attempt.
      let embNovelty = { ok: true, reasons: [] };
      if (blueprint) {
        const backstop = await runEmbeddingNoveltyBackstop([{ question: candidate, slotIndex }], blueprint);
        if (backstop.failed.length > 0) embNovelty = { ok: false, reasons: backstop.failed[0].reasons };
      }
      const grounding = checkGrounding({
        question: candidate,
        slotIndex,
        slotContexts,
        blueprint,
        slotUnitMap: input.slotUnitMap || null,
        imageGrounding: slotContexts?.[slotIndex]?.imageGrounding ?? null,
      });
      const failureList = [...structure.reasons, ...answers.reasons, ...topic.reasons, ...novelty.reasons, ...embNovelty.reasons, ...grounding.reasons];
      if (failureList.length === 0) {
        return { question: { ...stripEmbedding(candidate), status: 'accepted', attempts }, attempts, accepted: true, reasons: [] };
      }
      priorReasonsAcc = mergeReasonHistory(priorReasonsAcc, lastReasons);
      lastReasons = failureList;
    }

    // Exhausted retries — report honestly, never silently accept invalid content.
    return { question: { ...stripEmbedding(candidate), status: 'stale', attempts }, attempts, accepted: false, reasons: lastReasons };
  },

  /**
   * PHASE 6 — Dedicated Answer Key: regenerate ONLY the answers of ONE
   * question. The question text is frozen (never rewritten, never replaced);
   * only its answer fields are produced. Reuses the slot's Phase 2 RAG context
   * (slot-only retrieval — no other slot is touched) and the existing Gemini
   * client. NOT a second generator — a corrective agent for the answer key.
   *
   * @param {Object} input
   *   { class, subject, difficulty, blueprint, slotIndex, question, slotUnitMap?, notes? }
   * @returns {Promise<{ answers: Object, accepted: boolean, reasons: string[] }>}
   */
  async generateAnswer(input = {}) {
    const requirements = normalizeRequirements(input);
    const blueprint = normalizeBlueprint(input.blueprint);
    if (!blueprint) throw httpError('The provided reference blueprint is empty or invalid.', 400);

    const slotIndex = Number(input.slotIndex);
    const slot = blueprint.questions[slotIndex];
    if (!slot) throw httpError(`Slot index ${input.slotIndex} does not exist in the blueprint.`, 400);
    const question = input.question && typeof input.question === 'object' ? input.question : null;
    if (!question || !String(question.text ?? '').trim()) {
      throw httpError('"question" (the current teacher-approved question) is required to regenerate its answer.', 400);
    }

    // Slot-only RAG (one-slot projection — Phase 5 pattern). If the request
    // supplies evidence for the slot directly (the client already has the
    // generation context) it wins; otherwise targeted retrieval runs for this
    // slot only. Answers must stay grounded in the same syllabus material.
    let context = Array.isArray(input.slotEvidence) ? input.slotEvidence : [];
    if (context.length === 0) {
      const reqs = { ...requirements, ...(blueprint ? { blueprint } : {}) };
      const slotBlueprint = { ...blueprint, questions: [slot] };
      const perSlotSingle = await retrievalAgent.retrieveForSlots(slotBlueprint, reqs, {
        slotUnitMap: input.slotUnitMap && input.slotUnitMap[slot.label] ? { [slot.label]: input.slotUnitMap[slot.label] } : {},
      });
      context = perSlotSingle[0]?.results?.length ? perSlotSingle[0].results : [];
    }

    const { answers } = await questionGeneratorAgent.regenerateAnswer(question, requirements, context);
    if (answers == null || (typeof answers === 'object' && !Array.isArray(answers) && Object.keys(answers).length === 0)) {
      return { answers: null, accepted: false, reasons: ['The answer generation returned no usable answer key.'] };
    }
    return { answers, accepted: true, reasons: [] };
  },

  /**
   * Run the complete agentic question generation pipeline (LangGraph).
   * @param {Object} input
   *   { class, subject, topic?, difficulty?, questionCount?, questionType?, blueprint? }
   *   When `blueprint` (locked previous-year paper structure) is supplied, the
   *   reference structure takes priority: questionCount is locked to the
   *   blueprint, generation fills blueprint slots, and a deterministic
   *   blueprint-validation pass runs after quality evaluation.
   * @returns {Promise<Object>} Full generation result (same shape as before)
   */
  async generate(input) {
    const jobId = input?.jobId || null;
    emitStageEvent(jobId, 'blueprint_verification', {
      message: input?.blueprint ? 'Verifying reference paper blueprint structure' : 'Verifying generation requirements',
    });
    emitLogEvent(jobId, 'info', `Generation pipeline started for ${input?.subject || 'paper'}`);

    try {
      const requirements = normalizeRequirements(input);
    const teacherCount = requirements.questionCount;
    let blueprint = null;

    if (input.blueprint != null) {
      blueprint = normalizeBlueprint(input.blueprint);
      if (!blueprint) {
        throw httpError('The provided reference blueprint is empty or invalid.', 400);
      }
      const shape = checkBlueprintShape(blueprint);
      if (!shape.ok) {
        throw httpError(`The provided reference blueprint is invalid: ${shape.reasons.join(' ')}`, 400);
      }
      // The reference structure is authoritative: the teacher's question count
      // only applies where it is compatible (i.e. equal to the blueprint).
      requirements.questionCount = Math.min(Math.max(1, blueprint.totalQuestions), 30);
      if (teacherCount !== requirements.questionCount) {
        console.log(
          `[Orchestrator] Blueprint mode: teacher requested ${teacherCount} question(s) but the reference paper has ` +
          `${blueprint.totalQuestions}; locked to the reference structure.`
        );
      }
    }

    const t0 = Date.now();
    const stateInput = {
      requirements: { ...requirements, ...(blueprint ? { blueprint } : {}) },
      ...(blueprint ? { blueprint } : {}),
      // Teacher unit assignment + progress handle come straight from the
      // request body — never a server-side stored copy.
      ...(input.slotUnitMap ? { slotUnitMap: input.slotUnitMap } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
    };
    // Capture stats INSIDE the AsyncLocalStorage context (getStats() outside
    // the runWithStats() callback would see an empty store).
    let stats;
    const finalState = await runWithStats(async () => {
      // recursionLimit: LangGraph's default of 25 counts every superstep
      // (retrieve/generate/embed/evaluate each count), so a legitimate run of
      // the bounded retry design — several slots × several rounds — can exceed
      // it and CRASH instead of returning its honest exhausted-slots result.
      // The pipeline's own stop conditions (no rejected slots, or every slot
      // settled into accepted/failed) remain the real bound; this ceiling only
      // needs headroom above the design's worst case. RETRY_LOOP_BOUNDARY
      const state = await graph.invoke(stateInput, { recursionLimit: 100 });
      stats = getStats();
      return state;
    });

    const totalMs = Date.now() - t0;
    let accepted = finalState.accepted ?? [];
    if (blueprint) {
      // Preserve reference question order (slot order), not append order.
      accepted = [...accepted].sort((a, b) => (a.slotIndex ?? Infinity) - (b.slotIndex ?? Infinity));
    }
    let failed = finalState.failed ?? [];

    // ── SLOT ACCOUNTING INVARIANT (blueprint mode) ─────────────────────────
    // Every expected slot MUST end in exactly one terminal state: ACCEPTED or
    // REJECTED. A slot in NEITHER (silently dropped by a node) or in BOTH is a
    // pipeline bug — reconcile it explicitly here and, if it still cannot be
    // made to hold, throw a controlled internal error rather than return an
    // incomplete paper as if it were complete.
    if (blueprint) {
      const expectedCount = blueprint.questions.length;
      const acceptedSlots = new Set(accepted.map((q) => q.slotIndex).filter((i) => i != null));

      // A slot cannot be both accepted and failed — accepted wins, drop the dupe.
      failed = failed.filter((e) => e.slotIndex == null || !acceptedSlots.has(e.slotIndex));
      // Dedupe failed by slotIndex (keep the last / most-attempted entry).
      const failedBySlot = new Map();
      for (const e of failed) {
        if (e.slotIndex == null) continue;
        const prev = failedBySlot.get(e.slotIndex);
        if (!prev || (e.attempts ?? 0) >= (prev.attempts ?? 0)) failedBySlot.set(e.slotIndex, e);
      }
      failed = [...failedBySlot.values()];

      // Any slot in NEITHER terminal set → record it as REJECTED (never lost).
      for (let i = 0; i < expectedCount; i++) {
        if (!acceptedSlots.has(i) && !failedBySlot.has(i)) {
          console.error(`[Pipeline] ACCOUNTING: slot ${i + 1} (${blueprint.questions[i]?.label}) reached no terminal state — recording as REJECTED.`);
          failed.push({
            question: null,
            slotIndex: i,
            reasons: [`${blueprint.questions[i]?.label || `Q${i + 1}`} did not reach a terminal state (internal pipeline gap).`],
            attempts: env.MAX_RETRIES,
          });
        }
      }
      failed.sort((a, b) => (a.slotIndex ?? Infinity) - (b.slotIndex ?? Infinity));

      // Hard invariant: accepted + rejected === expected. If it still fails
      // (e.g. two accepted questions for one slot), stop with a controlled
      // error instead of returning a wrong paper.
      if (accepted.length + failed.length !== expectedCount) {
        const err = new Error(
          `Slot accounting invariant violated: ${accepted.length} accepted + ${failed.length} rejected != ${expectedCount} expected. ` +
          'The generation result is incomplete or inconsistent; not returning it.'
        );
        err.status = 500;
        throw err;
      }
    }

    console.log(
      `[Pipeline] Total: ${totalMs}ms → ${accepted.length} accepted, ${failed.length} rejected, ` +
      `${finalState.regenerationRounds ?? 0} regeneration round(s)${blueprint ? ' [blueprint mode]' : ''}`
    );

    let blueprintValidation = null;
    if (blueprint) {
      const v = validatePaper(accepted, blueprint);
      blueprintValidation = {
        ok: v.ok,
        ...summarizeBlueprint(v.results),
        results: v.results.map((r) => ({
          slotIndex: r.slotIndex,
          questionNumber: r.questionNumber,
          expected: {
            type: r.expected?.type,
            totalMarks: r.expected?.totalMarks,
            itemCount: r.expected?.itemCount,
            optionalRule: r.expected?.optionalRule ?? null,
          },
          ok: r.ok,
          reasons: r.reasons,
        })),
      };
    }

    checkCancellation(jobId);

    emitStageEvent(jobId, 'paper_assembled', {
      message: `Paper assembled: ${accepted.length} accepted, ${failed.length} rejected`,
    });
    emitComplete(jobId, {
      totalAccepted: accepted.length,
      totalRejected: failed.length,
      message: failed.length > 0
        ? `Generated ${accepted.length} question(s); ${failed.length} rejected after validation.`
        : `Generated ${accepted.length} question(s) successfully.`,
    });

    return {
      requirements,
      retrieval: finalState.retrieval && finalState.retrieval.perSlotContexts
        ? { ...finalState.retrieval, perSlotContexts: finalState.retrieval.perSlotContexts.map((s) => ({ slotIndex: s.slotIndex, results: s.results.length })) }
        : finalState.retrieval,
      questions: accepted,
      rejected: failed.map(entry => ({
        question: entry.question,
        slotIndex: entry.slotIndex,
        reasons: entry.reasons,
        attempts: entry.attempts,
      })),
      meta: {
        similarityThreshold: env.SIMILARITY_THRESHOLD,
        maxRetries: env.MAX_RETRIES,
        regenerationRounds: finalState.regenerationRounds ?? 0,
        totalGenerated: (finalState.candidates ?? []).length,
        totalQuestionsRequested: requirements.questionCount,
        totalAccepted: accepted.length,
        totalRejected: failed.length,
        // Latency + API-call instrumentation (per request; never secrets)
        timing: {
          retrievalMs: stats.timing.retrieve ?? 0,
          generationMs: stats.timing.generateBatch ?? 0,
          embeddingMs: stats.timing.batchEmbed ?? 0,
          validationMs: stats.timing.evaluateBatch ?? 0,
          regenerationMs: stats.timing.regenerateFailed ?? 0,
          blueprintMs: stats.timing.blueprintCheck ?? 0,
          totalMs,
        },
        ai: {
          geminiRequests: stats.ai.geminiRequests ?? 0,
          embeddingRequests: stats.ai.embeddingRequests ?? 0,
          embeddingInputs: stats.ai.embeddingInputs ?? 0,
          validationRequests: stats.ai.validationRequests ?? 0,
          cacheHits: stats.ai.cacheHits ?? 0,
          cacheMisses: stats.ai.cacheMisses ?? 0,
          failoverAttempts: stats.ai.failoverAttempts ?? 0,
          regenerationRounds: stats.ai.regenerationRounds ?? 0,
        },
        ...(blueprint
          ? {
              blueprintMode: true,
              blueprint,
              blueprintValidation,
              questionCountLockedToBlueprint: teacherCount !== blueprint.totalQuestions,
            }
          : {}),
      },
    };
    } catch (err) {
      const job = jobId ? getJob(jobId) : null;
      if (err?.isCancellation || job?.status === 'cancelled' || job?.abortController?.signal?.aborted || err?.name === 'AbortError') {
        // User cancellation: do NOT emit complete, do NOT emit error!
        return null;
      }
      emitError(jobId, err);
      throw err;
    }
  },
};

export default orchestrator;
