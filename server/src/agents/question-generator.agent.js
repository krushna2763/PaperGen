import { geminiClient } from '../services/gemini-client.service.js';
import { parseJsonObject } from './agent-utils.js';
import { GENERATOR_TYPES } from '../blueprint/blueprint-schema.js';
import { env } from '../config/env.js';
import { buildAdaptiveFeedback } from './adaptive-feedback.agent.js';
import { formatAnswerTargetDirective } from './quality-diversity-prompt.js';
import { formatPlanBlock, formatImageGroundingBlock } from '../planner/plan-prompt.js';

/**
 * Phase 6 — per-slot ANSWER-FIRST directives. `slotTargets[slotIndex]` is
 * selectTarget()-shaped ({ targetDemands, transformation, answerTarget, ... });
 * the block tells the generator to build the question FROM the internal
 * answer target + transformation instead of rewriting the reference text.
 * Additive: absent → byte-identical prompts (all existing callers/tests).
 */
function formatAnswerTargetBlock(slotTargets, slotIndex) {
  return formatAnswerTargetDirective(slotTargets?.[slotIndex] ?? null);
}

/**
 * Phase 2 — CANDIDATE POOL task text: one candidate PER entry of
 * `candidateTargets` (the pool), each carrying its own per-item target
 * information-demand assignment from target-selector.js. Every candidate
 * must independently satisfy the SAME structural contract as a single
 * regenerated candidate — pooling changes WHAT DEMAND each candidate uses,
 * never the locked type/marks/item-count/answer-form/topic/image contract.
 * @param {Array<Array<Object>>} candidateTargets - candidateTargets[c][itemIndex] = { targetDemand, referenceDemand, rationale, requiredConstraints }
 * @returns {string}
 */
export function formatCandidatePoolTargets(candidateTargets, slotPlan = null) {
  return candidateTargets.map((perItem, c) => {
    const lines = perItem.map((t, i) => {
      const label = t.itemLabel || String.fromCharCode(97 + i);
      const answerTargetBit = t.answerTarget ? `, answer target ${t.answerTarget}` : '';
      const itemPlan = slotPlan?.itemPlans?.[i] ?? slotPlan ?? null;
      const grounding = slotPlan?.imageGrounding ?? itemPlan?.imageGrounding ?? null;
      const ri = grounding?.status === 'ok' ? grounding.referenceImage ?? null : null;
      const rels = (Array.isArray(ri?.relationships) ? ri.relationships : []).filter(Boolean);
      const obs = (Array.isArray(ri?.observationTargets) ? ri.observationTargets : []).filter(Boolean);
      const combined = [...rels, ...obs];
      const positionalTarget = combined.length > 0 ? combined[i % combined.length] : null;
      const itemPlanVa = itemPlan?.imageRequirement?.visualAnchor?.target;
      const vaTarget = itemPlanVa || positionalTarget || t.visualAnchor?.target || t.visualTarget
        || slotPlan?.imageRequirement?.visualAnchor?.target
        || null;
      const isImgDep = t.imageDependency === 'IMAGE_DEPENDENT' || t.imageRequired || itemPlan?.imageDependency === 'IMAGE_DEPENDENT' || slotPlan?.imageDependency === 'IMAGE_DEPENDENT';
      const imageBit = isImgDep
        ? ` [IMAGE_DEPENDENT: the student-facing question text for item (${label}) MUST explicitly require inspecting the reference image or diagram${vaTarget ? ` to identify, compare, or explain "${vaTarget}"` : ''}. Frame the stem with visual relational wording (e.g. "Observe the diagram and identify...", "Locate in the depicted architecture...", "Based on the position/layers shown in the figure...") asking about visible structural layout, tier position (base/bottom, middle/intermediate, top), or components visually grouped inside that specific container in the figure. CRITICAL: Never ask a generic textbook recall question (e.g. "which layer contains X" or "explain the function of X") or an abstract business scenario (e.g. "a company wants to deploy an app...") that a student could answer from notes without looking at the diagram — the diagram must be necessary evidence to answer. If item (${label}) is SHORT_ANSWER or <= 1 mark, write a concise 1-2 sentence direct identification/statement ask, not an open-ended explain essay.]`
        : '';
      return `    item (${label}): use information demand ${t.targetDemand}${answerTargetBit}${imageBit} (reference asked ${t.referenceDemand} — do not repeat that demand in different words).`;
    }).join('\n');
    return `  CANDIDATE ${c + 1}:\n${lines}`;
  }).join('\n');
}

/**
 * Phase 3 — SOFT paper-level concept-diversity guidance. Purely advisory: it
 * never restricts the target-demand assignment above, never rejects a
 * candidate, and is silently omitted when the ledger has nothing to report
 * (e.g. this is the first accepted question of the paper).
 * @param {Array<Array<Object>>} candidateTargets - candidateTargets[c][itemIndex], each item carries `usedConceptsThisPaper` (question-ledger.js, via target-selector.js) when a Question Ledger was supplied
 * @returns {string}
 */
function formatConceptGuidance(candidateTargets) {
  const concepts = candidateTargets?.[0]?.[0]?.usedConceptsThisPaper;
  if (!Array.isArray(concepts) || concepts.length === 0) return '';
  const unique = [...new Set(concepts)].slice(0, 12);
  return `\nPAPER-LEVEL DIVERSITY (soft guidance, never overrides the reference/topic/grounding above): these concepts/topics already appear elsewhere in this paper — ${unique.join('; ')}. Prefer a different concept when the reference structure and academic grounding allow it; reusing one is fine if the reference or grounding requires it.\n`;
}


/**
 * Question Generation Agent (Module 8) + Difficulty Control (Module 9)
 *
 * Generates BRAND-NEW questions based on teacher requirements and the
 * retrieved academic context. The LLM must NOT copy or trivially paraphrase
 * source questions.
 *
 * BLUEPRINT MODE: when a locked blueprint (from a previous-year paper) is
 * supplied, the blueprint controls STRUCTURE (types, marks, item counts,
 * optional rules, sections, numbering) while the LLM only supplies new
 * CONTENT for each slot. Blueprint rules override free-form generation.
 *
 * RULE 5: The Generation Agent generates questions.
 * RULE 10: All AI calls go through the centralized Gemini client.
 */

// Retry-temperature ramp for targeted regeneration ONLY (never the initial
// batch/single-slot generation, which stays at its own fixed temperature).
// A candidate that failed once and gets resampled at the SAME temperature
// with the SAME instruction has no push to actually diverge — each retry
// samples a little further from the failed attempt. Index 0 = attempt 1.
// The ceiling (1.0) is comfortably inside Gemini's supported 0-2 range, but
// GEMINI_MAX_TEMPERATURE is honored generically in case a future provider or
// model needs a lower cap — never hard-coded to a specific model.
const RETRY_TEMPERATURES = [0.70, 0.85, 1.00];
const GEMINI_MAX_TEMPERATURE = 2.0;

/**
 * The temperature for regeneration attempt N (1-based). Clamps below 1 to
 * the first rung and above the table's length to its last rung, so an
 * out-of-range attempt number never produces `undefined`. Clamps above to
 * the provider's supported ceiling, logging when that clamp actually fires.
 * @param {number} attempt - 1-based retry attempt number
 * @returns {number}
 */
export function retryTemperature(attempt) {
  const n = Number.isFinite(Number(attempt)) ? Number(attempt) : 1;
  const idx = Math.min(Math.max(Math.round(n), 1), RETRY_TEMPERATURES.length) - 1;
  const requested = RETRY_TEMPERATURES[idx];
  if (requested > GEMINI_MAX_TEMPERATURE) {
    console.log(`[regeneration] requested temperature=${requested} exceeds supported max=${GEMINI_MAX_TEMPERATURE} — using ${GEMINI_MAX_TEMPERATURE}`);
    return GEMINI_MAX_TEMPERATURE;
  }
  return requested;
}

const DIFFICULTY_GUIDE = `
DIFFICULTY (match exactly; difficulty is NOT the same as creativity):
- Easy = direct recall, simple wording, limited reasoning.
- Medium = conceptual understanding, moderate reasoning, simple application.
- Difficult = multi-step reasoning/analysis, non-obvious scenarios.
Never make a question "difficult" with complicated words alone.`;

const GENERATION_RULES = `
STRICT RULES:
1. Do NOT copy or trivially paraphrase source questions. REJECTED: "Explain photosynthesis." → "Describe photosynthesis.". ACCEPTED: a NEW scenario, e.g. "A plant is kept in a dark room for several days. What change would you expect and why?" (same concept, new reasoning path).
2. Stay within the given class, subject and topic; create new scenarios; match the requested difficulty.
3. Each question must be complete, clear, have an expected answer, and not repeat another question in the batch.
4. MCQ: put the 3-4 choices ONLY in the "options" array (plain text, no A/B/C prefixes); "text" is the stem alone.

MULTI-PART STRUCTURE (real exam paper, not isolated one-liners):
5. You output MAIN questions; a main question may contain lettered sub-parts ("subParts" — the renderer adds a./b./c.).
6. GROUP short items: for several very-short items (MCQ/TRUE_FALSE/FILL_IN_THE_BLANK/short definitions) write ONE main question with 4-5 uniform sub-parts under a single stem, e.g. text: "Fill in the blanks with the correct tense form of the verbs:", subParts: [{ text: "She ____________ (go) to school yesterday." }], marks: 5.
7. Comprehension/literature: put the passage in the "passage" field (60-140 words) and the questions as sub-parts. NEVER refer to a text the student cannot see.
8. LONG_ANSWER (marks >= 4): single stem, or 2-3 parts with "(any N)" written in the stem.
9. "marks" = TOTAL marks of the whole main question; per-part marks are equal and derived automatically (renderer shows e.g. "1x5=5").
10. Keep sub-parts short (<= 40 words) and passages <= 140 words; never put options or sub-part text inline in "text".`;

const ANSWER_RULES = `
ANSWER KEY — produce the answer for every item IN THIS SAME RESPONSE, never as a later pass:
1. Every item carries "answer" (a grouped question puts it on each sub-part; a single-stem question puts it at the top level) plus a one-line "rationale".
2. MCQ: "answer" is the EXACT text of the correct option and MUST be one of that item's own options. Across one question's items, do NOT place the correct option in the same position every time (a key that reads a, a, a, a is wrong).
3. FILL_IN_THE_BLANK: "answer" is the missing word/phrase. TRUE_FALSE: "answer" is exactly "True" or "False".
4. SHORT_ANSWER / LONG_ANSWER: "answer" is the expected response. For any item worth MORE THAN ONE MARK add "markingScheme": [{ "point": "...", "marks": N }, ...] whose "marks" sum to that item's marks.
5. MATCH_THE_FOLLOWING: add "answerPairs": [{ "left": "...", "right": "..." }, ...] — one pair per row, each left entry and each right entry used EXACTLY once.
6. INTERNAL_CHOICE: every "OR" branch carries its own "answer" (and "rationale") — the key must show an answer for BOTH branches, never only one.
7. The answer must be consistent with the item you actually wrote — never name an option the stem does not support.`;

