import { geminiClient } from '../services/gemini-client.service.js';
import { retriever } from '../rag/retriever.js';
import { hybridSearch } from '../rag/hybrid-retriever.js';
import { retrieveHybridEvidence } from '../rag/hybrid-graph-retriever.js';
import { buildQuestionIntent, conceptTerms } from '../blueprint/question-intent.js';
import { buildStrategyQueries, evidenceSufficient, maxStrategyAttempts } from './retrieval-strategy.js';
import { env } from '../config/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


/**
 * Retrieval Agent (Module 7)
 *
 * Converts teacher requirements into a semantic search query, embeds it,
 * and retrieves a larger context pool of relevant previous-paper questions
 * from Qdrant.
 *
 * RULE 4: The Retrieval Agent provides ACADEMIC CONTEXT.
 *         It does NOT generate questions.
 *
 * RULE: Do not retrieve only exactly the number of questions to generate —
 *       retrieve a larger pool (RETRIEVAL_TOP_K) so the Generation Agent
 *       has enough context.
 */
import { runWithConcurrencyLimit } from './agent-utils.js';

export const retrievalAgent = {
  /**
   * Build a semantic search query string from teacher requirements.
   * Example: "Class 10 Science Life Processes medium-level questions"
   * @param {Object} requirements - { class, subject, topic?, difficulty }
   * @returns {string}
   */
  buildQuery(requirements) {
    const parts = ['Class', requirements.class, requirements.subject];
    if (requirements.topic) {
      parts.push(requirements.topic);
    }
    parts.push(`${requirements.difficulty} level questions`);
    return parts.join(' ');
  },

  /**
   * Build a QUESTION-LEVEL semantic query for one blueprint slot: the slot's
   * reference items (truncated topic anchors) + its instruction — so the
   * retrieved context covers the SAME concept area as that specific slot
   * instead of a generic whole-paper query.
   * @param {Object} slot - blueprint.questions[i]
   * @param {Object} requirements - { class, subject, difficulty }
   * @returns {string|null} null when the slot has no usable topic anchor
   */
  buildSlotQuery(slot, _requirements) {
    const items = Array.isArray(slot?.referenceItems)
      ? slot.referenceItems.filter(Boolean)
      : [];
    const anchor = items.length > 0
      ? items.join(' | ')
      : String(slot?.instruction || slot?.stem || '').trim();
    if (!anchor) return null;
    const query = `Class ${_requirements.class} ${_requirements.subject}: ${anchor}`.replace(/\s+/g, ' ').trim();
    return query.length > 600 ? query.slice(0, 600) : query;
  },

  /**
   * ITEM-LEVEL semantic query: anchored on ONE reference sub-question's topic
   * text, so an item assigned to its own unit retrieves that unit's material
   * for that concept, not the whole slot's.
   * @param {Object} slot
   * @param {Object|null} item - blueprint slot's items[] entry
   * @param {Object} requirements
   * @returns {string|null}
   */
  buildItemQuery(slot, item, _requirements) {
    const anchor =
      String(item?.referenceText || '').trim() ||
      (Array.isArray(slot?.referenceItems) ? slot.referenceItems.filter(Boolean).join(' | ') : '') ||
      String(slot?.instruction || slot?.stem || '').trim();
    if (!anchor) return null;
    const query = `Class ${_requirements.class} ${_requirements.subject}: ${anchor}`.replace(/\s+/g, ' ').trim();
    return query.length > 600 ? query.slice(0, 600) : query;
  },

  /**
   * CONTENT-ORIENTED retrieval query (PARTS 13/14/21).
   *
   * The raw reference question must NEVER be the main retrieval query:
   *   "What did Alice find on the glass table?"  → retrieves a near-identical
   *   notes sentence → Gemini paraphrases it back (Q1-d similarity 0.962).
   *
   * Instead we build a CONTENT query from the blueprint's topic anchor:
   *   - strip interrogative framing ("What did … find on …")
   *   - keep the CONCEPT terms (Alice, glass table, golden key, …)
   *   - add a question-type hint (MCQ → facts/details, LONG_ANSWER → story
   *     events, …) so retrieval finds material CONSTRUCTIBLE into that form
   * The metadata filter (class/subject/unit/corpus) does the scoping — not
   * the query words. Generic for every class/subject/unit (PART 37).
   *
   * @param {Object} slot - blueprint slot
 * @param {Object|null} item - blueprint slot's items[] entry
   * @param {Object} _requirements - unused today; kept for signature parity with
   *   buildSlotQuery/buildItemQuery (all three take the same leading args)
   * @returns {string|null}
   */
  buildContentQuery(slot, item, _requirements) {
    const anchor =
      String(item?.referenceText || '').trim() ||
      (Array.isArray(slot?.referenceItems) ? slot.referenceItems.filter(Boolean).join(' ') : '') ||
      String(slot?.instruction || slot?.stem || '').trim();
    if (!anchor) return null;

    // 1) Strip the interrogative frame: leading question words + auxiliaries.
    let content = anchor
      .replace(/^(what|why|how|which|who|whom|whose|where|when)\s+(did|does|do|is|are|was|were|can|could|will|would|should|has|have|had)?\s*/i, '')
      .replace(/^(the|a|an|to)\s+/i, '')
      .replace(/[?"'“”‘’]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 2) Fill-in-the-blank templates: drop the blank marker, keep the frame.
    content = content.replace(/_{2,}/g, ' ').replace(/\s+/g, ' ').trim();

    // 3) Question-type hint — what CONTENT the generator can construct from.
    const typeHint = {
      MCQ: 'facts details objects',
      FILL_IN_THE_BLANK: 'definition key term fact',
      TRUE_FALSE: 'facts statements',
      SHORT_ANSWER: 'reasons explanation details',
      LONG_ANSWER: 'story events sequence summary',
      MIXED: 'facts details key terms',
    }[String(slot?.type || '').toUpperCase()] || 'facts details';

    const query = `${content} ${typeHint}`.replace(/\s+/g, ' ').trim();
    return query.length > 400 ? query.slice(0, 400) : query;
  },


  /**
   * PHASE 9 — HYBRID_GRAPH RETRIEVAL MODE (additive; defaults untouched).
   *
   * 'legacy' / 'vector' -> dense-only Qdrant (pre-existing behavior, unchanged)
   * 'hybrid'            -> dense + BM25 + RRF (pre-existing behavior, unchanged)
   * 'hybrid_graph'      -> the SAME hybrid vector leg + the Phase 8 knowledge-graph
   *                        leg, fused by the EXISTING rag/hybrid-graph-retriever.js
   *                        (vector evidence stays the factual authority; graph items
   *                        are contextual support with provenance).
   *
   * Retrieval mode is NOT changed by the planner flag: QUESTION_PLANNER_ENABLED
   * only decides whether a QuestionPlan is built from the retrieved context.
   *
   * QUESTION-LEVEL / ITEM-LEVEL RAG over the SYLLABUS corpus for a locked
   * blueprint. Every slot (or every assigned item, when a slot's units differ)
   * becomes one retrieval task; all task queries are embedded in ONE batch call
   * and the Qdrant searches run concurrently (concurrency-limited). Each task's
   * Qdrant filter carries corpus:'syllabus' + class + subject + the task's unit.
   *
   * @param {Object} blueprint - locked blueprint with per-slot referenceItems / items
   * @param {Object} requirements - { class, subject, difficulty }
   * @param {Object} [opts] - { perSlotTopK, filter, slotUnitMap }
   * @returns {Promise<Array<{ slotIndex, query, unit, results, itemResults? }>>}
   *   Same order as blueprint.questions. `itemResults` is present (keyed by item
   *   label) only for slots whose items were retrieved per-unit.
   */
  async retrieveForSlots(blueprint, requirements, opts = {}) {
    const slots = Array.isArray(blueprint?.questions) ? blueprint.questions : [];
    if (slots.length === 0) return [];
    const perSlotTopK = opts.perSlotTopK ?? 5;
    const slotUnitMap = opts.slotUnitMap && typeof opts.slotUnitMap === 'object' ? opts.slotUnitMap : {};
    const baseFilter = {
      corpus: 'syllabus',
      class: requirements.class,
      subject: requirements.subject,
      ...(opts.filter || {}),
    };

    // Flatten slots → retrieval tasks. A slot with per-item units yields one
    // task per assigned item; every other slot yields one task. Every task
    // carries its QUESTION INTENT (PART 13) so traces, novelty checks and
    // generation prompts share ONE abstract specification.
    const hybrid = env.RETRIEVAL_MODE === 'hybrid';
    // PHASE 9 — RETRIEVAL_MODE=hybrid_graph routes every slot/item task through
    // the EXISTING Phase 8 hybrid+graph fusion (rag/hybrid-graph-retriever.js).
    const graphMode = env.RETRIEVAL_MODE === 'hybrid_graph';
    const useIntent = (hybrid || graphMode) && env.RETRIEVAL_INTENT_QUERIES !== false;
    const traces = [];
    const tasks = [];
    const intentsBySlot = new Map(); // slotIndex → { slotIntent?, itemIntents? }
    slots.forEach((slot, i) => {
      const key = slot?.label || (slot?.number != null ? `Q${slot.number}` : `Q${i + 1}`);
      const entry = slotUnitMap[key] || {};
      const items = Array.isArray(slot?.items) ? slot.items : [];
      const intentFor = (item) => buildQuestionIntent(slot, item, requirements);
      const pushItemTask = (it, label, unit) => {
        const intent = intentFor(it);
        const query = useIntent
          ? (intent.contentQuery || this.buildItemQuery(slot, it, requirements))
          : (this.buildItemQuery(slot, it, requirements) || this.buildSlotQuery(slot, requirements));
        const ladder = buildStrategyQueries({ slot, item: it, requirements });
        tasks.push({
          slotIndex: i, itemLabel: label, unit, slotKey: key, query, concept: intent.concept || null, ladder,
        });
        return intent;
      };

      if (entry.items && typeof entry.items === 'object' && Object.keys(entry.items).length > 0) {
        const itemIntents = {};
        for (const [label, unit] of Object.entries(entry.items)) {
          const it = items.find((x) => x.label === label) || null;
          itemIntents[label] = pushItemTask(it, label, unit);
        }
        intentsBySlot.set(i, { itemIntents });
        return;
      }

      // No explicit per-item UNIT assignment. A slot may still carry
      // INDEPENDENT items with genuinely distinct concepts under ONE unit
      // (Phase 4: "same unit, different concepts" is not a reason to merge
      // them into a single query — e.g. a 4-part IMAGE_BASED diagram
      // question, or a MIXED slot). Detected deterministically: items whose
      // own referenceText differs from one another. A manually-built slot
      // whose items all share the SAME topic-derived referenceText (no
      // per-item content to distinguish) stays a single merged task — no
      // benefit to splitting, and it would waste an extra Qdrant call per
      // item for an identical query.
      const distinctTexts = new Set(
        items.map((it) => String(it?.referenceText || '').trim()).filter(Boolean)
      );
      if (items.length > 1 && distinctTexts.size > 1) {
        const itemIntents = {};
        for (const it of items) {
          itemIntents[it.label] = pushItemTask(it, it.label, entry.unit ?? null);
        }
        intentsBySlot.set(i, { itemIntents });
        return;
      }

      const intent = intentFor(null);
      intentsBySlot.set(i, { slotIntent: intent });
      const ladder = buildStrategyQueries({ slot, item: null, requirements });
      tasks.push({
        slotIndex: i,
        itemLabel: null,
        unit: entry.unit ?? null,
        slotKey: key,
        query: useIntent
          ? (intent.contentQuery || this.buildSlotQuery(slot, requirements))
          : this.buildSlotQuery(slot, requirements),
        concept: intent.concept || null,
        ladder,
      });
    });

    // ONE batch embedding for every task query.
    const withQuery = tasks.filter((t) => t.query);
    const vectors = withQuery.length > 0 ? await geminiClient.embedBatch(withQuery.map((t) => t.query)) : [];
    withQuery.forEach((t, vi) => { t.vector = vectors[vi]; });

    // Phase 4 — Agentic Retrieval: ONE search at rung 1 (byte-identical to the
    // pre-Phase-4 query/vector/filter above) is the common case and costs
    // nothing extra. Only when that evidence is insufficient does the task
    // escalate to the next rung — a fresh, on-demand embedding for THAT
    // task alone, never a second batch call for tasks that already
    // succeeded. Bounded by maxStrategyAttempts(); never touches
    // slotAttempts/MAX_RETRIES — those live in orchestrator.agent.js and are
    // untouched by this module.
    const runSearch = async (query, vector, unit, concept) => {
      const filter = { ...baseFilter };
      if (unit != null && String(unit).trim() !== '') filter.unit = unit;
      if (graphMode) {
        // PHASE 9 — RETRIEVAL_MODE=hybrid_graph: the Phase 8 layer runs the SAME
        // hybrid vector leg (dense + BM25 → RRF → rerank → gate → compression)
        // PLUS the knowledge-graph leg, then fuses them (source text stays the
        // authority). Fail-safe: a total failure degrades to the plain hybrid
        // leg rather than aborting the slot; diagnostics are returned so the
        // failure is never silent.
        try {
          const out = await retrieveHybridEvidence({
            class: baseFilter.class,
            subject: baseFilter.subject,
            unit: filter.unit ?? null,
            concept: conceptOfQuery(query, concept),
            query,
            vector,
            mode: 'hybrid_graph',
            verbose: false,
          });
          return {
            results: dedupeHits(out.vectorEvidence),
            compressed: out.compressed,
            trace: null,
            vectorEvidence: out.vectorEvidence,
            graphEvidence: out.graphEvidence,
            graphRelationships: out.graphEvidence.filter((e) => e.type === 'GRAPH_RELATIONSHIP'),
            combinedEvidence: out.combinedEvidence,
            provenance: out.provenance,
            graphDiagnostics: out.diagnostics,
          };
        } catch (err) {
          console.warn(`[Retrieval Agent] hybrid_graph unavailable — degrading to hybrid vector retrieval: ${String(err?.message || err).slice(0, 160)}`);
          const out = await hybridSearch({ query, vector, filter });
          return {
            results: dedupeHits(out.final),
            compressed: out.compressed,
            trace: out.trace,
            vectorEvidence: out.final || [],
            graphEvidence: [],
            graphRelationships: [],
            combinedEvidence: out.final || [],
            provenance: [],
            graphDiagnostics: { graphFailed: true, graphError: String(err?.message || err).slice(0, 240) },
          };
        }
      }
      if (hybrid) {
        // PARTS 9/11/12/15-18: dense + BM25 → RRF → rerank → safety gate →
        // parent restore → compression. `final` hits keep the legacy shape.
        const out = await hybridSearch({ query, vector, filter });
        return { results: dedupeHits(out.final), compressed: out.compressed, trace: out.trace };
      }
      const hits = await retriever.search({ vector, topK: perSlotTopK, filter });
      return { results: dedupeHits(hits), compressed: null, trace: null };
    };

    const cap = maxStrategyAttempts();
    const searched = await runWithConcurrencyLimit(tasks, env.AI_EVAL_CONCURRENCY, async (t) => {
      const ladder = Array.isArray(t.ladder) && t.ladder.length > 0 ? t.ladder : [{ rung: 1, name: 'CONCEPT', query: t.query }];
      if (!t.vector || t.vector.length === 0) {
        return { ...t, results: [], strategy: ladder[0]?.name ?? 'CONCEPT', attempts: 0, sufficient: false };
      }

      let attempts = 1;
      let strategy = ladder[0]?.name ?? 'CONCEPT';
      let { results, compressed, trace, vectorEvidence, graphEvidence, graphRelationships, combinedEvidence, provenance, graphDiagnostics } =
        await runSearch(t.query, t.vector, t.unit, t.concept);
      let sufficient = evidenceSufficient(t.concept || t.query, results).ok;
      let triedQuery = t.query;

      for (let idx = 1; idx < ladder.length && !sufficient && attempts < cap; idx++) {
        const rung = ladder[idx];
        if (!rung?.query || rung.query === triedQuery) continue; // dedupe: never re-issue an identical query
        attempts++;
        const [vector] = await geminiClient.embedBatch([rung.query]);
        const attempt = await runSearch(rung.query, vector, t.unit, t.concept);
        results = attempt.results;
        compressed = attempt.compressed;
        trace = attempt.trace;
        // PHASE 9 — graph evidence follows the query that actually supplied the
        // context, so slotContext.graphEvidence always matches slotContext.results.
        if (graphDiagnostics) {
          vectorEvidence = attempt.vectorEvidence;
          graphEvidence = attempt.graphEvidence;
          graphRelationships = attempt.graphRelationships;
          combinedEvidence = attempt.combinedEvidence;
          provenance = attempt.provenance;
          graphDiagnostics = attempt.graphDiagnostics;
        }
        strategy = rung.name;
        triedQuery = rung.query;
        sufficient = evidenceSufficient(t.concept || rung.query, results).ok;
      }

      if (trace) traces.push({ slot: t.slotKey ?? `Q${t.slotIndex + 1}`, item: t.itemLabel, ...trace });
      return { ...t, query: triedQuery, results, compressed, strategy, attempts, sufficient, vectorEvidence, graphEvidence, graphRelationships, combinedEvidence, provenance, graphDiagnostics };
    });

    // Fold tasks back into per-slot shape. Intents ride along so the prompt
    // builder can show the abstract specification (PART 14) and the novelty
    // gate can compare demands (PART 16); compressed evidence rides along for
    // the prompt builder (PART 12).
    const perSlot = slots.map((slot, i) => {
      const intents = intentsBySlot.get(i) ?? {};
      const mine = searched.filter((t) => t.slotIndex === i);
      const itemTasks = mine.filter((t) => t.itemLabel != null);
      if (itemTasks.length > 0) {
        const itemResults = {};
        const itemRetrieval = {};
        for (const t of itemTasks) {
          itemResults[t.itemLabel] = t.results;
          itemRetrieval[t.itemLabel] = { strategy: t.strategy, attempts: t.attempts, sufficient: t.sufficient, query: t.query };
        }
        const itemBlocks = itemTasks.flatMap((t) => t.compressed?.blocks ?? []);
        return {
          slotIndex: i,
          query: mine[0]?.query ?? null,
          unit: 'mixed',
          itemResults,
          slotIntent: intents.slotIntent ?? null,
          itemIntents: intents.itemIntents ?? null,
          compressed: itemBlocks.length > 0 ? { blocks: itemBlocks, tokensUsed: itemBlocks.reduce((a, b) => a + (b.tokens || 0), 0) } : null,
          results: dedupeHits(itemTasks.flatMap((t) => t.results)),
          // Phase 4 — additive retrieval trace, per item. `sufficient` rolls
          // up to false if ANY item's evidence stayed insufficient after the
          // bounded ladder — existing consumers that only read
          // slotIndex/query/unit/results/itemResults/slotIntent/itemIntents/
          // compressed are unaffected.
          itemRetrieval,
          attempts: Math.max(0, ...itemTasks.map((t) => t.attempts ?? 0)),
          sufficient: itemTasks.every((t) => t.sufficient !== false),
          // PHASE 9 — graph evidence for a MIXED slot is the union of its items'
          // evidence (never merged into one plan; the planner plans per item).
          ...graphFieldsOf(itemTasks),
        };
      }
      const t = mine[0] || {};
      return {
        slotIndex: i,
        query: t.query ?? null,
        unit: t.unit ?? null,
        slotIntent: intents.slotIntent ?? null,
        itemIntents: intents.itemIntents ?? null,
        results: t.results ?? [],
        compressed: t.compressed ?? null,
        // Phase 4 — additive retrieval trace (see comment above).
        strategy: t.strategy ?? null,
        attempts: t.attempts ?? 0,
        sufficient: t.sufficient !== false,
        // PHASE 9 — additive evidence bundles (absent in legacy/vector/hybrid:
        // graphFieldsOf returns {} when the task carried no graph leg, so
        // existing consumers and prompt text are unchanged).
        ...graphFieldsOf([t]),
      };
    });

    const populated = perSlot.filter((s) => s.results.length > 0).length;
    console.log(
      `[Retrieval Agent] syllabus RAG (${graphMode ? 'hybrid+graph' : hybrid ? 'hybrid' : 'dense-legacy'}): ${tasks.length} task(s) embedded in one batch → ` +
      `${populated}/${slots.length} slot(s) with context (topK=${perSlotTopK})`
    );
    // DIAGNOSTIC (Phase 10 combined-timeout investigation) — evidence counts
    // per slot, no content. Only meaningful in hybrid_graph mode (graphMode);
    // vectorEvidence/graphEvidence/combinedEvidence are undefined/[] otherwise.
    if (graphMode) {
      perSlot.forEach((s, i) => {
        const label = slots[i]?.label ?? `Q${i + 1}`;
        console.log(`[DIAG retrieval] slot=${label} type=${slots[i]?.type ?? '?'} vectorEvidence=${(s.vectorEvidence || []).length} graphEvidence=${(s.graphEvidence || []).length} graphRelationships=${(s.graphRelationships || []).length} combinedEvidence=${(s.combinedEvidence || []).length} results=${(s.results || []).length}`);
      });
    }
    // PART 17 — retrieval trace persistence: server-side debugging artifact
    // only (server/data/retrieval-traces/). Never exposed to students.
    if (hybrid && traces.length > 0) {
      try {
        const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'retrieval-traces');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `trace-${Date.now()}.json`);
        fs.writeFileSync(file, JSON.stringify({ mode: 'hybrid', traces }, null, 2), 'utf8');
        console.log(`[Retrieval Agent] trace written → ${path.basename(file)}`);
      } catch { /* trace write is best-effort */ }
    }
    return perSlot;
  },

  /**
   * Free-form (no-blueprint) retrieval of grounding content from the SYLLABUS
   * corpus for a class + subject. Never touches the past_paper corpus.
   * @param {Object} requirements - { class, subject, topic?, difficulty, questionType?, unit? }
   * @returns {Promise<{ query: string, topK: number, results: Array<Object> }>}
   */
  async retrieve(requirements) {
    const query = this.buildQuery(requirements);

    const queryVector = await geminiClient.embedContent(query);

    const topK = env.RETRIEVAL_TOP_K;

    const filter = {
      corpus: 'syllabus',
      class: requirements.class,
      subject: requirements.subject,
    };
    if (requirements.unit != null && String(requirements.unit).trim() !== '') filter.unit = requirements.unit;

    const results = await retriever.search({ vector: queryVector, topK, filter });

    console.log(`[Retrieval Agent] Query: "${query}" → ${results.length} syllabus chunk(s) retrieved (topK=${topK}).`);

    return { query, topK, results };
  },
};

