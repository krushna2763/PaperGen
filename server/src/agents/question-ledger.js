/**
 * question-ledger.js — PAPER-LEVEL DIVERSITY LEDGER (Phase 3).
 *
 * A PURE, deterministic view derived from `state.accepted` (plus the locked
 * blueprint and teacher requirements) — never a second mutable copy of
 * accepted-question state. No internal state, no database, no LLM call.
 *
 * Because the ledger is recomputed from `state.accepted` every time it is
 * needed (mirroring the pattern the pre-Phase-3 `usedDemandsFromAccepted`
 * helper already used in orchestrator.agent.js), it is correct by
 * construction:
 *   - accepted question added   → next buildLedger() call reflects it
 *   - accepted question replaced (blueprintCheckNode's `kept` swap) → the old
 *     entry is gone the instant `state.accepted` no longer contains it
 *   - a rejected/pending candidate never reaches `state.accepted`, so it can
 *     never produce a ledger entry
 * There is nothing to keep in sync, so the candidate-loss/stale-state bug
 * class Phase 1 fixed cannot recur here.
 *
 * Reuses the EXISTING cognitive-demand taxonomy from blueprint/question-intent.js
 * (buildQuestionIntent / classifyCognitiveOperation) — no duplicate taxonomy,
 * no new classifier. Difficulty is read from `requirements.difficulty` (the
 * teacher's own setting), never guessed from candidate text.
 */
import { buildQuestionIntent, classifyCognitiveOperation, informationDemandOf } from '../blueprint/question-intent.js';

/** The accepted question's own final text, used as the intent anchor only
 * when no blueprint slot is available at all (free-form / non-blueprint mode,
 * or a slotIndex outside the blueprint's own question list) — mirrors the
 * previous usedDemandsFromAccepted() fallback exactly. */
function pseudoItemFromAccepted(question) {
  const text = Array.isArray(question?.subParts) && question.subParts.length > 0
    ? question.subParts.map((sp) => sp?.text).filter(Boolean).join(' ')
    : String(question?.text || '');
  return { referenceText: text, type: question?.type };
}

/** The accepted question's own text for ONE entry: `subParts[itemIndex]` when
 * positionally aligned to a MIXED/multi-item slot, else the whole question's
 * text — the same `accepted.subParts[i] ↔ blueprint items[i]` alignment
 * buildLedger() already uses. Truncated; the ledger stays lightweight
 * (never a raw-prompt/full-context store). */
function normalizedTextFor(question, itemIndex) {
  const subParts = Array.isArray(question?.subParts) ? question.subParts : [];
  const text = itemIndex != null && subParts[itemIndex]
    ? String(subParts[itemIndex]?.text || '')
    : (subParts.length > 0 ? subParts.map((sp) => sp?.text).filter(Boolean).join(' ') : String(question?.text || ''));
  return text.trim().slice(0, 200) || null;
}

/** Build ONE ledger entry for a single item (or the whole question, when `item` is null). */
function buildLedgerEntry({ slot, slotIndex, requirements, item, question = null, itemIndex = null }) {
  const intent = buildQuestionIntent(slot, item, requirements);
  const cognitiveOperation = classifyCognitiveOperation(slot, item);
  const type = intent.type;
  // An item's OWN type is authoritative for the demand/answer-form fields
  // (same rule target-selector.js already uses), but "grounded in an image"
  // is a property of the SLOT (the image + its asset relationship), not of
  // one sub-question's answer form — an IMAGE_BASED slot's per-item entries
  // (each often typed SHORT_ANSWER/EXPLAIN) are still answers drawn from
  // that image and must not lose the imageBased signal just because their
  // own item type isn't literally "IMAGE_BASED".
  const imageBased = type === 'IMAGE_BASED' || String(slot?.type || '').toUpperCase() === 'IMAGE_BASED';
  // Phase 5 — answerTarget reuses the SAME informationDemandOf() classifier
  // target-selector.js now also reports (REASON/PROCESS/OBJECT/DEFINITION/
  // COMPARISON/EXAMPLE/PREDICTION/STATEMENT) — no duplicate taxonomy.
  const anchorText = String(
    item?.referenceText || (Array.isArray(slot?.referenceItems) ? slot.referenceItems.join(' ') : '') || slot?.instruction || ''
  );
  const answerTarget = informationDemandOf(anchorText);
  return {
    slotIndex,
    slotId: slot?.label ?? null,
    itemLabel: item?.label ?? null,
    type,
    topic: intent.topic,
    concept: intent.concept,
    cognitiveOperation,
    answerTarget,
    informationDemand: { answerTarget, operation: cognitiveOperation, relationship: null },
    answerForm: intent.answerForm,
    difficulty: String(requirements?.difficulty || 'Medium'),
    imageBased,
    imageConcept: imageBased ? intent.concept : null,
    // The ledger only ever holds ACCEPTED entries (buildLedger reads
    // state.accepted exclusively) — this field is always 'accepted', kept
    // explicit because Phase 5 asks the ledger to report validation status
    // per entry rather than leaving it implicit.
    validationStatus: 'accepted',
    normalizedQuestionText: normalizedTextFor(question, itemIndex),
  };
}

