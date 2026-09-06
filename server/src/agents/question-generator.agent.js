import { geminiClient } from '../services/gemini-client.service.js';
import { parseJsonObject } from './agent-utils.js';
import { GENERATOR_TYPES } from '../blueprint/blueprint-schema.js';

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
11. PER-PART MARKS ARE LOCKED — when a reference item line shows a bracket such as [2 marks], produce the SAME per-part marks for the same position (e.g. a 5-part Q4 with marks 1,2,2,2,3 must keep exactly those per-part marks in that order). Put the marks on each sub-part object.
12. ANSWER FORM MUST MATCH THE QUESTION TYPE — do not change the pattern the reference uses inside the same slot: an MCQ slot must contain multiple-choice items each with its own options and one correct choice; a TRUE_FALSE slot must contain plain true/false statements (no options); a FILL_IN_THE_BLANK slot must contain sentences with a blank; a MATCH slot two equal-length columns; a passage slot a passage + questions about it. NEVER replace an MCQ with statements, or fill-in-the-blanks with short answers, inside a locked slot.

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
          text: { type: 'string' },
          type: {
            type: 'string',
            enum: ['MCQ', 'SHORT_ANSWER', 'LONG_ANSWER', 'TRUE_FALSE', 'FILL_IN_THE_BLANK'],
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
                text: { type: 'string' },
                options: { type: 'array', items: { type: 'string' }, description: 'Only for MCQ sub-parts: 3-4 short choice texts (no letter prefixes).' },
                marks: { type: 'integer', description: 'ONLY when the locked slot carries per-part marks (e.g. Q4: a=1, b=2, c=2, d=2, e=3): this sub-part\'s exact marks. Omit when all sub-parts share the same marks.' },
              },
              required: ['text'],
            },
            description: 'Uniform lettered sub-parts for a grouped main question. Text only; renderer adds a./b./c. labels.',
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
function buildGenerationSchema(blueprint) {
  const schema = JSON.parse(JSON.stringify(GENERATION_SCHEMA));
  if (blueprint) {
    const types = [...new Set([...GENERATOR_TYPES, ...blueprint.questions.map((q) => q.type)])];
    schema.properties.questions.items.properties.type.enum = types;
  }
  return schema;
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
  return bits.length > 0 ? `, ${bits.join(', ')}` : '';
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
  if (items.length > 0) {
    return items
      .map((it, i) => {
        const marks = it?.marks != null ? ` [${it.marks} mark${it.marks === 1 ? '' : 's'}]` : '';
        const text = String(it?.referenceText || '').slice(0, 200) || '(no recoverable reference text — infer the concept from the slot instruction)';
        return `   ${alpha[i] ?? i + 1}) ${text}${marks}`;
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
 * Format a slice of blueprint slots for the prompt — each slot carries its
 * construction pattern, its reference items (topic anchors) and, when provided,
 * its OWN question-level RAG context.
 */
function formatBlueprintSlots(blueprint, startSlot = 0, count, slotContexts) {
  const slots = blueprint.questions.slice(startSlot, count == null ? undefined : startSlot + count);
  return slots
    .map((s, i) => {
      const idx = startSlot + i + 1;
      const rule = s.optionalRule ? `optionalRule=any ${s.optionalRule.n}` : 'optionalRule=none';
      const sec = s.sectionName ? `, section=${s.sectionName}` : '';
      const inst = s.instruction ? `, instruction="${s.instruction}"` : '';
      const head = `Slot ${idx} (${s.label}): type=${s.type}, totalMarks=${s.totalMarks}, items=${s.itemCount}, ${rule}${sec}${inst}${slotPatternSummary(s)}`;
      const refs = slotItemLines(s);
      const ctx = Array.isArray(slotContexts) && slotContexts[startSlot + i]
        ? formatSlotContext(slotContexts[startSlot + i].results)
        : '';
      return `${head}${refs ? `\n   Reference items IN ORDER — generate one NEW sub-part per line on the SAME concept ([N marks] = that sub-part's locked marks):\n${refs}` : ''}${ctx ? `\n   Slot RAG context (concept reference only):\n${ctx}` : ''}`;
    })
    .join('\n');
}

/** Full per-slot spec for targeted regeneration / single-slot prompts. */
function formatSlotSpec(slot, slotIndex, contextResults) {
  const rule = slot.optionalRule ? `optionalRule=any ${slot.optionalRule.n}` : 'optionalRule=none';
  const sec = slot.sectionName ? `, section=${slot.sectionName}` : '';
  const inst = slot.instruction ? `, instruction="${slot.instruction}"` : '';
  const head = `Slot ${slotIndex + 1} (${slot.label}): type=${slot.type}, totalMarks=${slot.totalMarks}, items=${slot.itemCount}, ${rule}${sec}${inst}${slotPatternSummary(slot)}`;
  const refs = slotItemLines(slot);
  const ctx = formatSlotContext(contextResults);
  return `${head}${refs ? `\n   Reference items IN ORDER — generate one NEW sub-part per line on the SAME concept ([N marks] = that sub-part's locked marks):\n${refs}` : ''}${ctx ? `\n   Slot RAG context (concept reference only):\n${ctx}` : ''}`;
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
        options: partOptions,
        marks: partMarks,
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
    const parts = subParts.map((sp, i) => {
      const marks = canStamp ? Math.round(Number(slotMarks[i]) * 10) / 10 : sp.marks;
      return {
        text: sp.text.slice(0, 240),
        ...(sp.options.length > 0 ? { options: sp.options } : {}),
        ...(marks != null ? { marks } : {}),
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
  if (Array.isArray(raw?.choices)) {
    const choices = raw.choices
      .map((c) => {
        const choiceParts = Array.isArray(c?.subParts)
          ? c.subParts.map((sp) => String(sp?.text || '').trim()).filter(Boolean).slice(0, 6)
          : [];
        return {
          text: String(c?.text || '').trim().slice(0, 300),
          ...(choiceParts.length > 0 ? { subParts: choiceParts } : {}),
        };
      })
      .filter((c) => c.text.length >= 3)
      .slice(0, 4);
    if (choices.length > 0) question.choices = choices;
  }

  // Embedding source: passage + stem + sub-parts, so semantic checks see the
  // real content instead of a bare stem ("Fill in the blanks: …").
  const partsText = question.subParts ? question.subParts.map((sp) => sp.text).join('\n') : '';
  if (question.passage || partsText) {
    question.fullText = [question.passage, text, partsText].filter(Boolean).join('\n');
  }

  return question;
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

    const typeEnumHint = blueprint
      ? [...new Set([...GENERATOR_TYPES, ...blueprint.questions.map((q) => q.type)])].join('|')
      : GENERATOR_TYPES.join('|');
    const usePerSlotContext = blueprint && Array.isArray(opts.slotContexts);

    let task;
    if (opts.regenerate && opts.failedQuestion) {
      task = `
TASK: TARGETED REGENERATION — replace ONE rejected MAIN question with a better one.

The following generated question was REJECTED:
Question ID: ${opts.failedQuestion.questionId}
Text: ${opts.failedQuestion.text}
Rejection reasons: ${(opts.failureReasons || []).join(' | ')}

Produce ONE improved replacement MAIN question that fixes every rejection reason.
Keep the same questionId (${opts.failedQuestion.questionId}).
Keep the requested difficulty (${requirements.difficulty}) and stay within the same topic.
Keep the same type and overall structure (single stem, or passage + sub-parts, or options).`;
      if (blueprint && opts.slotIndex != null && blueprint.questions[opts.slotIndex]) {
        task += `

The replacement must fill this LOCKED BLUEPRINT slot exactly:
${formatSlotSpec(blueprint.questions[opts.slotIndex], opts.slotIndex)}
Do not change the slot's type, total marks, item count or optional rule — fix the CONTENT so it passes the rejection reasons above.
CRITICAL: if the rejection reason mentions item count, recount your sub-parts and produce EXACTLY ${blueprint.questions[opts.slotIndex].itemCount} of them.`;
      }
    } else if (opts.singleSlot && blueprint && opts.slotIndex != null && blueprint.questions[opts.slotIndex]) {
      const slot = blueprint.questions[opts.slotIndex];
      task = `
TASK: Generate exactly ONE brand-new MAIN question that fills this LOCKED BLUEPRINT slot:
${formatSlotSpec(slot, opts.slotIndex)}
Use the slot's exact type, total marks, item count and optional rule. Write entirely new content for it.`;
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
      ? `\nLOCKED BLUEPRINT (FROZEN STRUCTURE) — one NEW main question per slot below:\n${formatBlueprintSlots(blueprint, opts.startSlotIndex || 0, slotCount, usePerSlotContext ? opts.slotContexts : null)}\n${BLUEPRINT_RULES}\n`
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
${blueprintBlock}
${task}

OUTPUT FORMAT: Respond with ONLY a JSON object (no prose around it) in exactly this shape:
${opts.regenerate || (opts.singleSlot && blueprint)
  ? `{ "questions": [ { "questionId": "...", "text": "stem text", "type": "${typeEnumHint}", "marks": <total number>, "difficulty": "Easy|Medium|Difficult", "passage": "<only for comprehension, optional>", "options": ["...", "...", "..."] , "subParts": [ { "text": "...", "options": ["..."] }, { "text": "..." } ] } ] }`
  : `{ "questions": [ { "questionId": "generated-1", "text": "stem text", "type": "${typeEnumHint}", "marks": <total number>, "difficulty": "Easy|Medium|Difficult", "passage": "<only for comprehension, optional>", "options": ["...", "...", "..."] , "subParts": [ { "text": "...", "options": ["..."] }, { "text": "..." } ] } ] }`}`;
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

    const rawText = await geminiClient.generateContent(prompt, {
      responseMimeType: 'application/json',
      responseSchema: buildGenerationSchema(blueprint),
      temperature: 0.8,
    });

    const parsed = parseJsonObject(rawText);
    const rawQuestions = Array.isArray(parsed?.questions) ? parsed.questions : [];

    const allowedTypes = allowedTypesFor(blueprint);
    const startSlot = opts.startSlotIndex || 0;
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
  async generateForSlot(blueprint, slotIndex, requirements, context) {
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
    });

    const rawText = await geminiClient.generateContent(prompt, {
      responseMimeType: 'application/json',
      responseSchema: buildGenerationSchema(blueprint),
      temperature: 0.8,
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
      blueprint,
      slotIndex,
    });

    const rawText = await geminiClient.generateContent(prompt, {
      responseMimeType: 'application/json',
      responseSchema: buildGenerationSchema(blueprint),
      temperature: 0.7,
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
};

export default questionGeneratorAgent;