const BLUEPRINT_RULES = `
BLUEPRINT RULES (FROZEN — override any conflicting rule above):
1. The slot list below is LOCKED. Do NOT change question types, total marks, item counts, optional-answer rules, sections, numbering or answer form.
2. Generate exactly one main question per slot, in slot order (the i-th question fills Slot i).
3. Each slot's question must carry the slot's EXACT type and EXACT total marks, and EXACTLY its item count as lettered sub-parts (items=1 → single stem is fine). COUNT your sub-parts before responding — this is a hard requirement.
4. If the slot has an optionalRule (any N), keep that exact rule in the stem (e.g. "(any four)") AND offer EXACTLY the slot's item count of questions for the student to choose from.
5. The CONTENT must be entirely new — new items, new scenarios, new wording. Never copy or closely paraphrase the reference items shown for a slot.
6. MCQ slots: every sub-part MUST carry its own "options" array with EXACTLY the slot's option count (shown as perItemOptions) of plain choices, no prefixes, no labels.
7. Keep the general form of the slot's instruction (e.g. "Fill in the blanks:", "On a Map of India mark the following") but write entirely new items under it.
8. TOPIC FIDELITY — the most important rule: each NEW item must test the SAME educational concept/topic area as the reference item shown for that slot. Same topic is required; only the scenario, wording, examples and depth may change. Never drift to an unrelated topic, even inside the same subject.
9. Same question format + same topic + new content: do not change only a name or a number of a reference item — build a genuinely new question on the same concept.
10. PER-ITEM TOPIC MAPPING IS POSITIONAL — the reference items under each slot are listed IN THE EXACT ORDER they appear in the paper. Your sub-part 1 must be a NEW question on the SAME concept as reference item 1, sub-part 2 on reference item 2, and so on. Never drop, add, swap or merge per-item concepts, even when you think a different topic would fit the stem better.
10a. ONE REFERENCE LINE MAY BUNDLE SEVERAL CONCEPTS — read the whole line and cover EVERY distinct concept it names, in new wording (e.g. a line asking to "explain why Java is platform independent … outline the structure of a simple Java program" tests TWO concepts: platform independence AND program structure; a new item that answers only one will be REJECTED for dropping the other).
11. PER-PART MARKS ARE LOCKED — when a reference item line shows a bracket such as [2 marks], produce the SAME per-part marks for the same position (e.g. a 5-part Q4 with marks 1,2,2,2,3 must keep exactly those per-part marks in that order). Put the marks on each sub-part object.
11a. MARKING SCHEME MUST SUM EXACTLY — for every sub-part worth N marks, the "marks" values in its markingScheme MUST add up to exactly N (e.g. a 3-mark part needs points summing to 3, not 2 and not 4). Recount before responding; a wrong sum is a mechanical rejection.
12. ANSWER FORM MUST MATCH THE QUESTION TYPE — do not change the pattern the reference uses inside the same slot: an MCQ slot must contain multiple-choice items each with its own options and one correct choice; a TRUE_FALSE slot must contain plain true/false statements (no options); a FILL_IN_THE_BLANK slot must contain sentences with a blank; a MATCH slot two equal-length columns; a passage slot a passage + questions about it. NEVER replace an MCQ with statements, or fill-in-the-blanks with short answers, inside a locked slot.
12a. MIXED SLOT (type=MIXED) — the slot's sub-items are NOT all the same type. The header lists each position's form ("a=FILL_IN_THE_BLANK (no options), b=FILL_IN_THE_BLANK (no options), c=MCQ (×3 options), d=MCQ (×3 options)") and each reference item line ends with "— TYPE: <FORM>". Generate EACH sub-part in exactly that form and set that sub-part's "type" field to it: a FILL_IN_THE_BLANK sub-part is a sentence with a ____ blank and NO "options"; an MCQ sub-part carries EXACTLY the stated option count of plain choices + one correct "answer"; a TRUE_FALSE sub-part is a plain statement. Keep the item order. Never make every sub-part the same type — that is the exact failure this rule prevents.
12b. IMAGE-BASED SLOT (type=IMAGE_BASED) — the slot is linked to an actual reference image. You must inspect the image content closely and generate a NEW question (and sub-parts) that directly requires the student to observe and reason about the visual features, labels, positions, or processes shown in the image. CRITICAL FOR IMAGE_DEPENDENT ITEMS: The image must be NECESSARY evidence to answer the question, not merely mentioned. Every student-facing question text MUST require inspecting the visible diagram to identify its layout, tier position (base/bottom, middle/intermediate, top), arrow connections, or specific components visually grouped inside that container (e.g. "In the attached architecture diagram, locate the intermediate layer between SaaS and IaaS, identify the component depicted inside it, and describe its role", or "In the attached architecture diagram, observe the container positioned at the base (bottom) and name the components visually grouped inside it"). A generic question that can be answered using general subject notes from memory alone (e.g. "which service model provides Virtual Machines", "which layer contains Runtime Environment", or an abstract hypothetical company scenario) is INVALID and will be REJECTED. Do NOT invent visual details not visible in the image, and do NOT copy reference wording.
12c. PER-ITEM TYPE MATCHING — when a slot's reference items list distinct types (e.g. item a is SHORT_ANSWER and item b is EXPLAIN / LONG_ANSWER), each sub-part MUST strictly match its specific item type: if an item is SHORT_ANSWER (<= 1 mark), write a concise 1-2 sentence direct identification/statement ask (e.g. "Identify...", "State..."), NOT an open-ended explain essay; if an item is EXPLAIN (>= 2 marks), write an explanation or comparison task with a matching markingScheme.
13. NOVELTY GUARD — reference items are academic concept anchors, NEVER wording to copy verbatim. Never reuse a distinctive noun phrase or bare label of the reference item as your sub-part stem (e.g. if the reference item is "Runtime Environment", writing a sub-part with text "Runtime Environment" is a REJECTED near-paraphrase). Keep the concept, objective, question type, answer form and marks — but write a complete, freshly framed question (e.g. "In the depicted architecture, identify which layer hosts the Runtime Environment and explain its function.").

MCQ SLOT EXAMPLE (type=MCQ, items=3, marks=3): { "questionId": "g-2", "text": "Choose the correct option:", "type": "MCQ", "marks": 3, "subParts": [
  { "text": "Which of these is a non-renewable source of energy?", "options": ["Solar", "Coal", "Wind", "Water"] },
  { "text": "____ is the process of water turning into vapour.", "options": ["Condensation", "Evaporation", "Precipitation", "Infiltration"] },
  { "text": "Which animal is a herbivore?", "options": ["Tiger", "Cow", "Lion", "Snake"] } ] }`;

const GENERATION_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          questionId: { type: 'string' },
          text: { type: 'string', description: 'The question wording. When this is a single-stem IMAGE_DEPENDENT question (see the PLAN block\'s REQUIRED VISUAL TARGET), this text itself — not only visualAnchor — must describe the specific visual relationship/position/structure being inspected; naming a concept the image depicts is not sufficient.' },
          type: {
            type: 'string',
            enum: ['MCQ', 'SHORT_ANSWER', 'LONG_ANSWER', 'TRUE_FALSE', 'FILL_IN_THE_BLANK', 'IMAGE_BASED', 'MIXED'],
          },
          marks: { type: 'integer' },
          difficulty: { type: 'string', enum: ['Easy', 'Medium', 'Difficult'] },
          options: { type: 'array', items: { type: 'string' }, description: 'Only for MCQ: 3-4 short choice texts (no letter prefixes). Omit otherwise.' },
          passage: { type: 'string', description: 'Comprehension passage (60-140 words) when the question asks about a given text.' },
          subParts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'This sub-part\'s question wording. When this sub-part is IMAGE_DEPENDENT (see the PLAN block\'s REQUIRED VISUAL TARGET for its letter), this text itself — not only visualAnchor — must describe the specific visual relationship/position/structure being inspected; naming a concept the image depicts is not sufficient.' },
                type: {
                  type: 'string',
                  enum: ['MCQ', 'SHORT_ANSWER', 'LONG_ANSWER', 'TRUE_FALSE', 'FILL_IN_THE_BLANK'],
                  description: 'REQUIRED for a MIXED slot: this item\'s own type (from the reference item at the same position). For a homogeneous slot, omit it.',
                },
                options: { type: 'array', items: { type: 'string' }, description: 'Only for MCQ sub-parts: 3-4 short choice texts (no letter prefixes).' },
                marks: { type: 'integer', description: 'ONLY when the locked slot carries per-part marks (e.g. Q4: a=1, b=2, c=2, d=2, e=3): this sub-part\'s exact marks. Omit when all sub-parts share the same marks.' },
                answer: { type: 'string', description: 'The correct answer to THIS item, written now. MCQ: the exact text of the correct option. FILL: the missing word/phrase. TRUE_FALSE: "True" or "False". SHORT/LONG: the expected response.' },
                rationale: { type: 'string', description: 'One short line: why that is the answer.' },
                markingScheme: {
                  type: 'array',
                  items: { type: 'object', properties: { point: { type: 'string' }, marks: { type: 'number' } }, required: ['point'] },
                  description: 'The points this item\'s marks break down across; the marks must sum to the item marks. This key MUST always be present in your response — use an empty array [] ONLY when this item is worth 1 mark or less (no breakdown needed); for any item worth MORE than 1 mark, this array is MANDATORY and must contain at least 2 points summing exactly to the item marks. Never omit this key.',
                },
                visualAnchor: {
                  type: 'object',
                  properties: {
                    target: { type: 'string', description: 'The specific visual relationship/position/structure (from the image\'s observation targets) this sub-part requires the student to inspect. Only for an IMAGE_DEPENDENT sub-part of an image-linked slot; omit otherwise.' },
                    usage: { type: 'string', description: 'One short line: how the student must use that visual detail to answer.' },
                  },
                  description: 'ONLY for an IMAGE_DEPENDENT sub-part of an image-linked slot: the observation target it engages and how. Omit for every other sub-part.',
                },
              },
              required: ['text', 'answer', 'markingScheme'],
            },
            description: 'Uniform lettered sub-parts for a grouped main question. Each carries its own answer.',
          },
          columns: {
            type: 'object',
            properties: {
              left: { type: 'array', items: { type: 'string' }, description: 'Only for MATCH_THE_FOLLOWING: left column items.' },
              right: { type: 'array', items: { type: 'string' }, description: 'Only for MATCH_THE_FOLLOWING: right column items (same count as left).' },
            },
            description: 'Only for MATCH_THE_FOLLOWING: the two columns to be matched.',
          },
          choices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                subParts: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
              },
              required: ['text'],
            },
            description: 'Only for INTERNAL_CHOICE: the mutually-exclusive alternatives ("OR" branches).',
          },
          answer: { type: 'string', description: 'For a SINGLE-STEM question (no subParts): the correct answer, written now.' },
          rationale: { type: 'string', description: 'One short line: why that is the answer (single-stem question).' },
          markingScheme: {
            type: 'array',
            items: { type: 'object', properties: { point: { type: 'string' }, marks: { type: 'number' } }, required: ['point'] },
            description: 'REQUIRED for a single-stem question worth more than 1 mark: the points its marks break down across.',
          },
          answerPairs: {
            type: 'array',
            items: { type: 'object', properties: { left: { type: 'string' }, right: { type: 'string' } }, required: ['left', 'right'] },
            description: 'Only for MATCH_THE_FOLLOWING: the answer key — one { left, right } pair per row; each left and each right used exactly once.',
          },
          visualAnchor: {
            type: 'object',
            properties: {
              target: { type: 'string', description: 'The specific visual relationship/position/structure (from the image\'s observation targets) this question requires the student to inspect. Only for a SINGLE-STEM IMAGE_DEPENDENT question; omit otherwise.' },
              usage: { type: 'string', description: 'One short line: how the student must use that visual detail to answer.' },
            },
            description: 'ONLY for a single-stem (no subParts) IMAGE_DEPENDENT question: the observation target it engages and how. Omit otherwise.',
          },
        },
        required: ['questionId', 'text', 'type', 'marks', 'difficulty'],
      },
    },
  },
  required: ['questions'],
};

const DEFAULT_MARKS = {
  MCQ: 1,
  TRUE_FALSE: 1,
  FILL_IN_THE_BLANK: 1,
  SHORT_ANSWER: 2,
  LONG_ANSWER: 5,
};

/**
 * Generation schema with the type enum widened to include blueprint types
 * (only used when a blueprint is locked). Deep-clones so the shared schema
 * constant is never mutated.
 * @param {Object|null} blueprint
 * @returns {Object} schema
 */
export function buildGenerationSchema(blueprint) {
  const schema = JSON.parse(JSON.stringify(GENERATION_SCHEMA));
  if (blueprint) {
    const types = [...new Set([...GENERATOR_TYPES, ...blueprint.questions.map((q) => q.type)])];
    schema.properties.questions.items.properties.type.enum = types;
  }
  return schema;
}

/**
 * Phase 2 CANDIDATE POOL schema: the IDENTICAL per-question item schema as
 * buildGenerationSchema, only re-wrapped under `candidates` with an exact
 * `poolSize` count — never a separate question format, so every downstream
 * consumer (normalizeGeneratedQuestion, the validators) sees the same shape
 * a single-candidate regenerate() already produces.
 * @param {Object|null} blueprint
 * @param {number} poolSize
 * @returns {Object} schema
 */
export function buildPoolGenerationSchema(blueprint, poolSize) {
  const base = buildGenerationSchema(blueprint);
  const itemSchema = base.properties.questions.items;
  return {
    type: 'object',
    properties: {
      candidates: { type: 'array', items: itemSchema, minItems: poolSize, maxItems: poolSize },
    },
    required: ['candidates'],
  };
}

/**
 * PHASE 10 — INITIAL-PASS CANDIDATE POOL schema: one pool of `poolSize`
 * candidates PER blueprint slot, all produced in ONE call. Reuses the
 * IDENTICAL per-question item schema as every other generation path — only
 * the wrapper (slots[] of {candidates[]}) is new, so normalizeGeneratedQuestion
 * and every validator see the exact same question shape they already trust.
 * @param {Object} blueprint
 * @param {number} poolSize
 * @returns {Object} schema
 */
export function buildInitialPoolGenerationSchema(blueprint, poolSize) {
  const base = buildGenerationSchema(blueprint);
  const itemSchema = base.properties.questions.items;
  const slotCount = blueprint.questions.length;
  return {
    type: 'object',
    properties: {
      slots: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidates: { type: 'array', items: itemSchema, minItems: poolSize, maxItems: poolSize },
          },
          required: ['candidates'],
        },
        minItems: slotCount,
        maxItems: slotCount,
      },
    },
    required: ['slots'],
  };
}