/**
 * Build the paper-scoped Question Ledger from the CURRENT accepted[] list.
 * One entry per accepted item: any slot whose blueprint entry carries
 * `items[]` (a MIXED slot, or any other type with independent multi-item
 * referenceItems, e.g. a 4-part IMAGE_BASED diagram question) yields one
 * entry per `blueprint.questions[slotIndex].items[i]` — the SAME rule
 * target-selector.js's selectTargetsForPool already applies, and the SAME
 * positional alignment `accepted.subParts[i] ↔ blueprint.questions[slotIndex].items[i]`
 * already used by reference-novelty.agent.js and checkPerItemTopicFidelity —
 * never flattened to one generic demand. A slot with no items[] yields one entry.
 * @param {Array<Object>} accepted - state.accepted (accumulated, authoritative)
 * @param {Object|null} blueprint - the locked blueprint (optional — free-form mode passes null)
 * @param {Object} [requirements] - { difficulty, ... } — teacher-controlled
 * @returns {Array<Object>} ledger entries, in accepted[] order
 */
export function buildLedger(accepted, blueprint = null, requirements = {}) {
  const list = Array.isArray(accepted) ? accepted : [];
  const entries = [];

  for (const q of list) {
    const slotIndex = q?.slotIndex ?? null;
    const slot = slotIndex != null && blueprint?.questions?.[slotIndex] ? blueprint.questions[slotIndex] : null;
    const slotItems = Array.isArray(slot?.items) ? slot.items : [];

    if (slot && slotItems.length > 0) {
      // One entry PER ITEM whenever the slot has items[] — the SAME rule
      // target-selector.js's selectTargetsForPool already applies
      // (`items.length > 0 ? slot.items : [null]`), regardless of the
      // parent slot's own `type`. A MIXED slot is the common case, but an
      // IMAGE_BASED (or any other) slot with independent multi-item
      // referenceItems carries the same per-item type/demand shape and must
      // not be flattened into a single generic entry either.
      slotItems.forEach((item, itemIndex) => {
        entries.push(buildLedgerEntry({ slot, slotIndex, requirements, item, question: q, itemIndex }));
      });
      continue;
    }

    if (slot) {
      entries.push(buildLedgerEntry({ slot, slotIndex, requirements, item: null, question: q }));
      continue;
    }

    // No blueprint slot available for this accepted entry — fall back to the
    // accepted question's own final text/type rather than crashing or
    // inventing structural facts that don't exist for this entry.
    entries.push(buildLedgerEntry({ slot: null, slotIndex, requirements, item: pseudoItemFromAccepted(q), question: q }));
  }

  return entries;
}

/** Cognitive demands already used by accepted questions/items this paper. */
export function usedDemandsFromLedger(ledger) {
  return (ledger || []).map((e) => e.cognitiveOperation).filter(Boolean);
}

/** Concept/topic strings already used this paper — SOFT guidance only, never a filter. */
export function usedConceptsFromLedger(ledger) {
  return (ledger || [])
    .map((e) => e.concept || e.topic)
    .filter((c) => typeof c === 'string' && c.length > 0);
}

export default { buildLedger, usedDemandsFromLedger, usedConceptsFromLedger };
