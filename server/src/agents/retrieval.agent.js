import { geminiClient } from '../services/gemini-client.service.js';
import { retriever } from '../rag/retriever.js';
import { env } from '../config/env.js';

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
  buildSlotQuery(slot, requirements) {
    const items = Array.isArray(slot?.referenceItems)
      ? slot.referenceItems.filter(Boolean)
      : [];
    const anchor = items.length > 0
      ? items.join(' | ')
      : String(slot?.instruction || slot?.stem || '').trim();
    if (!anchor) return null;
    const query = `Class ${requirements.class} ${requirements.subject}: ${anchor}`.replace(/\s+/g, ' ').trim();
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
  buildItemQuery(slot, item, requirements) {
    const anchor =
      String(item?.referenceText || '').trim() ||
      (Array.isArray(slot?.referenceItems) ? slot.referenceItems.filter(Boolean).join(' | ') : '') ||
      String(slot?.instruction || slot?.stem || '').trim();
    if (!anchor) return null;
    const query = `Class ${requirements.class} ${requirements.subject}: ${anchor}`.replace(/\s+/g, ' ').trim();
    return query.length > 600 ? query.slice(0, 600) : query;
  },

  /**
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
    // task per assigned item; every other slot yields one task.
    const tasks = [];
    slots.forEach((slot, i) => {
      const key = slot?.label || (slot?.number != null ? `Q${slot.number}` : `Q${i + 1}`);
      const entry = slotUnitMap[key] || {};
      const items = Array.isArray(slot?.items) ? slot.items : [];
      if (entry.items && typeof entry.items === 'object' && Object.keys(entry.items).length > 0) {
        for (const [label, unit] of Object.entries(entry.items)) {
          const it = items.find((x) => x.label === label) || null;
          tasks.push({
            slotIndex: i,
            itemLabel: label,
            unit,
            query: this.buildItemQuery(slot, it, requirements) || this.buildSlotQuery(slot, requirements),
          });
        }
      } else {
        tasks.push({
          slotIndex: i,
          itemLabel: null,
          unit: entry.unit ?? null,
          query: this.buildSlotQuery(slot, requirements),
        });
      }
    });

    // ONE batch embedding for every task query.
    const withQuery = tasks.filter((t) => t.query);
    const vectors = withQuery.length > 0 ? await geminiClient.embedBatch(withQuery.map((t) => t.query)) : [];
    withQuery.forEach((t, vi) => { t.vector = vectors[vi]; });

    const searched = await runWithConcurrencyLimit(tasks, env.AI_EVAL_CONCURRENCY, async (t) => {
      if (!t.vector || t.vector.length === 0) return { ...t, results: [] };
      const filter = { ...baseFilter };
      if (t.unit != null && String(t.unit).trim() !== '') filter.unit = t.unit;
      const hits = await retriever.search({ vector: t.vector, topK: perSlotTopK, filter });
      return { ...t, results: dedupeHits(hits) };
    });

    // Fold tasks back into per-slot shape.
    const perSlot = slots.map((slot, i) => {
      const mine = searched.filter((t) => t.slotIndex === i);
      const itemTasks = mine.filter((t) => t.itemLabel != null);
      if (itemTasks.length > 0) {
        const itemResults = {};
        for (const t of itemTasks) itemResults[t.itemLabel] = t.results;
        return {
          slotIndex: i,
          query: mine[0]?.query ?? null,
          unit: 'mixed',
          itemResults,
          results: dedupeHits(itemTasks.flatMap((t) => t.results)),
        };
      }
      const t = mine[0] || {};
      return { slotIndex: i, query: t.query ?? null, unit: t.unit ?? null, results: t.results ?? [] };
    });

    const populated = perSlot.filter((s) => s.results.length > 0).length;
    console.log(
      `[Retrieval Agent] syllabus RAG: ${tasks.length} task(s) embedded in one batch → ` +
      `${populated}/${slots.length} slot(s) with context (topK=${perSlotTopK})`
    );
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