/**
 * PHASE 10 — the actual single-call worker behind generateInitialPool(): ONE
 * generateContent call producing `poolSize` candidates for every slot in the
 * given `opts.blueprint` (which may be the full blueprint, or one partition
 * of it — the caller decides). Kept separate from generateInitialPool() so a
 * mixed text+image blueprint can call this twice (once per partition)
 * without duplicating the prompt-build / schema / parse / normalize logic.
 * @param {Object} agent - the questionGeneratorAgent instance (for buildPrompt)
 * @param {Object} requirements
 * @param {Array<Object>} context
 * @param {Array<Array<Object>>} poolTargetsBySlot - one entry per slot IN `opts.blueprint`'s order
 * @param {Object} opts - { blueprint (required, already partitioned by the caller), poolSize }
 * @returns {Promise<Object[][]>} one array of normalized candidates per slot, in `opts.blueprint`'s order (slotIndex is LOCAL to this partition — the caller remaps it)
 */
async function runInitialPoolCall(agent, requirements, context, poolTargetsBySlot, opts) {
  const blueprint = opts.blueprint;
  const poolSize = opts.poolSize;

  const prompt = agent.buildPrompt(requirements, context, {
    ...opts,
    blueprint,
    initialPool: true,
    poolTargetsBySlot,
  });

  const images = blueprint.questions.flatMap((s) => s.imageAssets || []).filter(Boolean);

  // DIAGNOSTIC (Phase 10 combined-timeout investigation) — sizes/counts only,
  // never prompt content or secrets. Safe to leave in permanently: cheap,
  // additive, no behavior change. `partitionSlots`/`images` show which
  // partition (text vs image) this particular call belongs to.
  const imageBytesApprox = images.reduce((sum, img) => sum + String(img?.dataUri || '').length, 0);
  const poolTargetCount = Array.isArray(poolTargetsBySlot) ? poolTargetsBySlot.reduce((n, s) => n + (Array.isArray(s) ? s.length : 0), 0) : 0;
  console.log(`[DIAG generateInitialPool] partitionSlots=${blueprint.questions.length} promptChars=${prompt.length} poolSize=${poolSize} poolTargetEntries=${poolTargetCount} images=${images.length} imageBytesApprox=${imageBytesApprox} maxOutputTokens=${env.AI_GENERATION_MAX_OUTPUT_TOKENS}`);
  const callStart = Date.now();

  const rawText = await geminiClient.generateContent(prompt, {
    responseMimeType: 'application/json',
    responseSchema: buildInitialPoolGenerationSchema(blueprint, poolSize),
    temperature: 0.8,
    maxOutputTokens: env.AI_GENERATION_MAX_OUTPUT_TOKENS,
    ...(images.length > 0 ? { images } : {}),
  });

  console.log(`[DIAG generateInitialPool] callDurationMs=${Date.now() - callStart} responseChars=${String(rawText || '').length}`);

  const parsed = parseJsonObject(rawText);
  const rawSlots = Array.isArray(parsed?.slots) ? parsed.slots : [];
  const allowedTypes = allowedTypesFor(blueprint);

  return blueprint.questions.map((slot, i) => {
    const rawCandidates = Array.isArray(rawSlots[i]?.candidates) ? rawSlots[i].candidates : [];
    const candidates = rawCandidates
      .map((raw) => normalizeGeneratedQuestion(raw, i, { allowedTypes, blueprintSlot: { ...slot, slotIndex: i } }))
      .filter((q) => q.text.length >= 5);
    candidates.forEach((c, idx) => {
      const parts = (c.subParts || []).map((p, pi) => `(${String.fromCharCode(97 + pi)}) "${p.text}"`).join(' | ');
      console.log(`  [initial pool slot ${i + 1} #${idx + 1}] stem: "${c.text}" | subParts: ${parts}`);
    });
    return candidates;
  });
}

/** Allowed type set for normalization (blueprint mode widens it). */
function allowedTypesFor(blueprint) {
  if (!blueprint) return undefined;
  return [...new Set([...GENERATOR_TYPES, ...blueprint.questions.map((q) => q.type)])];
}

/** Per-slot pattern summary line (construction + answer form + option count). */
function slotPatternSummary(slot) {
  const bits = [];
  const pat = slot?.pattern && typeof slot?.pattern === 'object' ? slot.pattern : {};
  if (pat.answerForm) bits.push(`answerForm=${pat.answerForm}`);
  if (pat.instructionType) bits.push(`construction=${pat.instructionType}`);
  if (Number.isFinite(Number(pat.maxOptionCount)) && Number(pat.maxOptionCount) >= 2) {
    bits.push(`perItemOptions=${Math.round(Number(pat.maxOptionCount))}`);
  }
  // PER-SLOT DIFFICULTY (Mode B): the slot may override the paper-level value.
  // Extracted (Mode A) slots never carry one — the paper-level difficulty
  // in REQUIREMENTS then applies, so the reference path is unaffected.
  if (['Easy', 'Medium', 'Difficult'].includes(slot?.difficulty)) {
    bits.push(`difficulty=${slot.difficulty}`);
  }
  return bits.length > 0 ? `, ${bits.join(', ')}` : '';
}

/**
 * Extra one-liner appended to a MIXED slot's header so the model treats the
 * slot item-by-item. Empty for every other slot type.
 */
function mixedSlotNote(slot) {
  const items = Array.isArray(slot?.items) ? slot.items : [];
  const forms = items.map((it) => String(it?.type || '').toUpperCase()).filter(Boolean);
  const isMixed = String(slot?.type || '').toUpperCase() === 'MIXED'
    || (forms.length > 1 && new Set(forms).size > 1);
  if (!isMixed) return '';
  const itemDescs = items
    .map((it, i) => {
      const t = String(it?.type || 'UNKNOWN').toUpperCase();
      const oc = Number(it?.optionCount);
      const optNote = t === 'MCQ' ? `×${Number.isFinite(oc) && oc >= 2 ? oc : 3} options` : 'no options';
      return `${String.fromCharCode(97 + i)}=${t} (${optNote})`;
    })
    .join(', ');
  return `\n   HETEROGENEOUS/MIXED ITEMS — generate each sub-part in ITS OWN form, in order: ${itemDescs}. items[].type is authoritative; do NOT make every item the same type (e.g. if item a is SHORT_ANSWER, write a concise 1-2 sentence direct ask, NOT an open-ended explain essay).`;
}

/** Reference items of a slot as topic-anchor lines (short; never to be copied). */
function slotReferenceLines(slot, maxItems = 8) {
  const items = Array.isArray(slot?.referenceItems) ? slot.referenceItems.filter(Boolean).slice(0, maxItems) : [];
  if (items.length === 0) return '';
  const alpha = 'abcdefghijklmnopqrstuvwxyz'.split('');
  return items.map((it, i) => `   ${alpha[i] ?? i + 1}) ${it}`).join('\n');
}

/**
 * CANONICAL PER-ITEM reference lines for a slot: one line per reference
 * sub-question with its label, its topic anchor text and (when recovered) its
 * LOCKED per-part marks — e.g. "   a) What is the use of saving a document? [1 mark]".
 * Falls back to the legacy flat reference items when the per-item spec is empty.
 */
function slotItemLines(slot, maxItems = 12) {
  const items = Array.isArray(slot?.items) ? slot.items.slice(0, maxItems) : [];
  const alpha = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const forms = items.map((it) => String(it?.type || '').toUpperCase()).filter(Boolean);
  const slotMixed = String(slot?.type || '').toUpperCase() === 'MIXED'
    || (forms.length > 1 && new Set(forms).size > 1);
  if (items.length > 0) {
    return items
      .map((it, i) => {
        const marks = it?.marks != null ? ` [${it.marks} mark${it.marks === 1 ? '' : 's'}]` : '';
        const oc = Number(it?.optionCount);
        const itype = String(it?.type || '').toUpperCase();
        const isMcqItem = itype === 'MCQ' || (Number.isFinite(oc) && oc >= 2);
        const numMarks = Number(it?.marks);
        const schemeHint = Number.isFinite(numMarks) && numMarks > 1
          ? `, MANDATORY markingScheme breakdown: [{ "point": "...", "marks": ... }] with at least 2 points summing exactly to ${numMarks} marks`
          : '';
        // For a MIXED slot or heterogeneous slot, spell out EACH item's own form explicitly so the
        // model treats the slot item-by-item and never as one uniform type.
        let formHint = '';
        if (slotMixed) {
          if (isMcqItem) {
            const n = Number.isFinite(oc) && oc >= 2 ? oc : 3;
            formHint = ` — TYPE: MCQ, write EXACTLY ${n} plain options + one correct answer`;
          } else if (itype === 'FILL_IN_THE_BLANK') {
            formHint = ' — TYPE: FILL_IN_THE_BLANK, sentence with a ____ blank, NO options';
          } else if (itype === 'TRUE_FALSE') {
            formHint = ' — TYPE: TRUE_FALSE, a plain statement, NO options, answer "True"/"False"';
          } else if (itype === 'SHORT_ANSWER') {
            formHint = ' — TYPE: SHORT_ANSWER, concise 1-2 sentence direct identification/statement ask, NO options';
          } else if (itype === 'EXPLAIN' || itype === 'LONG_ANSWER') {
            formHint = ` — TYPE: ${itype}, explanation task, NO options${schemeHint}`;
          } else if (itype && itype !== 'UNKNOWN') {
            formHint = ` — TYPE: ${itype}, NO options${schemeHint}`;
          }
        } else if (isMcqItem) {
          formHint = ` (${Number.isFinite(oc) && oc >= 2 ? oc : 3} options)`;
        } else if (itype === 'FILL_IN_THE_BLANK') {
          formHint = ' (fill-in-the-blank — keep a ____ blank, NO options)';
        } else if (itype && itype !== 'MCQ' && itype !== 'UNKNOWN') {
          formHint = ` (${itype.replace(/_/g, ' ').toLowerCase()} — NO options${schemeHint})`;
        }
        const text = String(it?.referenceText || it?.topicAnchor || '').slice(0, 200) || '(no recoverable reference text — infer the concept from the slot instruction)';
        return `   ${alpha[i] ?? i + 1}) ${text}${marks}${formHint}`;
      })
      .join('\n');
  }
  return slotReferenceLines(slot, maxItems);
}

/** Format one slot's RAG context (deduped, truncated) for the prompt. */
function formatSlotContext(results, maxItems = 4, maxChars = 200) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) return '';
  const seen = new Set();
  const lines = [];
  for (const q of list) {
    const text = String(q.text || '').trim();
    const norm = text.toLowerCase().replace(/\s+/g, ' ');
    if (!text || seen.has(norm)) continue;
    seen.add(norm);
    lines.push(`   - ${text.length > maxChars ? text.slice(0, maxChars) + '…' : text}`);
    if (lines.length >= maxItems) break;
  }
  return lines.join('\n');
}

/**
 * Format the slot's COMPRESSED ACADEMIC EVIDENCE (PART 12/14) — sentence-level
 * selected facts from the hybrid pipeline's top 3–5 chunks, each retaining its
 * source metadata. This is WHAT to ask about; the blueprint slot is HOW to ask.
 */
function formatEvidenceBlocks(blocks, maxBlocks = 5, maxChars = 260) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (list.length === 0) return '';
  return list.slice(0, maxBlocks).map((b, i) => {
    const src = [b.unit ? `unit ${b.unit}` : null, b.sourcePage != null ? `p${b.sourcePage}` : null]
      .filter(Boolean).join(', ');
    const text = String(b.text || '').trim();
    return `   [E${i + 1}]${src ? ` (${src})` : ''} ${text.length > maxChars ? text.slice(0, maxChars) + '…' : text}`;
  }).join('\n');
}

/** One-line question-intent summary for the prompt (PART 13/14). */
function formatIntentLine(intent) {
  if (!intent) return '';
  const bits = [
    intent.type ? `type=${intent.type}` : null,
    intent.concept ? `concept=${intent.concept}` : null,
    intent.cognitiveOperation ? `demand=${intent.cognitiveOperation}` : null,
    intent.answerForm ? `answerForm=${intent.answerForm}` : null,
    intent.difficulty ? `difficulty=${intent.difficulty}` : null,
  ].filter(Boolean);
  return bits.length > 0 ? `   Question intent: ${bits.join(' · ')}` : '';
}

/**
 * Format a slice of blueprint slots for the prompt — each slot carries its
 * construction pattern, its reference items (topic anchors) and, when provided,
 * its OWN question-level RAG context.
 */
