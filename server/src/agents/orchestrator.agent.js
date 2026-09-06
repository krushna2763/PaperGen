import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { env } from '../config/env.js';
import { retrievalAgent } from './retrieval.agent.js';
import { questionGeneratorAgent } from './question-generator.agent.js';
import { similarityAgent } from './similarity.agent.js';
import { validationAgent } from './validation.agent.js';
import { embeddingService } from '../rag/embeddings.js';
import { runWithConcurrencyLimit, normalizeQuestionText } from './agent-utils.js';
import { checkBlueprintShape } from '../blueprint/blueprint-schema.js';
import { normalizeBlueprint } from '../blueprint/blueprint-normalizer.js';
import { checkQuestion, validatePaper, summarize as summarizeBlueprint } from '../blueprint/blueprint-validator.js';
import { runWithStats, getStats, addTiming, bumpAi } from '../services/perf-context.js';
import { updateSlot } from '../services/job-store.js';

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
 * Retrieval Agent node. Free-form mode: ONE query embedding + ONE search.
 * BLUEPRINT mode: QUESTION-LEVEL RAG — one batch embedding of N slot queries
 * (built from each slot's reference items = its topic/concept area) followed
 * by a concurrent per-slot Qdrant search. Per-slot contexts drive generation;
 * the flattened pool is kept for the semantic validation pass.
 */
async function retrieveNode(state) {
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

/** Generation Agent node: ONE batch LLM call for all candidates (+ bounded refill). */
async function generateNode(state) {
  return timed('generateBatch', async () => {
    const requirements = state.requirements;
    const blueprint = state.blueprint || null;
    let candidates = await questionGeneratorAgent.generate(
      requirements,
      state.context,
      blueprint ? { blueprint, slotContexts: state.slotContexts } : {}
    );

    // Refill shortfall (bounded: one extra call) so count matches the requested
    // count when possible (blueprint mode: fills the remaining slots in order).
    if (candidates.length > 0 && candidates.length < requirements.questionCount) {
      const extraCount = requirements.questionCount - candidates.length;
      const extra = await questionGeneratorAgent.generate(requirements, state.context, blueprint
        ? { blueprint, extraCount, startSlotIndex: candidates.length, slotContexts: state.slotContexts }
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
    return {
      candidates,
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
    const result = await embeddingService.embedQuestions(
      pending.map(e => e.question),
      { concurrency: env.AI_EVAL_CONCURRENCY }
    );

    const rejected = pending.map((entry, i) => ({
      ...entry,
      question: { ...entry.question, embedding: result.questions[i].embedding },
    }));

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
  return timed('evaluateBatch', async () => {
    const requirements = state.requirements;
    const blueprint = state.blueprint || null;
    const validTypes = validTypesFor(blueprint);
    const useFullText = !!blueprint;
    // Source-similarity dedup runs ONLY against the past_paper corpus — the
    // syllabus corpus is content to ground in, never a duplication target.
    const filter = { corpus: 'past_paper', class: requirements.class, subject: requirements.subject };
    const maxRetries = env.MAX_RETRIES;
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
        // Slot-aware marks gate: a blueprint slot whose reference marks are
        // unknown must not deadlock here (see validation.agent deterministicCheck).
        blueprint,
        slotIndex: entry.slotIndex ?? null,
      });
      seenTexts.add(dupTextOf(entry.question, useFullText));
      if (result.ok) checked.push(entry);
      else localFailed.push({ entry, reasons: result.reasons });
    }

    // 2) In-memory peer duplicate detection (local cosine on batch embeddings, 0 calls)
    const peerDupMap = similarityAgent.findPeerDuplicates(checked, { acceptedVectors });

    // 3) Source similarity vs previous papers (parallel Qdrant searches, 0 LLM calls)
    const sourceResults = await runWithConcurrencyLimit(checked, env.AI_EVAL_CONCURRENCY, async (entry) => {
      const vector = entry.question.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        return { questionId: entry.question.questionId, isDuplicate: false, maxSimilarity: 0, threshold: env.SIMILARITY_THRESHOLD, matchedQuestion: null, missingEmbedding: true };
      }
      return similarityAgent.checkAgainstSource(entry.question, vector, { filter, topK: 5 });
    });
    const sourceCheckById = new Map(sourceResults.map(s => [s.questionId, s]));

    // 4) ONE batch LLM validation for survivors only
    const survivors = checked.filter(entry => {
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

    const settle = (entry, reasons) => {
      const attempts = entry.attempts + 1;
      const questionId = entry.question.questionId;
      const sourceCheck = sourceCheckById.get(questionId) ?? null;
      const peerCheck = peerDupMap.get(questionId) ?? null;
      const validation = validationById.get(questionId) ?? null;

      if (reasons.length === 0) {
        if (state.jobId != null && entry.slotIndex != null) {
          updateSlot(state.jobId, entry.slotIndex, { state: 'accepted', attempts });
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
      } else if (attempts >= maxRetries) {
        if (state.jobId != null && entry.slotIndex != null) {
          updateSlot(state.jobId, entry.slotIndex, { state: 'failed', attempts });
        }
        newFailed.push({ question: stripEmbedding(entry.question), slotIndex: entry.slotIndex, reasons, attempts });
      } else {
        if (state.jobId != null && entry.slotIndex != null) {
          updateSlot(state.jobId, entry.slotIndex, { state: 'generating', attempts });
        }
        stillPending.push({ ...entry, reasons, attempts });
      }
    };

    for (const entry of checked) {
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
      `[Pipeline] evaluateBatch: ${checked.length + localFailed.length} evaluated, ` +
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
  const keptVectors = { ...acceptedVectors };

  // Slots whose questions already exhausted MAX_RETRIES (they are in `failed`)
  // must NOT be re-tried forever: leave them missing and let the final report
  // surface the failure honestly.
  const exhaustedSlots = new Set((state.failed ?? []).map((e) => e.slotIndex).filter((i) => i != null));

  const bySlot = new Map();
  for (const q of accepted) {
    if (q.slotIndex != null) bySlot.set(q.slotIndex, q);
  }

  for (let i = 0; i < bpQuestions.length; i++) {
    const expected = bpQuestions[i];
    const q = bySlot.get(i);

    if (!q) {
      if (exhaustedSlots.has(i)) {
        console.warn(`[Pipeline] blueprintCheck: slot ${i + 1} (${expected.label}) already exhausted retries — left unreported.`);
        continue;
      }
      newRejected.push({
        question: null,
        slotIndex: i,
        reasons: [`${expected.label || `Q${i + 1}`} (slot ${i + 1}) was not generated.`],
        attempts: 0,
      });
      continue;
    }

    const check = checkQuestion(q, expected);
    if (check.ok) {
      kept.push(q);
    } else {
      if ((q.attempts ?? 0) >= env.MAX_RETRIES) {
        console.warn(`[Pipeline] blueprintCheck: slot ${i + 1} (${expected.label}) exhausted its regeneration budget — left unreported.`);
        delete keptVectors[q.questionId];
        continue;
      }
      newRejected.push({ question: q, slotIndex: i, reasons: check.reasons, attempts: q.attempts ?? 0 });
      delete keptVectors[q.questionId];
    }
  }

  console.log(`[Pipeline] blueprintCheck: ${kept.length}/${bpQuestions.length} slot(s) conform, ${newRejected.length} failed (targeted regeneration).`);
  return { accepted: kept, acceptedVectors: keptVectors, rejected: newRejected };
}

/** Regeneration node: regenerate ONLY pending (failed) questions, parallel, concurrency-limited. */
async function regenerateFailedNode(state) {
  const pending = state.rejected ?? [];
  if (pending.length === 0) return { rejected: [] };

  const blueprint = state.blueprint || null;

  return timed('regenerateFailed', async () => {
    const slotContexts = state.slotContexts ?? [];
    const replacements = await runWithConcurrencyLimit(
      pending,
      env.AI_EVAL_CONCURRENCY,
      (entry) => {
        // QUESTION-LEVEL RAG: regenerate with THIS slot's own context (topic
        // anchors), falling back to the flattened pool.
        const entryContext =
          blueprint && entry.slotIndex != null && Array.isArray(slotContexts[entry.slotIndex]?.results) && slotContexts[entry.slotIndex].results.length > 0
            ? slotContexts[entry.slotIndex].results
            : state.context;
        // A slot whose question was never produced at all → generate fresh for it.
        if (!entry.question && blueprint && entry.slotIndex != null) {
          return questionGeneratorAgent.generateForSlot(blueprint, entry.slotIndex, state.requirements, entryContext);
        }
        return questionGeneratorAgent.regenerate(entry.question, entry.reasons, state.requirements, entryContext, {
          blueprint,
          slotIndex: entry.slotIndex,
        });
      }
    );

    console.log(`[Pipeline] regenerateFailed: ${pending.length} question(s) regenerated`);
    bumpAi('regenerationRounds', pending.length);
    return {
      rejected: pending.map((entry, i) => ({ ...entry, question: replacements[i], reasons: [] })),
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
      const state = await graph.invoke(stateInput);
      stats = getStats();
      return state;
    });

    const totalMs = Date.now() - t0;
    let accepted = finalState.accepted ?? [];
    if (blueprint) {
      // Preserve reference question order (slot order), not append order.
      accepted = [...accepted].sort((a, b) => (a.slotIndex ?? Infinity) - (b.slotIndex ?? Infinity));
    }
    const failed = finalState.failed ?? [];
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
  },
};

export default orchestrator;