/**
 * PHASE 9 — collapse the hybrid_graph evidence bundles of one slot's retrieval
 * task(s) into the slotContext fields the Question Planner reads
 * (sc.vectorEvidence / sc.graphEvidence / sc.graphRelationships /
 * sc.combinedEvidence / sc.provenance). Returns {} for every other retrieval
 * mode so slotContexts keep their exact pre-Phase-9 shape.
 */
function graphFieldsOf(tasks) {
  const withGraph = (Array.isArray(tasks) ? tasks : []).filter((t) => t?.graphDiagnostics);
  if (withGraph.length === 0) return {};
  const uniq = (list, keyOf) => {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const k = keyOf(item);
      if (k == null || seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
    return out;
  };
  const vectorEvidence = uniq(withGraph.flatMap((t) => t.vectorEvidence || []), (e) => e.id ?? e.chunkId ?? e.text);
  const graphEvidence = uniq(withGraph.flatMap((t) => t.graphEvidence || []), (e) => e.id ?? e.text);
  const graphRelationships = uniq(
    withGraph.flatMap((t) => t.graphRelationships || []),
    (e) => e.id ?? `${e.relation ?? ''}::${e.text ?? ''}`
  );
  const combinedEvidence = [...vectorEvidence, ...graphEvidence].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const provenance = uniq(withGraph.flatMap((t) => t.provenance || []), (p) => `${p.sourceDocumentId ?? ''}::${p.chunkId ?? ''}`);
  return {
    retrievalMode: 'hybrid_graph',
    vectorEvidence,
    graphEvidence,
    graphRelationships,
    combinedEvidence,
    provenance,
    graphDiagnostics: withGraph.map((t) => ({
      graphUnavailable: Boolean(t.graphDiagnostics?.graphUnavailable),
      graphFailed: Boolean(t.graphDiagnostics?.graphFailed),
      graphNodes: t.graphDiagnostics?.graphNodes ?? 0,
      graphRelationships: t.graphDiagnostics?.graphRelationships ?? 0,
      graphConfidence: t.graphDiagnostics?.graphConfidence ?? 0,
    })),
  };
}

/**
 * PHASE 9 — deterministic concept anchor for the hybrid_graph leg.
 *
 * The retrieval task's query is already the CONTENT query built by
 * question-intent.js (interrogative frame stripped, type content hint appended).
 * The best available "known concept" is the task's own intent concept, which
 * buildItemQuery/buildSlotQuery don't carry — so the concept is taken from the
 * query's own content terms, never guessed from thin air. No intent concept
 * exists → null, and hybrid-graph-retriever falls back to topic/unit scope and
 * simply reports graphUnavailable when the graph has nothing for that scope
 * (never fabricated — e.g. the JVM/JRE nodes absent from the OOP graph).
 */
function conceptOfQuery(query, concept) {
  const known = String(concept ?? '').trim();
  if (known) return known;
  const terms = conceptTerms(String(query || '')).filter((t) => t.length > 2);
  return terms.slice(0, 3).join(' ') || null;
}

/** Drop near-identical hits (same normalized text) within one context list. */
function dedupeHits(hits) {
  const seen = new Set();
  const out = [];
  for (const h of Array.isArray(hits) ? hits : []) {
    const norm = String(h.text || '').toLowerCase().replace(/\s+/g, ' ');
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(h);
  }
  return out;
}

export default retrievalAgent;