function formatBlueprintSlots(blueprint, startSlot = 0, count, slotContexts, slotTargets, poolTargetsBySlot = null) {
  const slots = blueprint.questions.slice(startSlot, count == null ? undefined : startSlot + count);
  return slots
    .map((s, i) => {
      const idx = startSlot + i + 1;
      const rule = s.optionalRule ? `optionalRule=any ${s.optionalRule.n}` : 'optionalRule=none';
      const sec = s.sectionName ? `, section=${s.sectionName}` : '';
      const inst = s.instruction ? `, instruction="${s.instruction}"` : '';
      const hint = s.teacherHint ? `, teacherHint="${s.teacherHint}"` : '';
      const head = `Slot ${idx} (${s.label}): type=${s.type}, totalMarks=${s.totalMarks}, items=${s.itemCount}, ${rule}${sec}${inst}${hint}${slotPatternSummary(s)}${mixedSlotNote(s)}`;
      const refs = slotItemLines(s);
      const sc = Array.isArray(slotContexts) ? slotContexts[startSlot + i] : null;
      const answerFirst = formatAnswerTargetBlock(slotTargets, startSlot + i);
      const ctx = sc ? formatSlotContext(sc.results) : '';
      const evidence = sc?.compressed?.blocks?.length ? formatEvidenceBlocks(sc.compressed.blocks) : '';
      const intent = sc?.slotIntent
        || (sc?.itemIntents && typeof sc.itemIntents === 'object' ? Object.values(sc.itemIntents)[0] : null);
      const intentLine = formatIntentLine(intent);
      // PHASE 9 (opt-in) — PLAN block from the attached QuestionPlan ('' when
      // disabled). formatPlanBlock already prefixes its OWN leading '\n' when
      // non-empty, so it is spliced in directly (no extra wrapping newline —
      // that would leave a stray blank line the disabled prompt never has).
      // When the planner is OFF but image grounding ran, the grounding block
      // still rides (additive — the grounding layer has its own flag). The
      // blueprint slot rides into formatPlanBlock so the grounding block can
      // label each sub-part with its reference item's image-dependency class.
      const planBlock = formatPlanBlock(sc, s) || formatImageGroundingBlock(sc?.imageGrounding, s);
      // PHASE 10 (opt-in, initial-pass pooling only) — this slot's own
      // per-candidate information-demand assignment, right under its
      // reference items, so the model treats each slot's pool independently.
      const slotPoolTargets = Array.isArray(poolTargetsBySlot) ? poolTargetsBySlot[startSlot + i] : null;
      const poolBlock = Array.isArray(slotPoolTargets) && slotPoolTargets.length > 0
        ? `\n   PER-CANDIDATE INFORMATION-DEMAND ASSIGNMENT for THIS slot's pool:\n${formatCandidatePoolTargets(slotPoolTargets, sc?.plan)}`
        : '';
      return `${head}${planBlock}${refs ? `\n   Reference items IN ORDER — generate one NEW sub-part per line on the SAME concept ([N marks] = that sub-part's locked marks):\n${refs}` : ''}${intentLine ? `\n${intentLine}` : ''}${answerFirst}${evidence ? `\n   ACADEMIC EVIDENCE for this slot (facts to build the question from — never wording to mirror):\n${evidence}` : ''}${ctx && !evidence ? `\n   Slot RAG context (concept reference only):\n${ctx}` : ''}${poolBlock}`;
    })
    .join('\n');
}

/** Full per-slot spec for targeted regeneration / single-slot prompts. */
function formatSlotSpec(slot, slotIndex, contextResults, slotCtx = null, target = null) {
  const rule = slot.optionalRule ? `optionalRule=any ${slot.optionalRule.n}` : 'optionalRule=none';
  const sec = slot.sectionName ? `, section=${slot.sectionName}` : '';
  const inst = slot.instruction ? `, instruction="${slot.instruction}"` : '';
  const hint = slot.teacherHint ? `, teacherHint="${slot.teacherHint}"` : '';
  const head = `Slot ${slotIndex + 1} (${slot.label}): type=${slot.type}, totalMarks=${slot.totalMarks}, items=${slot.itemCount}, ${rule}${sec}${inst}${hint}${slotPatternSummary(slot)}${mixedSlotNote(slot)}`;
  const refs = slotItemLines(slot);
  const ctx = formatSlotContext(contextResults);
  const answerFirst = formatAnswerTargetDirective(target);
  // PHASE 9 (opt-in) — render the attached QuestionPlan as the PLAN block.
  // Returns '' when the planner is disabled → prompt is byte-identical.
  // formatPlanBlock already prefixes its OWN leading '\n' when non-empty, so
  // it is spliced in directly (see the matching comment in formatBlueprintSlots).
  // Same additive fallback for image grounding when the planner is off.
  const planBlock = formatPlanBlock(slotCtx, slot) || formatImageGroundingBlock(slotCtx?.imageGrounding, slot);
  const evidence = slotCtx?.compressed?.blocks?.length ? formatEvidenceBlocks(slotCtx.compressed.blocks) : '';
  const intent = slotCtx?.slotIntent
    || (slotCtx?.itemIntents && typeof slotCtx.itemIntents === 'object' ? Object.values(slotCtx.itemIntents)[0] : null);
  const intentLine = formatIntentLine(intent);
  return `${head}${planBlock}${refs ? `\n   Reference items IN ORDER — generate one NEW sub-part per line on the SAME concept ([N marks] = that sub-part's locked marks):\n${refs}` : ''}${intentLine ? `\n${intentLine}` : ''}${answerFirst}${evidence ? `\n   ACADEMIC EVIDENCE for this slot (facts to build the question from — never wording to mirror):\n${evidence}` : ''}${ctx && !evidence ? `\n   Slot RAG context (concept reference only):\n${ctx}` : ''}`;
}

/**
 * Format retrieved context for the prompt (compact, deduped, bounded).
 */
function formatContext(context, limit = 8) {
  const slice = Array.isArray(context) ? context.slice(0, limit) : [];
  if (slice.length === 0) return '(no retrieved context available)';

  const seen = new Set();
  const lines = [];
  for (const q of slice) {
    const text = String(q.text || '').trim();
    const norm = text.toLowerCase().replace(/\s+/g, ' ');
    if (!text || seen.has(norm)) continue; // drop duplicate chunks
    seen.add(norm);
    lines.push(`- ${text.slice(0, 220)}`);
    if (lines.length >= limit) break;
  }
  return lines.length > 0 ? lines.join('\n') : '(no retrieved context available)';
}

function normalizeDifficulty(value) {
  if (!value) return 'Medium';
  const v = String(value).trim();
  const lower = v.toLowerCase();
  if (lower.startsWith('easy')) return 'Easy';
  if (lower.startsWith('diff')) return 'Difficult';
  if (lower.startsWith('hard')) return 'Difficult';
  if (lower.startsWith('med')) return 'Medium';
  return 'Medium';
}

/** Marking scheme → [{ point, marks }] (clean point text, positive marks or null). */
function normMarkingScheme(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      const point = String(s?.point ?? s?.text ?? '').trim().slice(0, 240);
      const m = Number(s?.marks);
      return { point, ...(Number.isFinite(m) && m > 0 ? { marks: Math.round(m * 10) / 10 } : {}) };
    })
    .filter((s) => s.point)
    .slice(0, 12);
}

/**
 * Deterministically repair a marking scheme's ARITHMETIC so its points sum
 * exactly to the declared marks — never invents new point content, never
 * changes the declared marks, never touches a scheme that already needs a
 * DIFFERENT fix (no rows, or a non-numeric row stays exactly as before,
 * still caught by answer-validator.js's checkAnswers and still driving real
 * regeneration). Root cause this closes: the model occasionally emits a
 * marking scheme whose points don't sum to the sub-part's marks (e.g. two
 * 1-mark points on a 3-mark item), which answer-validator.js correctly
 * rejects as a structural failure — this repairs the ARITHMETIC at the
 * source so a candidate is never even offered to that gate malformed.
 * Proportionally rescales the model's own point values to the target sum
 * (preserving their RELATIVE weighting and text), rounds to the nearest
 * half-mark, then corrects any rounding drift on the last point so the sum
 * lands exactly on target. Falls back to an even split across the SAME
 * number of points only if that correction would drive a point to zero or
 * below (a very lopsided original scheme) — never fewer/more points than
 * the model wrote, never a fabricated point of content.
 * @param {Array<{point:string, marks?:number}>} scheme
 * @param {number|null} marks - the sub-part's AUTHORITATIVE (blueprint-locked
 *   when present) marks; scheme is returned unchanged when this isn't a
 *   finite number > 1 (a 1-mark item needs no breakdown at all).
 * @returns {Array<{point:string, marks?:number}>} the same array (unchanged)
 *   or a repaired copy with corrected `marks` on each row.
 */
function repairMarkingScheme(scheme, marks) {
  const rows = Array.isArray(scheme) ? scheme : [];
  if (!(Number.isFinite(marks) && marks > 1) || rows.length < 2) return scheme;
  const nums = rows.map((s) => Number(s?.marks));
  if (!nums.every((n) => Number.isFinite(n) && n > 0)) return scheme; // let the existing gate catch this
  const sum = nums.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - marks) <= 0.5) return scheme; // already within the existing validator's tolerance

  const evenSplit = () => {
    const even = Math.round((marks / rows.length) * 10) / 10;
    const vals = rows.map(() => even);
    const drift = Math.round((marks - vals.reduce((a, b) => a + b, 0)) * 10) / 10;
    vals[vals.length - 1] = Math.round((vals[vals.length - 1] + drift) * 10) / 10;
    return rows.map((s, i) => ({ ...s, marks: vals[i] }));
  };

  const factor = marks / sum;
  const scaled = nums.map((n) => Math.max(0.5, Math.round(n * factor * 2) / 2));
  const drift = Math.round((marks - scaled.reduce((a, b) => a + b, 0)) * 10) / 10;
  scaled[scaled.length - 1] = Math.round((scaled[scaled.length - 1] + drift) * 10) / 10;
  if (scaled[scaled.length - 1] <= 0) return evenSplit();
  return rows.map((s, i) => ({ ...s, marks: scaled[i] }));
}

/**
 * Normalize an IMAGE_DEPENDENT sub-part's optional visualAnchor — the
 * observation target it engages and how. Returns null when the model omitted
 * it or supplied nothing usable (never invented; a missing anchor is not an
 * error, it just means the deterministic visual-engagement check falls back
 * to the sub-part text alone).
 */
function normVisualAnchor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const target = String(raw.target ?? '').trim().slice(0, 200);
  const usage = String(raw.usage ?? '').trim().slice(0, 200);
  if (!target && !usage) return null;
  return { ...(target ? { target } : {}), ...(usage ? { usage } : {}) };
}

function normalizeType(value, marks, allowedTypes) {
  const v = String(value || '').trim().toUpperCase().replace(/\s+/g, '_');
  const pool = allowedTypes || GENERATOR_TYPES;
  if (pool.includes(v)) return v;
  if (v === 'FILL_IN_THE_BLANKS') return 'FILL_IN_THE_BLANK';
  if (v === 'TRUE_OR_FALSE') return 'TRUE_FALSE';
  // Fallback from marks when the model omits the type
  if (marks >= 4) return 'LONG_ANSWER';
  return 'SHORT_ANSWER';
}

export function normalizeGeneratedQuestion(raw, index, opts = {}) {
  const { allowedTypes, blueprintSlot } = opts || {};
  const text = String(raw?.text || '').trim();
  const rawMarks = Number(raw?.marks);
  const marks = Number.isFinite(rawMarks) && rawMarks > 0 ? Math.round(rawMarks) : null;
  const difficulty = normalizeDifficulty(raw?.difficulty);
  const type = normalizeType(raw?.type, marks, allowedTypes);

  const question = {
    questionId: String(raw?.questionId || `generated-${index + 1}`),
    text,
    type,
    marks: marks ?? DEFAULT_MARKS[type] ?? 2,
    difficulty,
  };

  // Blueprint slot is AUTHORITATIVE for structure: the LLM may write new
  // content, but type and marks come from the locked slot (STEP 5 — the
  // backend treats blueprint marks as authoritative, never re-derived).
  if (blueprintSlot) {
    question.type = blueprintSlot.type;
    question.marks = blueprintSlot.totalMarks;
    question.slotIndex = blueprintSlot.slotIndex;
    question.markExpression = blueprintSlot.markExpression || null;
    question.section = blueprintSlot.sectionName || null;
    // PER-SLOT DIFFICULTY is authoritative when the slot carries one (Mode B);
    // the model's own difficulty guess never overrides it. Absent → the
    // paper-level difficulty the model was told to write stays.
    if (['Easy', 'Medium', 'Difficult'].includes(blueprintSlot.difficulty)) {
      question.difficulty = blueprintSlot.difficulty;
    }
  }

  // Optional structured content used only by the document renderer
  // (exam-paper layout) and for embedding the FULL question text. The stem
  // (`text`) alone is what validation / dedup see.
  const options = Array.isArray(raw?.options)
    ? raw.options.map((o) => String(o || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  if (type === 'MCQ' && options.length > 0) question.options = options;
  if (raw?.passage && String(raw.passage).trim().length > 5) {
    question.passage = String(raw.passage).trim().slice(0, 600);
  }

  const maxSubParts = Math.max(8, blueprintSlot?.itemCount || 8);
  const rawParts = Array.isArray(raw?.subParts) ? raw.subParts : [];
  const subParts = rawParts
    .map((sp) => {
      const partOptions = Array.isArray(sp?.options)
        ? sp.options.map((o) => String(o || '').trim()).filter(Boolean).slice(0, 6)
        : [];
      const rawMark = Number(sp?.marks);
      const partMarks = Number.isFinite(rawMark) && rawMark > 0 ? Math.round(rawMark * 10) / 10 : null;
      return {
        text: String(sp?.text || '').trim().replace(/\s+/g, ' '),
        rawType: String(sp?.type ?? '').trim(),
        options: partOptions,
        marks: partMarks,
        // Answer-key fields, carried through verbatim (the deterministic answer
        // validator enforces shape; nothing is re-derived).
        answer: String(sp?.answer ?? '').trim(),
        rationale: String(sp?.rationale ?? '').trim(),
        markingScheme: normMarkingScheme(sp?.markingScheme),
        visualAnchor: normVisualAnchor(sp?.visualAnchor),
      };
    })
    .filter((sp) => sp.text.length >= 3)
    .slice(0, maxSubParts);
  if (subParts.length > 0) {
    // PER-PART MARKS: the locked blueprint slot's per-item marks are
    // AUTHORITATIVE — when the reference carried per-part marks (items[].marks)
    // and the part count matches, stamp each part with its slot marks so a
    // model that omits or shifts them cannot silently change the paper.
    const slotMarks = Array.isArray(blueprintSlot?.items)
      ? blueprintSlot.items.map((it) => it?.marks)
      : [];
    const canStamp =
      slotMarks.length === subParts.length
      && slotMarks.every((m) => Number.isFinite(Number(m)) && Number(m) > 0);
    // PER-ITEM TYPE — the locked blueprint slot's items[].type is AUTHORITATIVE
    // for a MIXED slot: each generated sub-part is stamped with its reference
    // position's type so the model can never flatten "2 blanks + 2 MCQs" into
    // "4 MCQs". Homogeneous slots carry no per-item type (the parent type
    // covers them) unless the slot itself is MIXED. The model's own `type`
    // hint is the fallback only when the blueprint has none.
    const slotIsMixed = String(blueprintSlot?.type || '').toUpperCase() === 'MIXED';
    const slotItemTypes = Array.isArray(blueprintSlot?.items)
      ? blueprintSlot.items.map((it) => String(it?.type || '').toUpperCase())
      : [];
    const parts = subParts.map((sp, i) => {
      const slotMark = Number(slotMarks[i]);
      const marks = Number.isFinite(slotMark) && slotMark > 0
        ? Math.round(slotMark * 10) / 10
        : (canStamp ? Math.round(Number(slotMarks[i]) * 10) / 10 : sp.marks);
      const lockedType = slotItemTypes[i] && slotItemTypes[i] !== 'UNKNOWN' ? slotItemTypes[i] : null;
      const modelType = sp.rawType ? sp.rawType.toUpperCase().replace(/\s+/g, '_') : null;
      const itemType = slotIsMixed ? (lockedType || modelType || null) : (lockedType || null);
      return {
        text: sp.text.slice(0, 1000),
        ...(itemType ? { type: itemType } : {}),
        ...(sp.options.length > 0 ? { options: sp.options } : {}),
        ...(marks != null ? { marks } : {}),
        ...(sp.answer ? { answer: sp.answer } : {}),
        ...(sp.rationale ? { rationale: sp.rationale } : {}),
        ...(sp.markingScheme.length > 0 ? { markingScheme: repairMarkingScheme(sp.markingScheme, marks) } : {}),
        ...(sp.visualAnchor ? { visualAnchor: sp.visualAnchor } : {}),
      };
    });
    question.subParts = parts;
    // Uniform per-part marks are kept for legacy display math; non-uniform
    // per-part marks travel on the parts themselves (never averaged).
    const partMarks = parts.map((p) => p?.marks).filter((m) => Number.isFinite(Number(m)));
    if (partMarks.length === parts.length && new Set(partMarks).size === 1) {
      question.subPartMarks = Math.round(Number(partMarks[0]) * 10) / 10;
    }
  }

  // MATCH_THE_FOLLOWING columns and INTERNAL_CHOICE branches (optional,
  // additive — the renderer consumes them in a later phase).
  if (raw?.columns && Array.isArray(raw.columns.left) && Array.isArray(raw.columns.right)) {
    const left = raw.columns.left.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 12);
    const right = raw.columns.right.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 12);
    if (left.length > 0 && right.length > 0) question.columns = { left, right };
  }
  // MATCH answer key: one { left, right } pair per row (whole-question answer).
  if (Array.isArray(raw?.answerPairs)) {
    const pairs = raw.answerPairs
      .map((p) => ({ left: String(p?.left ?? '').trim(), right: String(p?.right ?? '').trim() }))
      .filter((p) => p.left && p.right)
      .slice(0, 12);
    if (pairs.length > 0) question.answerPairs = pairs;
  }
  if (Array.isArray(raw?.choices)) {
    const choices = raw.choices
      .map((c) => {
        const choiceParts = Array.isArray(c?.subParts)
          ? c.subParts.map((sp) => String(sp?.text || '').trim()).filter(Boolean).slice(0, 6)
          : [];
        const branchAnswer = String(c?.answer ?? '').trim();
        const branchWhy = String(c?.rationale ?? '').trim();
        return {
          text: String(c?.text || '').trim().slice(0, 300),
          ...(choiceParts.length > 0 ? { subParts: choiceParts } : {}),
          // PHASE 6: each OR branch keeps its own answer key entry so the
          // answer key can show an answer for BOTH branches.
          ...(branchAnswer ? { answer: branchAnswer } : {}),
          ...(branchWhy ? { rationale: branchWhy } : {}),
        };
      })
      .filter((c) => c.text.length >= 3)
      .slice(0, 4);
    if (choices.length > 0) question.choices = choices;
  }

  // Single-stem answer key (multi-item questions carry theirs per sub-part).
  if (!question.subParts || question.subParts.length === 0) {
    const ans = String(raw?.answer ?? '').trim();
    if (ans) question.answer = ans;
    const why = String(raw?.rationale ?? '').trim();
    if (why) question.rationale = why;
    const scheme = normMarkingScheme(raw?.markingScheme);
    if (scheme.length > 0) question.markingScheme = repairMarkingScheme(scheme, question.marks);
    const anchor = normVisualAnchor(raw?.visualAnchor);
    if (anchor) question.visualAnchor = anchor;
  }

  // Embedding source: passage + stem + sub-parts, so semantic checks see the
  // real content instead of a bare stem ("Fill in the blanks: …").
  const partsText = question.subParts ? question.subParts.map((sp) => sp.text).join('\n') : '';
  if (question.passage || partsText) {
    question.fullText = [question.passage, text, partsText].filter(Boolean).join('\n');
  }

  // Preserve image assets, layout, and locked state from blueprint slot
  if (blueprintSlot?.imageAssets && Array.isArray(blueprintSlot.imageAssets) && blueprintSlot.imageAssets.length > 0) {
    question.imageAssets = blueprintSlot.imageAssets;
    question.assetImages = blueprintSlot.imageAssets;
  } else if (raw?.imageAssets || raw?.assetImages) {
    question.imageAssets = raw.imageAssets || raw.assetImages;
    question.assetImages = question.imageAssets;
  }
  if (blueprintSlot?.imageLayout) {
    question.imageLayout = blueprintSlot.imageLayout;
  } else if (raw?.imageLayout) {
    question.imageLayout = raw.imageLayout;
  }
  if (blueprintSlot?.isLocked !== undefined) {
    question.isLocked = blueprintSlot.isLocked;
  }
  if (blueprintSlot?.lockedFields) {
    question.lockedFields = blueprintSlot.lockedFields;
  }

  return question;
}

// ─── LAYER 2 — TARGETED STRUCTURAL REPAIR (generic, bounded, non-content) ──
//
// answer-validator.js's checkAnswers() classifies a PURE required-field
// omission (never a content/quality problem) into `missingFields`. This
// repairs EXACTLY that field, from the model's OWN already-generated answer,
// never touching question text/answer/marks/options/image metadata/topic/
// unit/planner output. It is NOT normal regeneration: it does not consume
// env.MAX_RETRIES, is bounded by its OWN small env.STRUCTURAL_REPAIR_MAX_ATTEMPTS,
// and never asks the model to rewrite anything but the missing field(s).
//
// Field support is a small registry so a future required field (e.g.
// `answer`, `options`) can be added without inventing a new mechanism — only
// `markingScheme` is registered today because it is the only field the
// classification above currently produces.

/** One markingScheme repair unit: the sub-part/stem text+answer to ground the missing breakdown in. */
function repairUnitFor(question, itemIndex, itemMarks = null) {
  const fromMissing = Number(itemMarks);
  if (itemIndex == null || itemIndex === -1) {
    const marks = Number.isFinite(fromMissing) && fromMissing > 0 ? fromMissing : Number(question?.marks);
    return { text: String(question?.text ?? '').trim(), answer: String(question?.answer ?? '').trim(), marks };
  }
  const part = Array.isArray(question?.subParts) ? question.subParts[itemIndex] : null;
  const marks = Number.isFinite(fromMissing) && fromMissing > 0 ? fromMissing : Number(part?.marks);
  return { text: String(part?.text ?? '').trim(), answer: String(part?.answer ?? '').trim(), marks };
}

/** Registry: field name -> { schemaFor(count), promptFor(units), apply(question, itemIndex, value, targetMarks) }. */
const REPAIRABLE_FIELDS = {
  markingScheme: {
    schemaFor: () => ({
      type: 'object',
      properties: {
        repairs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              itemIndex: { type: 'integer', description: 'The same itemIndex given in the request (use -1 for the single-stem/top-level item).' },
              markingScheme: {
                type: 'array',
                items: { type: 'object', properties: { point: { type: 'string' }, marks: { type: 'number' } }, required: ['point', 'marks'] },
                description: 'Points breaking down the marks of the ALREADY-GIVEN answer below — must sum exactly to its marks.',
              },
            },
            required: ['itemIndex', 'markingScheme'],
          },
        },
      },
      required: ['repairs'],
    }),
    promptFor: (units) => `You are completing the ANSWER KEY for exam questions that have ALREADY been written and approved. Each item below is FINAL: its question text, its answer, and its marks are ALL CORRECT and MUST NOT change. The ONLY thing missing is the marking-scheme breakdown for the answer that is already given.

For EACH item, produce ONLY a "markingScheme": the points its marks break down across, summing EXACTLY to the stated marks. Use the EXISTING answer text below as the sole basis — do not introduce facts the answer does not already contain, and do not change the answer, the question, or the marks in any way.

${units.map((u) => `itemIndex=${u.itemIndex} (${u.marks} marks)\nQuestion: ${u.text}\nExisting answer: ${u.answer}`).join('\n\n')}

Respond with ONLY JSON: { "repairs": [ { "itemIndex": <same as given>, "markingScheme": [{ "point": "...", "marks": <number> }] } ] } — one entry per item above, points summing exactly to each item's marks.`,
    apply: (question, itemIndex, value, targetMarks = null) => {
      if (!Array.isArray(value) || value.length < 2) return false;
      const points = value
        .map((p) => ({ point: String(p?.point ?? '').trim(), marks: Number(p?.marks) }))
        .filter((p) => p.point && Number.isFinite(p.marks) && p.marks > 0);
      if (points.length < 2) return false;
      const tm = Number(targetMarks);
      const repaired = Number.isFinite(tm) && tm > 1 ? repairMarkingScheme(points, tm) : points;
      if (itemIndex == null || itemIndex === -1) question.markingScheme = repaired;
      else if (Array.isArray(question.subParts) && question.subParts[itemIndex]) question.subParts[itemIndex].markingScheme = repaired;
      else return false;
      return true;
    },
  },
};

/**
 * Attempt a bounded, narrow repair of PURE required-field omissions on an
 * otherwise-complete candidate. Returns a NEW question object (the input is
 * never mutated) with the repaired field(s) merged in, or `null` when no
 * registered field could be repaired (the caller falls through to the
 * existing rejection/regeneration pipeline, unchanged).
 * @param {Object} question - the candidate exactly as generated
 * @param {Array<{field:string, itemIndex:number|null, marks:number|null}>} missingFields
 * @returns {Promise<Object|null>}
 */
export async function repairMissingRequiredFields(question, missingFields) {
  const entries = (Array.isArray(missingFields) ? missingFields : []).filter((m) => REPAIRABLE_FIELDS[m?.field]);
  if (!question || entries.length === 0) return null;

  // Only ONE field kind is repaired per call today (markingScheme) — group by
  // field so a future second registered field would get its own model call,
  // never mixed into the same schema/prompt.
  const byField = new Map();
  for (const m of entries) {
    if (!byField.has(m.field)) byField.set(m.field, []);
    byField.get(m.field).push(m);
  }

  const patched = JSON.parse(JSON.stringify(question));
  let anyApplied = false;

  for (const [field, items] of byField) {
    const spec = REPAIRABLE_FIELDS[field];
    const units = items.map((m) => ({ itemIndex: m.itemIndex ?? -1, ...repairUnitFor(question, m.itemIndex, m.marks) }));
    if (units.some((u) => !u.text || !u.answer || !Number.isFinite(u.marks))) continue; // nothing usable to ground the repair in

    let rawText;
    try {
      rawText = await geminiClient.generateContent(spec.promptFor(units), {
        responseMimeType: 'application/json',
        responseSchema: spec.schemaFor(units.length),
        temperature: 0.2,
      });
    } catch (err) {
      console.warn(`[Generation Agent] structural repair (${field}) call failed: ${String(err?.message || err).slice(0, 160)}`);
      continue;
    }
    const parsed = parseJsonObject(rawText);
    const repairs = Array.isArray(parsed?.repairs) ? parsed.repairs : [];
    const byIndex = new Map(repairs.map((r) => [Number(r?.itemIndex), r]));
    for (const m of items) {
      const key = m.itemIndex ?? -1;
      const r = byIndex.get(key) || (items.length === 1 ? (repairs[0] || (Array.isArray(parsed) ? parsed[0] : null)) : null);
      if (r && spec.apply(patched, m.itemIndex, r[field] || r.points || r.scheme, m.marks)) anyApplied = true;
    }
  }

  return anyApplied ? patched : null;
}

export const questionGeneratorAgent = {
  /**
   * Build the generation prompt.
   * @param {Object} requirements - { class, subject, topic?, difficulty, questionCount, questionType? }
   * @param {Array<Object>} context - Retrieved previous questions
   * @param {Object} [opts]
   *   - regenerate, failedQuestion, failureReasons : targeted regeneration
   *   - blueprint : locked blueprint (slot-based mode)
   *   - slotIndex, singleSlot : generate ONE slot (missing-slot refill)
   *   - extraCount, startSlotIndex : batch refill for remaining slots
   */
  buildPrompt(requirements, context, opts = {}) {
    const topicLine = requirements.topic ? `Topic: ${requirements.topic}` : 'Topic: general (use the concepts present in the retrieved context)';
    const typeLine = requirements.questionType
      ? `Question type: ${requirements.questionType}`
      : 'Question type: mix types naturally appropriate to the content';
    const blueprint = opts.blueprint || null;
    const slotCount = opts.slotCount ?? (opts.extraCount ? opts.extraCount : undefined);
    // Per-slot context (results + compressed evidence + question intent) rides
    // through every prompt path that names a slot (PARTS 12/14).
    const slotCtxFor = (idx) => (Array.isArray(opts.slotContexts) ? opts.slotContexts[idx] ?? null : null);
    // Phase 6 — per-slot answer-first targets (additive; absent everywhere →
    // byte-identical prompts for all existing callers/tests).
    const slotTargetsFor = (idx) => (Array.isArray(opts.slotTargets) ? opts.slotTargets[idx] ?? null : null);

    const typeEnumHint = blueprint
      ? [...new Set([...GENERATOR_TYPES, ...blueprint.questions.map((q) => q.type)])].join('|')
      : GENERATOR_TYPES.join('|');
    const usePerSlotContext = blueprint && Array.isArray(opts.slotContexts);

    let task;
    if (opts.regenerate && opts.pool && Array.isArray(opts.candidateTargets) && opts.failedQuestion) {
      // Phase 2 CANDIDATE POOL: ONE call produces `poolSize` independent
      // replacement candidates for the SAME rejected slot, each assigned its
      // own target information-demand by target-selector.js. This never
      // consumes extra retry budget — it is still exactly one regeneration
      // attempt (the caller's slotAttempts increments once, same as a
      // single-candidate regenerate()).
      const regenSlot = blueprint && opts.slotIndex != null ? blueprint.questions[opts.slotIndex] : null;
      const adaptiveFeedback = buildAdaptiveFeedback({
        previousCandidate: opts.failedQuestion,
        reasons: opts.failureReasons,
        requirements,
        slot: regenSlot,
        priorReasons: opts.priorReasons,
      });
      const attemptNum = Number(opts.attempt) || null;
      const maxAttempts = Number(opts.maxAttempts) || null;
      const escalationLine = attemptNum != null && maxAttempts != null
        ? `\nRETRY BUDGET: this is attempt ${attemptNum} of a HARD ceiling of ${maxAttempts}. If the ceiling is reached without a passing candidate, the slot is FAILED and left EMPTY on the paper.\n`
        : '';
      const poolSize = opts.candidateTargets.length;
      task = `
TASK: CANDIDATE POOL REGENERATION — produce ${poolSize} INDEPENDENT replacement candidates for ONE rejected MAIN question. Each candidate is a complete, standalone replacement (not a refinement of the others) using its OWN assigned information demand below.

The following generated question was REJECTED:
Question ID: ${opts.failedQuestion.questionId}
Text: ${opts.failedQuestion.text}
Rejection reasons: ${(opts.failureReasons || []).join(' | ')}
${adaptiveFeedback ? `\n${adaptiveFeedback}\n` : ''}${escalationLine}
PER-CANDIDATE INFORMATION-DEMAND ASSIGNMENT (each candidate MUST use its own assigned demand, never the reference's own demand, and no two candidates may use the same demand for the same item):
${formatCandidatePoolTargets(opts.candidateTargets, slotCtxFor(opts.slotIndex)?.plan)}
${formatConceptGuidance(opts.candidateTargets)}
Every one of the ${poolSize} candidates must independently:
- Keep the same questionId (${opts.failedQuestion.questionId}).
- Keep the requested difficulty (${requirements.difficulty}) and stay within the same topic.
- Keep the same type and overall structure (single stem, or passage + sub-parts, or options).
- Genuinely change the information demand per the assignment above — not a wording-only rewrite of the reference or of each other.${regenSlot && (String(regenSlot.type || '').toUpperCase() === 'IMAGE_BASED' || (Array.isArray(regenSlot.imageAssets) && regenSlot.imageAssets.length > 0)) ? `\n- For IMAGE_DEPENDENT items: The student-facing question text MUST explicitly require inspecting the reference image or diagram to answer — ask about visible spatial layout, relative layer position, hierarchy, or grouping (e.g. "In the depicted architecture, identify which layer is positioned at the base containing Virtual Machines and Storage, and describe its structural relationship to the layer directly above it"). Prepending "Observe the diagram" to a textbook recall ask that can be answered from memory alone (e.g. "Observe the diagram and state which service model provides Virtual Machines" or "which layer contains Runtime Environment") will be REJECTED.` : ''}`;
      if (opts.failedQuestion?.teacherNotes) {
        task += `\n\nTEACHER NOTES for this question (honor them; they are private guidance and never appear on the student paper):\n"${String(opts.failedQuestion.teacherNotes).slice(0, 500)}"`;
      }
      if (blueprint && opts.slotIndex != null && blueprint.questions[opts.slotIndex]) {
        task += `

Every candidate must fill this LOCKED BLUEPRINT slot exactly:
${formatSlotSpec(blueprint.questions[opts.slotIndex], opts.slotIndex, slotCtxFor(opts.slotIndex)?.results, slotCtxFor(opts.slotIndex), slotTargetsFor(opts.slotIndex))}
Do not change the slot's type, total marks, item count or optional rule in ANY candidate — fix the CONTENT so it passes the rejection reasons above.
CRITICAL: if the rejection reason mentions item count, recount your sub-parts and produce EXACTLY ${blueprint.questions[opts.slotIndex].itemCount} of them, in every candidate.`;
      }
    } else if (opts.regenerate && opts.failedQuestion) {
      const regenSlot = blueprint && opts.slotIndex != null ? blueprint.questions[opts.slotIndex] : null;
      const adaptiveFeedback = buildAdaptiveFeedback({
        previousCandidate: opts.failedQuestion,
        reasons: opts.failureReasons,
        requirements,
        slot: regenSlot,
        priorReasons: opts.priorReasons,
      });
      const attemptNum = Number(opts.attempt) || null;
      const maxAttempts = Number(opts.maxAttempts) || null;
      const escalationLine = attemptNum != null && maxAttempts != null
        ? `\nRETRY BUDGET: this is attempt ${attemptNum} of a HARD ceiling of ${maxAttempts}. If the ceiling is reached without a passing candidate, the slot is FAILED and left EMPTY on the paper — there is no further attempt. Do NOT produce a cosmetic rewrite of the rejected question; rebuild the item(s) around different evidence-backed content so this attempt can actually pass.\n`
        : '';
      task = `
TASK: TARGETED REGENERATION — replace ONE rejected MAIN question with a better one.

The following generated question was REJECTED:
Question ID: ${opts.failedQuestion.questionId}
Text: ${opts.failedQuestion.text}
Rejection reasons: ${(opts.failureReasons || []).join(' | ')}
${adaptiveFeedback ? `\n${adaptiveFeedback}\n` : ''}${escalationLine}
Produce ONE improved replacement MAIN question that fixes every rejection reason.
Keep the same questionId (${opts.failedQuestion.questionId}).
Keep the requested difficulty (${requirements.difficulty}) and stay within the same topic.
Keep the same type and overall structure (single stem, or passage + sub-parts, or options).${regenSlot && (String(regenSlot.type || '').toUpperCase() === 'IMAGE_BASED' || (Array.isArray(regenSlot.imageAssets) && regenSlot.imageAssets.length > 0)) ? `\n- For IMAGE_DEPENDENT items: The student-facing question text MUST explicitly require inspecting the reference image or diagram to answer — ask about visible spatial layout, relative layer position, hierarchy, or grouping (e.g. "In the depicted architecture, identify which layer is positioned at the base containing Virtual Machines and Storage, and describe its structural relationship to the layer directly above it"). Prepending "Observe the diagram" to a textbook recall ask that can be answered from memory alone (e.g. "Observe the diagram and state which service model provides Virtual Machines" or "which layer contains Runtime Environment") will be REJECTED.` : ''}`;
      if (opts.failedQuestion?.teacherNotes) {
        task += `\n\nTEACHER NOTES for this question (honor them; they are private guidance and never appear on the student paper):\n"${String(opts.failedQuestion.teacherNotes).slice(0, 500)}"`;
      }
      if (blueprint && opts.slotIndex != null && blueprint.questions[opts.slotIndex]) {
        task += `

The replacement must fill this LOCKED BLUEPRINT slot exactly:
${formatSlotSpec(blueprint.questions[opts.slotIndex], opts.slotIndex, slotCtxFor(opts.slotIndex)?.results, slotCtxFor(opts.slotIndex), slotTargetsFor(opts.slotIndex))}
Do not change the slot's type, total marks, item count or optional rule — fix the CONTENT so it passes the rejection reasons above.
CRITICAL: if the rejection reason mentions item count, recount your sub-parts and produce EXACTLY ${blueprint.questions[opts.slotIndex].itemCount} of them.`;
      }
    } else if (opts.singleSlot && blueprint && opts.slotIndex != null && blueprint.questions[opts.slotIndex]) {
      const slot = blueprint.questions[opts.slotIndex];
      task = `
TASK: Generate exactly ONE brand-new MAIN question that fills this LOCKED BLUEPRINT slot:
${formatSlotSpec(slot, opts.slotIndex, slotCtxFor(opts.slotIndex)?.results, slotCtxFor(opts.slotIndex), slotTargetsFor(opts.slotIndex))}
Use the slot's exact type, total marks, item count and optional rule. Write entirely new content for it.`;
      if (slot.teacherNotes) {
        task += `\n\nTEACHER NOTES for this question (honor them; they are private guidance and never appear on the student paper):\n"${String(slot.teacherNotes).slice(0, 500)}"`;
      }
    } else if (opts.initialPool && blueprint && Array.isArray(opts.poolTargetsBySlot)) {
      // PHASE 10 — INITIAL-PASS CANDIDATE POOL: ONE call produces `poolSize`
      // independent candidates for EVERY slot at once (never a per-slot
      // regeneration; this replaces the normal single-candidate initial batch
      // only when explicitly opted in). Each slot's own pool carries its own
      // per-item target-demand assignment (formatBlueprintSlots below), so a
      // slot's 3 candidates genuinely differ from each other, not just from
      // the reference.
      const poolSize = opts.poolTargetsBySlot[0]?.length || 3;
      task = `
TASK: Generate exactly ${poolSize} INDEPENDENT candidates for EACH of the ${blueprint.questions.length} LOCKED BLUEPRINT slots below — ${poolSize} candidates per slot, one main question per slot per candidate, in the exact slot order. Each candidate for a given slot is a complete, standalone alternative (never a refinement of the others) using its OWN assigned information demand shown under that slot.`;
    } else if (opts.extraCount) {
      task = blueprint
        ? `
TASK: Generate exactly ${opts.extraCount} ADDITIONAL BRAND-NEW MAIN questions to fill the remaining LOCKED BLUEPRINT slots below (starting at Slot ${(opts.startSlotIndex || 0) + 1}), one per slot, in order.
These must be DISTINCT from any questions already produced in this batch — do not repeat or rephrase them.`
        : `
TASK: Generate exactly ${opts.extraCount} ADDITIONAL BRAND-NEW MAIN questions to reach the requested total for the paper.
These must be DISTINCT from any questions already produced in this batch — do not repeat or rephrase them.`;
    } else {
      task = blueprint
        ? `
TASK: Generate exactly ${requirements.questionCount} BRAND-NEW MAIN questions that fill every slot of the LOCKED BLUEPRINT below — one main question per slot, in the exact slot order.`
        : `
TASK: Generate exactly ${requirements.questionCount} BRAND-NEW MAIN questions for a previous-year-paper-style question paper.
Each main question should read like one numbered item on a real exam paper (see MULTI-PART rules above) — group short items into lettered sub-parts and provide a passage when a question needs one.`;
    }

    const blueprintBlock = blueprint
      ? `\nLOCKED BLUEPRINT (FROZEN STRUCTURE) — one NEW main question per slot below:\n${formatBlueprintSlots(blueprint, opts.startSlotIndex || 0, slotCount, usePerSlotContext ? opts.slotContexts : null, opts.slotTargets, opts.initialPool ? opts.poolTargetsBySlot : null)}\n${BLUEPRINT_RULES}\n`
      : '';
    const retrievedBlock = usePerSlotContext
      ? 'QUESTION-LEVEL RAG CONTEXT: relevant previous-year material is attached under EACH slot below ("Slot RAG context"). Use it only as concept reference for that slot — never copy it.'
      : `RETRIEVED CONTEXT (previous-year questions covering the target concepts — use them ONLY as concept reference):\n${formatContext(context)}`;

    return `You are an expert academic question paper setter for school examinations.

REQUIREMENTS:
- Class: ${requirements.class}
- Subject: ${requirements.subject}
- ${topicLine}
- Difficulty: ${requirements.difficulty}
- Requested question count: ${requirements.questionCount}
- ${typeLine}

${DIFFICULTY_GUIDE}

${retrievedBlock}

${GENERATION_RULES}
${ANSWER_RULES}
${blueprintBlock}
${task}

OUTPUT FORMAT: Respond with ONLY a JSON object (no prose around it) in exactly this shape:
${opts.initialPool && Array.isArray(opts.poolTargetsBySlot)
  ? `{ "slots": [ { "candidates": [ { "questionId": "...", "text": "stem text", "type": "${typeEnumHint}", "marks": <total number>, "difficulty": "Easy|Medium|Difficult", "passage": "<only for comprehension, optional>", "options": ["...", "...", "..."], "answer": "<single-stem answer>", "rationale": "<why>", "markingScheme": [ { "point": "...", "marks": 1 } ], "answerPairs": [ { "left": "...", "right": "..." } ], "subParts": [ { "text": "...", "type": "<only for a MIXED slot: this item's own type>", "options": ["..."], "answer": "...", "rationale": "...", "markingScheme": [ { "point": "...", "marks": 1 }, { "point": "...", "marks": 2 } ] } ] } /* exactly ${opts.poolTargetsBySlot[0]?.length || 3} entries, one per candidate for THIS slot */ ] } /* exactly ${blueprint.questions.length} entries, one per blueprint slot, same order */ ] }`
  : (opts.pool && Array.isArray(opts.candidateTargets)
  ? `{ "candidates": [ { "questionId": "...", "text": "stem text", "type": "${typeEnumHint}", "marks": <total number>, "difficulty": "Easy|Medium|Difficult", "passage": "<only for comprehension, optional>", "options": ["...", "...", "..."], "answer": "<single-stem answer>", "rationale": "<why>", "markingScheme": [ { "point": "...", "marks": 1 } ], "answerPairs": [ { "left": "...", "right": "..." } ], "subParts": [ { "text": "...", "type": "<only for a MIXED slot: this item's own type>", "options": ["..."], "answer": "...", "rationale": "...", "markingScheme": [ { "point": "...", "marks": 1 }, { "point": "...", "marks": 2 } ] } ] } /* exactly ${opts.candidateTargets.length} entries, one per candidate above, same order */ ] }`
  : (opts.regenerate || (opts.singleSlot && blueprint)
    ? `{ "questions": [ { "questionId": "...", "text": "stem text", "type": "${typeEnumHint}", "marks": <total number>, "difficulty": "Easy|Medium|Difficult", "passage": "<only for comprehension, optional>", "options": ["...", "...", "..."], "answer": "<single-stem answer>", "rationale": "<why>", "markingScheme": [ { "point": "...", "marks": 1 } ], "answerPairs": [ { "left": "...", "right": "..." } ], "subParts": [ { "text": "...", "type": "<only for a MIXED slot: this item's own type>", "options": ["..."], "answer": "...", "rationale": "...", "markingScheme": [ { "point": "...", "marks": 1 }, { "point": "...", "marks": 2 } ] } ] } ] }`
    : `{ "questions": [ { "questionId": "generated-1", "text": "stem text", "type": "${typeEnumHint}", "marks": <total number>, "difficulty": "Easy|Medium|Difficult", "passage": "<only for comprehension, optional>", "options": ["...", "...", "..."], "answer": "<single-stem answer>", "rationale": "<why>", "markingScheme": [ { "point": "...", "marks": 1 } ], "answerPairs": [ { "left": "...", "right": "..." } ], "subParts": [ { "text": "...", "type": "<only for a MIXED slot: this item's own type>", "options": ["..."], "answer": "...", "rationale": "...", "markingScheme": [ { "point": "...", "marks": 1 }, { "point": "...", "marks": 2 } ] } ] } ] }`))}`;
  },

  /**
   * Generate a fresh batch of candidate questions in ONE LLM call.
   * @param {Object} requirements
   * @param {Array<Object>} context
   * @param {Object} [opts] - { extraCount, blueprint, startSlotIndex }
   * @returns {Promise<Array<Object>>} Normalized question objects with unique ids
   */
  async generate(requirements, context, opts = {}) {
    const blueprint = opts.blueprint || null;
    // Question-level RAG: when per-slot contexts were retrieved, the batch
    // prompt carries each slot's own context instead of the global pool.
    const prompt = this.buildPrompt(requirements, context, opts);

    const startSlot = opts.startSlotIndex || 0;
    const slotCount = opts.extraCount ?? (blueprint ? blueprint.questions.length : requirements.questionCount);
    const targetSlots = blueprint ? blueprint.questions.slice(startSlot, startSlot + slotCount) : [];
    const images = targetSlots
      .flatMap((s) => s.imageAssets || [])
      .filter(Boolean);

    const rawText = await geminiClient.generateContent(prompt, {
      responseMimeType: 'application/json',
      responseSchema: buildGenerationSchema(blueprint),
      temperature: 0.8,
      maxOutputTokens: env.AI_GENERATION_MAX_OUTPUT_TOKENS,
      ...(images.length > 0 ? { images } : {}),
    });

    const parsed = parseJsonObject(rawText);
    const rawQuestions = Array.isArray(parsed?.questions) ? parsed.questions : [];

    const allowedTypes = allowedTypesFor(blueprint);
    const questions = rawQuestions
      .map((raw, i) => normalizeGeneratedQuestion(raw, i, {
        allowedTypes,
        blueprintSlot: blueprint && blueprint.questions[startSlot + i]
          ? { ...blueprint.questions[startSlot + i], slotIndex: startSlot + i }
          : null,
      }))
      .filter(q => q.text.length >= 5);

    // Guarantee unique question ids (deterministic local cleanup)
    const seenIds = new Set();
    questions.forEach((q, i) => {
      if (!q.questionId || seenIds.has(q.questionId)) {
        q.questionId = `generated-${i + 1}`;
      }
      seenIds.add(q.questionId);
    });

    console.log(`[Generation Agent] LLM returned ${rawQuestions.length} raw candidate(s); ${questions.length} usable${blueprint ? ' (blueprint mode)' : ''}.`);
    questions.forEach((c, idx) => console.log(`  [initial candidate ${idx + 1}] stem: "${c.text}" | subParts: ${JSON.stringify(c.subParts?.map(p => p.text))}`));

    return questions;
  },

  /**
   * Generate ONE question for a specific blueprint slot (used when a slot's
   * question was never produced at all).
   * @param {Object} blueprint
   * @param {number} slotIndex
   * @param {Object} requirements
   * @param {Array<Object>} context
   * @returns {Promise<Object>} Replacement question for that slot
   */
  async generateForSlot(blueprint, slotIndex, requirements, context, opts = {}) {
    const slot = blueprint.questions[slotIndex];
    if (!slot) {
      const error = new Error(`[Generation Agent] Blueprint has no slot ${slotIndex + 1}.`);
      error.status = 500;
      throw error;
    }

    const prompt = this.buildPrompt(requirements, context, {
      blueprint,
      slotIndex,
      singleSlot: true,
      notes: slot.teacherNotes || null,
      slotContexts: opts.slotContexts,
      slotTargets: opts.slotTargets,
    });

    const images = Array.isArray(slot.imageAssets) && slot.imageAssets.length > 0 ? slot.imageAssets : [];

    const rawText = await geminiClient.generateContent(prompt, {
      responseMimeType: 'application/json',
      responseSchema: buildGenerationSchema(blueprint),
      temperature: 0.8,
      maxOutputTokens: env.AI_GENERATION_MAX_OUTPUT_TOKENS,
      ...(images.length > 0 ? { images } : {}),
    });

    const parsed = parseJsonObject(rawText);
    const rawQuestions = Array.isArray(parsed?.questions) ? parsed.questions : [];

    const question = normalizeGeneratedQuestion(rawQuestions[0] ?? parsed, 0, {
      allowedTypes: allowedTypesFor(blueprint),
      blueprintSlot: { ...slot, slotIndex },
    });
    question.questionId = question.questionId || `generated-slot-${slotIndex + 1}`;

    console.log(`[Generation Agent] Generated new question for blueprint slot ${slotIndex + 1} (${slot.label}).`);

    return question;
  },

  /**
   * Regenerate ONLY a single failed question (RULE 12 — never regenerate the whole batch).
   * @param {Object} failedQuestion - The rejected question object
   * @param {Array<string>} failureReasons - Why it was rejected
   * @param {Object} requirements
   * @param {Array<Object>} context
   * @param {Object} [opts] - { blueprint, slotIndex }
   * @returns {Promise<Object>} Replacement question (same questionId)
   */
  async regenerate(failedQuestion, failureReasons, requirements, context, opts = {}) {
    const blueprint = opts.blueprint || null;
    const slotIndex = opts.slotIndex ?? failedQuestion?.slotIndex ?? null;
    const prompt = this.buildPrompt(requirements, context, {
      regenerate: true,
      failedQuestion,
      failureReasons,
      priorReasons: opts.priorReasons,
      blueprint,
      slotIndex,
      slotContexts: opts.slotContexts,
      attempt: opts.attempt,
      maxAttempts: opts.maxAttempts,
      slotTargets: opts.slotTargets,
    });

    const slot = blueprint && slotIndex != null ? blueprint.questions[slotIndex] : null;
    const images = (slot?.imageAssets || failedQuestion?.imageAssets || failedQuestion?.assetImages || []).filter(Boolean);

    const temperature = retryTemperature(opts.attempt);
    const slotLabel = slot?.label ?? (slotIndex != null ? `slot-${slotIndex + 1}` : failedQuestion?.questionId ?? 'unknown');
    const attemptNum = opts.attempt ?? 1;
    if (opts.maxAttempts != null) {
      console.log(`[regeneration] slot=${slotLabel} attempt=${attemptNum}/${opts.maxAttempts} temperature=${temperature.toFixed(2)}`);
    } else {
      console.log(`[regeneration] attempt=${attemptNum} temperature=${temperature.toFixed(2)}`);
    }

    const rawText = await geminiClient.generateContent(prompt, {
      responseMimeType: 'application/json',
      responseSchema: buildGenerationSchema(blueprint),
      temperature,
      maxOutputTokens: env.AI_GENERATION_MAX_OUTPUT_TOKENS,
      ...(images.length > 0 ? { images } : {}),
    });

    const parsed = parseJsonObject(rawText);
    const rawQuestions = Array.isArray(parsed?.questions) ? parsed.questions : [];

    const replacement = normalizeGeneratedQuestion(rawQuestions[0] ?? parsed, 0, {
      allowedTypes: allowedTypesFor(blueprint),
      blueprintSlot: blueprint && slotIndex != null && blueprint.questions[slotIndex]
        ? { ...blueprint.questions[slotIndex], slotIndex }
        : null,
    });

    // Keep the same questionId so tracking/attempts stay stable
    replacement.questionId = failedQuestion.questionId;

    console.log(`[Generation Agent] Regenerated replacement for ${failedQuestion.questionId}${blueprint ? ` (slot ${slotIndex + 1})` : ''}.`);

    return replacement;
  },

  /**
   * PHASE 10 — INITIAL-PASS CANDIDATE POOL: ONE LLM call returns `poolSize`
   * independent candidates for EVERY blueprint slot at once (opt-in — the
   * caller decides when to use this instead of `generate()`). Each slot's
   * pool is pre-screened downstream by candidate-selector.js exactly like a
   * regeneration pool; this function only produces + normalizes candidates,
   * it never picks a winner itself.
   * @param {Object} requirements
   * @param {Array<Object>} context
   * @param {Array<Array<Object>>} poolTargetsBySlot - one selectTargetsForPool() result per blueprint slot, same order
   * @param {Object} [opts] - { blueprint (required), poolSize }
   * @returns {Promise<Object[][]>} one array of normalized candidates per slot, same order as blueprint.questions (never padded — an under-delivered slot just has fewer candidates)
   */
  async generateInitialPool(requirements, context, poolTargetsBySlot, opts = {}) {
    const blueprint = opts.blueprint;
    if (!blueprint || !Array.isArray(blueprint.questions) || blueprint.questions.length === 0) {
      throw new Error('[Generation Agent] generateInitialPool requires a locked blueprint.');
    }
    const poolSize = opts.poolSize || (Array.isArray(poolTargetsBySlot?.[0]) ? poolTargetsBySlot[0].length : 3);

    // PHASE 10 TIMEOUT-FIX — partition text-only slots from IMAGE_BASED slots
    // into SEPARATE pool calls. ai-router.service.js routes ANY call carrying
    // opts.images through the single, no-failover vision provider; before
    // this split, one image slot in a shared multi-slot call silently forced
    // every OTHER (text-only) slot's candidates through that same fragile
    // path too — confirmed root cause of a reproducible 20+ minute hang with
    // MULTI_CANDIDATE_ENABLED + hybrid_graph + the planner all enabled on a
    // real text+image blueprint. A homogeneous blueprint (all-text or
    // all-image — the common case) is completely unaffected: exactly one
    // call, identical to before this fix.
    const imageIndices = [];
    const textIndices = [];
    blueprint.questions.forEach((s, i) => {
      (Array.isArray(s.imageAssets) && s.imageAssets.length > 0 ? imageIndices : textIndices).push(i);
    });

    const pools = blueprint.questions.map(() => []);
    const runPartition = async (indices) => {
      if (indices.length === 0) return;
      const subBlueprint = { ...blueprint, questions: indices.map((i) => blueprint.questions[i]) };
      const subPoolTargets = indices.map((i) => poolTargetsBySlot[i]);
      const subPools = await runInitialPoolCall(this, requirements, context, subPoolTargets, { ...opts, blueprint: subBlueprint, poolSize });
      indices.forEach((originalIndex, localIndex) => {
        pools[originalIndex] = (subPools[localIndex] || []).map((c) => ({ ...c, slotIndex: originalIndex }));
      });
    };

    await runPartition(textIndices);
    await runPartition(imageIndices);

    console.log(`[Generation Agent] Initial candidate pools (text=${textIndices.length} slot(s), image=${imageIndices.length} slot(s)): ${pools.map((p) => p.length).join(',')} candidate(s) across ${blueprint.questions.length} slot(s) (requested ${poolSize}/slot).`);

    return pools;
  },

  /**
   * Phase 2 — CANDIDATE POOL regeneration: ONE LLM call returns `poolSize`
   * independent replacement candidates for a single rejected slot, each
   * built around its own target information-demand (target-selector.js).
   * This is still exactly ONE regeneration attempt — the caller's
   * `slotAttempts` counter increments once regardless of `poolSize`; pool
   * size and retry budget are deliberately separate concepts, never mixed.
   * @param {Object} failedQuestion - the rejected question object
   * @param {Array<string>} failureReasons
   * @param {Object} requirements
   * @param {Array<Object>} context
   * @param {Array<Array<Object>>} candidateTargets - candidateTargets[c][itemIndex], from target-selector.selectTargetsForPool
   * @param {Object} [opts] - { blueprint, slotIndex, slotContexts, attempt, maxAttempts }
   * @returns {Promise<Object[]>} normalized candidate question objects, length === candidateTargets.length (or fewer if the model under-delivers — never invented)
   */
  async regeneratePool(failedQuestion, failureReasons, requirements, context, candidateTargets, opts = {}) {
    const blueprint = opts.blueprint || null;
    const slotIndex = opts.slotIndex ?? failedQuestion?.slotIndex ?? null;
    const poolSize = Array.isArray(candidateTargets) ? candidateTargets.length : 0;
    if (poolSize === 0) {
      throw new Error('[Generation Agent] regeneratePool requires at least one candidateTargets entry.');
    }

    const prompt = this.buildPrompt(requirements, context, {
      regenerate: true,
      pool: true,
      candidateTargets,
      failedQuestion,
      failureReasons,
      priorReasons: opts.priorReasons,
      blueprint,
      slotIndex,
      slotContexts: opts.slotContexts,
      attempt: opts.attempt,
      maxAttempts: opts.maxAttempts,
      slotTargets: opts.slotTargets,
    });

    const slot = blueprint && slotIndex != null ? blueprint.questions[slotIndex] : null;
    const images = (slot?.imageAssets || failedQuestion?.imageAssets || failedQuestion?.assetImages || []).filter(Boolean);

    // ONE temperature, ONE call, regardless of poolSize — pool diversity comes
    // from the per-candidate target-demand assignment in the prompt, not from
    // resampling the same request multiple times.
    const temperature = retryTemperature(opts.attempt);
    const slotLabel = slot?.label ?? (slotIndex != null ? `slot-${slotIndex + 1}` : failedQuestion?.questionId ?? 'unknown');
    const attemptNum = opts.attempt ?? 1;
    if (opts.maxAttempts != null) {
      console.log(`[regeneration] slot=${slotLabel} attempt=${attemptNum}/${opts.maxAttempts} pool=${poolSize} temperature=${temperature.toFixed(2)}`);
    } else {
      console.log(`[regeneration] attempt=${attemptNum} pool=${poolSize} temperature=${temperature.toFixed(2)}`);
    }

    const rawText = await geminiClient.generateContent(prompt, {
      responseMimeType: 'application/json',
      responseSchema: buildPoolGenerationSchema(blueprint, poolSize),
      temperature,
      maxOutputTokens: env.AI_GENERATION_MAX_OUTPUT_TOKENS,
      ...(images.length > 0 ? { images } : {}),
    });

    const parsed = parseJsonObject(rawText);
    let rawCandidates = [];
    if (Array.isArray(parsed?.candidates)) {
      rawCandidates = parsed.candidates;
    } else if (Array.isArray(parsed?.questions)) {
      rawCandidates = parsed.questions;
    } else if (Array.isArray(parsed)) {
      rawCandidates = parsed;
    } else if (parsed && typeof parsed === 'object' && (parsed.text || parsed.subParts || parsed.stem)) {
      rawCandidates = [parsed];
    }

    const blueprintSlot = blueprint && slotIndex != null && blueprint.questions[slotIndex]
      ? { ...blueprint.questions[slotIndex], slotIndex }
      : null;
    const candidates = rawCandidates.map((raw) => {
      const candidate = normalizeGeneratedQuestion(raw, 0, { allowedTypes: allowedTypesFor(blueprint), blueprintSlot });
      // Keep the same questionId on every candidate so tracking/attempts stay
      // stable regardless of which candidate is eventually selected.
      candidate.questionId = failedQuestion.questionId;
      return candidate;
    });

    if (candidates.length === 0) {
      console.warn(`[Generation Agent] Candidate pool empty for ${failedQuestion.questionId} (slot ${slotIndex != null ? slotIndex + 1 : '?'}). Raw response preview: ${(rawText || '').slice(0, 200)}`);
    }

    console.log(`[Generation Agent] Candidate pool of ${candidates.length}/${poolSize} for ${failedQuestion.questionId}${blueprint ? ` (slot ${slotIndex + 1})` : ''}.`);
    candidates.forEach((c, idx) => {
      const parts = (c.subParts || []).map((p, pi) => `(${String.fromCharCode(97 + pi)}) "${p.text}"`).join(' | ');
      console.log(`  [regen pool #${idx + 1}] stem: "${c.text}" | subParts: ${parts}`);
    });

    return candidates;
  },

  /**
   * PHASE 6 — regenerate ONLY the answer key of ONE existing question. The
   * question itself is FROZEN: the prompt shows it verbatim and the response
   * schema does not even accept stem/item text, so a model cannot rewrite what
   * the teacher approved. Returns the answers in the question's own shape
   * (same subParts array; MATCH returns answerPairs; INTERNAL_CHOICE branches
   * carry per-branch answers).
   * @param {Object} question - the CURRENT teacher-edited question
   * @param {Object} requirements - { class, subject, difficulty, ... }
   * @param {Array<Object>} context - the same RAG evidence the slot was grounded on
   * @returns {Promise<{ answers: Object }>}
   */
  async regenerateAnswer(question, requirements, context = []) {
    if (!question || typeof question !== 'object') {
      const error = new Error('[Generation Agent] regenerateAnswer requires the current question.');
      error.status = 400;
      throw error;
    }
    const stem = String(question.text || '').trim();
    const items = Array.isArray(question.subParts) ? question.subParts : [];
    const evidence = (Array.isArray(context) ? context : [])
      .map((r) => String(r?.text ?? r ?? '').trim())
      .filter(Boolean)
      .slice(0, 6)
      .map((t, i) => `${i + 1}. ${t}`)
      .join('\n');

    const shapeLine = question.columns
      ? 'MATCH: return "answerPairs" — one { left, right } pair per row, each entry used exactly once.'
      : items.length > 0
        ? `Return "answers" as an array with EXACTLY ${items.length} entries, one per item in order.`
        : 'Return a single answer for the stem.';

    const prompt = `You are an expert exam setter writing the ANSWER KEY for an existing school examination question.

The question below is FINAL — it has already been reviewed and approved by the teacher. Do NOT rewrite, reword or replace the question or any of its items. Your task is ONLY to produce the correct answer key for it, grounded in the supplied syllabus evidence.

QUESTION (${question.type || 'question'}, ${question.marks ?? '?'} marks, Class ${requirements.class ?? ''} ${requirements.subject ?? ''}):
${stem}
${question.passage ? `\nPassage: ${question.passage}` : ''}
${items.map((sp, i) => `${String.fromCharCode(97 + i)}) ${sp?.text ?? ''}${Array.isArray(sp?.options) && sp.options.length ? ` [options: ${sp.options.join(' | ')}]` : ''}`).join('\n')}
${question.columns ? `\nLeft column: ${question.columns.left.join(' | ')}\nRight column: ${question.columns.right.join(' | ')}` : ''}
${Array.isArray(question.choices) && question.choices.length ? `\nOR branches: ${question.choices.map((c, i) => `(${String.fromCharCode(97 + i)}) ${c.text}`).join(' / ')}` : ''}

SYLLABUS EVIDENCE (ground every answer in this material — do not invent content beyond it):
${evidence || '(no evidence supplied — answer strictly from the question itself)'}

${ANSWER_RULES}

OUTPUT FORMAT: Respond with ONLY a JSON object (no prose) in exactly this shape:
${shapeLine}
{ "answers": <as described> }
For a single-stem question return { "answers": "<the answer>" }. For an itemized question return { "answers": [ { "answer": "...", "rationale": "...", "markingScheme": [{ "point": "...", "marks": 1 }] } ] }. For MATCH return { "answers": { "answerPairs": [{ "left": "...", "right": "..." }] } }. For INTERNAL_CHOICE return { "answers": { "choices": [{ "answer": "...", "rationale": "..." }] } }.`;

    // The response schema ACCEPTS ONLY answer fields — the model physically
    // cannot return a replacement question through this call.
    const answerOnlySchema = {
      type: 'object',
      properties: {
        answers: {},
      },
      required: ['answers'],
    };

    const rawText = await geminiClient.generateContent(prompt, {
      responseMimeType: 'application/json',
      responseSchema: answerOnlySchema,
      temperature: 0.3,
    });

    const parsed = parseJsonObject(rawText);
    console.log(`[Generation Agent] Regenerated answer key for ${question.questionId || 'question'}.`);
    return { answers: parsed?.answers ?? null };
  },
};

export default questionGeneratorAgent;